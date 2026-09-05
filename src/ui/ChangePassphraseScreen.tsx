// Same-seed passphrase rotation. A BIP39 passphrase cannot be changed in
// place: it derives the addresses, so "changing" it means moving every coin
// on-chain to the same seed under the new passphrase. This screen does that
// without a second device, because the seed already lives here and can
// derive the destination itself.
//
// Sequence: new passphrase (strength-enforced) → review the sweep with the
// derived destination shown → type the CURRENT passphrase → sign & broadcast
// → re-point the app to the new passphrase's xpub. The seed, PIN, and seal
// are untouched; only the tracked xpub changes.
//
// Security invariants:
// - Neither passphrase is persisted. The seed is unsealed only for the
//   duration of a derivation or a signature, then zeroed, exactly as the
//   ordinary send does.
// - The Rust signer's address interlock rejects a wrong current passphrase
//   before anything is signed, so a typo cannot broadcast.
// - The tracked xpub is re-pointed only AFTER a successful broadcast, and a
//   failure to persist that pointer is surfaced with the txid, never hidden.

import { useCallback, useEffect, useState } from "react";
import {
  account_xpub_js,
  entropy_to_mnemonic_js,
  sign_spend_js,
  xpub_to_address_js,
} from "../../core/pkg/adversarial_core";
import {
  broadcastTransaction,
  collectSpendableInputs,
  computeSweepAmount,
  estimateFeeSats,
  fetchFeeRate,
  scanWatchOnlyBalance,
  type SpendableInputs,
  type WatchOnlyBalance,
} from "../btc";
import { openSecret, type KeyValueBackend } from "../storage";
import { ErrorBanner, TopBar, errorMessage } from "./components";
import { formatSats, truncateMiddle } from "./format";
import { HoldButton } from "./HoldButton";
import { assessPassphrase } from "./passphrase-strength";
import { PassphraseMeter } from "./PassphraseMeter";
import { getSessionPin } from "./session-lock";
import { BTC_ENTROPY_KEY } from "./SetupFlow";
import { saveConfig, type WalletConfig } from "./wallet-config";

type Step = "intro" | "new" | "confirm" | "done";

interface PreparedSweep {
  inputs: SpendableInputs;
  feeSats: number;
  amountSats: bigint;
  newXpub: string;
  newAddress: string;
}

