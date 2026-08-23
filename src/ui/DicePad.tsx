// Tap-pad entry for physical dice rolls. The die is real and in the user's
// hand — this component only records results. It never generates rolls.

export function DicePad({
  value,
  min,
  onChange,
}: {
  value: string;
  min: number;
  onChange: (next: string) => void;
}) {
  const pct = Math.min(100, Math.round((value.length / min) * 100));
  return (
    <div className="dicepad-wrap">
      <div className="dicepad-count">
        {value.length} <span className="muted">/ {min} rolls</span>
      </div>
      <div className="progress">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="dicepad">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <button key={n} type="button" className="die" onClick={() => onChange(value + n)}>
            {n}
          </button>
        ))}
      </div>
      <div className="dicepad-actions">
        <button type="button" className="secondary" onClick={() => onChange(value.slice(0, -1))}>
          Undo
        </button>
        <button type="button" className="secondary" onClick={() => onChange("")}>
          Clear
        </button>
      </div>
    </div>
  );
}
