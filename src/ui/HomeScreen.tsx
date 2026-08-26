// Home: the three accounts as rows, each labeled with what spending takes.
// Balances load lazily per account screen; home stays instant and static.

import type { Route } from "../App";
import type { WalletConfig } from "./wallet-config";

export function HomeScreen({
  config,
  go,
}: {
  config: WalletConfig;
  go: (r: Route) => void;
}) {
  return (
    <div className="screen">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="brandrow">
          <span className="sq" />
          <span className="nm">Cairn</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="micro">{config.network}</span>
          <button className="gear" onClick={() => go("settings")} aria-label="Settings">⚙</button>
        </div>
      </div>
      <div style={{ marginTop: 28, display: "flex", flexDirection: "column" }}>
        <button className="acct" onClick={() => go("bitcoin")}>
          <span className="r1"><span className="name">Spending</span></span>
          <span className="sub2">Bitcoin</span>
          <span className="chip accent">spends with passphrase</span>
        </button>
        <button className="acct" onClick={() => go("lightning")}>
          <span className="r1"><span className="name">Instant</span></span>
          <span className="sub2">Lightning</span>
          <span className="chip">spends while unlocked</span>
        </button>
        <button className="acct" onClick={() => go("savings")}>
          <span className="r1"><span className="name">Savings</span></span>
          <span className="sub2">Base · 2-of-3</span>
          <span className="chip">spends with two devices</span>
        </button>
      </div>
      <div className="grow" />
    </div>
  );
}
