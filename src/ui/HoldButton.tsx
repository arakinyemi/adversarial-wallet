// Press-and-hold commit button (~1.1s). Releasing early cancels. Used for
// the one irreversible moment in onboarding: setting the passphrase.

import { useEffect, useRef, useState } from "react";

const HOLD_MS = 1100;
const TICK_MS = 40;

export function HoldButton({
  label,
  disabled,
  onCommit,
}: {
  label: string;
  disabled?: boolean;
  onCommit: () => void;
}) {
  const [pct, setPct] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fired = useRef(false);

  const stop = () => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    setPct(0);
  };
  useEffect(() => stop, []);

  const start = () => {
    if (disabled === true || timer.current !== null) return;
    fired.current = false;
    let p = 0;
    timer.current = setInterval(() => {
      p += (TICK_MS / HOLD_MS) * 100;
      if (p >= 100 && !fired.current) {
        fired.current = true;
        stop();
        onCommit();
        return;
      }
      setPct(Math.min(p, 100));
    }, TICK_MS);
  };

  if (disabled === true) {
    return (
      <button className="btn" disabled>
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="holdbtn"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
    >
      <span className="fill" style={{ width: `${pct}%` }} />
      <span className="lbl">{label}</span>
    </button>
  );
}
