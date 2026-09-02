// Home: total at the top, the three accounts as rows with live balances.
// Each component loads independently; a failed load shows as unavailable,
// and the total only renders when every configured component loaded — a
// partial sum must never masquerade as the whole.

import { useEffect, useState } from "react";
import { createPublicClient, formatEther, getAddress, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Intent, Route } from "../App";
import { scanWatchOnlyBalance } from "../btc";
import { getBalanceMsat } from "../lightning";
import { fetchUsdPrices, type UsdPrices } from "../prices";
import { BottomNav } from "./BottomNav";
import { formatSats, msatToSats, satsToBtc, satsToUsd } from "./format";
import type { WalletConfig } from "./wallet-config";

type Load = { state: "loading" } | { state: "ok"; value: number } | { state: "error" } | { state: "off" };

export function HomeScreen({
  config,
  go,
}: {
  config: WalletConfig;
  go: (r: Route, intent?: Intent) => void;
}) {
  // Send/Receive need an account: the chooser picks Bitcoin or Lightning.
  const [chooser, setChooser] = useState<Intent | null>(null);
  const [btc, setBtc] = useState<Load>({ state: "loading" });
  const [ln, setLn] = useState<Load>(
    config.lnbitsUrl !== "" && config.lnbitsInvoiceKey !== "" ? { state: "loading" } : { state: "off" },
  );
  const [sav, setSav] = useState<{ state: "loading" | "error" | "off" } | { state: "ok"; eth: string }>(
    config.safeAddress !== "" ? { state: "loading" } : { state: "off" },
  );
  const [prices, setPrices] = useState<UsdPrices | null>(null);

  useEffect(() => {
    let alive = true;
    // Display sugar only: a price failure silently falls back to sats.
    void fetchUsdPrices()
      .then((usd) => { if (alive) setPrices(usd); })
      .catch(() => {});
    void scanWatchOnlyBalance({
      esploraUrl: config.esploraUrl,
      xpub: config.xpub,
      network: config.network,
    })
      .then((b) => { if (alive) setBtc({ state: "ok", value: b.confirmedSats + Math.max(0, b.pendingSats) }); })
      .catch(() => { if (alive) setBtc({ state: "error" }); });

    if (config.lnbitsUrl !== "" && config.lnbitsInvoiceKey !== "") {
      void getBalanceMsat({ baseUrl: config.lnbitsUrl, apiKey: config.lnbitsInvoiceKey })
        .then((msat) => { if (alive) setLn({ state: "ok", value: msatToSats(msat) }); })
        .catch(() => { if (alive) setLn({ state: "error" }); });
    }

    if (config.safeAddress !== "") {
      const chain = config.network === "mainnet" ? base : baseSepolia;
      const client = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]!) });
      void client
        .getBalance({ address: getAddress(config.safeAddress) })
        .then((wei) => { if (alive) setSav({ state: "ok", eth: formatEther(wei) }); })
        .catch(() => { if (alive) setSav({ state: "error" }); });
    }
    return () => { alive = false; };
  }, [config]);

  const satParts = [btc, ln].filter((l) => l.state !== "off");
  const allSatsLoaded = satParts.every((l) => l.state === "ok");
  const anyError = satParts.some((l) => l.state === "error") || sav.state === "error";
  const totalSats = allSatsLoaded
    ? satParts.reduce((a, l) => a + (l.state === "ok" ? l.value : 0), 0)
    : null;

  const amountOf = (l: Load): string =>
    l.state === "ok"
      ? prices !== null
        ? satsToUsd(l.value, prices.btcUsd)
        : formatSats(l.value)
      : l.state === "loading" ? "…" : l.state === "error" ? "unavailable" : "";

  const grandUsd =
    prices !== null && totalSats !== null && sav.state !== "loading" && sav.state !== "error"
      ? (totalSats / 100_000_000) * prices.btcUsd +
        (sav.state === "ok" ? parseFloat(sav.eth) * prices.ethUsd : 0)
      : null;

  return (
    <div className="screen with-nav with-actions">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="brandrow">
          <span className="sq" />
          <span className="nm">Aegis</span>
        </div>
        {config.network === "testnet" && (
          <span className="micro" style={{ color: "var(--amber)" }}>test mode</span>
        )}
      </div>

      <div style={{ marginTop: 26 }}>
        <div className="micro dim">Total</div>
        <div className="balance-big" style={{ marginTop: 6 }}>
          {grandUsd !== null
            ? grandUsd.toLocaleString("en-US", { style: "currency", currency: "USD" })
            : totalSats !== null ? formatSats(totalSats) : anyError ? "—" : "…"}
        </div>
        <div className="balance-sub">
          {totalSats !== null && <span>{satsToBtc(totalSats)} BTC</span>}
          {sav.state === "ok" && <span>+ {sav.eth} ETH</span>}
          {anyError && <span style={{ color: "var(--amber)" }}>some balances unavailable</span>}
        </div>
      </div>

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column" }}>
        <button className="acct" onClick={() => go("bitcoin")}>
          <span className="r1"><span className="name">Spending</span><span className="amt">{amountOf(btc)}</span></span>
          <span className="sub2">Bitcoin</span>
          <span className="chip accent">spends with passphrase</span>
        </button>
        <button className="acct" onClick={() => go("lightning")}>
          <span className="r1"><span className="name">Instant</span><span className="amt">{ln.state === "off" ? "" : amountOf(ln)}</span></span>
          <span className="sub2">Lightning{ln.state === "off" ? " · not set up" : ""}</span>
          <span className="chip">spends while unlocked</span>
        </button>
        <button className="acct" onClick={() => go("savings")}>
          <span className="r1">
            <span className="name">Savings</span>
            <span className="amt">
              {sav.state === "ok"
                ? prices !== null
                  ? (parseFloat(sav.eth) * prices.ethUsd).toLocaleString("en-US", { style: "currency", currency: "USD" })
                  : `${sav.eth} ETH`
                : sav.state === "loading" ? "…" : sav.state === "error" ? "unavailable" : ""}
            </span>
          </span>
          <span className="sub2">Two-device protected{sav.state === "off" ? " · not set up" : ""}</span>
          <span className="chip">spends with two devices</span>
        </button>
      </div>
      <div className="grow" />
      <div className="dock-actions">
        <button className="btn primary" onClick={() => setChooser("send")}>Send</button>
        <button className="btn ghost" onClick={() => setChooser("receive")}>Receive</button>
      </div>
      {chooser !== null && (
        <>
          <button className="sheet-back" aria-label="Close" onClick={() => setChooser(null)} />
          <div className="sheet">
            <div className="micro dim">{chooser === "send" ? "Send from" : "Receive to"}</div>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column" }}>
              <button className="acct" onClick={() => go("bitcoin", chooser)}>
                <span className="r1"><span className="name">Spending</span></span>
                <span className="sub2">Bitcoin</span>
              </button>
              <button
                className="acct"
                disabled={ln.state === "off"}
                style={ln.state === "off" ? { opacity: 0.45 } : undefined}
                onClick={() => go("lightning", chooser)}
              >
                <span className="r1"><span className="name">Instant</span></span>
                <span className="sub2">Lightning{ln.state === "off" ? " · not set up" : ""}</span>
              </button>
            </div>
          </div>
        </>
      )}
      <BottomNav at="home" go={go} />
    </div>
  );
}
