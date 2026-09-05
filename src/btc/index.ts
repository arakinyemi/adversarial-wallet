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

/** Addresses fetched concurrently during a scan. */
const SCAN_CHUNK = 10;
const FETCH_TIMEOUT_MS = 15_000;
const BROADCAST_TIMEOUT_MS = 30_000;

// Default fetches carry a hard timeout: a stalled connection must become a
// visible error, never an indefinite spinner.
const defaultGet: FetchLike = (url) =>
  globalThis.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

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
      throw new BtcWatchError(`The balance service sent malformed data (${label}).`);
    }
  }
  return { funded: funded as number, spent: spent as number, txCount: txCount as number };
}

/** Fetch and validate one address's activity from Esplora. */
export async function fetchAddressActivity(
  esploraUrl: string,
  address: string,
  fetchFn: FetchLike = defaultGet,
): Promise<AddressActivity> {
  const response = await fetchFn(`${esploraUrl}/address/${address}`);
  if (!response.ok) {
    throw new BtcWatchError(`The balance service returned an error (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as
    | { address?: unknown; chain_stats?: unknown; mempool_stats?: unknown }
    | null;
  if (body === null || typeof body !== "object") {
    throw new BtcWatchError("The balance service sent an unreadable response.");
  }
  if (body.address !== address) {
    throw new BtcWatchError("The balance service answered for a different address.");
  }
  const chain = requireStats(body.chain_stats, "chain_stats");
  const mempool = requireStats(body.mempool_stats, "mempool_stats");
  const confirmedSats = chain.funded - chain.spent;
  if (confirmedSats < 0) {
    // On-chain spent can never exceed on-chain funded for an address.
    throw new BtcWatchError("The balance service sent inconsistent data.");
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
  fetchFn: FetchLike = defaultGet,
): Promise<Utxo[]> {
  const response = await fetchFn(`${esploraUrl}/address/${address}/utxo`);
  if (!response.ok) {
    throw new BtcWatchError(`The balance service returned an error (HTTP ${response.status}).`);
  }
  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new BtcWatchError("The balance service sent an unreadable coin list.");
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
      throw new BtcWatchError("The balance service sent a malformed coin entry.");
    }
    return { txid, vout, valueSats: value, confirmed };
  });
}

/** Broadcast a signed transaction; returns the txid Esplora reports.
 * Throws on any HTTP failure or malformed response. */
export async function broadcastTransaction(
  esploraUrl: string,
  txHex: string,
  fetchFn: PostFetchLike = (url, init) =>
    globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS) }),
): Promise<string> {
  const response = await fetchFn(`${esploraUrl}/tx`, {
    method: "POST",
    body: txHex,
  });
  const text = (await response.text()).trim();
  if (!response.ok) {
    // Esplora puts the node's rejection reason in the body; surface it.
    throw new BtcWatchError(`The Bitcoin network rejected this payment: ${text}`);
  }
  if (!TXID_RE.test(text)) {
    throw new BtcWatchError("The payment may not have gone through — no confirmation was received.");
  }
  return text;
}

/** Confirmation target for automatic fees: within ~3 blocks. */
const FEE_TARGET_BLOCKS = "3";
/** Sanity ceiling — an endpoint claiming more than this is refused. */
const MAX_FEE_RATE = 1_000;

/** Current sat/vB fee rate for the confirmation target, from the same
 * Esplora endpoint used for balances. No fallback rate exists: estimation
 * failure refuses the send rather than guessing. */
export async function fetchFeeRate(
  esploraUrl: string,
  fetchFn: FetchLike = defaultGet,
): Promise<number> {
  const response = await fetchFn(`${esploraUrl}/fee-estimates`);
  if (!response.ok) {
    throw new BtcWatchError(`The balance service returned an error (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as Record<string, unknown> | null;
  const rate = body?.[FEE_TARGET_BLOCKS];
  if (
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > MAX_FEE_RATE
  ) {
    throw new BtcWatchError("Could not get a reliable network fee right now.");
  }
  return rate;
}

/** Conservative dust threshold in sats. Mirrors DUST_SATS in the Rust core;
 * an output below this is refused there, so callers size outputs above it. */
export const DUST_SATS = 546;

/** Every confirmed, spendable coin of the wallet, with the derivation
 * coordinates the signer needs to reproduce each input's key. */
export interface SpendableInputs {
  txids: string[];
  addresses: string[];
  vouts: number[];
  values: bigint[];
  chains: number[];
  indexes: number[];
}

/** Walk both chains with the same consecutive-gap semantics as
 * scanWatchOnlyBalance and gather every CONFIRMED utxo. Addresses are
 * derived locally from the xpub — never taken from the endpoint — which is
 * what lets the Rust signer's address interlock reject foreign inputs.
 * Shared by the ordinary send and the passphrase-rotation sweep so the two
 * can never disagree about what is spendable. Fail-closed: any endpoint
 * failure throws. */
export async function collectSpendableInputs(
  esploraUrl: string,
  xpub: string,
  network: "mainnet" | "testnet",
  usedAddresses: readonly string[],
  fetchFn: FetchLike = defaultGet,
): Promise<SpendableInputs> {
  const used = new Set(usedAddresses);
  const out: SpendableInputs = {
    txids: [], addresses: [], vouts: [], values: [], chains: [], indexes: [],
  };
  for (const chain of [0, 1]) {
    for (let i = 0, gap = 0; gap < GAP_LIMIT; i++) {
      const address = xpub_to_address_js(xpub, network, chain, i);
      if (!used.has(address)) { gap++; continue; }
      gap = 0;
      for (const utxo of await fetchUtxos(esploraUrl, address, fetchFn)) {
        if (!utxo.confirmed) continue;
        out.txids.push(utxo.txid);
        out.addresses.push(address);
        out.vouts.push(utxo.vout);
        out.values.push(BigInt(utxo.valueSats));
        out.chains.push(chain);
        out.indexes.push(i);
      }
    }
  }
  return out;
}

/** Amount for a single-output sweep of every input: total minus fee, with
 * no change. Refuses when the remainder could not stand as an output. */
export function computeSweepAmount(values: readonly bigint[], feeSats: number): bigint {
  if (values.length === 0) {
    throw new BtcWatchError("No confirmed coins to move yet.");
  }
  if (!Number.isSafeInteger(feeSats) || feeSats <= 0) {
    throw new BtcWatchError("fee must be a positive whole number of sats");
  }
  const total = values.reduce((a, v) => a + v, 0n);
  const amount = total - BigInt(feeSats);
  if (amount < BigInt(DUST_SATS)) {
    throw new BtcWatchError("Balance is too small to move after the network fee.");
  }
  return amount;
}

/** Fee for a P2WPKH transaction: vsize ≈ 10.5 + 68·inputs + 31·outputs,
 * rounded up so the estimate never undershoots the rate. */
export function estimateFeeSats(
  inputs: number,
  outputs: number,
  satPerVb: number,
): number {
  if (inputs < 1 || outputs < 1 || satPerVb <= 0) {
    throw new BtcWatchError("fee estimation received a degenerate transaction shape");
  }
  return Math.ceil((10.5 + 68 * inputs + 31 * outputs) * satPerVb);
}

/** Scan receive and change chains to the gap limit and sum balances.
 * Throws on any failure — never returns a partial result. */
export async function scanWatchOnlyBalance(
  params: ScanParams,
): Promise<WatchOnlyBalance> {
  const fetchFn = params.fetchFn ?? defaultGet;
  let confirmedSats = 0;
  let pendingSats = 0;
  let addressesScanned = 0;
  const usedAddresses: string[] = [];

  for (const chain of [0, 1]) {
    let gap = 0;
    for (let start = 0; gap < GAP_LIMIT; start += SCAN_CHUNK) {
      // Fetch a chunk concurrently; Promise.all keeps the fail-closed
      // contract (any failure rejects the whole scan) while cutting the
      // scan's wall-clock by ~10x on high-latency links. Results are
      // processed in index order, so gap accounting and address ordering
      // are identical to a sequential scan (a chunk may fetch a few
      // addresses past the stopping point; harmless — they are public).
      const chunk = await Promise.all(
        Array.from({ length: SCAN_CHUNK }, (_, k) => {
          const address = xpub_to_address_js(params.xpub, params.network, chain, start + k);
          return fetchAddressActivity(params.esploraUrl, address, fetchFn).then(
            (activity) => ({ address, activity }),
          );
        }),
      );
      for (const { address, activity } of chunk) {
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
  }

  return { confirmedSats, pendingSats, addressesScanned, usedAddresses };
}

/** One wallet-relevant transaction: signed net effect on our addresses. */
export interface TxActivity {
  txid: string;
  netSats: number;
  confirmed: boolean;
  time: number | null;
}

/** Recent transactions across the given (already-known-used) addresses,
 * deduplicated, with the signed net amount computed from inputs and
 * outputs. Fail-closed: any HTTP failure or malformed entry throws. */
export async function fetchRecentTransactions(
  esploraUrl: string,
  addresses: string[],
  fetchFn: FetchLike = defaultGet,
): Promise<TxActivity[]> {
  const mine = new Set(addresses);
  const byId = new Map<string, TxActivity>();

  for (let start = 0; start < addresses.length; start += SCAN_CHUNK) {
    const chunk = addresses.slice(start, start + SCAN_CHUNK);
    const lists = await Promise.all(
      chunk.map(async (address) => {
        const response = await fetchFn(`${esploraUrl}/address/${address}/txs`);
        if (!response.ok) {
          throw new BtcWatchError(`The balance service returned an error (HTTP ${response.status}).`);
        }
        const body = await response.json();
        if (!Array.isArray(body)) {
          throw new BtcWatchError("The balance service sent an unreadable transaction list.");
        }
        return body;
      }),
    );
    for (const list of lists) {
      for (const entry of list) {
        const tx = entry as {
          txid?: unknown;
          status?: { confirmed?: unknown; block_time?: unknown };
          vin?: { prevout?: { scriptpubkey_address?: unknown; value?: unknown } | null }[];
          vout?: { scriptpubkey_address?: unknown; value?: unknown }[];
        } | null;
        if (
          tx === null ||
          typeof tx.txid !== "string" ||
          typeof tx.status?.confirmed !== "boolean" ||
          !Array.isArray(tx.vin) ||
          !Array.isArray(tx.vout)
        ) {
          throw new BtcWatchError("The balance service sent a malformed transaction.");
        }
        if (byId.has(tx.txid)) continue;
        let net = 0;
        for (const vout of tx.vout) {
          if (typeof vout?.scriptpubkey_address === "string" && mine.has(vout.scriptpubkey_address)) {
            if (typeof vout.value !== "number" || !Number.isSafeInteger(vout.value)) {
              throw new BtcWatchError("The balance service sent a malformed transaction.");
            }
            net += vout.value;
          }
        }
        for (const vin of tx.vin) {
          const prev = vin?.prevout;
          if (prev && typeof prev.scriptpubkey_address === "string" && mine.has(prev.scriptpubkey_address)) {
            if (typeof prev.value !== "number" || !Number.isSafeInteger(prev.value)) {
              throw new BtcWatchError("The balance service sent a malformed transaction.");
            }
            net -= prev.value;
          }
        }
        const time = typeof tx.status.block_time === "number" ? tx.status.block_time : null;
        byId.set(tx.txid, { txid: tx.txid, netSats: net, confirmed: tx.status.confirmed, time });
      }
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1;
    return (b.time ?? 0) - (a.time ?? 0);
  });
}
