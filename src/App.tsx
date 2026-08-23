import { useEffect, useState } from "react";
import init, { round_trip } from "../core/pkg/adversarial_core";
import wasmUrl from "../core/pkg/adversarial_core_bg.wasm?url";

export default function App() {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    init({ module_or_path: wasmUrl })
      .then(() => setResult(round_trip("boundary")))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>Adversarial Wallet</h1>
      <p>WASM boundary check: {error ?? result ?? "loading…"}</p>
    </main>
  );
}
