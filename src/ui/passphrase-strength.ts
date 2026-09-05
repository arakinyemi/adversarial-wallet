// Passphrase strength policy for wallet CREATION.
//
// Threat model this defends against: the Bitcoin component's security reduces
// to the passphrase's entropy the moment the seed is obtained (device loss,
// or any future scope that includes the device), because the watch-only xpub
// stored on the device is a perfect offline oracle — an attacker can test a
// guessed passphrase by deriving its account xpub and comparing, with no rate
// limit and no chain interaction. A weak passphrase therefore defeats the
// whole component. This module refuses to let a new wallet be created with a
// passphrase that would fall to an offline dictionary or short brute force.
//
// Deliberately dependency-free: a strength estimator like zxcvbn would be a
// new dependency (banned without justification) and a large one. The estimate
// here is a CONSERVATIVE floor, not a guarantee — see the limitations note at
// the bottom. It is applied ONLY on the create path; restoring an existing
// wallet must never be blocked by it, or a user could be locked out of funds
// secured with a passphrase set before this policy existed.

/** Minimum passphrase length. Below this, offline brute force is cheap
 * regardless of character mix. */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Minimum estimated entropy (bits) required to create a wallet. A 12-char
 * mixed-case-plus-digit passphrase clears this; a 12-char single-case word
 * does not, nudging the user toward more length or more variety. */
export const MIN_PASSPHRASE_BITS = 60;

/** Common passwords, crypto-themed guesses, and this wallet's own words. An
 * attacker's first list. Compared case-insensitively, and also against the
 * passphrase with trailing digits/symbols stripped (so "bitcoin123" is caught
 * by "bitcoin"). Not exhaustive — the length and entropy floors carry the
 * rest — but it rejects the guesses that a pure entropy estimate overrates. */
const BLOCKLIST: readonly string[] = [
  // Top leaked passwords
  "password", "passphrase", "123456", "12345678", "123456789", "1234567890",
  "qwerty", "qwertyuiop", "abc123", "111111", "000000", "iloveyou", "admin",
  "welcome", "monkey", "dragon", "letmein", "login", "princess", "solo",
  "starwars", "football", "baseball", "superman", "batman", "trustno1",
  "sunshine", "master", "shadow", "michael", "jennifer", "computer", "whatever",
  "changeme", "secret", "test", "test1234", "asdfghjkl", "zxcvbnm", "1q2w3e4r",
  "qazwsx", "password1", "password123", "hello", "hunter2", "freedom",
  // xkcd / famous example passphrases
  "correcthorsebatterystaple", "correct horse battery staple",
  // Crypto / wallet themed
  "bitcoin", "satoshi", "satoshinakamoto", "hodl", "blockchain", "ethereum",
  "wallet", "seedphrase", "recovery", "notyourkeys", "tothemoon", "cryptography",
  "privatekey", "coldstorage", "hardwarewallet", "mnemonic", "twentyfifthword",
  "25thword", "moneymoney", "getrich",
  // This app's own identifiers
  "aegis", "adversarial", "adversarialwallet", "shield",
];

const BLOCKSET = new Set(BLOCKLIST.map((s) => s.toLowerCase()));

export type PassphraseLabel = "empty" | "too short" | "weak" | "fair" | "good" | "strong";

export interface PassphraseAssessment {
  /** True only if the passphrase may be used to CREATE a wallet. */
  acceptable: boolean;
  /** 0–4, for a strength meter. */
  score: 0 | 1 | 2 | 3 | 4;
  label: PassphraseLabel;
  /** Why it is not acceptable, phrased for the user; null when acceptable. */
  reason: string | null;
  /** Conservative entropy estimate in bits (for display/testing). */
  bits: number;
}

/** Size of the character pool the passphrase draws from, by classes present.
 * Symbols and any non-ASCII each widen the pool. This is the standard (and
 * generous) pool model; the degenerate-pattern cap below stops it from
 * over-rating repeats and sequences. */
