// Strength meter + reason line for a passphrase being CREATED. Renders
// nothing for an empty passphrase. Single source for the setup flow and the
// passphrase-rotation flow.

import type { PassphraseAssessment } from "./passphrase-strength";

export function PassphraseMeter({ assessment }: { assessment: PassphraseAssessment }) {
  if (assessment.label === "empty") return null;
  const fill = assessment.score >= 3
    ? "var(--success)"
    : assessment.acceptable
      ? "var(--accent)"
      : "var(--amber)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: i < assessment.score ? fill : "var(--faint)",
            }}
          />
        ))}
      </div>
      <div
        className="mono"
        style={{ fontSize: 11.5, color: assessment.acceptable ? "var(--success)" : "var(--amber)" }}
      >
        {assessment.reason ?? `Strength: ${assessment.label}`}
      </div>
    </div>
  );
}
