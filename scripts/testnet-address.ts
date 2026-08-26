// Prints a throwaway TESTNET Bitcoin address to send to when testing the
// send flow. Watch-only output — it prints the address and account xpub, not
// a seed. Send to the address from the app, then confirm arrival on
// https://mempool.space/testnet/address/<address>.
//
//   node scripts/testnet-address.ts
//
// Testnet only. These coins have no value; do not reuse anything here for
// real funds.

import { readFileSync } from "node:fs";
import init, {
  account_xpub_js,
  entropy_to_mnemonic_js,
  xpub_to_address_js,
} from "../core/pkg/adversarial_core.js";

await init({
  module_or_path: readFileSync(
    new URL("../core/pkg/adversarial_core_bg.wasm", import.meta.url),
  ),
});

// Throwaway entropy from the platform CSPRNG (Node WebCrypto).
const entropy = new Uint8Array(32);
globalThis.crypto.getRandomValues(entropy);

const mnemonic = entropy_to_mnemonic_js(entropy);
const xpub = account_xpub_js(mnemonic, "", "testnet");

console.log("Throwaway testnet destination (watch-only):");
for (let i = 0; i < 3; i++) {
  console.log(`  address ${i}: ${xpub_to_address_js(xpub, "testnet", 0, i)}`);
}
console.log(`  account xpub: ${xpub}`);
console.log("Watch it at https://mempool.space/testnet/address/<address>");