function poolSize(passphrase: string): number {
  let pool = 0;
  if (/[a-z]/.test(passphrase)) pool += 26;
  if (/[A-Z]/.test(passphrase)) pool += 26;
  if (/[0-9]/.test(passphrase)) pool += 10;
  if (/ /.test(passphrase)) pool += 1;
  // Any printable ASCII symbol.
  if (/[!-/:-@[-`{-~]/.test(passphrase)) pool += 32;
  // Anything outside ASCII (accents, emoji, other scripts) widens it further.
  if ([...passphrase].some((c) => (c.codePointAt(0) ?? 0) > 0x7f)) pool += 64;
  return pool;
}

/** How many DISTINCT characters the passphrase uses. */
function distinctChars(passphrase: string): number {
  return new Set(passphrase).size;
}

/** True for all-one-character strings and simple monotonic runs like
 * "123456789012" or "abcdefghijkl" — patterns an entropy estimate rates high
 * but a cracker tries immediately. */
function isDegeneratePattern(passphrase: string): boolean {
  if (distinctChars(passphrase) <= 2) return true;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < passphrase.length; i++) {
    const delta = passphrase.charCodeAt(i) - passphrase.charCodeAt(i - 1);
    if (delta !== 1) ascending = false;
    if (delta !== -1) descending = false;
  }
  return ascending || descending;
}

/** Lowercased passphrase with trailing digits and symbols removed, so a
 * blocklisted base word is caught even with a suffix ("bitcoin!" -> "bitcoin"). */
function blocklistBase(passphrase: string): string {
  return passphrase.toLowerCase().replace(/[0-9!-/:-@[-`{-~]+$/, "");
}

function estimateBits(passphrase: string): number {
  if (passphrase.length === 0) return 0;
  if (isDegeneratePattern(passphrase)) {
    // Cap hard: these fall in seconds regardless of length.
    return Math.min(passphrase.length, 8);
  }
  const bits = passphrase.length * Math.log2(poolSize(passphrase));
  return Math.round(bits);
}

/**
 * Assess a candidate passphrase for wallet creation.
 *
 * A passphrase is `acceptable` only when it is at least MIN_PASSPHRASE_LENGTH
 * characters, estimates at MIN_PASSPHRASE_BITS or more, is not a degenerate
 * pattern, and is not on the common-password blocklist.
 */
export function assessPassphrase(passphrase: string): PassphraseAssessment {
  if (passphrase.length === 0) {
    return { acceptable: false, score: 0, label: "empty", reason: null, bits: 0 };
  }

  const bits = estimateBits(passphrase);

  if (BLOCKSET.has(passphrase.toLowerCase()) || BLOCKSET.has(blocklistBase(passphrase))) {
    return {
      acceptable: false,
      score: 0,
      label: "weak",
      reason: "That is a commonly guessed passphrase. Choose something unique to you.",
      bits,
    };
  }

  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return {
      acceptable: false,
      score: bits >= 40 ? 1 : 0,
      label: "too short",
      reason: `Use at least ${MIN_PASSPHRASE_LENGTH} characters. Longer is stronger.`,
      bits,
    };
  }

  if (isDegeneratePattern(passphrase)) {
    return {
      acceptable: false,
      score: 0,
      label: "weak",
      reason: "Avoid repeated characters or simple sequences.",
      bits,
    };
  }

  if (bits < MIN_PASSPHRASE_BITS) {
    return {
      acceptable: false,
      score: 1,
      label: "weak",
      reason: "Too easy to guess. Add length, or mix in capitals, numbers, or symbols.",
      bits,
    };
  }

  // Acceptable: grade the surplus for the meter.
  if (bits >= 100) return { acceptable: true, score: 4, label: "strong", reason: null, bits };
  if (bits >= 80) return { acceptable: true, score: 3, label: "good", reason: null, bits };
  return { acceptable: true, score: 2, label: "fair", reason: null, bits };
}

// Limitations (honest scope of this check):
// - The entropy estimate is pool-size × length. It OVER-rates natural-language
//   passphrases built from common dictionary words (e.g. four common English
//   words), which a targeted wordlist attack tries. Catching those reliably
//   needs a dictionary model (zxcvbn), which is a dependency this repo will not
//   add without justification. Treat MIN_PASSPHRASE_BITS as a floor against
//   brute force, not a promise of resistance to dictionary attack.
// - This runs only when CREATING a wallet. It intentionally does not gate the
//   restore flow, where the passphrase already exists and must be entered as-is.
