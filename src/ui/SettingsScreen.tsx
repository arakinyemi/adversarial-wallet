// Non-secret configuration only. Secrets have their own sealed paths and
// never appear on this screen.

import { useState } from "react";
import type { KeyValueBackend } from "../storage";
import { Card, ErrorBanner, Field, SuccessBanner, errorMessage } from "./components";
import { saveConfig, type WalletConfig } from "./wallet-config";

export function SettingsScreen({
  backend,
  config,
  onChange,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
  onChange: (next: WalletConfig) => void;
}) {
  const [draft, setDraft] = useState<WalletConfig>(config);
  const [owners, setOwners] = useState(config.safeOwners.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

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
    <>
      <ErrorBanner error={error} />
      <SuccessBanner message={saved} />
      <Card title="Network">
        <Field label="Bitcoin network" hint="Also selects Base vs Base Sepolia.">
          <select
            value={draft.network}
            onChange={(e) => set("network", e.target.value as WalletConfig["network"])}
          >
            <option value="testnet">testnet</option>
            <option value="mainnet">mainnet</option>
          </select>
        </Field>
        <Field label="Esplora endpoint">
          <input value={draft.esploraUrl} onChange={(e) => set("esploraUrl", e.target.value)} spellCheck={false} />
        </Field>
      </Card>
      <Card title="Lightning (LNbits)">
        <Field label="LNbits URL">
          <input value={draft.lnbitsUrl} onChange={(e) => set("lnbitsUrl", e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Invoice key" hint="Read/receive only. The admin key is sealed from the Lightning screen, never stored here.">
          <input value={draft.lnbitsInvoiceKey} onChange={(e) => set("lnbitsInvoiceKey", e.target.value)} spellCheck={false} autoComplete="off" />
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
      <button className="primary" onClick={() => void save()}>
        Save settings
      </button>
    </>
  );
}
