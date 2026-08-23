// Lightning proof run against the developer's LNbits instance. Run by the
// developer, never CI. Two modes:
//
// Receive proof (external wallet pays the printed invoice):
//   LNBITS_URL=https://... LNBITS_INVOICE_KEY=... AMOUNT_SATS=100 \
//   MODE=receive node scripts/lightning-proof.ts
//
// Send proof (pays BOLT11 from this wallet, verifies the preimage):
//   LNBITS_URL=https://... LNBITS_ADMIN_KEY=... BOLT11=lnbc... \
//   MODE=send node scripts/lightning-proof.ts
//
// Sweep gate (must pass before handover):
//   LNBITS_URL=https://... LNBITS_INVOICE_KEY=... \
//   MODE=sweep-check node scripts/lightning-proof.ts
//
// Every settled payment is proven by sha256(preimage) == payment_hash,
// verified locally — record the printed proofs for the handover package.

import {
  assertSweptToZero,
  createInvoice,
  fetchPaymentProof,
  getBalanceMsat,
  payInvoice,
} from "../src/lightning/index.ts";

declare const process: {
  env: Record<string, string | undefined>;
  exit(code: number): never;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const mode = requireEnv("MODE");
const baseUrl = requireEnv("LNBITS_URL");

if (mode === "receive") {
  const config = { baseUrl, apiKey: requireEnv("LNBITS_INVOICE_KEY") };
  const amount = Number(requireEnv("AMOUNT_SATS"));
  const invoice = await createInvoice(config, amount, "receive proof");
  console.log(`invoice (${amount} sats):\n${invoice.bolt11}`);
  console.log(`payment hash: ${invoice.paymentHash}`);
  console.log("pay this from an external wallet, then watch for settlement...");
  for (;;) {
    const proof = await fetchPaymentProof(config, invoice.paymentHash);
    if (proof !== null) {
      console.log("RECEIVE PROOF (verified sha256(preimage) == payment_hash):");
      console.log(`  payment_hash: ${proof.paymentHash}`);
      console.log(`  preimage:     ${proof.preimage}`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
} else if (mode === "send") {
  const config = { baseUrl, apiKey: requireEnv("LNBITS_ADMIN_KEY") };
  const { paymentHash } = await payInvoice(config, requireEnv("BOLT11"));
  console.log(`payment sent, hash: ${paymentHash}`);
  for (;;) {
    const proof = await fetchPaymentProof(config, paymentHash);
    if (proof !== null) {
      console.log("SEND PROOF (verified sha256(preimage) == payment_hash):");
      console.log(`  payment_hash: ${proof.paymentHash}`);
      console.log(`  preimage:     ${proof.preimage}`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
} else if (mode === "sweep-check") {
  const config = { baseUrl, apiKey: requireEnv("LNBITS_INVOICE_KEY") };
  const balance = await getBalanceMsat(config);
  console.log(`balance: ${balance} msat`);
  await assertSweptToZero(config);
  console.log("SWEEP GATE PASSED: balance is exactly zero");
} else {
  console.error(`MODE must be receive, send, or sweep-check; got "${mode}"`);
  process.exit(1);
}
