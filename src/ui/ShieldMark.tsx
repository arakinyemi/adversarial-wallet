// The Aegis shield — the app's logo mark, drawn in the accent color.

export function ShieldMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={Math.round((size * 20) / 18)}
      viewBox="0 0 18 20"
      fill="none"
      aria-hidden
    >
      <path
        d="M9 1 L17 4 V10 C17 15 13.5 18.2 9 19.5 C4.5 18.2 1 15 1 10 V4 Z"
        stroke="var(--accent)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
