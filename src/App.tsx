import { useEffect, useReducer, useState } from "react";
import wasmUrl from "../core/pkg/adversarial_core_bg.wasm?url";
import { initEntropyCore } from "./entropy";
import type { KeyValueBackend } from "./storage";
import { preferencesBackend } from "./storage/preferences-backend";
import { ActivityScreen } from "./ui/ActivityScreen";
import { BitcoinScreen } from "./ui/BitcoinScreen";
import { errorMessage } from "./ui/components";
import { HomeScreen } from "./ui/HomeScreen";
import { LightningScreen } from "./ui/LightningScreen";
import { SafeScreen } from "./ui/SafeScreen";
import { isUnlocked, subscribe, touch } from "./ui/session-lock";
import { SettingsScreen } from "./ui/SettingsScreen";
import { SetupFlow } from "./ui/SetupFlow";
import { UnlockScreen } from "./ui/UnlockScreen";
import { loadConfig, saveConfig, type WalletConfig } from "./ui/wallet-config";

export type Route = "home" | "activity" | "bitcoin" | "lightning" | "savings" | "settings";
/** Jump straight into a screen's send or receive view (home quick actions). */
export type Intent = "send" | "receive";

const backend: KeyValueBackend = preferencesBackend;

export default function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [config, setConfig] = useState<WalletConfig | null>(null);
  const [route, setRoute] = useState<Route>("home");
  const [intent, setIntent] = useState<Intent | null>(null);
  const [, forceLockState] = useReducer((x: number) => x + 1, 0);

  useEffect(() => subscribe(forceLockState), []);

  useEffect(() => {
    const onActivity = () => touch();
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, []);

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

  useEffect(() => {
    document.documentElement.dataset.theme = config?.theme ?? "dark";
  }, [config?.theme]);

  if (fatal !== null) {
    return (
      <div className="screen">
        <div className="grow center">
          <div className="mark bad" />
          <div className="h1">Startup failed</div>
          <div className="banner error">{fatal}</div>
        </div>
      </div>
    );
  }
  if (!ready || config === null) {
    return (
      <div className="screen">
        <div className="grow center" style={{ alignItems: "center" }}>
          <div className="mark" />
          <div className="sub">Loading…</div>
        </div>
      </div>
    );
  }

  const needsSetup = config.xpub === "";
  if (needsSetup) {
    return (
      <SetupFlow
        backend={backend}
        config={config}
        onConfigChange={setConfig}
        onComplete={(xpub) => {
          const next = { ...config, xpub };
          setConfig(next);
          // Persist, or onboarding would repeat on the next launch. A failed
          // save is surfaced, not swallowed — the wallet would be unusable.
          saveConfig(backend, next).catch((e: unknown) => setFatal(errorMessage(e)));
        }}
      />
    );
  }
  if (!isUnlocked()) {
    return <UnlockScreen backend={backend} biometricEnabled={config.biometricUnlock} />;
  }

  const go = (r: Route, i?: Intent) => {
    setIntent(i ?? null);
    setRoute(r);
  };
  const home = () => go("home");
  switch (route) {
    case "bitcoin":
      return <BitcoinScreen backend={backend} config={config} initialIntent={intent} onHome={home} />;
    case "lightning":
      return (
        <LightningScreen backend={backend} config={config} initialIntent={intent} onConfigChange={setConfig} onHome={home} />
      );
    case "savings":
      return <SafeScreen backend={backend} config={config} onConfigChange={setConfig} onHome={home} />;
    case "settings":
      return <SettingsScreen backend={backend} config={config} onChange={setConfig} go={go} />;
    case "activity":
      return <ActivityScreen config={config} go={go} />;
    default:
      return <HomeScreen config={config} go={go} />;
  }
}
