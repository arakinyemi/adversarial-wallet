import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import init, {
  account_xpub_js,
  sign_spend_js,
  xpub_to_address_js,
} from "../../core/pkg/adversarial_core";
import {
  broadcastTransaction,
  BtcWatchError,
  fetchAddressActivity,
  fetchUtxos,
  GAP_LIMIT,
  scanWatchOnlyBalance,
  type FetchLike,
  type PostFetchLike,
} from "./index";

// Public BIP84 reference mnemonic — never real key material.
const BIP84_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ESPLORA = "https://esplora.test/api";

let xpub: string;
let receive: (i: number) => string;
let change: (i: number) => string;

beforeAll(async () => {
  await init({
    module_or_path: readFileSync(
      new URL("../../core/pkg/adversarial_core_bg.wasm", import.meta.url),
    ),
  });
  xpub = account_xpub_js(BIP84_MNEMONIC, "", "mainnet");
  receive = (i) => xpub_to_address_js(xpub, "mainnet", 0, i);
  change = (i) => xpub_to_address_js(xpub, "mainnet", 1, i);
});

interface EsploraDoc {
  address: string;
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
}

const emptyDoc = (address: string): EsploraDoc => ({
  address,
  chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
  mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
});

function mockEsplora(docs: Record<string, Partial<EsploraDoc>>) {
  const requested: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    requested.push(url);
    const address = url.split("/").pop()!;
    const doc = { ...emptyDoc(address), ...docs[address] };
    return { ok: true, status: 200, json: async () => doc };
  };
  return { fetchFn, requested };
}

describe("fetchAddressActivity fails closed", () => {
  test("HTTP error status refuses", async () => {
    const dead: FetchLike = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await expect(
      fetchAddressActivity(ESPLORA, "bc1qexample", dead),
    ).rejects.toThrow(BtcWatchError);
  });

  test("a rejecting fetch propagates — nothing catches and continues", async () => {
    const boom = new Error("network down");
    const dead: FetchLike = async () => {
      throw boom;
    };
    await expect(fetchAddressActivity(ESPLORA, "bc1qexample", dead)).rejects.toThrow(
      boom,
    );
  });

  test("malformed bodies refuse", async () => {
    for (const body of [
      null,
      {},
      { address: "bc1qexample" },
      { address: "bc1qexample", chain_stats: { funded_txo_sum: "10" } },
    ]) {
      const bad: FetchLike = async () => ({
        ok: true,
        status: 200,
        json: async () => body,
      });
      await expect(
        fetchAddressActivity(ESPLORA, "bc1qexample", bad),
      ).rejects.toThrow(BtcWatchError);
    }
  });

  test("a response for a different address refuses", async () => {
    const wrong: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => emptyDoc("bc1qsomeoneelse"),
    });
    await expect(
      fetchAddressActivity(ESPLORA, "bc1qexample", wrong),
    ).rejects.toThrow(/different address/);
  });

  test("spent exceeding funded refuses", async () => {
    const inconsistent: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...emptyDoc("bc1qexample"),
        chain_stats: { funded_txo_sum: 5, spent_txo_sum: 10, tx_count: 2 },
      }),
    });
    await expect(
      fetchAddressActivity(ESPLORA, "bc1qexample", inconsistent),
    ).rejects.toThrow(BtcWatchError);
  });

  test("unsafe integer values refuse", async () => {
    const huge: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...emptyDoc("bc1qexample"),
        chain_stats: {
          funded_txo_sum: 2 ** 60,
          spent_txo_sum: 0,
          tx_count: 1,
        },
      }),
    });
    await expect(fetchAddressActivity(ESPLORA, "bc1qexample", huge)).rejects.toThrow(
      BtcWatchError,
    );
  });
});

describe("fetchUtxos fails closed", () => {
  const goodUtxo = {
    txid: "ab".repeat(32),
    vout: 1,
    value: 50_000,
    status: { confirmed: true },
  };

  const jsonFetch =
    (body: unknown, ok = true, status = 200): FetchLike =>
    async () => ({ ok, status, json: async () => body });

  test("valid utxo lists parse", async () => {
    const utxos = await fetchUtxos(ESPLORA, "bc1qexample", jsonFetch([goodUtxo]));
    expect(utxos).toEqual([
      { txid: "ab".repeat(32), vout: 1, valueSats: 50_000, confirmed: true },
    ]);
  });

  test("HTTP errors, non-arrays, and malformed entries refuse", async () => {
    const bads: FetchLike[] = [
      jsonFetch([], false, 502),
      jsonFetch({}),
      jsonFetch([{ ...goodUtxo, txid: "zz" }]),
      jsonFetch([{ ...goodUtxo, vout: -1 }]),
      jsonFetch([{ ...goodUtxo, value: 2 ** 60 }]),
      jsonFetch([{ ...goodUtxo, value: 0 }]),
      jsonFetch([{ ...goodUtxo, status: {} }]),
    ];
    for (const bad of bads) {
      await expect(fetchUtxos(ESPLORA, "bc1qexample", bad)).rejects.toThrow(
        BtcWatchError,
      );
    }
  });
});

