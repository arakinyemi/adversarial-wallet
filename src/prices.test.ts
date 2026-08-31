import { describe, expect, test } from "vitest";
import { fetchUsdPrices, PriceError, type PriceFetchLike } from "./prices";

const jsonFetch =
  (body: unknown, ok = true, status = 200): PriceFetchLike =>
  async () => ({ ok, status, json: async () => body });

describe("usd prices fail closed", () => {
  test("valid prices parse", async () => {
    const prices = await fetchUsdPrices(
      jsonFetch({ bitcoin: { usd: 104_250.12 }, ethereum: { usd: 3_920.5 } }),
    );
    expect(prices).toEqual({ btcUsd: 104_250.12, ethUsd: 3_920.5 });
  });

  test("HTTP errors, missing assets, and unusable values refuse", async () => {
    const bads: PriceFetchLike[] = [
      jsonFetch({}, false, 429),
      jsonFetch({}),
      jsonFetch({ bitcoin: { usd: 100_000 } }),
      jsonFetch({ bitcoin: { usd: "100000" }, ethereum: { usd: 4_000 } }),
      jsonFetch({ bitcoin: { usd: 0 }, ethereum: { usd: 4_000 } }),
      jsonFetch({ bitcoin: { usd: -5 }, ethereum: { usd: 4_000 } }),
      jsonFetch(null),
    ];
    for (const bad of bads) {
      await expect(fetchUsdPrices(bad)).rejects.toThrow(PriceError);
    }
  });
});
