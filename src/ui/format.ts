// Display formatting only. No security-relevant logic belongs in this file.

/** 123456789 → "1.23456789" (BTC, 8 decimal places, no trailing trim). */
export function satsToBtc(sats: number): string {
  const sign = sats < 0 ? "-" : "";
  const abs = Math.abs(sats);
  const whole = Math.floor(abs / 100_000_000);
  const frac = String(abs % 100_000_000).padStart(8, "0");
  return `${sign}${whole}.${frac}`;
}

/** 12345 → "12,345 sats". */
export function formatSats(sats: number): string {
  return `${sats.toLocaleString("en-US")} sats`;
}

/** Millisats → whole sats, floored toward zero. */
export function msatToSats(msat: number): number {
  return Math.trunc(msat / 1000);
}

/** "bc1qabcdef...xyzuvw" for long addresses/hashes. */
export function truncateMiddle(value: string, keep = 8): string {
  if (value.length <= keep * 2 + 1) return value;
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
