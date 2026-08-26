import type { ReactNode } from "react";

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="panel pad" style={{ marginBottom: 12 }}>
      {title !== undefined && <div className="micro" style={{ marginBottom: 12 }}>{title}</div>}
      {children}
    </div>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (error === null) return null;
  return <div className="banner error">{error}</div>;
}

export function SuccessBanner({ message }: { message: string | null }) {
  if (message === null) return null;
  return <div className="banner success">{message}</div>;
}

export function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="row">
      <span className="label">{label}</span>
      <span className={mono === true ? "value mono" : "value"}>{value}</span>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint !== undefined && <div className="hint">{hint}</div>}
    </div>
  );
}

/** Renders any thrown value as a displayable message. Never logs. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TopBar({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <div className="topbar">
      {onBack !== undefined && (
        <button className="back" onClick={onBack} aria-label="Back">←</button>
      )}
      <span className="title">{title}</span>
    </div>
  );
}

export function Segbar({ total, at }: { total: number; at: number }) {
  return (
    <div className="segbar">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i <= at ? "on" : ""} />
      ))}
    </div>
  );
}
