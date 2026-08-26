// On-screen PIN keypad with dot indicators. PINs are exactly PIN_LENGTH
// digits; onComplete fires when the last digit lands and the buffer clears
// after handoff, so digits never linger in this component.

import { useState } from "react";

export const PIN_LENGTH = 6;

export function PinPad({
  onComplete,
  disabled,
}: {
  onComplete: (pin: string) => void;
  disabled?: boolean;
}) {
  const [buf, setBuf] = useState("");

  const press = (d: string) => {
    if (disabled === true) return;
    const next = (buf + d).slice(0, PIN_LENGTH);
    setBuf(next);
    if (next.length === PIN_LENGTH) {
      setBuf("");
      onComplete(next);
    }
  };
  const erase = () => setBuf(buf.slice(0, -1));

  return (
    <>
      <div className="pindots" style={{ marginBottom: 18 }}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={i < buf.length ? "on" : ""} />
        ))}
      </div>
      <div className="keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => (
          <button key={k} type="button" onClick={() => press(k)}>{k}</button>
        ))}
        <button type="button" className="blank" tabIndex={-1} />
        <button type="button" onClick={() => press("0")}>0</button>
        <button type="button" onClick={erase}>⌫</button>
      </div>
    </>
  );
}
