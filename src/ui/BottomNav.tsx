// Bottom navigation: activity · home · settings. The active tab is
// highlighted; shown on top-level screens only — sub-flows keep back arrows.

import type { Route } from "../App";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function BottomNav({ at, go }: { at: Route; go: (r: Route) => void }) {
  return (
    <nav className="fnav">
      <button className={at === "activity" ? "on" : ""} onClick={() => go("activity")}>
        <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
          <path d="M3 12h4l3-8 4 16 3-8h4" />
        </svg>
        Activity
      </button>
      <button className={at === "home" ? "on" : ""} onClick={() => go("home")}>
        <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5.5 9v11h13V9" />
        </svg>
        Home
      </button>
      <button className={at === "settings" ? "on" : ""} onClick={() => go("settings")}>
        <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
          <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="9" cy="17" r="2" />
        </svg>
        Settings
      </button>
    </nav>
  );
}