export function ChangePassphraseScreen({
  backend,
  config,
  onConfigChange,
  onHome,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
  onConfigChange: (next: WalletConfig) => void;
  onHome: () => void;
}) {
  const [step, setStep] = useState<Step>("intro");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState<WatchOnlyBalance | null>(null);
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [current, setCurrent] = useState("");
  const [prepared, setPrepared] = useState<PreparedSweep | null>(null);
  const [sentTxid, setSentTxid] = useState("");
  const [pointerError, setPointerError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      setBalance(
        await scanWatchOnlyBalance({
          esploraUrl: config.esploraUrl,
          xpub: config.xpub,
          network: config.network,
        }),
      );
    } catch (e) {
      setBalance(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [config]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const strength = assessPassphrase(p1);
  const newMatch = p1 !== "" && p1 === p2;
  const canContinueNew = newMatch && strength.acceptable && !busy;

  /** Derive the destination under the new passphrase and size the sweep.
   * The seed is unsealed only to derive the new xpub, then zeroed; only
   * public values are kept in state. */
  const prepare = async () => {
    if (balance === null) return;
    setError(null);
    setBusy(true);
    try {
      const pin = getSessionPin();
      if (pin === null) throw new Error("Session locked; reopen the app to unlock.");

      const entropy = await openSecret(backend, BTC_ENTROPY_KEY, pin);
      let newXpub: string;
      try {
        const mnemonic = entropy_to_mnemonic_js(entropy);
        newXpub = account_xpub_js(mnemonic, p1, config.network);
      } finally {
        entropy.fill(0);
      }
      if (newXpub === config.xpub) {
        throw new Error("That is already your current passphrase. Choose a different one.");
      }
      const newAddress = xpub_to_address_js(newXpub, config.network, 0, 0);

      const inputs = await collectSpendableInputs(
        config.esploraUrl, config.xpub, config.network, balance.usedAddresses,
      );
      if (inputs.txids.length === 0) throw new Error("No confirmed coins to move yet.");
      const rate = await fetchFeeRate(config.esploraUrl);
      // One output, no change: the whole balance moves.
      const feeSats = estimateFeeSats(inputs.txids.length, 1, rate);
      const amountSats = computeSweepAmount(inputs.values, feeSats);

      setPrepared({ inputs, feeSats, amountSats, newXpub, newAddress });
      setStep("confirm");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** Sign the sweep with the CURRENT passphrase and, only after a successful
   * broadcast, re-point the tracked xpub to the new passphrase's wallet. */
  const moveAndRotate = async () => {
    if (prepared === null) return;
    setError(null);
    setBusy(true);
    try {
      const pin = getSessionPin();
      if (pin === null) throw new Error("Session locked; reopen the app to unlock.");
      const entropy = await openSecret(backend, BTC_ENTROPY_KEY, pin);
      let hex: string;
      try {
        const mnemonic = entropy_to_mnemonic_js(entropy);
        const { inputs } = prepared;
        hex = sign_spend_js(
          mnemonic,
          current,
          config.network,
          inputs.txids.join("\n"),
          inputs.addresses.join("\n"),
          new Uint32Array(inputs.vouts),
          new BigUint64Array(inputs.values),
          new Uint32Array(inputs.chains),
          new Uint32Array(inputs.indexes),
          prepared.newAddress,
          prepared.amountSats,
          BigInt(prepared.feeSats),
          0,
        );
      } finally {
        entropy.fill(0);
      }
      const txid = await broadcastTransaction(config.esploraUrl, hex);
      setSentTxid(txid);

      // Broadcast succeeded: the coins are now under the new passphrase.
      // Re-point the app. In-memory first so this session is correct even
      // if persistence fails; a persistence failure is shown, not swallowed.
      const next: WalletConfig = { ...config, xpub: prepared.newXpub };
      onConfigChange(next);
      try {
        await saveConfig(backend, next);
      } catch (e) {
        setPointerError(errorMessage(e));
      }
      setStep("done");
    } catch (e) {
      const message = errorMessage(e);
      setError(
        message.includes("wrong passphrase")
          ? "That isn't your current passphrase. Nothing was signed or sent."
          : message,
      );
    } finally {
      // Neither passphrase survives the attempt.
      setCurrent("");
      setP1("");
      setP2("");
      setBusy(false);
    }
  };

  if (step === "done") {
    return (
      <div className="screen">
        <div className="grow center">
          <div className="mark ok" />
          <div className="h1 big">Passphrase changed.</div>
          <div className="body-dim" style={{ maxWidth: 320, fontSize: 14, lineHeight: 1.7 }}>
            Your Bitcoin is moving to the same seed under the new passphrase.
            From now on only the new passphrase spends it. The old one opens
            an empty wallet.
          </div>
          <div className="panel">
            <div className="rowline"><span className="k">Moved</span><span className="v">{prepared !== null ? formatSats(Number(prepared.amountSats)) : "—"}</span></div>
            <div className="rowline"><span className="k">Fee</span><span className="v">{prepared !== null ? formatSats(prepared.feeSats) : "—"}</span></div>
            <div className="rowline"><span className="k">Transaction</span><span className="v plain mono" style={{ fontSize: 11 }}>{truncateMiddle(sentTxid, 10)}</span></div>
          </div>
          {pointerError !== null && (
            <div className="banner error" style={{ marginTop: 12 }}>
              The coins moved, but this phone could not save the new wallet
              pointer ({pointerError}). If your balance looks empty after
              reopening, restore from your 24 words with the NEW passphrase.
            </div>
          )}
        </div>
        <button className="btn primary" onClick={onHome}>Done</button>
      </div>
    );
  }

  if (step === "confirm" && prepared !== null) {
    return (
      <div className="screen deep">
        <TopBar title="Confirm the move" onBack={() => { setCurrent(""); setPrepared(null); setStep("new"); }} />
        <ErrorBanner error={error} />
        <div className="panel" style={{ marginTop: 20 }}>
          <div className="rowline"><span className="k">Moving</span><span className="v">{formatSats(Number(prepared.amountSats))}</span></div>
          <div className="rowline"><span className="k">Fee</span><span className="v">{formatSats(prepared.feeSats)}</span></div>
          <div className="rowline"><span className="k">New address</span><span className="v plain mono" style={{ fontSize: 12 }}>{truncateMiddle(prepared.newAddress, 12)}</span></div>
        </div>
        <div className="faint" style={{ marginTop: 10 }}>
          The new address is derived from your same 24 words under the new
          passphrase. Every confirmed coin moves; nothing stays behind.
        </div>
        <div className="grow center" style={{ gap: 14 }}>
          <div style={{ font: "600 20px/1.3 var(--font)" }}>Type your current passphrase</div>
          <input
            type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
            placeholder="Current passphrase" autoComplete="off" style={{ borderColor: "var(--accent)" }}
          />
          <div className="faint">Authorises the move. Held only for this signature.</div>
        </div>
        <HoldButton
          label={busy ? "Signing…" : "Hold to move & change passphrase"}
          disabled={busy || current === ""}
          onCommit={() => void moveAndRotate()}
        />
      </div>
    );
  }

  if (step === "new") {
    return (
      <div className="screen deep">
        <TopBar title="New passphrase" onBack={() => { setP1(""); setP2(""); setStep("intro"); }} />
        <ErrorBanner error={error} />
        <div className="grow center">
          <div className="h1" style={{ maxWidth: 320 }}>Choose the new passphrase</div>
          <div className="stack" style={{ gap: 10, maxWidth: 330 }}>
            {[
              "Typed every time you spend Bitcoin.",
              "Never stored. It cannot be recovered.",
              "Your 24 words stay exactly the same.",
            ].map((t) => (
              <div key={t} style={{ display: "flex", gap: 12 }} className="body-dim">
                <span style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>—</span>
                <span>{t}</span>
              </div>
            ))}
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <input type="password" value={p1} onChange={(e) => setP1(e.target.value)} placeholder="New passphrase" autoComplete="off" />
            <input type="password" value={p2} onChange={(e) => setP2(e.target.value)} placeholder="Type it again" autoComplete="off" />
            <div className="mono" style={{ fontSize: 11.5, color: newMatch ? "var(--success)" : "var(--faint)" }}>
              {p1 === "" && p2 === "" ? " " : newMatch ? "They match." : "Not matching yet."}
            </div>
            <PassphraseMeter assessment={strength} />
          </div>
        </div>
        <button className="btn primary" disabled={!canContinueNew} onClick={() => void prepare()}>
          {busy ? "Preparing…" : "Continue"}
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      <TopBar title="Change passphrase" onBack={onHome} />
      <ErrorBanner error={error} />
      <div style={{ marginTop: 26 }}>
        <div className="h1" style={{ fontSize: 24 }}>Move your Bitcoin to a new passphrase</div>
        <div className="body-dim" style={{ marginTop: 12, fontSize: 14, lineHeight: 1.7 }}>
          A passphrase can't be edited in place: it is part of what makes
          your addresses. Changing it means sending every coin, on-chain, to
          the same seed under the new passphrase. This costs one network fee
          and needs your current passphrase to authorise it.
        </div>
      </div>
      <div className="panel" style={{ marginTop: 20 }}>
        <div className="rowline">
          <span className="k">To move</span>
          <span className="v">
            {balance === null ? (busy ? "checking…" : "—") : formatSats(balance.confirmedSats)}
          </span>
        </div>
        {balance !== null && balance.pendingSats !== 0 && (
          <div className="rowline">
            <span className="k">Not yet confirmed</span>
            <span className="v" style={{ color: "var(--amber)" }}>{formatSats(balance.pendingSats)}</span>
          </div>
        )}
      </div>
      {balance !== null && balance.pendingSats !== 0 && (
        <div className="faint" style={{ marginTop: 10 }}>
          Only confirmed coins move. Wait for pending coins to confirm, or
          they will stay under the old passphrase.
        </div>
      )}
      <div className="grow" />
      <button
        className="btn primary"
        disabled={busy || balance === null || balance.confirmedSats === 0}
        onClick={() => setStep("new")}
      >
        Continue
      </button>
    </div>
  );
}
