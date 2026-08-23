import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { combine_entropy_js } from "../../core/pkg/adversarial_core";
import {
  drawPlatformEntropy,
  EntropyError,
  generateSeedEntropy,
  initEntropyCore,
  MIN_DICE_ROLLS,
  PLATFORM_ENTROPY_BYTES,
  type PlatformCrypto,
} from "./index";

// Exactly 50 valid rolls.
const FIFTY_ROLLS = "12345612345612345612345612345612345612345612345612";

// Independent vector, computed with Python hashlib (see core/src/entropy.rs):
// platform = 0x00..0x1f, expected = platform XOR sha256(FIFTY_ROLLS as UTF-8).
const VECTOR_EXPECTED_HEX =
  "ee73ac925e4b68a0c4b7b2eee9e3c0fd8a0c1f83e4460e203ebd3eadcfad6d3a";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

beforeAll(async () => {
  await initEntropyCore({
    module_or_path: readFileSync(
      new URL("../../core/pkg/adversarial_core_bg.wasm", import.meta.url),
    ),
  });
});

describe("platform source fails closed", () => {
  test("missing crypto object refuses", () => {
    vi.stubGlobal("crypto", undefined);
    try {
      expect(() => drawPlatformEntropy()).toThrow(EntropyError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("crypto object without getRandomValues refuses", () => {
    expect(() =>
      drawPlatformEntropy({} as PlatformCrypto),
    ).toThrow(EntropyError);
  });

  test("short fill refuses", () => {
    const short: PlatformCrypto = {
      getRandomValues: (buf) => buf.subarray(0, 16),
    };
    expect(() => drawPlatformEntropy(short)).toThrow(EntropyError);
  });

  test("a throwing source propagates — nothing catches and continues", () => {
    const boom = new Error("hardware RNG fault");
    const throwing: PlatformCrypto = {
      getRandomValues: () => {
        throw boom;
      },
    };
    expect(() => drawPlatformEntropy(throwing)).toThrow(boom);
  });

  test("all-zero output fails the health check", () => {
    const dead: PlatformCrypto = { getRandomValues: (buf) => buf };
    expect(() => drawPlatformEntropy(dead)).toThrow(EntropyError);
  });

  test("all-identical output fails the health check", () => {
    const stuck: PlatformCrypto = {
      getRandomValues: (buf) => (buf.fill(0x42), buf),
    };
    expect(() => drawPlatformEntropy(stuck)).toThrow(EntropyError);
  });

  test("real source: draw is 32 bytes", () => {
    expect(drawPlatformEntropy().byteLength).toBe(PLATFORM_ENTROPY_BYTES);
  });

  test("real source: two consecutive draws differ", () => {
    expect(toHex(drawPlatformEntropy())).not.toBe(toHex(drawPlatformEntropy()));
  });
});

describe("dice source fails closed (via the Rust core)", () => {
  test("49 rolls refuse, no entropy produced", () => {
    expect(() => generateSeedEntropy(FIFTY_ROLLS.slice(0, 49))).toThrow(
      /dice rolls/,
    );
  });

  test("empty dice string refuses", () => {
    expect(() => generateSeedEntropy("")).toThrow(/dice rolls/);
  });

  test("invalid characters refuse", () => {
    for (const bad of ["0", "7", "a", " "]) {
      expect(() =>
        generateSeedEntropy(FIFTY_ROLLS.slice(0, 49) + bad),
      ).toThrow(/1-6/);
    }
  });
});

describe("combined flow", () => {
  test("a stuck platform source aborts the whole flow — dice alone are not enough", () => {
    const stuck: PlatformCrypto = {
      getRandomValues: (buf) => (buf.fill(0x42), buf),
    };
    expect(() => generateSeedEntropy(FIFTY_ROLLS, stuck)).toThrow(EntropyError);
  });

  test("two identical consecutive draws abort the flow", () => {
    // Passes the per-draw health checks (bytes vary within the draw) but
    // returns the same output every call.
    const replay: PlatformCrypto = {
      getRandomValues: (buf) => {
        for (let i = 0; i < buf.length; i++) buf[i] = i;
        return buf;
      },
    };
    expect(() => generateSeedEntropy(FIFTY_ROLLS, replay)).toThrow(
      EntropyError,
    );
  });

  test("50 rolls with a healthy platform source produces 32 bytes and a two-source report", () => {
    const { entropy, report } = generateSeedEntropy(FIFTY_ROLLS);
    expect(entropy.byteLength).toBe(PLATFORM_ENTROPY_BYTES);
    expect(report.sources).toHaveLength(2);
    for (const source of report.sources) {
      expect(source.bytes).toBe(PLATFORM_ENTROPY_BYTES);
    }
    const dice = report.sources.find((s) => s.rolls !== undefined);
    expect(dice?.rolls).toBe(MIN_DICE_ROLLS);
  });

  test("two full runs produce different entropy", () => {
    const a = generateSeedEntropy(FIFTY_ROLLS);
    const b = generateSeedEntropy(FIFTY_ROLLS);
    expect(toHex(a.entropy)).not.toBe(toHex(b.entropy));
  });

  test("the boundary carries the known vector exactly", () => {
    const platform = Uint8Array.from({ length: 32 }, (_, i) => i);
    const out = combine_entropy_js(platform, FIFTY_ROLLS);
    expect(toHex(out)).toBe(VECTOR_EXPECTED_HEX);
  });
});