describe("broadcastTransaction fails closed", () => {
  test("posts the hex and returns the reported txid", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn: PostFetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      return { ok: true, status: 200, text: async () => "cd".repeat(32) };
    };
    const txid = await broadcastTransaction(ESPLORA, "deadbeef", fetchFn);
    expect(txid).toBe("cd".repeat(32));
    expect(calls).toEqual([{ url: `${ESPLORA}/tx`, body: "deadbeef" }]);
  });

  test("HTTP errors refuse with the endpoint's message", async () => {
    const fetchFn: PostFetchLike = async () => ({
      ok: false,
      status: 400,
      text: async () => "sendrawtransaction RPC error: min relay fee not met",
    });
    await expect(broadcastTransaction(ESPLORA, "deadbeef", fetchFn)).rejects.toThrow(
      /min relay fee/,
    );
  });

  test("a malformed txid response refuses — broadcast success must be provable", async () => {
    const fetchFn: PostFetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "ok",
    });
    await expect(broadcastTransaction(ESPLORA, "deadbeef", fetchFn)).rejects.toThrow(
      BtcWatchError,
    );
  });
});

describe("scanWatchOnlyBalance", () => {
  test("no activity scans exactly the gap limit on both chains and reports zero", async () => {
    const { fetchFn, requested } = mockEsplora({});
    const balance = await scanWatchOnlyBalance({
      esploraUrl: ESPLORA,
      xpub,
      network: "mainnet",
      fetchFn,
    });
    expect(balance.confirmedSats).toBe(0);
    expect(balance.pendingSats).toBe(0);
    expect(balance.usedAddresses).toEqual([]);
    expect(requested).toHaveLength(GAP_LIMIT * 2);
  });

  test("activity resets the gap and sums confirmed and pending across chains", async () => {
    const { fetchFn, requested } = mockEsplora({
      [receive(0)]: {
        chain_stats: { funded_txo_sum: 10_000, spent_txo_sum: 4_000, tx_count: 3 },
      },
      [receive(5)]: {
        chain_stats: { funded_txo_sum: 2_000, spent_txo_sum: 0, tx_count: 1 },
        mempool_stats: { funded_txo_sum: 500, spent_txo_sum: 0, tx_count: 1 },
      },
      [change(2)]: {
        chain_stats: { funded_txo_sum: 1_000, spent_txo_sum: 0, tx_count: 1 },
      },
    });
    const balance = await scanWatchOnlyBalance({
      esploraUrl: ESPLORA,
      xpub,
      network: "mainnet",
      fetchFn,
    });
    expect(balance.confirmedSats).toBe(6_000 + 2_000 + 1_000);
    expect(balance.pendingSats).toBe(500);
    expect(balance.usedAddresses).toEqual([receive(0), receive(5), change(2)]);
    // receive chain: used index 5 → scan reaches 5 + GAP_LIMIT + 1 addresses;
    // change chain: used index 2 → 2 + GAP_LIMIT + 1.
    expect(requested).toHaveLength(5 + GAP_LIMIT + 1 + (2 + GAP_LIMIT + 1));
  });

  test("passphrase-gated signing works through the boundary and refuses a wrong passphrase", () => {
    const utxoAddress = receive(0);
    const txid = "aa".repeat(32);
    const sign = (passphrase: string) =>
      sign_spend_js(
        BIP84_MNEMONIC,
        passphrase,
        "mainnet",
        txid,
        utxoAddress,
        new Uint32Array([0]),
        new BigUint64Array([100_000n]),
        new Uint32Array([0]),
        new Uint32Array([0]),
        receive(1),
        40_000n,
        1_000n,
        0,
      );
    const hex = sign("");
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(sign("")).toBe(hex);
    expect(() => sign("TREZOR")).toThrow(/wrong passphrase/);
  });

  test("one failing address aborts the whole scan — no partial balance", async () => {
    const failAt = receive(3);
    const fetchFn: FetchLike = async (url) => {
      const address = url.split("/").pop()!;
      if (address === failAt) {
        return { ok: false, status: 502, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          address === receive(0)
            ? {
                ...emptyDoc(address),
                chain_stats: {
                  funded_txo_sum: 10_000,
                  spent_txo_sum: 0,
                  tx_count: 1,
                },
              }
            : emptyDoc(address),
      };
    };
    await expect(
      scanWatchOnlyBalance({ esploraUrl: ESPLORA, xpub, network: "mainnet", fetchFn }),
    ).rejects.toThrow(BtcWatchError);
  });
});
