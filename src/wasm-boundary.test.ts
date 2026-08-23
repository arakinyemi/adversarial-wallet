import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import init, {
  derive_address_js,
  entropy_to_mnemonic_js,
  round_trip,
} from "../core/pkg/adversarial_core";

// In the browser the module is fetched by URL; under Vitest (node) we hand
// the raw bytes to the same init function. Same glue code, same module.
const wasmBytes = readFileSync(
  new URL("../core/pkg/adversarial_core_bg.wasm", import.meta.url),
);

test("TypeScript can call into the Rust WASM core and get a value back", async () => {
  await init({ module_or_path: wasmBytes });
  expect(round_trip("boundary")).toBe("yradnuob");
  expect(round_trip("")).toBe("");
});

// Public BIP39/BIP84 reference vectors only — never real key material.
const BIP84_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("the boundary carries BIP39 mnemonic generation (zero-entropy vector)", async () => {
  await init({ module_or_path: wasmBytes });
  const words = entropy_to_mnemonic_js(new Uint8Array(32));
  expect(words.split(" ")).toHaveLength(24);
  expect(words.endsWith("abandon art")).toBe(true);
  expect(() => entropy_to_mnemonic_js(new Uint8Array(16))).toThrow(/32 bytes/);
});

test("the boundary carries BIP84 derivation and the passphrase changes the address", async () => {
  await init({ module_or_path: wasmBytes });
  const without = derive_address_js(BIP84_MNEMONIC, "", "mainnet", 0);
  expect(without).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  const withPass = derive_address_js(BIP84_MNEMONIC, "TREZOR", "mainnet", 0);
  expect(withPass).not.toBe(without);
  expect(() => derive_address_js("not a mnemonic", "", "mainnet", 0)).toThrow(
    /invalid mnemonic/,
  );
});
