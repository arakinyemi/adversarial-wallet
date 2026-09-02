// Lock gate: cold start, inactivity, or backgrounding. The PIN check is a
// real decryption of a stored secret (wiped immediately); only the PIN is
// cached for the session, never a decrypted key. When fingerprint unlock is
// enabled, the biometric releases the PIN from the hardware Keystore and it
// flows through the exact same decryption check — the keypad always remains
// as fallback.

import { useEffect, useRef, useState } from "react";
import { ShieldMark } from "./ShieldMark";
import { openSecret, type KeyValueBackend } from "../storage";
import { biometricUnlock } from "./biometric";
import { errorMessage } from "./components";
import { PinPad } from "./PinPad";
import { unlock } from "./session-lock";
import { BTC_ENTROPY_KEY } from "./SetupFlow";

export function UnlockScreen({
  backend,
  biometricEnabled,
}: {
  backend: KeyValueBackend;
  biometricEnabled: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoPrompted = useRef(false);

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

  const useFingerprint = async () => {
    setError(null);
    try {
      const pin = await biometricUnlock();
      await submit(pin);
    } catch (e) {
      // A dismissed prompt is not an error worth shouting about; other
      // failures are shown and the keypad is right there.
      const message = errorMessage(e);
      if (/credential/i.test(message)) {
        setError("Fingerprint needs to be set up again — unlock with your PIN, then re-enable it in Settings.");
      } else if (!/cancel/i.test(message)) {
        setError(message);
      }
    }
  };

  useEffect(() => {
    if (biometricEnabled && !autoPrompted.current) {
      autoPrompted.current = true;
      void useFingerprint();
    }
  }, [biometricEnabled]);

  return (
    <div className="screen">
      <div className="grow center" style={{ alignItems: "center", textAlign: "center" }}>
        <ShieldMark size={30} />
        <div className="h1">Aegis</div>
        <div className="sub">{busy ? "Checking…" : "Enter your PIN"}</div>
        {error !== null && (
          <div className="mono" style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>
        )}
        {biometricEnabled && (
          <button className="btn ghost small" style={{ maxWidth: 240 }} onClick={() => void useFingerprint()}>
            Use fingerprint
          </button>
        )}
      </div>
      <PinPad onComplete={(pin) => void submit(pin)} disabled={busy} />
    </div>
  );
}
