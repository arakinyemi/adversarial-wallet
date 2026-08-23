// Watch-only Bitcoin balance over an Esplora endpoint. See PLAN.md §5.
//
// This module never touches the seed, the passphrase, or any private key:
// addresses are derived in the Rust core from the account xpub alone.
//
// Fail-closed contract: any HTTP failure, malformed response, or integrity
// violation throws, and a scan either completes for every address or throws —
// there is no partial balance. A dead endpoint must read as an error, never
// as "balance: 0".

import { xpub_to_address_js } from "../../core/pkg/adversarial_core";

export const GAP_LIMIT = 20;
export const ESPLORA_MAINNET = "https://blockstream.info/api";
export const ESPLORA_TESTNET = "https://blockstream.info/testnet/api";

export class BtcWatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BtcWatchError";
  }
}

/** The subset of fetch this module consumes, injectable in tests. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface AddressActivity {
  address: string;
  txCount: number;
  confirmedSats: number;
  /** Net unconfirmed delta; negative while an outgoing spend is in the mempool. */
  pendingSats: number;
}

export interface WatchOnlyBalance {
  confirmedSats: number;
  pendingSats: number;
  addressesScanned: number;
  usedAddresses: string[];
}

export interface ScanParams {
  esploraUrl: string;
  xpub: string;
  network: "mainnet" | "testnet";
  fetchFn?: FetchLike;
}

interface StatBlock {
  funded: number;
  spent: number;
  txCount: number;
}

function requireStats(value: unknown, label: string): StatBlock {
  const v = value as
    | { funded_txo_sum?: unknown; spent_txo_sum?: unknown; tx_count?: unknown }
    | null
    | undefined;
  const funded = v?.funded_txo_sum;
  const spent = v?.spent_txo_sum;
  const txCount = v?.tx_count;
  for (const n of [funded, spent, txCount]) {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
      throw new BtcWatchError(`esplora response has malformed ${label}`);
    }
  }
  return { funded: funded as number, spent: spent as number, txCount: txCount as number };
}

/** Fetch and validate one address's activity from Esplora. */
export async function fetchAddressActivity(
  esploraUrl: string,
  address: string,
  fetchFn: FetchLike = (url) => globalThis.fetch(url),
): Promise<AddressActivity> {
  const response = await fetchFn(`${esploraUrl}/address/${address}`);
  if (!response.ok) {
    throw new BtcWatchError(`esplora endpoint returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as
    | { address?: unknown; chain_stats?: unknown; mempool_stats?: unknown }
    | null;
  if (body === null || typeof body !== "object") {
    throw new BtcWatchError("esplora response is not an object");
  }
  if (body.address !== address) {
    throw new BtcWatchError("esplora response is for a different address");
  }
  const chain = requireStats(body.chain_stats, "chain_stats");
  const mempool = requireStats(body.mempool_stats, "mempool_stats");
  const confirmedSats = chain.funded - chain.spent;
  if (confirmedSats < 0) {
    // On-chain spent can never exceed on-chain funded for an address.
    throw new BtcWatchError("esplora response is internally inconsistent");
  }
  return {
    address,
    txCount: chain.txCount + mempool.txCount,
    confirmedSats,
    pendingSats: mempool.funded - mempool.spent,
  };
}

/** The POST subset of fetch used for broadcasting, injectable in tests. */
export type PostFetchLike = (
  url: string,
  init: { method: "POST"; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface Utxo {
  txid: string;
  vout: number;
  valueSats: number;
  confirmed: boolean;
}

const TXID_RE = /^[0-9a-f]{64}$/;

/** Fetch and validate the UTXO set of one address from Esplora. */
export async function fetchUtxos(
  esploraUrl: string,
  address: string,
  fetchFn: FetchLike = (url) => globalThis.fetch(url),
): Promise<Utxo[]> {
  const response = await fetchFn(`${esploraUrl}/address/${address}/utxo`);
  if (!response.ok) {
    throw new BtcWatchError(`esplora endpoint returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new BtcWatchError("esplora utxo response is not an array");
  }
  return body.map((entry: unknown): Utxo => {
    const u = entry as {
      txid?: unknown;
      vout?: unknown;
      value?: unknown;
      status?: { confirmed?: unknown };
    } | null;
    const txid = u?.txid;
    const vout = u?.vout;
    const value = u?.value;
    const confirmed = u?.status?.confirmed;
    if (
      typeof txid !== "string" ||
      !TXID_RE.test(txid) ||
      typeof vout !== "number" ||
      !Number.isSafeInteger(vout) ||
      vout < 0 ||
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      typeof confirmed !== "boolean"
    ) {
      throw new BtcWatchError("esplora utxo response has a malformed entry");
    }
    return { txid, vout, valueSats: value, confirmed };
  });
}

/** Broadcast a signed transaction; returns the txid Esplora reports.
 * Throws on any HTTP failure or malformed response. */
export async function broadcastTransaction(
  esploraUrl: string,
  txHex: string,
  fetchFn: PostFetchLike = (url, init) => globalThis.fetch(url, init),
): Promise<string> {
  const response = await fetchFn(`${esploraUrl}/tx`, {
    method: "POST",
    body: txHex,
  });
  const text = (await response.text()).trim();
  if (!response.ok) {
    // Esplora puts the node's rejection reason in the body; surface it.
    throw new BtcWatchError(`broadcast failed with HTTP ${response.status}: ${text}`);
  }
  if (!TXID_RE.test(text)) {
    throw new BtcWatchError("broadcast response is not a txid; success is unproven");
  }
  return text;
}

/** Scan receive and change chains to the gap limit and sum balances.
 * Throws on any failure — never returns a partial result. */
export async function scanWatchOnlyBalance(
  params: ScanParams,
): Promise<WatchOnlyBalance> {
  const fetchFn = params.fetchFn ?? ((url: string) => globalThis.fetch(url));
  let confirmedSats = 0;
  let pendingSats = 0;
  let addressesScanned = 0;
  const usedAddresses: string[] = [];

  for (const chain of [0, 1]) {
    let gap = 0;
    for (let index = 0; gap < GAP_LIMIT; index++) {
      const address = xpub_to_address_js(params.xpub, params.network, chain, index);
      const activity = await fetchAddressActivity(params.esploraUrl, address, fetchFn);
      addressesScanned++;
      if (activity.txCount > 0) {
        gap = 0;
        usedAddresses.push(address);
        confirmedSats += activity.confirmedSats;
        pendingSats += activity.pendingSats;
      } else {
        gap++;
      }
    }
  }

  return { confirmedSats, pendingSats, addressesScanned, usedAddresses };
}
