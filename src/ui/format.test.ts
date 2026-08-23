import { describe, expect, test } from "vitest";
import { formatSats, msatToSats, satsToBtc, truncateMiddle } from "./format";

describe("display formatting", () => {
  test("satsToBtc", () => {
    expect(satsToBtc(0)).toBe("0.00000000");
    expect(satsToBtc(1)).toBe("0.00000001");
    expect(satsToBtc(123_456_789)).toBe("1.23456789");
    expect(satsToBtc(2_100_000_000_000_000)).toBe("21000000.00000000");
    expect(satsToBtc(-59_000)).toBe("-0.00059000");
  });

  test("formatSats", () => {
    expect(formatSats(0)).toBe("0 sats");
    expect(formatSats(59_000)).toBe("59,000 sats");
  });

  test("msatToSats floors toward zero", () => {
    expect(msatToSats(0)).toBe(0);
    expect(msatToSats(1_999)).toBe(1);
    expect(msatToSats(-1_999)).toBe(-1);
  });

  test("truncateMiddle keeps ends and short strings", () => {
    expect(truncateMiddle("short")).toBe("short");
    const addr = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
    expect(truncateMiddle(addr)).toBe("bc1qcr8t…8z306fyu");
  });
});
