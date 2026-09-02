// Onboarding, following the Aegis design prototype: welcome → PIN (keypad,
// set then confirm) → tier → [dice] → words → quiz → passphrase (ack +
// hold-to-commit) → ready. Restore: welcome → words → PIN → passphrase.
//
// Security invariants (unchanged from previous flows):
// - Mnemonic and passphrase live only in component state; wiped on finish.
// - Passphrase entered twice, never persisted, no recovery affordance.
// - Quiz positions from the health-checked platform draw (never
//   Math.random), rejection-sampled.
// - Restore accepts exactly 24 words. Quick/advanced tiers are separate
//   code paths with no fallback between them.

import { useState } from "react";
import { ShieldMark } from "./ShieldMark";
import {
  account_xpub_js,
  entropy_to_mnemonic_js,
  mnemonic_to_entropy_js,
  xpub_to_address_js,
} from "../../core/pkg/adversarial_core";
import {
  drawPlatformEntropy,
  generateQuickSeedEntropy,
  generateSeedEntropy,
  MIN_DICE_ROLLS,
  type SeedEntropyResult,
} from "../entropy";
import { ESPLORA_MAINNET, ESPLORA_TESTNET } from "../btc";
import { sealSecret, type KeyValueBackend } from "../storage";
import { ErrorBanner, Segbar, errorMessage } from "./components";
import { DiceEntry } from "./DiceEntry";
import { HoldButton } from "./HoldButton";
import { PinPad } from "./PinPad";
import { unlock } from "./session-lock";
import { saveConfig, type WalletConfig } from "./wallet-config";

export const BTC_ENTROPY_KEY = "wallet.btc-entropy.v1";

type Screen =
  | "welcome" | "restore-words" | "pin" | "tier" | "dice"
  | "words" | "quiz" | "pass" | "ready";

const QUIZ_WORDS = 3;

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

