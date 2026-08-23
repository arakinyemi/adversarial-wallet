import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import init, { round_trip } from "../core/pkg/adversarial_core";

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
