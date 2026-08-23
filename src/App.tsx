import { useEffect, useState } from "react";
import wasmUrl from "../core/pkg/adversarial_core_bg.wasm?url";
import { initEntropyCore } from "./entropy";
import type { KeyValueBackend } from "./storage";
import { preferencesBackend } from "./storage/preferences-backend";
import { BitcoinScreen } from "./ui/BitcoinScreen";
import { errorMessage } from "./ui/components";
import { LightningScreen } from "./ui/LightningScreen";
import { SafeScreen } from "./ui/SafeScreen";
import { SettingsScreen } from "./ui/SettingsScreen";
import { SetupFlow } from "./ui/SetupFlow";
import { loadConfig, type WalletConfig } from "./ui/wallet-config";

type Tab = "bitcoin" | "lightning" | "safe" | "settings";

const backend: KeyValueBackend = preferencesBackend;

export default function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [config, setConfig] = useState<WalletConfig | null>(null);
  const [tab, setTab] = useState<Tab>("bitcoin");

  useEffect(() => {
    void (async () => {
      try {
        await initEntropyCore({ module_or_path: wasmUrl });
        setConfig(await loadConfig(backend));
        setReady(true);
      } catch (e) {
        // Fail closed and visibly: without the core there is no wallet.
        setFatal(errorMessage(e));
      }
    })();
  }, []);

  if (fatal !== null) {
    return (
      <div className="app">
        <div className="app-title">Adversarial Wallet</div>
        <div className="banner error">Startup failed: {fatal}</div>
      </div>
    );
  }
  if (!ready || config === null) {
    return (
      <div className="app">
        <div className="app-title">Adversarial Wallet</div>
        <div className="muted">Loading core…</div>
      </div>
    );
  }

  const needsSetup = config.xpub === "";

  return (
    <div className="app">
      <div className="app-title">Adversarial Wallet</div>
      {needsSetup && tab !== "settings" ? (
        <SetupFlow
          backend={backend}
          config={config}
          onComplete={(xpub) => setConfig({ ...config, xpub })}
        />
      ) : (
        <>
          {tab === "bitcoin" && <BitcoinScreen backend={backend} config={config} />}
          {tab === "lightning" && <LightningScreen backend={backend} config={config} />}
          {tab === "safe" && <SafeScreen backend={backend} config={config} />}
          {tab === "settings" && (
            <SettingsScreen backend={backend} config={config} onChange={setConfig} />
          )}
        </>
      )}
      {!needsSetup && (
        <nav className="tabbar">
          {(["bitcoin", "lightning", "safe", "settings"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "bitcoin" ? "Bitcoin" : t === "lightning" ? "Lightning" : t === "safe" ? "Safe" : "Settings"}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
