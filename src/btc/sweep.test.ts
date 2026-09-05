import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import init, { account_xpub_js, xpub_to_address_js } from "../../core/pkg/adversarial_core";
import {
  BtcWatchError,
  collectSpendableInputs,
  computeSweepAmount,
  DUST_SATS,
  type FetchLike,
} from "./index";

// Public BIP84 reference mnemonic — never real key material.
const BIP84_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ESPLORA = "https://esplora.test/api";
const TXID = (n: number) => n.toString(16).padStart(64, "0");

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

interface UtxoDoc { txid: string; vout: number; value: number; status: { confirmed: boolean } }

/** Esplora /utxo mock keyed by address; unknown addresses return []. */
function mockUtxos(byAddress: Record<string, UtxoDoc[]>, failFor?: string) {
  const requested: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    requested.push(url);
    const parts = url.split("/");
    const address = parts[parts.length - 2]!;
    if (address === failFor) return { ok: false, status: 500, json: async () => null };
    return { ok: true, status: 200, json: async () => byAddress[address] ?? [] };
  };
  return { fetchFn, requested };
}

describe("computeSweepAmount", () => {
  test("empty input set refuses", () => {
    expect(() => computeSweepAmount([], 500)).toThrow(BtcWatchError);
  });

  test("non-positive or non-integer fee refuses", () => {
    expect(() => computeSweepAmount([10_000n], 0)).toThrow(BtcWatchError);
    expect(() => computeSweepAmount([10_000n], -1)).toThrow(BtcWatchError);
    expect(() => computeSweepAmount([10_000n], 1.5)).toThrow(BtcWatchError);
  });

  test("remainder below dust refuses rather than producing an unspendable output", () => {
    expect(() => computeSweepAmount([1_000n], 1_000 - DUST_SATS + 1)).toThrow(/too small/);
  });

  test("remainder exactly at dust is allowed", () => {
    expect(computeSweepAmount([1_000n], 1_000 - DUST_SATS)).toBe(BigInt(DUST_SATS));
  });

  test("sums every input and subtracts the fee, leaving no change", () => {
    expect(computeSweepAmount([40_000n, 60_000n], 1_500)).toBe(98_500n);
  });
});

describe("collectSpendableInputs", () => {
  test("gathers only confirmed coins with local derivation coordinates", async () => {
    const r0 = receive(0);
    const c1 = change(1);
    const { fetchFn } = mockUtxos({
      [r0]: [
        { txid: TXID(1), vout: 0, value: 50_000, status: { confirmed: true } },
        { txid: TXID(2), vout: 1, value: 5_000, status: { confirmed: false } },
      ],
      [c1]: [{ txid: TXID(3), vout: 2, value: 7_000, status: { confirmed: true } }],
    });
    const inputs = await collectSpendableInputs(ESPLORA, xpub, "mainnet", [r0, c1], fetchFn);
    expect(inputs.txids).toEqual([TXID(1), TXID(3)]);
    expect(inputs.addresses).toEqual([r0, c1]);
    expect(inputs.vouts).toEqual([0, 2]);
    expect(inputs.values).toEqual([50_000n, 7_000n]);
    expect(inputs.chains).toEqual([0, 1]);
    expect(inputs.indexes).toEqual([0, 1]);
  });

  test("only used addresses are queried; unused ones are skipped without a request", async () => {
    const r0 = receive(0);
    const { fetchFn, requested } = mockUtxos({
      [r0]: [{ txid: TXID(1), vout: 0, value: 1_000, status: { confirmed: true } }],
    });
    await collectSpendableInputs(ESPLORA, xpub, "mainnet", [r0], fetchFn);
    expect(requested).toEqual([`${ESPLORA}/address/${r0}/utxo`]);
  });

  test("reaches a used address past a sparse gap (consecutive-gap semantics)", async () => {
    const r0 = receive(0);
    const r15 = receive(15);
    const { fetchFn } = mockUtxos({
      [r0]: [{ txid: TXID(1), vout: 0, value: 1_000, status: { confirmed: true } }],
      [r15]: [{ txid: TXID(2), vout: 0, value: 2_000, status: { confirmed: true } }],
    });
    const inputs = await collectSpendableInputs(ESPLORA, xpub, "mainnet", [r0, r15], fetchFn);
    expect(inputs.txids).toEqual([TXID(1), TXID(2)]);
    expect(inputs.indexes).toEqual([0, 15]);
  });

  test("an endpoint failure on any used address throws — no partial input set", async () => {
    const r0 = receive(0);
    const r1 = receive(1);
    const { fetchFn } = mockUtxos(
      { [r0]: [{ txid: TXID(1), vout: 0, value: 1_000, status: { confirmed: true } }] },
      r1,
    );
    await expect(
      collectSpendableInputs(ESPLORA, xpub, "mainnet", [r0, r1], fetchFn),
    ).rejects.toThrow(BtcWatchError);
  });

  test("no used addresses yields an empty set", async () => {
    const { fetchFn, requested } = mockUtxos({});
    const inputs = await collectSpendableInputs(ESPLORA, xpub, "mainnet", [], fetchFn);
    expect(inputs.txids).toEqual([]);
    expect(requested).toEqual([]);
  });
});
