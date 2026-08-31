import { describe, expect, test } from "vitest";
import {
  assertSweptToZero,
  createInvoice,
  createWallet,
  fetchPaymentProof,
  getBalanceMsat,
  LightningError,
  payInvoice,
  type LnbitsConfig,
  type LnFetchLike,
} from "./index";

// Independent vectors computed with Python hashlib, not this code:
//   sha256(32 zero bytes) and sha256(32 x 0x11).
const PREIMAGE = "00".repeat(32);
const PAYMENT_HASH = "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925";
const WRONG_PREIMAGE = "11".repeat(32);

const API_KEY = "test-api-key-abc123";
const BASE = "https://lnbits.test";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function mockLnbits(responder: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchFn: LnFetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, fetchFn };
}

const config = (fetchFn: LnFetchLike): LnbitsConfig => ({
  baseUrl: BASE,
  apiKey: API_KEY,
  fetchFn,
});

describe("createInvoice", () => {
  test("posts the request with the api key header and returns the invoice", async () => {
    const { calls, fetchFn } = mockLnbits(() => ({
      body: { payment_hash: PAYMENT_HASH, bolt11: "lnbc10n1exampleinvoice" },
    }));
    const invoice = await createInvoice(config(fetchFn), 1000, "test memo");
    expect(invoice).toEqual({
      bolt11: "lnbc10n1exampleinvoice",
      paymentHash: PAYMENT_HASH,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/payments`);
    expect(calls[0]!.headers["X-Api-Key"]).toBe(API_KEY);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      out: false,
      amount: 1000,
      memo: "test memo",
    });
  });

  test("zero or negative amounts refuse before any network call", async () => {
    const { calls, fetchFn } = mockLnbits(() => ({ body: {} }));
    for (const amount of [0, -5, 1.5]) {
      await expect(createInvoice(config(fetchFn), amount, "x")).rejects.toThrow(
        LightningError,
      );
    }
    expect(calls).toHaveLength(0);
  });

  test("HTTP errors and malformed responses refuse", async () => {
    for (const responder of [
      () => ({ status: 401, body: { detail: "unauthorized" } }),
      () => ({ body: {} }),
      () => ({ body: { payment_hash: "zz", bolt11: "lnbc1x" } }),
      () => ({ body: { payment_hash: PAYMENT_HASH, bolt11: "" } }),
    ]) {
      const { fetchFn } = mockLnbits(responder as (c: Call) => { status?: number; body: unknown });
      await expect(createInvoice(config(fetchFn), 1000, "x")).rejects.toThrow(
        LightningError,
      );
    }
  });

  test("error messages never contain the api key", async () => {
    const { fetchFn } = mockLnbits(() => ({ status: 500, body: { detail: "boom" } }));
    const failure = await createInvoice(config(fetchFn), 1000, "x").catch((e: Error) => e);
    expect(failure).toBeInstanceOf(LightningError);
    expect((failure as Error).message).not.toContain(API_KEY);
  });
});

describe("payInvoice", () => {
  test("posts the bolt11 and returns the payment hash", async () => {
    const { calls, fetchFn } = mockLnbits(() => ({
      body: { payment_hash: PAYMENT_HASH },
    }));
    const result = await payInvoice(config(fetchFn), "lnbc10n1exampleinvoice");
    expect(result.paymentHash).toBe(PAYMENT_HASH);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      out: true,
      bolt11: "lnbc10n1exampleinvoice",
    });
  });

  test("an empty bolt11 refuses before any network call", async () => {
    const { calls, fetchFn } = mockLnbits(() => ({ body: {} }));
    await expect(payInvoice(config(fetchFn), "")).rejects.toThrow(LightningError);
    expect(calls).toHaveLength(0);
  });
});

describe("fetchPaymentProof verifies, never trusts", () => {
  test("a settled payment with a valid preimage returns the proof", async () => {
    const { fetchFn } = mockLnbits(() => ({
      body: { paid: true, preimage: PREIMAGE },
    }));
    const proof = await fetchPaymentProof(config(fetchFn), PAYMENT_HASH);
    expect(proof).toEqual({ paymentHash: PAYMENT_HASH, preimage: PREIMAGE });
  });

  test("an unsettled payment returns null", async () => {
    const { fetchFn } = mockLnbits(() => ({ body: { paid: false } }));
    expect(await fetchPaymentProof(config(fetchFn), PAYMENT_HASH)).toBeNull();
  });

  test("a settled claim whose preimage does not hash to the payment hash refuses", async () => {
    const { fetchFn } = mockLnbits(() => ({
      body: { paid: true, preimage: WRONG_PREIMAGE },
    }));
    await expect(fetchPaymentProof(config(fetchFn), PAYMENT_HASH)).rejects.toThrow(
      /preimage/,
    );
  });

  test("a settled claim with no preimage refuses", async () => {
    const { fetchFn } = mockLnbits(() => ({ body: { paid: true } }));
    await expect(fetchPaymentProof(config(fetchFn), PAYMENT_HASH)).rejects.toThrow(
      LightningError,
    );
  });
});

describe("balance and the sweep gate", () => {
  test("returns the wallet balance in msat", async () => {
    const { calls, fetchFn } = mockLnbits(() => ({ body: { balance: 21_000 } }));
    expect(await getBalanceMsat(config(fetchFn))).toBe(21_000);
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/wallet`);
    expect(calls[0]!.method).toBe("GET");
  });

  test("malformed balances refuse", async () => {
    for (const body of [{}, { balance: "100" }, { balance: 2 ** 60 }]) {
      const { fetchFn } = mockLnbits(() => ({ body }));
      await expect(getBalanceMsat(config(fetchFn))).rejects.toThrow(LightningError);
    }
  });

  test("assertSweptToZero passes on exactly zero and refuses otherwise", async () => {
    const zero = mockLnbits(() => ({ body: { balance: 0 } }));
    await expect(assertSweptToZero(config(zero.fetchFn))).resolves.toBeUndefined();
    const nonzero = mockLnbits(() => ({ body: { balance: 1 } }));
    await expect(assertSweptToZero(config(nonzero.fetchFn))).rejects.toThrow(
      /not zero/,
    );
  });
});

describe("createWallet (self-provisioning)", () => {
  const KEYS = { adminkey: "a1".repeat(16), inkey: "b2".repeat(16) };

  test("provisions against the account endpoint and returns both keys", async () => {
    const { calls, fetchFn } = mockLnbits(() => ({ body: { id: "w1", name: "aegis", ...KEYS } }));
    const wallet = await createWallet(BASE, fetchFn);
    expect(wallet).toEqual({ adminKey: KEYS.adminkey, invoiceKey: KEYS.inkey });
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/account`);
    expect(calls[0]!.method).toBe("POST");
  });

  test("accepts the nested wallets shape from newer LNbits", async () => {
    const { fetchFn } = mockLnbits(() => ({ body: { id: "u1", wallets: [{ ...KEYS }] } }));
    const wallet = await createWallet(BASE, fetchFn);
    expect(wallet.adminKey).toBe(KEYS.adminkey);
  });

  test("HTTP errors and responses missing either key refuse", async () => {
    for (const responder of [
      () => ({ status: 403, body: { detail: "new accounts disabled" } }),
      () => ({ body: {} }),
      () => ({ body: { adminkey: KEYS.adminkey } }),
      () => ({ body: { wallets: [] } }),
    ]) {
      const { fetchFn } = mockLnbits(responder as (c: Call) => { status?: number; body: unknown });
      await expect(createWallet(BASE, fetchFn)).rejects.toThrow(LightningError);
    }
  });

  test("an empty base url refuses before any network call", async () => {
    const { calls, fetchFn } = mockLnbits(() => ({ body: {} }));
    await expect(createWallet("", fetchFn)).rejects.toThrow(LightningError);
    expect(calls).toHaveLength(0);
  });
});

describe("config validation", () => {
  test("missing base url or api key refuses before any network call", async () => {
    const { calls, fetchFn } = mockLnbits(() => ({ body: {} }));
    await expect(
      getBalanceMsat({ baseUrl: "", apiKey: API_KEY, fetchFn }),
    ).rejects.toThrow(LightningError);
    await expect(
      getBalanceMsat({ baseUrl: BASE, apiKey: "", fetchFn }),
    ).rejects.toThrow(LightningError);
    expect(calls).toHaveLength(0);
  });
});
