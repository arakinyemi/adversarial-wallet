// Settings: appearance and security only. Everything applies instantly —
// no Save button. Network was fixed at wallet creation; the savings account
// links through its own guided flow; secrets never appear here.

import { useEffect, useState } from "react";
import type { KeyValueBackend } from "../storage";
import type { Route } from "../App";
import { biometricAvailable, disableBiometricUnlock, enableBiometricUnlock } from "./biometric";
import { Card, ErrorBanner, errorMessage } from "./components";
import { FloatingNav } from "./FloatingNav";
import { getSessionPin, lock } from "./session-lock";
import { saveConfig, type WalletConfig } from "./wallet-config";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function SettingsScreen({
  backend,
  config,
  onChange,
  go,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
  onChange: (next: WalletConfig) => void;
  go: (r: Route) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);

  useEffect(() => {
    void biometricAvailable().then(setBioAvailable);
  }, []);

  const setTheme = async (theme: WalletConfig["theme"]) => {
    setError(null);
    const next = { ...config, theme };
    onChange(next);
    try {
      await saveConfig(backend, next);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

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

  return (
    <div className="screen with-nav">
      <div className="micro dim">Settings</div>
      <div className="h1" style={{ marginTop: 10, fontSize: 24 }}>Make it yours</div>
      <div className="spacer" />
      <ErrorBanner error={error} />
      <Card title="Appearance">
        <div className="seg">
          <button className={config.theme === "dark" ? "on" : ""} onClick={() => void setTheme("dark")}>
            <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
            Dark
          </button>
          <button className={config.theme === "light" ? "on" : ""} onClick={() => void setTheme("light")}>
            <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            Light
          </button>
        </div>
      </Card>
      <Card title="Security">
        <p className="muted">
          The app locks itself after two minutes of inactivity or when you
          switch away.
        </p>
        <div className="spacer" />
        <button className="btn ghost small" onClick={() => lock()}>
          Lock now
        </button>
        {bioAvailable && (
          <>
            <div className="spacer" />
            <button className="btn ghost small" disabled={bioBusy} onClick={() => void toggleBiometric()}>
              {bioBusy
                ? "Confirming…"
                : config.biometricUnlock
                  ? "Turn off fingerprint unlock"
                  : "Turn on fingerprint unlock"}
            </button>
          </>
        )}
      </Card>
      <div className="faint" style={{ marginTop: 4 }}>
        This wallet lives on {config.network === "mainnet" ? "the real Bitcoin network" : "the test network"}.
      </div>
      <FloatingNav at="settings" go={go} />
    </div>
  );
}
