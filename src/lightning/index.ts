// Lightning through an LNbits instance we control. See PLAN.md §6.
//
// This is the named weak point of the wallet: the LNbits admin key is an
// app-resident secret that CAN move Lightning funds. The mitigation is
// operational, not cryptographic — the wallet is swept to zero before the
// attack window, so the hot component holds nothing. assertSweptToZero is
// the checklist gate for that.
//
// Payment proof is verified, not trusted: a payment counts as settled only
// when the API's preimage actually SHA-256-hashes to the payment hash. An
// API that says "paid" without a valid preimage is refused.
//
// Fail-closed contract: HTTP failures, malformed responses, and proof
// mismatches throw. The API key is passed per call by the caller (which
// unseals it from encrypted storage) and never appears in error messages.

export class LightningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LightningError";
  }
}

/** The subset of fetch this module consumes, injectable in tests. */
export type LnFetchLike = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface LnbitsConfig {
  baseUrl: string;
  /** Invoice key for receiving/reading; admin key for paying. */
  apiKey: string;
  fetchFn?: LnFetchLike;
}

export interface CreatedInvoice {
  bolt11: string;
  paymentHash: string;
}

export interface PaymentProof {
  paymentHash: string;
  preimage: string;
}

const HASH_RE = /^[0-9a-f]{64}$/;

function requireConfig(config: LnbitsConfig): void {
  if (config.baseUrl === "" || config.apiKey === "") {
    throw new LightningError("lnbits base url and api key are required");
  }
}

async function request(
  config: LnbitsConfig,
  method: "GET" | "POST",
  path: string,
  body?: object,
): Promise<unknown> {
  requireConfig(config);
  const fetchFn =
    config.fetchFn ??
    ((url: string, init: Parameters<LnFetchLike>[1]) => globalThis.fetch(url, init));
  const response = await fetchFn(`${config.baseUrl}${path}`, {
    method,
    headers: {
      "X-Api-Key": config.apiKey,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      parsed !== null && typeof parsed === "object" && "detail" in parsed
        ? String((parsed as { detail: unknown }).detail)
        : "";
    // Never include the api key or request headers here.
    throw new LightningError(
      `lnbits returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return parsed;
}

function requirePaymentHash(value: unknown): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new LightningError("lnbits response has a malformed payment hash");
  }
  return value;
}

/** Create an invoice to receive amountSats. */
export async function createInvoice(
  config: LnbitsConfig,
  amountSats: number,
  memo: string,
): Promise<CreatedInvoice> {
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new LightningError("invoice amount must be a positive whole number of sats");
  }
  const body = (await request(config, "POST", "/api/v1/payments", {
    out: false,
    amount: amountSats,
    memo,
  })) as { payment_hash?: unknown; bolt11?: unknown; payment_request?: unknown } | null;
  const paymentHash = requirePaymentHash(body?.payment_hash);
  const bolt11 = body?.bolt11 ?? body?.payment_request;
  if (typeof bolt11 !== "string" || !bolt11.toLowerCase().startsWith("ln")) {
    throw new LightningError("lnbits response has a malformed invoice");
  }
  return { bolt11, paymentHash };
}

/** Pay a bolt11 invoice (requires the admin key). Returns the payment hash;
 * settlement proof comes from fetchPaymentProof. */
export async function payInvoice(
  config: LnbitsConfig,
  bolt11: string,
): Promise<{ paymentHash: string }> {
  if (bolt11 === "") {
    throw new LightningError("bolt11 invoice is required");
  }
  const body = (await request(config, "POST", "/api/v1/payments", {
    out: true,
    bolt11,
  })) as { payment_hash?: unknown } | null;
  return { paymentHash: requirePaymentHash(body?.payment_hash) };
}

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Fetch a payment's status; if the API reports it settled, verify the
 * preimage against the payment hash and return the proof. An unsettled
 * payment returns null. A settled claim with a bad preimage throws. */
export async function fetchPaymentProof(
  config: LnbitsConfig,
  paymentHash: string,
): Promise<PaymentProof | null> {
  const expectedHash = requirePaymentHash(paymentHash);
  const body = (await request(
    config,
    "GET",
    `/api/v1/payments/${expectedHash}`,
  )) as { paid?: unknown; preimage?: unknown } | null;
  if (typeof body?.paid !== "boolean") {
    throw new LightningError("lnbits payment status response is malformed");
  }
  if (!body.paid) {
    return null;
  }
  const preimage = body.preimage;
  if (typeof preimage !== "string" || !HASH_RE.test(preimage)) {
    throw new LightningError(
      "lnbits reports the payment settled but supplied no valid preimage",
    );
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", hexToBytes(preimage)),
  );
  if (bytesToHex(digest) !== expectedHash) {
    throw new LightningError(
      "preimage does not hash to the payment hash; refusing to record this as proof",
    );
  }
  return { paymentHash: expectedHash, preimage };
}

/** Wallet balance in millisats. */
export async function getBalanceMsat(config: LnbitsConfig): Promise<number> {
  const body = (await request(config, "GET", "/api/v1/wallet")) as {
    balance?: unknown;
  } | null;
  const balance = body?.balance;
  if (typeof balance !== "number" || !Number.isSafeInteger(balance) || balance < 0) {
    throw new LightningError("lnbits wallet response has a malformed balance");
  }
  return balance;
}

/** Pre-handover checklist gate: throws unless the balance is exactly zero. */
export async function assertSweptToZero(config: LnbitsConfig): Promise<void> {
  const balance = await getBalanceMsat(config);
  if (balance !== 0) {
    throw new LightningError(`lightning balance is not zero: ${balance} msat remain`);
  }
}