export function SetupFlow({
  backend,
  config,
  onConfigChange,
  onComplete,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
  onConfigChange: (next: WalletConfig) => void;
  onComplete: (xpub: string) => void;
}) {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [path, setPath] = useState<"create" | "restore">("create");
  const [tier, setTier] = useState<"quick" | "advanced">("quick");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pinFirst, setPinFirst] = useState("");
  const [pinPhase, setPinPhase] = useState<"set" | "confirm">("set");
  const [pin, setPin] = useState("");
  const [dice, setDice] = useState("");
  const [entropy, setEntropy] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [report, setReport] = useState<string[]>([]);
  const [mnemonic, setMnemonic] = useState("");
  const [restoreText, setRestoreText] = useState("");
  const [quizPos, setQuizPos] = useState<number[]>([]);
  const [quizAt, setQuizAt] = useState(0);
  const [quizInput, setQuizInput] = useState("");
  const [quizFailed, setQuizFailed] = useState(false);
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [ack, setAck] = useState(false);
  const [xpub, setXpub] = useState("");
  const [firstAddress, setFirstAddress] = useState("");

  // Progress segments per path/tier.
  const steps: Screen[] =
    path === "restore"
      ? ["restore-words", "pin", "pass"]
      : tier === "advanced"
        ? ["pin", "tier", "dice", "words", "quiz", "pass"]
        : ["pin", "tier", "words", "quiz", "pass"];
  const stepAt = steps.indexOf(screen);
  const stepLabel = `Step ${stepAt + 1} of ${steps.length}`;

  const go = (next: Screen) => { setError(null); setScreen(next); };

  // The network must be chosen BEFORE the ceremony: derived keys and the
  // stored xpub are network-specific and cannot be switched afterwards.
  const toggleNetwork = () => {
    const network = config.network === "mainnet" ? "testnet" : "mainnet";
    const next: WalletConfig = {
      ...config,
      network,
      esploraUrl: network === "mainnet" ? ESPLORA_MAINNET : ESPLORA_TESTNET,
    };
    onConfigChange(next);
    void saveConfigSafe(next);
  };
  const saveConfigSafe = async (next: WalletConfig) => {
    try {
      await saveConfig(backend, next);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const wipeSecrets = () => {
    entropy?.fill(0);
    setEntropy(null);
    setMnemonic("");
    setP1(""); setP2("");
    setRestoreText("");
    setPinFirst("");
  };

  const acceptResult = (result: SeedEntropyResult) => {
    setEntropy(result.entropy as Uint8Array<ArrayBuffer>);
    setReport(
      result.report.sources.map((s) =>
        s.rolls !== undefined
          ? `Your dice rolls (${s.rolls})`
          : "This phone's secure generator",
      ),
    );
    setMnemonic(entropy_to_mnemonic_js(result.entropy));
    go("words");
  };

  const onPinEntry = (entered: string) => {
    setError(null);
    if (pinPhase === "set") {
      setPinFirst(entered);
      setPinPhase("confirm");
      return;
    }
    if (entered !== pinFirst) {
      setPinFirst("");
      setPinPhase("set");
      return setError("The PINs didn't match. Choose a PIN again.");
    }
    setPin(entered);
    if (path === "restore") {
      go("pass");
    } else {
      go("tier");
    }
  };

  const tierContinue = () => {
    setError(null);
    if (tier === "advanced") return go("dice");
    try {
      acceptResult(generateQuickSeedEntropy());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const diceContinue = () => {
    setError(null);
    try {
      acceptResult(generateSeedEntropy(dice));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const startQuiz = () => {
    setQuizPos(pickQuizIndices(QUIZ_WORDS, 24));
    setQuizAt(0);
    setQuizInput("");
    setQuizFailed(false);
    go("quiz");
  };

  const quizSubmit = () => {
    const words = mnemonic.split(" ");
    if (quizInput.trim().toLowerCase() !== words[quizPos[quizAt]!]) {
      setQuizFailed(true);
      setQuizInput("");
      return;
    }
    setQuizInput("");
    if (quizAt + 1 < quizPos.length) return setQuizAt(quizAt + 1);
    go("pass");
  };

  const confirmRestoreWords = () => {
    setError(null);
    try {
      const normalized = restoreText.trim().toLowerCase().split(/\s+/).join(" ");
      const restored = new Uint8Array(mnemonic_to_entropy_js(normalized)) as Uint8Array<ArrayBuffer>;
      setEntropy(restored);
      setMnemonic(normalized);
      setReport(["Restored from your recovery words"]);
      setPinPhase("set");
      go("pin");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const finish = async () => {
    setError(null);
    if (entropy === null) return setError("No entropy present; restart setup.");
    setBusy(true);
    try {
      // xpub of the PASSPHRASE wallet: watch-only follows this, so funds
      // sent here are spendable only with the passphrase.
      const derivedXpub = account_xpub_js(mnemonic, p1, config.network);
      await sealSecret(backend, BTC_ENTROPY_KEY, entropy, pin);
      unlock(pin);
      setXpub(derivedXpub);
      setFirstAddress(xpub_to_address_js(derivedXpub, config.network, 0, 0));
      go("ready");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      wipeSecrets();
    }
  };

  const restoreWordCount = restoreText.trim() === "" ? 0 : restoreText.trim().split(/\s+/).length;
  const passMatch = p1 !== "" && p1 === p2;
  const canCommit = passMatch && ack && !busy;

  return (
    <div className={`screen${screen === "pass" ? " deep" : ""}`}>
      {stepAt >= 0 && <Segbar total={steps.length} at={stepAt} />}
      <ErrorBanner error={error} />

      {screen === "welcome" && (
        <>
          <div className="grow center" style={{ gap: 18 }}>
            <ShieldMark size={34} />
            <div style={{ font: "600 40px/1.05 var(--font)", letterSpacing: "-0.02em" }}>Aegis</div>
            <div className="sub" style={{ maxWidth: 300 }}>
              A self-custody wallet. Your keys never leave this phone.
            </div>
          </div>
          <div className="stack">
            <button className="btn primary" onClick={() => { setPath("create"); setPinPhase("set"); go("pin"); }}>
              Create a new wallet
            </button>
            <button className="btn ghost" onClick={() => { setPath("restore"); go("restore-words"); }}>
              Restore from recovery words
            </button>
            <div className="micro" style={{ textAlign: "center", marginTop: 8 }}>
              Bitcoin · Lightning · Savings
            </div>
            <button className="linklike" onClick={toggleNetwork} style={{ marginTop: 4 }}>
              {config.network === "testnet" ? (
                <span style={{ color: "var(--amber)" }}>USING TEST COINS — tap for real Bitcoin</span>
              ) : (
                "test mode"
              )}
            </button>
          </div>
        </>
      )}

      {screen === "restore-words" && (
        <>
          <div className="micro">Restore</div>
          <div className="h1" style={{ marginTop: 14 }}>Enter your 24 recovery words</div>
          <div className="sub" style={{ marginTop: 8 }}>In order, separated by spaces.</div>
          <textarea
            rows={6}
            style={{ marginTop: 20 }}
            value={restoreText}
            onChange={(e) => setRestoreText(e.target.value)}
            placeholder="word word word …"
            autoComplete="off" spellCheck={false} autoCapitalize="none"
          />
          <div className="mono" style={{ marginTop: 10, fontSize: 12, color: restoreWordCount === 24 ? "var(--success)" : "var(--faint)" }}>
            {restoreWordCount} of 24 words
          </div>
          <div className="grow" />
          <button className="btn primary" disabled={restoreWordCount !== 24} onClick={confirmRestoreWords}>
            Continue
          </button>
          <button className="linklike" onClick={() => { setRestoreText(""); go("welcome"); }}>Back</button>
        </>
      )}

      {screen === "pin" && (
        <>
          <div className="micro">{stepLabel}</div>
          <div className="h1" style={{ marginTop: 14 }}>
            {pinPhase === "set" ? "Choose a 6-digit PIN" : "Enter it once more"}
          </div>
          <div className="sub" style={{ marginTop: 10 }}>
            Your PIN encrypts the wallet on this phone.
          </div>
          <div className="grow" />
          <PinPad key={pinPhase} onComplete={onPinEntry} />
        </>
      )}

      {screen === "tier" && (
        <>
          <div className="micro">{stepLabel}</div>
          <div className="h1" style={{ marginTop: 14 }}>Choose your setup</div>
          <button
            className="panel pad" onClick={() => setTier("quick")}
            style={{ marginTop: 24, cursor: "pointer", background: "none", textAlign: "left", width: "100%", borderColor: tier === "quick" ? "var(--accent)" : undefined, display: "flex", flexDirection: "column", gap: 8 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ font: "600 15px var(--font)", color: "var(--text)" }}>Standard</span>
              <span className="micro" style={{ color: "var(--success)" }}>Recommended</span>
            </div>
            <span className="sub" style={{ fontSize: 13 }}>Keys from this phone's secure generator. Ready now.</span>
          </button>
          <button
            className="panel pad" onClick={() => setTier("advanced")}
            style={{ marginTop: 12, cursor: "pointer", background: "none", textAlign: "left", width: "100%", borderColor: tier === "advanced" ? "var(--accent)" : undefined, display: "flex", flexDirection: "column", gap: 8 }}
          >
            <span style={{ font: "600 15px var(--font)", color: "var(--text)" }}>Advanced</span>
            <span className="sub" style={{ fontSize: 13 }}>
              You also roll a real die {MIN_DICE_ROLLS} times — then not even
              the phone's generator has to be trusted.
            </span>
          </button>
          <div className="faint" style={{ marginTop: 14 }}>Permanent for this wallet.</div>
          <div className="grow" />
          <button className="btn primary" onClick={tierContinue}>
            {tier === "quick" ? "Create my wallet" : "Continue to the dice"}
          </button>
        </>
      )}

      {screen === "dice" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="micro">{stepLabel}</span>
            <span className="mono" style={{ font: "600 13px var(--mono)", color: "var(--accent)" }}>
              {dice.length} / {MIN_DICE_ROLLS}
            </span>
          </div>
          <div className="h1" style={{ fontSize: 24, marginTop: 12 }}>
            Roll a physical die.<br />Enter each result.
          </div>
          <div className="sub" style={{ fontSize: 13.5, marginTop: 8 }}>
            Your rolls create the wallet's randomness.
          </div>
          <DiceEntry value={dice} min={MIN_DICE_ROLLS} onChange={(v) => setDice(v.replace(/[^1-6]/g, "").slice(0, 200))} />
          {dice.length >= MIN_DICE_ROLLS ? (
            <button className="btn primary" style={{ marginTop: 14 }} onClick={diceContinue}>
              All entries recorded — continue
            </button>
          ) : (
            <div className="faint" style={{ marginTop: 14, height: 54, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {MIN_DICE_ROLLS - dice.length} to go · about {Math.ceil((MIN_DICE_ROLLS - dice.length) / 30)} min
            </div>
          )}
        </>
      )}

      {screen === "words" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="micro">{stepLabel}</span>
            <span className="micro danger">Displayed once</span>
          </div>
          <div className="h1" style={{ fontSize: 24, marginTop: 12 }}>Write down all 24 words, in order</div>
          <div className="wordgrid">
            {mnemonic.split(" ").map((w, i) => (
              <span className="w" key={i}><b>{i + 1}</b>{w}</span>
            ))}
          </div>
          <div className="grow" />
          <div className="faint" style={{ marginTop: 12 }}>
            On paper, kept offline. They are shown only this once and never
            leave the phone.
          </div>
          <button className="btn primary" style={{ marginTop: 10 }} onClick={startQuiz}>Done</button>
        </>
      )}

      {screen === "quiz" && (
        <>
          <div className="micro">{stepLabel}</div>
          <div className="h1" style={{ marginTop: 14 }}>Verify your record</div>
          <div className="sub" style={{ marginTop: 8 }}>Confirm a few words from your paper.</div>
          <div className="stack" style={{ marginTop: 24 }}>
            {quizPos.map((pos, i) => (
              <div key={pos} className={`quizslot${i < quizAt ? " done" : i > quizAt ? " off" : ""}`}>
                <span className="pos">Word {pos + 1}</span>
                <span className="word">{i < quizAt ? "••••••" : i === quizAt ? "" : " "}</span>
                {i < quizAt && <span className="check">✓</span>}
              </div>
            ))}
          </div>
          {!quizFailed ? (
            <div className="quizrow">
              <input
                value={quizInput}
                onChange={(e) => setQuizInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") quizSubmit(); }}
                placeholder={`word ${quizPos[quizAt]! + 1}`}
                autoCapitalize="none" autoComplete="off" spellCheck={false}
              />
              <button className="btn primary" onClick={quizSubmit}>Check</button>
            </div>
          ) : (
            <>
              <div className="banner error" style={{ marginTop: 16 }}>
                That word doesn't match. Check your paper — it is the only copy.
              </div>
              <button className="btn primary" onClick={() => go("words")}>Return to the words</button>
            </>
          )}
          <div className="grow" />
        </>
      )}

      {screen === "pass" && (
        <>
          <div className="micro">{stepLabel}</div>
          <div className="grow center">
            <div className="h1" style={{ maxWidth: 320 }}>The spending passphrase</div>
            <div className="stack" style={{ gap: 10, maxWidth: 330 }}>
              {[
                "Typed every time you spend Bitcoin.",
                "Never stored. It cannot be recovered.",
                "A typo opens a different, empty wallet.",
              ].map((t) => (
                <div key={t} style={{ display: "flex", gap: 12 }} className="body-dim">
                  <span style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>—</span>
                  <span>{t}</span>
                </div>
              ))}
            </div>
            <div className="stack" style={{ gap: 10 }}>
              <input type="password" value={p1} onChange={(e) => setP1(e.target.value)} placeholder="Passphrase" autoComplete="off" />
              <input type="password" value={p2} onChange={(e) => setP2(e.target.value)} placeholder="Type it again" autoComplete="off" />
              <div className="mono" style={{ fontSize: 11.5, color: passMatch ? "var(--success)" : "var(--faint)" }}>
                {p1 === "" && p2 === "" ? " " : passMatch ? "They match." : "Not matching yet."}
              </div>
            </div>
            <button className="ackbox" onClick={() => setAck(!ack)}>
              <span className="box">{ack ? "✓" : ""}</span>
              <span className="lbl">I understand it cannot be recovered.</span>
            </button>
          </div>
          <HoldButton
            label={busy ? "Sealing…" : "Hold to set the passphrase"}
            disabled={!canCommit}
            onCommit={() => void finish()}
          />
        </>
      )}

      {screen === "ready" && (
        <>
          <div className="grow center" style={{ gap: 24 }}>
            <div>
              <div className="mark ok" />
              <div className="h1 big" style={{ marginTop: 14 }}>The wallet is ready.</div>
            </div>
            <div className="panel pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="micro dim">Your keys were made from</div>
              {report.map((src) => (
                <div key={src} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <span className="body-dim">{src}</span>
                  <span className="mono" style={{ color: "var(--success)", fontWeight: 600 }}>✓</span>
                </div>
              ))}
            </div>
            <div>
              <div className="rowline" style={{ padding: "14px 0" }}>
                <span className="k">PIN</span><span className="v plain">set · encrypts this phone</span>
              </div>
              <div className="rowline" style={{ padding: "14px 0" }}>
                <span className="k">Passphrase</span>
                <span className="v" style={{ color: "var(--accent)" }}>in your head only</span>
              </div>
              <div className="rowline" style={{ padding: "14px 0" }}>
                <span className="k">First address</span>
                <span className="v plain mono" style={{ fontSize: 11 }}>{firstAddress}</span>
              </div>
            </div>
          </div>
          <button className="btn primary" onClick={() => onComplete(xpub)}>Open your wallet</button>
        </>
      )}
    </div>
  );
}
