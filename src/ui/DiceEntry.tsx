// Pip-face dice entry with a tick progress bar, recent rolls, and undo.
// The die is real and in the user's hand — this only records results and
// never generates a roll in software.

const PIPS: Record<number, string[]> = {
  1: ["2/2"],
  2: ["1/3", "3/1"],
  3: ["1/3", "2/2", "3/1"],
  4: ["1/1", "1/3", "3/1", "3/3"],
  5: ["1/1", "1/3", "2/2", "3/1", "3/3"],
  6: ["1/1", "2/1", "3/1", "1/3", "2/3", "3/3"],
};

export function DiceEntry({
  value,
  min,
  onChange,
}: {
  value: string;
  min: number;
  onChange: (next: string) => void;
}) {
  return (
    <>
      <div className="ticks">
        {Array.from({ length: min }, (_, i) => (
          <span key={i} className={i < value.length ? "on" : ""} />
        ))}
      </div>
      <div className="dicefoot">
        <span>{value.slice(-14).split("").join(" ")}</span>
        <button type="button" onClick={() => onChange(value.slice(0, -1))}>undo last</button>
      </div>
      <div className="grow" />
      <div className="dicegrid">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <button key={n} type="button" className="die" onClick={() => onChange(value + n)} aria-label={`${n}`}>
            <span className="face">
              {PIPS[n]!.map((area) => (
                <span key={area} className="pip" style={{ gridArea: `${area.split("/")[0]} / ${area.split("/")[1]}` }} />
              ))}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
