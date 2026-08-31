// Non-secret configuration only. Secrets have their own sealed paths and
// never appear on this screen.

import { useEffect, useState } from "react";
import type { KeyValueBackend } from "../storage";
import { biometricAvailable, disableBiometricUnlock, enableBiometricUnlock } from "./biometric";
import { Card, ErrorBanner, Field, SuccessBanner, TopBar, errorMessage } from "./components";
import { getSessionPin, lock } from "./session-lock";
import { saveConfig, type WalletConfig } from "./wallet-config";

export function SettingsScreen({
  backend,
  config,
  onChange,
  onHome,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
  onChange: (next: WalletConfig) => void;
  onHome: () => void;
}) {
  const [draft, setDraft] = useState<WalletConfig>(config);
  const [owners, setOwners] = useState(config.safeOwners.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);

  useEffect(() => {
    void biometricAvailable().then(setBioAvailable);
  }, []);

  const toggleBiometric = async () => {
    setError(null);
    setBioBusy(true);
    try {
      if (config.biometricUnlock) {
        await disableBiometricUnlock();
      } else {
        const pin = getSessionPin();
        if (pin === null) throw new Error("Session locked; reopen the app to unlock.");
        // Prompt first; a failed or dismissed prompt stores nothing.
        await enableBiometricUnlock(pin);
      }
      const next = { ...config, biometricUnlock: !config.biometricUnlock };
      await saveConfig(backend, next);
      onChange(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBioBusy(false);
    }
  };

  const save = async () => {
    setError(null);
    setSaved(null);
    try {
      const next: WalletConfig = {
        ...draft,
        safeOwners: owners
          .split("\n")
          .map((o) => o.trim())
          .filter((o) => o !== ""),
      };
      await saveConfig(backend, next);
      onChange(next);
      setSaved("Settings saved.");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const set = <K extends keyof WalletConfig>(key: K, value: WalletConfig[K]) =>
    setDraft({ ...draft, [key]: value });

  return (
    <div className="screen">
      <TopBar title="Settings" onBack={onHome} />
      <div className="spacer" />
      <ErrorBanner error={error} />
      <SuccessBanner message={saved} />
      <Card title="Appearance">
        <Field label="Theme">
          <select
            value={draft.theme}
            onChange={(e) => set("theme", e.target.value as WalletConfig["theme"])}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </Field>
      </Card>
      <Card title="Safe on Base">
        <Field label="Safe address">
          <input value={draft.safeAddress} onChange={(e) => set("safeAddress", e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Expected owners (one per line, exactly three)">
          <textarea rows={3} value={owners} onChange={(e) => setOwners(e.target.value)} spellCheck={false} />
        </Field>
      </Card>
      <button className="btn primary" onClick={() => void save()}>
        Save settings
      </button>
      <Card title="Security">
        <p className="muted">
          The app locks itself after two minutes of inactivity or when you
          switch away. Lock it now to require your PIN again.
        </p>
        <div className="spacer" />
        <button className="btn ghost small" onClick={() => lock()}>
          Lock now
        </button>
        <div className="spacer" />
        {bioAvailable && (
          <button className="btn ghost small" disabled={bioBusy} onClick={() => void toggleBiometric()}>
            {bioBusy
              ? "Confirming…"
              : config.biometricUnlock
                ? "Turn off fingerprint unlock"
                : "Turn on fingerprint unlock"}
          </button>
        )}
      </Card>
    </div>
  );
}
