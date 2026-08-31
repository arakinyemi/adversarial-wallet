// USD display prices for BTC and ETH, from CoinGecko's public endpoint
// (dependency approved; chosen for reachability where mempool.space and
// coinbase are blocked). Prices are display sugar only: a failure here must
// never block balances — callers hide fiat and show native units instead.
// Fail-closed within its own scope: malformed or absurd data throws rather
// than rendering a wrong number.

export class PriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceError";
  }
}

export type PriceFetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd";

export interface UsdPrices {
  btcUsd: number;
  ethUsd: number;
}

export async function fetchUsdPrices(
  fetchFn: PriceFetchLike = (url) =>
    globalThis.fetch(url, { signal: AbortSignal.timeout(10_000) }),
): Promise<UsdPrices> {
  const response = await fetchFn(PRICE_URL);
  if (!response.ok) {
    throw new PriceError(`The price service returned an error (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as {
    bitcoin?: { usd?: unknown };
    ethereum?: { usd?: unknown };
  } | null;
  const btcUsd = body?.bitcoin?.usd;
  const ethUsd = body?.ethereum?.usd;
  for (const price of [btcUsd, ethUsd]) {
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new PriceError("The price service sent unusable prices.");
    }
  }
  return { btcUsd: btcUsd as number, ethUsd: ethUsd as number };
}
