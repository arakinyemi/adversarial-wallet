// Home: total at the top, the three accounts as rows with live balances.
// Each component loads independently; a failed load shows as unavailable,
// and the total only renders when every configured component loaded — a
// partial sum must never masquerade as the whole.

import { useEffect, useState } from "react";
import { createPublicClient, formatEther, getAddress, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Route } from "../App";
import { scanWatchOnlyBalance } from "../btc";
import { getBalanceMsat } from "../lightning";
import { formatSats, msatToSats, satsToBtc } from "./format";
import type { WalletConfig } from "./wallet-config";

type Load = { state: "loading" } | { state: "ok"; value: number } | { state: "error" } | { state: "off" };

export function HomeScreen({
  config,
  go,
}: {
  config: WalletConfig;
  go: (r: Route) => void;
}) {
  const [btc, setBtc] = useState<Load>({ state: "loading" });
  const [ln, setLn] = useState<Load>(
    config.lnbitsUrl !== "" && config.lnbitsInvoiceKey !== "" ? { state: "loading" } : { state: "off" },
  );
  const [sav, setSav] = useState<{ state: "loading" | "error" | "off" } | { state: "ok"; eth: string }>(
    config.safeAddress !== "" ? { state: "loading" } : { state: "off" },
  );

  useEffect(() => {
    let alive = true;
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
    l.state === "ok" ? formatSats(l.value) : l.state === "loading" ? "…" : l.state === "error" ? "unavailable" : "";

  return (
    <div className="screen">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="brandrow">
          <span className="sq" />
          <span className="nm">Aegis</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="micro">{config.network}</span>
          <button className="gear" onClick={() => go("settings")} aria-label="Settings">⚙</button>
        </div>
      </div>

      <div style={{ marginTop: 26 }}>
        <div className="micro dim">Total</div>
        <div className="balance-big" style={{ marginTop: 6 }}>
          {totalSats !== null ? formatSats(totalSats) : anyError ? "—" : "…"}
        </div>
        <div className="balance-sub">
          {totalSats !== null && <span>{satsToBtc(totalSats)} BTC</span>}
          {sav.state === "ok" && <span>+ {sav.eth} ETH in Savings</span>}
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
              {sav.state === "ok" ? `${sav.eth} ETH` : sav.state === "loading" ? "…" : sav.state === "error" ? "unavailable" : ""}
            </span>
          </span>
          <span className="sub2">Base · 2-of-3{sav.state === "off" ? " · not set up" : ""}</span>
          <span className="chip">spends with two devices</span>
        </button>
      </div>
      <div className="grow" />
    </div>
  );
}
