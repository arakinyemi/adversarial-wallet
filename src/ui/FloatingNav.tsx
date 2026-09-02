// Floating bottom navigation: activity · home (center) · settings.
// Shown on top-level screens only; sub-flows keep their back arrows.

import type { Route } from "../App";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function FloatingNav({ at, go }: { at: Route; go: (r: Route) => void }) {
  return (
    <nav className="fnav">
      <button className={at === "activity" ? "on" : ""} onClick={() => go("activity")} aria-label="Activity">
        <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
          <path d="M3 12h4l3-8 4 16 3-8h4" />
        </svg>
      </button>
      <button className={`center${at === "home" ? " on" : ""}`} onClick={() => go("home")} aria-label="Home">
        <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5.5 9v11h13V9" />
        </svg>
      </button>
      <button className={at === "settings" ? "on" : ""} onClick={() => go("settings")} aria-label="Settings">
        <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
          <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="9" cy="17" r="2" />
        </svg>
      </button>
    </nav>
  );
}
