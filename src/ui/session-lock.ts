// Session PIN cache. The PIN unlocks the app once per session; while
// unlocked, actions that unseal a secret reuse the cached PIN instead of
// re-prompting. Only the PIN (a low-value secret compared to a decrypted
// seed) is cached — never a decrypted key.
//
// The session locks automatically on inactivity and whenever the app is
// backgrounded, and can be locked manually. The Bitcoin passphrase is NOT
// part of this: it is never cached and is entered on every Bitcoin spend.

const INACTIVITY_MS = 120_000; // 2 minutes

let cachedPin: string | null = null;
let lastActivity = 0;
let timer: ReturnType<typeof setInterval> | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export function isUnlocked(): boolean {
  return cachedPin !== null;
}

/** The cached PIN, or null when locked. Callers must handle null. */
export function getSessionPin(): string | null {
  return cachedPin;
}

export function unlock(pin: string): void {
  cachedPin = pin;
  lastActivity = nowMs();
  startTimer();
  emit();
}

export function lock(): void {
  if (cachedPin === null) return;
  cachedPin = null;
  emit();
}

/** Reset the inactivity countdown; called on user interaction. */
export function touch(): void {
  if (cachedPin !== null) lastActivity = nowMs();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function nowMs(): number {
  return Date.now();
}

function startTimer(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    if (cachedPin !== null && nowMs() - lastActivity > INACTIVITY_MS) lock();
  }, 5_000);
}

// Lock immediately when the app is backgrounded (task switcher, screen off).
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") lock();
  });
}
