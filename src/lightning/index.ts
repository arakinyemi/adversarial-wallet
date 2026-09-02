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
    throw new LightningError("Lightning is not set up yet.");
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
    ((url: string, init: Parameters<LnFetchLike>[1]) =>
      // Hard timeout: a stalled connection must surface as an error.
      globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }));
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
      `The Lightning service returned an error${detail ? `: ${detail}` : ` (HTTP ${response.status})`}.`,
    );
  }
  return parsed;
}

function requirePaymentHash(value: unknown): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new LightningError("The Lightning service sent an invalid payment reference.");
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
    throw new LightningError("The Lightning service sent an invalid invoice.");
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
    throw new LightningError("The Lightning service sent an unreadable payment status.");
  }
  if (!body.paid) {
    return null;
  }
  const preimage = body.preimage;
  if (typeof preimage !== "string" || !HASH_RE.test(preimage)) {
    throw new LightningError(
      "The payment shows as settled but its preimage receipt is missing.",
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

export interface ProvisionedWallet {
  adminKey: string;
  invoiceKey: string;
}

/** Create a fresh wallet on the operator's LNbits server (its open account
 * endpoint; no credentials required when the server allows new accounts).
 * Both keys must come back or the provisioning refuses — a wallet that can
 * receive but never pay is not a wallet. */
export async function createWallet(
  baseUrl: string,
  fetchFn: LnFetchLike = (url, init) =>
    globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }),
): Promise<ProvisionedWallet> {
  if (baseUrl === "") {
    throw new LightningError("Lightning is not available in this build.");
  }
  const response = await fetchFn(`${baseUrl}/api/v1/account`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "aegis" }),
  });
  const parsed = (await response.json().catch(() => null)) as {
    adminkey?: unknown;
    inkey?: unknown;
    wallets?: { adminkey?: unknown; inkey?: unknown }[];
    detail?: unknown;
  } | null;
  if (!response.ok) {
    const detail = typeof parsed?.detail === "string" ? `: ${parsed.detail}` : "";
    throw new LightningError(`lnbits returned HTTP ${response.status}${detail}`);
  }
  // Older LNbits returns keys top-level; newer nests them under wallets[].
  const source = Array.isArray(parsed?.wallets) ? parsed?.wallets[0] : parsed;
  const adminKey = source?.adminkey;
  const invoiceKey = source?.inkey;
  if (typeof adminKey !== "string" || adminKey === "" || typeof invoiceKey !== "string" || invoiceKey === "") {
    throw new LightningError("The Lightning service could not create a wallet.");
  }
  return { adminKey, invoiceKey };
}

/** Wallet balance in millisats. */
export async function getBalanceMsat(config: LnbitsConfig): Promise<number> {
  const body = (await request(config, "GET", "/api/v1/wallet")) as {
    balance?: unknown;
  } | null;
  const balance = body?.balance;
  if (typeof balance !== "number" || !Number.isSafeInteger(balance) || balance < 0) {
    throw new LightningError("The Lightning service sent an unreadable balance.");
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

export interface LnPayment {
  /** Millisats; negative for outgoing payments. */
  amountMsat: number;
  memo: string;
  time: number;
  pending: boolean;
}

/** Payment history for the wallet (invoice key suffices). */
export async function listPayments(config: LnbitsConfig): Promise<LnPayment[]> {
  const body = await request(config, "GET", "/api/v1/payments");
  if (!Array.isArray(body)) {
    throw new LightningError("The Lightning service sent an unreadable payment list.");
  }
  return body.map((entry): LnPayment => {
    const p = entry as { amount?: unknown; memo?: unknown; time?: unknown; pending?: unknown } | null;
    if (
      p === null ||
      typeof p.amount !== "number" ||
      !Number.isSafeInteger(p.amount) ||
      typeof p.time !== "number" ||
      typeof p.pending !== "boolean"
    ) {
      throw new LightningError("The Lightning service sent a malformed payment entry.");
    }
    return {
      amountMsat: p.amount,
      memo: typeof p.memo === "string" ? p.memo : "",
      time: p.time,
      pending: p.pending,
    };
  });
}
