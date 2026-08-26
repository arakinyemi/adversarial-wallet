// Lock gate: cold start, inactivity, or backgrounding. The PIN check is a
// real decryption of a stored secret (wiped immediately); only the PIN is
// cached for the session, never a decrypted key.

import { useState } from "react";
import { openSecret, type KeyValueBackend } from "../storage";
import { errorMessage } from "./components";
import { PinPad } from "./PinPad";
import { unlock } from "./session-lock";
import { BTC_ENTROPY_KEY } from "./SetupFlow";

export function UnlockScreen({ backend }: { backend: KeyValueBackend }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (pin: string) => {
    setError(null);
    setBusy(true);
    try {
      const secret = await openSecret(backend, BTC_ENTROPY_KEY, pin);
      secret.fill(0);
      unlock(pin);
    } catch (e) {
      setError(
        errorMessage(e).startsWith("decryption failed") ? "Incorrect PIN." : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="grow center" style={{ alignItems: "center", textAlign: "center" }}>
        <div className="mark" />
        <div className="h1">Cairn</div>
        <div className="sub">{busy ? "Checking…" : "Enter your PIN"}</div>
        {error !== null && (
          <div className="mono" style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>
        )}
      </div>
      <PinPad onComplete={(pin) => void submit(pin)} disabled={busy} />
    </div>
  );
}
