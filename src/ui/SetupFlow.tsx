// Wallet onboarding: welcome → create or restore.
//
// Create: PIN → dice ceremony → back up 24 words → verification quiz →
// passphrase → ready. Restore: PIN → enter 24 words → passphrase → ready.
//
// Security invariants carried by this flow:
// - The mnemonic and passphrase live only in component state and are wiped
//   when the flow completes, goes back, or errors.
// - The passphrase is entered twice and never persisted anywhere.
// - Quiz word positions come from the health-checked platform draw with
//   rejection sampling — Math.random is banned repo-wide, UI included.
// - Restore accepts exactly 24 words, same policy as generation.

import { useState } from "react";
import {
  account_xpub_js,
  entropy_to_mnemonic_js,
  mnemonic_to_entropy_js,
  xpub_to_address_js,
} from "../../core/pkg/adversarial_core";
import { drawPlatformEntropy, generateSeedEntropy, MIN_DICE_ROLLS } from "../entropy";
import { sealSecret, type KeyValueBackend } from "../storage";
import { Card, ErrorBanner, Field, errorMessage } from "./components";
import { DicePad } from "./DicePad";
import type { WalletConfig } from "./wallet-config";

export const BTC_ENTROPY_KEY = "wallet.btc-entropy.v1";

type Screen =
  | "welcome"
  | "pin"
  | "dice"
  | "backup"
  | "verify"
  | "restore-words"
  | "passphrase"
  | "done";

const CREATE_STEPS: Screen[] = ["pin", "dice", "backup", "verify", "passphrase"];
const RESTORE_STEPS: Screen[] = ["pin", "restore-words", "passphrase"];

const QUIZ_WORDS = 3;

/** Distinct word positions from the platform CSPRNG (never Math.random),
 * rejection-sampled so the modulo is unbiased. */
function pickQuizIndices(count: number, max: number): number[] {
  const limit = Math.floor(256 / max) * max;
  const picked: number[] = [];
  while (picked.length < count) {
    for (const byte of drawPlatformEntropy()) {
      if (picked.length >= count) break;
      if (byte >= limit) continue;
      const index = byte % max;
      if (!picked.includes(index)) picked.push(index);
    }
  }
  return picked.sort((a, b) => a - b);
}

function Steps({ path, screen }: { path: Screen[]; screen: Screen }) {
  const at = path.indexOf(screen);
  return (
    <div className="steps">
      {path.map((s, i) => (
        <span key={s} className={i < at ? "dot done" : i === at ? "dot active" : "dot"} />
      ))}
    </div>
  );
}

