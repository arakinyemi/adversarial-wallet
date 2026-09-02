// Pull-to-refresh: drag down from the top of a screen to reload its data.
// Hand-rolled on touch events — no library. The indicator is a square in
// the Signal accent that arms at the threshold and spins while loading.

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Pixels of (dampened) pull that trigger a refresh on release. */
const TRIGGER = 55;
const MAX_PULL = 110;

export function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh: () => Promise<void>;
  children: ReactNode;
}) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const gesture = useRef({ startY: 0, pull: 0, active: false, busy: false });
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const el = wrap.current;
    if (el === null) return;
    const atTop = () => (document.scrollingElement?.scrollTop ?? 0) <= 0;

    const onStart = (e: TouchEvent) => {
      if (gesture.current.busy || !atTop()) return;
      gesture.current.startY = e.touches[0].clientY;
      gesture.current.active = true;
      setDragging(true);
    };
    const onMove = (e: TouchEvent) => {
      const g = gesture.current;
      if (!g.active || g.busy) return;
      const dy = e.touches[0].clientY - g.startY;
      if (dy <= 0 || !atTop()) {
        g.pull = 0;
        setPull(0);
        return;
      }
      // Dampen the drag so the indicator feels weighted, and keep the
      // page itself still while the gesture owns the touch.
      e.preventDefault();
      g.pull = Math.min(dy * 0.5, MAX_PULL);
      setPull(g.pull);
    };
    const onEnd = () => {
      const g = gesture.current;
      if (!g.active) return;
      g.active = false;
      setDragging(false);
      const released = g.pull;
      g.pull = 0;
      if (released >= TRIGGER && !g.busy) {
        g.busy = true;
        setBusy(true);
        setPull(TRIGGER);
        // Errors are each screen's business — surfaced by its own banner.
        void refreshRef.current().finally(() => {
          g.busy = false;
          setBusy(false);
          setPull(0);
        });
      } else if (!g.busy) {
        setPull(0);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  return (
    <div ref={wrap}>
      <div
        className="ptr"
        style={{ height: pull, transition: dragging ? "none" : "height 0.2s" }}
      >
        <span className={`ptr-box${busy ? " spin" : pull >= TRIGGER ? " ready" : ""}`} />
      </div>
      {children}
    </div>
  );
}
