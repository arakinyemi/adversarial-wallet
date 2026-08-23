// Two-source seed entropy: crypto.getRandomValues XOR SHA-256(dice rolls).
// The draw happens here because getRandomValues is a platform API; validation
// and combining happen in the Rust core, which re-checks everything and does
// not trust this layer. See PLAN.md §3.
//
// Fail-closed contract: every function in this module either returns healthy
// output or throws. There is no fallback source, no default value, and no
// catch anywhere in this file — failures propagate to the caller, who must
// surface them. The only try blocks are try/finally that zero buffers.

import init, { combine_entropy_js } from "../../core/pkg/adversarial_core";

export const PLATFORM_ENTROPY_BYTES = 32;
export const MIN_DICE_ROLLS = 50;

/** Inputs that must never be used as entropy. Mirrors REJECTED_SOURCES in the
 * Rust core: an attacker can enumerate every one of these. */
export const REJECTED_SOURCES: readonly string[] = [
  "device identifiers (serial, IMEI, Android ID)",
  "timestamps or clock registers",
  "boot time or uptime",
  "process or thread IDs",
  "MAC or IP addresses",
  "Math.random or any non-CSPRNG generator",
];

export class EntropyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntropyError";
  }
}

/** The single platform API surface this module consumes, injectable in tests. */
export interface PlatformCrypto {
  getRandomValues(buffer: Uint8Array): Uint8Array;
}

export interface EntropySourceReport {
  name: string;
  bytes: number;
  rolls?: number;
}

export interface SeedEntropyResult {
  entropy: Uint8Array;
  report: { sources: EntropySourceReport[] };
}

let coreReady = false;

/** Initialise the WASM core. Must complete before generateSeedEntropy. */
export async function initEntropyCore(input: {
  module_or_path: string | URL | Uint8Array;
}): Promise<void> {
  await init(input);
  coreReady = true;
}

/** Draw 32 health-checked bytes from the platform CSPRNG. Throws on a
 * missing API, short fill, or degenerate output. */
export function drawPlatformEntropy(
  cryptoObj: PlatformCrypto | undefined = globalThis.crypto,
): Uint8Array {
  if (cryptoObj === undefined || typeof cryptoObj.getRandomValues !== "function") {
    throw new EntropyError("platform CSPRNG (crypto.getRandomValues) is unavailable");
  }
  const filled = cryptoObj.getRandomValues(new Uint8Array(PLATFORM_ENTROPY_BYTES));
  if (!(filled instanceof Uint8Array) || filled.byteLength !== PLATFORM_ENTROPY_BYTES) {
    throw new EntropyError(
      `platform CSPRNG returned ${filled instanceof Uint8Array ? filled.byteLength : 0} bytes, expected ${PLATFORM_ENTROPY_BYTES}`,
    );
  }
  if (filled.every((b) => b === filled[0])) {
    throw new EntropyError("platform CSPRNG failed health check: all bytes identical");
  }
  return filled;
}

/** Full two-source flow. Returns entropy only if BOTH sources are healthy;
 * any failure in either source throws with nothing produced. */
export function generateSeedEntropy(
  diceRolls: string,
  cryptoObj: PlatformCrypto | undefined = globalThis.crypto,
): SeedEntropyResult {
  if (!coreReady) {
    throw new EntropyError("entropy core is not initialised");
  }

  // Two consecutive draws must differ — a source that replays output is dead
  // even when each individual draw looks healthy.
  const first = drawPlatformEntropy(cryptoObj);
  const second = drawPlatformEntropy(cryptoObj);
  const replayed = first.every((b, i) => b === second[i]);
  first.fill(0);
  if (replayed) {
    second.fill(0);
    throw new EntropyError(
      "platform CSPRNG failed health check: consecutive draws identical",
    );
  }

  try {
    // The Rust core re-validates the platform bytes and the dice rolls and
    // rejects either with a hard error; see core/src/entropy.rs.
    const entropy = combine_entropy_js(second, diceRolls);
    return {
      entropy,
      report: {
        sources: [
          { name: "crypto.getRandomValues", bytes: PLATFORM_ENTROPY_BYTES },
          {
            name: "user dice rolls via SHA-256",
            bytes: PLATFORM_ENTROPY_BYTES,
            rolls: diceRolls.length,
          },
        ],
      },
    };
  } finally {
    // Best-effort residue reduction; JS cannot guarantee erasure. LIMITATIONS.md.
    second.fill(0);
  }
}
