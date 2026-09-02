// Activity: Bitcoin transactions and Lightning payments, merged, newest
// first. Honest per source — a failed source says so rather than showing
// an empty feed as if nothing happened.

import { useEffect, useState } from "react";
import { fetchRecentTransactions, scanWatchOnlyBalance } from "../btc";
import { listPayments } from "../lightning";
import { fetchUsdPrices, type UsdPrices } from "../prices";
import type { Route } from "../App";
import { FloatingNav } from "./FloatingNav";
import { formatSats, msatToSats, satsToUsd, truncateMiddle } from "./format";
import type { WalletConfig } from "./wallet-config";

interface Item {
  kind: "bitcoin" | "lightning";
  label: string;
  detail: string;
  sats: number;
  pending: boolean;
  time: number;
}

export function ActivityScreen({
  config,
  go,
}: {
  config: WalletConfig;
  go: (r: Route) => void;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [btcFailed, setBtcFailed] = useState(false);
  const [lnFailed, setLnFailed] = useState(false);
  const [prices, setPrices] = useState<UsdPrices | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchUsdPrices().then((usd) => { if (alive) setPrices(usd); }).catch(() => {});

    const load = async () => {
      const collected: Item[] = [];
      try {
        const balance = await scanWatchOnlyBalance({
          esploraUrl: config.esploraUrl,
          xpub: config.xpub,
          network: config.network,
        });
        const txs = await fetchRecentTransactions(config.esploraUrl, balance.usedAddresses);
        for (const tx of txs) {
          collected.push({
            kind: "bitcoin",
            label: tx.netSats >= 0 ? "Received bitcoin" : "Sent bitcoin",
            detail: truncateMiddle(tx.txid, 8),
            sats: tx.netSats,
            pending: !tx.confirmed,
            time: tx.time ?? Math.floor(Date.now() / 1000),
          });
        }
      } catch {
        if (alive) setBtcFailed(true);
      }
      if (config.lnbitsUrl !== "" && config.lnbitsInvoiceKey !== "") {
        try {
          const payments = await listPayments({ baseUrl: config.lnbitsUrl, apiKey: config.lnbitsInvoiceKey });
          for (const p of payments) {
            collected.push({
              kind: "lightning",
              label: p.amountMsat >= 0 ? "Received instantly" : "Paid instantly",
              detail: p.memo !== "" ? p.memo : "Lightning",
              sats: msatToSats(p.amountMsat),
              pending: p.pending,
              time: p.time,
            });
          }
        } catch {
          if (alive) setLnFailed(true);
        }
      }
      collected.sort((a, b) => Number(a.pending) - Number(b.pending) === 0 ? b.time - a.time : Number(b.pending) - Number(a.pending));
      if (alive) setItems(collected);
    };
    void load();
    return () => { alive = false; };
  }, [config]);

  const dateOf = (t: number) =>
    new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="screen with-nav">
      <div className="micro dim">Activity</div>
      <div className="h1" style={{ marginTop: 10, fontSize: 24 }}>What's happened</div>
      {btcFailed && <div className="banner error">Couldn't load Bitcoin activity right now.</div>}
      {lnFailed && <div className="banner error">Couldn't load Lightning activity right now.</div>}
      <div style={{ marginTop: 14 }}>
        {items === null ? (
          <div className="sub">Loading…</div>
        ) : items.length === 0 && !btcFailed && !lnFailed ? (
          <div className="sub">Nothing yet. Your payments will show up here.</div>
        ) : (
          items.map((item, i) => (
            <div className="act-row" key={i}>
              <span className="ic">
                {item.sats >= 0 ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 19V5M5 12l7 7 7-7" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12l7-7 7 7" /></svg>
                )}
              </span>
              <span className="mid">
                <div className="l1">{item.label}{item.pending ? " · pending" : ""}</div>
                <div className="l2">{item.detail} · {dateOf(item.time)}</div>
              </span>
              <span className={`amt${item.sats >= 0 ? " in" : ""}`}>
                {prices !== null
                  ? `${item.sats >= 0 ? "+" : "−"}${satsToUsd(Math.abs(item.sats), prices.btcUsd)}`
                  : `${item.sats >= 0 ? "+" : "−"}${formatSats(Math.abs(item.sats))}`}
              </span>
            </div>
          ))
        )}
      </div>
      <FloatingNav at="activity" go={go} />
    </div>
  );
}
