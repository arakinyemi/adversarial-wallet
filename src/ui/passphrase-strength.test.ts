import { describe, expect, test } from "vitest";
import {
  assessPassphrase,
  MIN_PASSPHRASE_BITS,
  MIN_PASSPHRASE_LENGTH,
} from "./passphrase-strength";

describe("assessPassphrase — refusals", () => {
  test("empty is not acceptable and carries no scolding reason", () => {
    const a = assessPassphrase("");
    expect(a.acceptable).toBe(false);
    expect(a.label).toBe("empty");
    expect(a.reason).toBeNull();
  });

  test("short passphrases are refused even with a rich character mix", () => {
    // 11 chars, four classes — still under the length floor.
    const a = assessPassphrase("aB3$aB3$aB3");
    expect(a.acceptable).toBe(false);
    expect(a.label).toBe("too short");
  });

  test(`exactly ${MIN_PASSPHRASE_LENGTH} single-case chars fail the entropy floor`, () => {
    // 12 lowercase letters ≈ 12·log2(26) ≈ 56 bits, below the 60-bit floor.
    const a = assessPassphrase("abrhqmztlkwp");
    expect(a.acceptable).toBe(false);
    expect(a.label).toBe("weak");
    expect(a.bits).toBeLessThan(MIN_PASSPHRASE_BITS);
  });

  test("common passwords are refused regardless of length model", () => {
    for (const p of ["password", "PASSWORD", "iloveyou", "qwertyuiop"]) {
      expect(assessPassphrase(p).acceptable).toBe(false);
    }
  });

  test("blocklisted base word with a trailing suffix is still refused", () => {
    for (const p of ["bitcoin123", "Password1", "satoshi!!!", "aegis2026"]) {
      const a = assessPassphrase(p);
      expect(a.acceptable).toBe(false);
      expect(a.reason).toMatch(/commonly guessed/);
    }
  });

  test("crypto- and app-themed guesses are refused", () => {
    for (const p of ["satoshinakamoto", "notyourkeys", "twentyfifthword", "adversarialwallet"]) {
      expect(assessPassphrase(p).acceptable).toBe(false);
    }
  });

  test("the xkcd example passphrase is blocklisted", () => {
    expect(assessPassphrase("correcthorsebatterystaple").acceptable).toBe(false);
    expect(assessPassphrase("correct horse battery staple").acceptable).toBe(false);
  });

  test("repeated single character is refused however long", () => {
    const a = assessPassphrase("aaaaaaaaaaaaaaaaaaaa");
    expect(a.acceptable).toBe(false);
    expect(a.reason).toMatch(/repeated characters|sequences/);
  });

  test("monotonic sequences are refused however long", () => {
    for (const p of ["123456789012", "abcdefghijklmnop", "zyxwvutsrqponml"]) {
      expect(assessPassphrase(p).acceptable).toBe(false);
    }
  });
});

describe("assessPassphrase — acceptance", () => {
  test("a 12-char mixed-class passphrase is acceptable", () => {
    // three classes, 12 chars ≈ 12·log2(62) ≈ 71 bits.
    const a = assessPassphrase("Rk7mQ2pLx9Tb");
    expect(a.acceptable).toBe(true);
    expect(a.bits).toBeGreaterThanOrEqual(MIN_PASSPHRASE_BITS);
    expect(a.reason).toBeNull();
  });

  test("a long single-case passphrase clears the floor on length alone", () => {
    // 16 lowercase ≈ 16·log2(26) ≈ 75 bits.
    const a = assessPassphrase("plfhqbnzmxvdjrkw");
    expect(a.acceptable).toBe(true);
    expect(a.label).not.toBe("weak");
  });

  test("score rises with entropy", () => {
    const fair = assessPassphrase("Rk7mQ2pLx9Tb"); // ~71 bits
    const strong = assessPassphrase("Rk7mQ2pLx9Tb!Wv4Zc8Hn2Gd"); // ~24 chars, four classes
    expect(fair.score).toBeLessThan(strong.score);
    expect(strong.label).toBe("strong");
  });

  test("non-ASCII characters widen the pool and are accepted", () => {
    const a = assessPassphrase("café-münchen-2026-ü");
    expect(a.acceptable).toBe(true);
  });

  test("acceptable results never carry a reason; unacceptable always do (except empty)", () => {
    const samples = ["", "short", "password", "abrhqmztlkwp", "Rk7mQ2pLx9Tb"];
    for (const p of samples) {
      const a = assessPassphrase(p);
      if (a.acceptable) expect(a.reason).toBeNull();
      else if (p !== "") expect(a.reason).not.toBeNull();
    }
  });
});
