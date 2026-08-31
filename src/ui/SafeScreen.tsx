// Savings (2-of-3 Safe on Base). This phone holds one owner key of three;
// every send needs a second device. Propose here → payload travels by copy →
// approve there (or vice versa). The signing key has its own ceremony,
// independent of the Bitcoin seed; key bytes are unsealed per action and
// zeroed in finally.

import { useEffect, useState } from "react";
import { createPublicClient, formatEther, getAddress, http, parseEther, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { entropyToEvmSigner, verifySafeDeployment } from "../evm";
import { countersignAndExecute, proposeSafeSpend } from "../evm/spend";
import { generateQuickSeedEntropy, generateSeedEntropy, MIN_DICE_ROLLS } from "../entropy";
import { hasSecret, openSecret, sealSecret, type KeyValueBackend } from "../storage";
import { ErrorBanner, TopBar, errorMessage } from "./components";
import { DiceEntry } from "./DiceEntry";
import { getSessionPin } from "./session-lock";
import { truncateMiddle } from "./format";
import type { WalletConfig } from "./wallet-config";

export const EVM_SIGNER_KEY = "wallet.evm-signer-a.v1";

const toHex = (bytes: Uint8Array): Hex =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;

type View = "main" | "send" | "wait" | "approve" | "done";

export function SafeScreen({
  backend,
  config,
  onHome,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
  onHome: () => void;
}) {
  const [view, setView] = useState<View>("main");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signerSealed, setSignerSealed] = useState<boolean | null>(null);
  const [signerAddress, setSignerAddress] = useState<string | null>(null);
  const [dice, setDice] = useState("");
  const [useDice, setUseDice] = useState(false);
  const [verifiedLine, setVerifiedLine] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [sendTo, setSendTo] = useState("");
  const [sendEth, setSendEth] = useState("");
  const [proposal, setProposal] = useState<string | null>(null);
  const [incoming, setIncoming] = useState("");
  const [doneTx, setDoneTx] = useState("");
  const [copied, setCopied] = useState(false);

  const chain = config.network === "mainnet" ? base : baseSepolia;
  const rpcUrl = chain.rpcUrls.default.http[0]!;

  useEffect(() => {
    void hasSecret(backend, EVM_SIGNER_KEY).then(setSignerSealed);
  }, [backend]);

  const withSignerKey = async <T,>(fn: (key: Hex, address: string) => Promise<T>): Promise<T> => {
    const pin = getSessionPin();
    if (pin === null) throw new Error("Session locked; reopen the app to unlock.");
    const keyBytes = await openSecret(backend, EVM_SIGNER_KEY, pin);
    try {
      const account = entropyToEvmSigner(keyBytes as Uint8Array<ArrayBuffer>);
      return await fn(toHex(keyBytes), account.address);
    } finally {
      keyBytes.fill(0);
    }
  };

  const createSigner = async () => {
    setError(null);
    setBusy(true);
    try {
      const pin = getSessionPin();
      if (pin === null) throw new Error("Session locked; reopen the app to unlock.");
      const { entropy } = useDice ? generateSeedEntropy(dice) : generateQuickSeedEntropy();
      try {
        const account = entropyToEvmSigner(entropy as Uint8Array<ArrayBuffer>);
        await sealSecret(backend, EVM_SIGNER_KEY, entropy as Uint8Array<ArrayBuffer>, pin);
        setSignerAddress(account.address);
        setSignerSealed(true);
      } finally {
        entropy.fill(0);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDice("");
      setBusy(false);
    }
  };

  const verify = async () => {
    setError(null);
    setBusy(true);
    setVerifiedLine(null);
    try {
      if (config.safeOwners.length !== 3) {
        throw new Error("Add the Safe address and its three owners in Settings first.");
      }
      const client = createPublicClient({ chain, transport: http(rpcUrl) });
      const result = await verifySafeDeployment(
        client,
        config.safeAddress,
        config.safeOwners as unknown as readonly [string, string, string],
      );
      setVerifiedLine(`${result.owners.length} keys · ${result.threshold} approvals ✓`);
      setBalance(formatEther(await client.getBalance({ address: getAddress(config.safeAddress) })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const propose = async () => {
    setError(null);
    setBusy(true);
    try {
      const valueWei = parseEther(sendEth);
      if (valueWei <= 0n) throw new Error("Amount must be greater than zero.");
      const payload = await withSignerKey((key) =>
        proposeSafeSpend({
          rpcUrl, chain, safeAddress: config.safeAddress,
          signerKey: key, to: sendTo.trim(), valueWei,
        }),
      );
      setProposal(payload);
      setView("wait");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const approveAndSend = async () => {
    setError(null);
    setBusy(true);
    try {
      const { txHash } = await withSignerKey((key, address) =>
        countersignAndExecute({
          rpcUrl, chain, signerKey: key,
          localSignerAddress: address, proposalJson: incoming.trim(),
        }),
      );
      setDoneTx(txHash);
      setIncoming("");
      setView("done");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copyPayload = async () => {
    if (proposal === null) return;
    await navigator.clipboard.writeText(proposal);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // --- signer setup (first run on this device) ---
  if (signerSealed === false) {
    return (
      <div className="screen">
        <TopBar title="Savings · set up" onBack={onHome} />
        <ErrorBanner error={error} />
        <div className="h1" style={{ marginTop: 20, fontSize: 24 }}>Create this phone's signing key</div>
        <div className="sub" style={{ marginTop: 8 }}>
          Savings payments need approval from two devices. Each device has its
          own key.
        </div>
        <button className="ackbox" style={{ marginTop: 18, borderColor: "var(--border)" }} onClick={() => setUseDice(!useDice)}>
          <span className="box" style={{ borderColor: "var(--muted)", color: "var(--muted)" }}>{useDice ? "✓" : ""}</span>
          <span className="lbl">Advanced: mix in {MIN_DICE_ROLLS}+ physical dice rolls, like the advanced wallet setup.</span>
        </button>
        {useDice && (
          <DiceEntry value={dice} min={MIN_DICE_ROLLS} onChange={(v) => setDice(v.replace(/[^1-6]/g, "").slice(0, 200))} />
        )}
        {!useDice && <div className="grow" />}
        <button
          className="btn primary" style={{ marginTop: 14 }}
          disabled={busy || (useDice && dice.length < MIN_DICE_ROLLS)}
          onClick={() => void createSigner()}
        >
          {busy ? "Creating…" : "Create signing key"}
        </button>
      </div>
    );
  }

  if (view === "send") {
    return (
      <div className="screen">
        <TopBar title="Send from Savings" onBack={() => setView("main")} />
        <ErrorBanner error={error} />
        <div className="stack" style={{ marginTop: 24 }}>
          <div className="amountbox">
            <input inputMode="decimal" value={sendEth} onChange={(e) => setSendEth(e.target.value)} placeholder="0.00" autoComplete="off" />
            <span className="unit">ETH</span>
          </div>
          <input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="Address" spellCheck={false} autoComplete="off" style={{ fontSize: 13 }} />
        </div>
        <div className="faint" style={{ marginTop: 14 }}>
          This phone signs first. Your second device must approve.
        </div>
        <div className="grow" />
        <button className="btn primary" disabled={busy || sendEth === "" || sendTo.trim() === ""} onClick={() => void propose()}>
          {busy ? "Signing…" : "Sign on this phone"}
        </button>
      </div>
    );
  }

  if (view === "wait" && proposal !== null) {
    return (
      <div className="screen">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="topbar"><span className="title">Signed on this phone</span></span>
          <span className="micro accent">1 of 2</span>
        </div>
        <div className="mono" style={{ marginTop: 16, fontSize: 13, color: "var(--body)" }}>
          {sendEth} ETH → {truncateMiddle(sendTo.trim(), 10)}
        </div>
        <div className="panel pad" style={{ marginTop: 20, borderColor: "oklch(0.7 0.19 300 / .5)", display: "flex", flexDirection: "column", gap: 14 }}>
          <textarea rows={5} readOnly value={proposal} className="mono" style={{ fontSize: 10.5 }} onFocus={(e) => e.target.select()} />
          <div className="body-dim" style={{ fontSize: 12, textAlign: "center" }}>
            Copy this to your second device and approve it there.
          </div>
          <button className="btn ghost small" style={{ height: 44 }} onClick={() => void copyPayload()}>
            {copied ? "Copied" : "Copy the request"}
          </button>
        </div>
        <div className="statusdot" style={{ marginTop: 18, justifyContent: "flex-start" }}>
          <i className="warn" />
          waiting for approval · nothing has moved
        </div>
        <div className="grow" />
        <button className="linklike danger" onClick={() => { setProposal(null); setView("main"); }}>
          Done for now
        </button>
      </div>
    );
  }

  if (view === "approve") {
    return (
      <div className="screen">
        <TopBar title="Approve a send" onBack={() => setView("main")} />
        <ErrorBanner error={error} />
        <div className="sub" style={{ marginTop: 16 }}>
          Paste the request from the other device. Check the amount and
          address inside it — approving executes the payment.
        </div>
        <div className="stack" style={{ marginTop: 14 }}>
          <textarea rows={5} value={incoming} onChange={(e) => setIncoming(e.target.value)} placeholder="Paste the request" spellCheck={false} autoComplete="off" style={{ fontSize: 11 }} />
        </div>
        <div className="grow" />
        <button className="btn primary" disabled={busy || incoming.trim() === ""} onClick={() => void approveAndSend()}>
          {busy ? "Sending…" : "Approve and send"}
        </button>
      </div>
    );
  }

  if (view === "done") {
    return (
      <div className="screen">
        <div className="grow center">
          <div className="mark ok" />
          <div className="h1 big">Payment executed.</div>
          <div className="body-dim" style={{ fontSize: 13 }}>
            Both signatures collected. Transaction:
          </div>
          <div className="mono" style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>{doneTx}</div>
        </div>
        <button className="btn ghost" onClick={() => setView("main")}>Done</button>
      </div>
    );
  }

  const owners = config.safeOwners;
  return (
    <div className="screen">
      <TopBar title="Savings" onBack={onHome} />
      <ErrorBanner error={error} />
      <div style={{ marginTop: 26 }}>
        {config.safeAddress === "" ? (
          <div className="sub">Add your Safe address in Settings to see it here.</div>
        ) : (
          <>
            <div className="balance-big">{balance ?? "—"} <span style={{ fontSize: 18, color: "var(--muted)" }}>ETH</span></div>
            <div className="balance-sub"><span>Protected by 3 keys · 2 must approve</span></div>
            <div className="faint mono" style={{ marginTop: 4 }}>{truncateMiddle(config.safeAddress, 10)}</div>
          </>
        )}
      </div>
      {owners.length === 3 && (
        <div className="panel" style={{ marginTop: 22 }}>
          {["This phone", "Second device", "Recovery key"].map((label, i) => (
            <div className="rowline" key={label} style={{ padding: "13px 18px" }}>
              <span style={{ fontFamily: "var(--font)" }}>{label}</span>
              <span className="v plain mono" style={{ fontSize: 12, color: "var(--muted)" }}>{truncateMiddle(owners[i]!, 8)}</span>
            </div>
          ))}
        </div>
      )}
      {config.safeAddress !== "" && (
        <button className="panel" style={{ marginTop: 12, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", cursor: "pointer", width: "100%" }} onClick={() => void verify()}>
          <span style={{ font: "600 13px var(--font)", color: "var(--text)" }}>Check account security</span>
          <span className="mono" style={{ fontSize: 12, color: verifiedLine !== null ? "var(--success)" : "var(--faint)" }}>
            {busy ? "checking…" : verifiedLine ?? "tap to check"}
          </span>
        </button>
      )}
      {signerAddress !== null && (
        <div className="faint" style={{ marginTop: 12 }}>This phone's key: <span className="mono">{truncateMiddle(signerAddress, 10)}</span></div>
      )}
      <div className="grow" />
      <div className="stack">
        <button className="btn primary" disabled={config.safeAddress === ""} onClick={() => setView("send")}>Send</button>
        <button className="btn ghost" onClick={() => setView("approve")}>Approve a send from the other device</button>
      </div>
      <div className="micro dim" style={{ textAlign: "center", marginTop: 12 }}>needs this phone + one other</div>
    </div>
  );
}