export function SetupFlow({
  backend,
  config,
  onComplete,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
  onComplete: (xpub: string) => void;
}) {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [path, setPath] = useState<"create" | "restore">("create");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [dice, setDice] = useState("");
  const [entropy, setEntropy] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [report, setReport] = useState<string[]>([]);
  const [mnemonic, setMnemonic] = useState("");
  const [backedUp, setBackedUp] = useState(false);
  const [quizIndices, setQuizIndices] = useState<number[]>([]);
  const [quizAnswers, setQuizAnswers] = useState<string[]>([]);
  const [restoreWords, setRestoreWords] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [xpub, setXpub] = useState("");
  const [firstAddress, setFirstAddress] = useState("");

  const steps = path === "create" ? CREATE_STEPS : RESTORE_STEPS;
  const diceClean = dice.replace(/[^1-6]/g, "");

  const wipeSecrets = () => {
    entropy?.fill(0);
    setEntropy(null);
    setMnemonic("");
    setPassphrase("");
    setPassphraseConfirm("");
    setQuizAnswers([]);
    setRestoreWords("");
  };

  const go = (next: Screen) => {
    setError(null);
    setScreen(next);
  };

  const start = (chosen: "create" | "restore") => {
    setPath(chosen);
    go("pin");
  };

  const confirmPin = () => {
    setError(null);
    if (pin.length < 6) return setError("PIN must be at least 6 characters.");
    if (pin !== pinConfirm) return setError("PINs do not match.");
    go(path === "create" ? "dice" : "restore-words");
  };

  const generate = () => {
    setError(null);
    try {
      const result = generateSeedEntropy(diceClean);
      setEntropy(result.entropy as Uint8Array<ArrayBuffer>);
      setReport(
        result.report.sources.map((s) =>
          s.rolls !== undefined
            ? `Your dice rolls (${s.rolls}) — ${s.bytes} bytes`
            : `Device secure random — ${s.bytes} bytes`,
        ),
      );
      setMnemonic(entropy_to_mnemonic_js(result.entropy));
      go("backup");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const toQuiz = () => {
    setQuizIndices(pickQuizIndices(QUIZ_WORDS, 24));
    setQuizAnswers(Array.from({ length: QUIZ_WORDS }, () => ""));
    go("verify");
  };

  const checkQuiz = () => {
    setError(null);
    const words = mnemonic.split(" ");
    for (let i = 0; i < quizIndices.length; i++) {
      if (quizAnswers[i]!.trim().toLowerCase() !== words[quizIndices[i]!]) {
        setQuizAnswers(Array.from({ length: QUIZ_WORDS }, () => ""));
        return setError(
          "One or more words did not match. Check your paper backup — it is the only copy.",
        );
      }
    }
    go("passphrase");
  };

  const confirmRestoreWords = () => {
    setError(null);
    try {
      const normalized = restoreWords.trim().toLowerCase().split(/\s+/).join(" ");
      const restored = new Uint8Array(mnemonic_to_entropy_js(normalized)) as Uint8Array<ArrayBuffer>;
      setEntropy(restored);
      setMnemonic(normalized);
      go("passphrase");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const finish = async () => {
    setError(null);
    if (passphrase === "") return setError("A passphrase is required by this wallet's design.");
    if (passphrase !== passphraseConfirm) return setError("Passphrases do not match.");
    if (entropy === null) return setError("No entropy present; restart setup.");
    setBusy(true);
    try {
      // xpub of the PASSPHRASE wallet: this is what watch-only follows, so
      // funds sent here are spendable only with the passphrase.
      const derivedXpub = account_xpub_js(mnemonic, passphrase, config.network);
      await sealSecret(backend, BTC_ENTROPY_KEY, entropy, pin);
      setXpub(derivedXpub);
      setFirstAddress(xpub_to_address_js(derivedXpub, config.network, 0, 0));
      go("done");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      wipeSecrets();
      setPin("");
      setPinConfirm("");
    }
  };

  return (
    <>
      {screen !== "welcome" && screen !== "done" && <Steps path={steps} screen={screen} />}
      <ErrorBanner error={error} />

      {screen === "welcome" && (
        <div className="hero">
          <div className="hero-mark">₿</div>
          <h1>Adversarial Wallet</h1>
          <p className="muted">
            Bitcoin, Lightning, and a 2-of-3 Safe on Base. Built so that
            nothing stored on this device is enough to move funds.
          </p>
          <div className="spacer" />
          <button className="primary" onClick={() => start("create")}>
            Create new wallet
          </button>
          <button className="secondary" onClick={() => start("restore")}>
            Restore from recovery phrase
          </button>
        </div>
      )}

      {screen === "pin" && (
        <Card title="Choose a PIN">
          <p className="muted">
            Your PIN protects the wallet on this device. You will enter it
            when sending funds.
          </p>
          <div className="spacer" />
          <Field label="PIN (min 6 characters)">
            <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="Confirm PIN">
            <input type="password" inputMode="numeric" autoComplete="off" value={pinConfirm} onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <button className="primary" onClick={confirmPin}>Continue</button>
          <button className="secondary" onClick={() => { setPin(""); setPinConfirm(""); go("welcome"); }}>
            Back
          </button>
        </Card>
      )}

      {screen === "dice" && (
        <Card title="Add dice randomness">
          <p className="muted">
            Grab a real die, roll it at least {MIN_DICE_ROLLS} times, and tap
            each result below. Mixing your physical rolls into the seed means
            your wallet stays safe even if this device's random generator is
            ever compromised.
          </p>
          <div className="spacer" />
          <DicePad value={diceClean} min={MIN_DICE_ROLLS} onChange={setDice} />
          <button className="primary" disabled={diceClean.length < MIN_DICE_ROLLS} onClick={generate}>
            Create my wallet
          </button>
          <button className="secondary" onClick={() => { setDice(""); go("pin"); }}>Back</button>
        </Card>
      )}

      {screen === "backup" && (
        <>
          <Card title="Where your randomness came from">
            {report.map((line) => (
              <div key={line} className="muted">{line}</div>
            ))}
          </Card>
          <Card title="Write down your recovery phrase">
            <div className="words">
              {mnemonic.split(" ").map((word, i) => (
                <span className="word" key={i}>
                  <b>{i + 1}</b>
                  {word}
                </span>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} />
              I wrote all 24 words on paper, in order. They are shown only
              once, and I will keep them somewhere safe.
            </label>
            <button className="primary" disabled={!backedUp} onClick={toQuiz}>
              Verify my backup
            </button>
          </Card>
        </>
      )}

      {screen === "verify" && (
        <Card title="Confirm your backup">
          <p className="muted">
            Enter the requested words from your paper backup. This catches a
            wrong or incomplete backup now, while it can still be fixed.
          </p>
          <div className="spacer" />
          {quizIndices.map((wordIndex, i) => (
            <Field key={wordIndex} label={`Word #${wordIndex + 1}`}>
              <input
                autoComplete="off"
                spellCheck={false}
                value={quizAnswers[i] ?? ""}
                onChange={(e) => {
                  const next = [...quizAnswers];
                  next[i] = e.target.value;
                  setQuizAnswers(next);
                }}
              />
            </Field>
          ))}
          <button
            className="primary"
            disabled={quizAnswers.some((a) => a.trim() === "")}
            onClick={checkQuiz}
          >
            Confirm
          </button>
          <button className="secondary" onClick={() => go("backup")}>
            Show the words again
          </button>
        </Card>
      )}

      {screen === "restore-words" && (
        <Card title="Enter your recovery phrase">
          <p className="muted">
            Type the 24 words in order, separated by spaces. This wallet uses
            24-word phrases only.
          </p>
          <div className="spacer" />
          <Field label="Recovery phrase">
            <textarea rows={4} value={restoreWords} onChange={(e) => setRestoreWords(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" />
          </Field>
          <button className="primary" onClick={confirmRestoreWords}>Continue</button>
          <button className="secondary" onClick={() => { setRestoreWords(""); go("pin"); }}>Back</button>
        </Card>
      )}

      {screen === "passphrase" && (
        <Card title={path === "create" ? "Choose a passphrase" : "Enter your passphrase"}>
          <p className="muted">
            Your passphrase is the key to spending. It is never saved anywhere
            — memorize it. If it is lost or mistyped it cannot be recovered,
            which is why you enter it twice.
          </p>
          <div className="spacer" />
          <Field label="Passphrase">
            <input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
          <Field label="Confirm passphrase">
            <input type="password" autoComplete="off" value={passphraseConfirm} onChange={(e) => setPassphraseConfirm(e.target.value)} />
          </Field>
          <button className="primary" disabled={busy} onClick={() => void finish()}>
            {busy ? "Sealing…" : path === "create" ? "Finish setup" : "Restore wallet"}
          </button>
        </Card>
      )}

      {screen === "done" && (
        <div className="hero">
          <div className="hero-mark ok">✓</div>
          <h1>Wallet ready</h1>
          <p className="muted">
            Your wallet is set up and encrypted on this device. Remember:
            your passphrase lives only in your head. Here is your first
            receive address:
          </p>
          <div className="card mono" style={{ wordBreak: "break-all" }}>{firstAddress}</div>
          <button className="primary" onClick={() => onComplete(xpub)}>
            Open wallet
          </button>
        </div>
      )}
    </>
  );
}
