// Spending · Bitcoin. Watch-only by default; the passphrase is requested on
// its own screen per spend, held only while signing, and cleared in finally.
// A wrong passphrase gets a full refusal screen: nothing signed, nothing
// sent. Fees are always shown before commitment.

import { useCallback, useEffect, useState } from "react";
import {
  entropy_to_mnemonic_js,
  sign_spend_js,
  xpub_to_address_js,
} from "../../core/pkg/adversarial_core";
import {
  broadcastTransaction,
  estimateFeeSats,
  fetchFeeRate,
  fetchUtxos,
  scanWatchOnlyBalance,
  type WatchOnlyBalance,
} from "../btc";
import { openSecret, type KeyValueBackend } from "../storage";
import type { Intent } from "../App";
import { ErrorBanner, TopBar, errorMessage } from "./components";
import { fetchUsdPrices, type UsdPrices } from "../prices";
import { formatSats, satsToBtc, satsToUsd, truncateMiddle } from "./format";
import { PullToRefresh } from "./PullToRefresh";
import { QrCode } from "./QrCode";
import { getSessionPin } from "./session-lock";
import { BTC_ENTROPY_KEY } from "./SetupFlow";
import type { WalletConfig } from "./wallet-config";

type View = "main" | "receive" | "send" | "pass" | "refused" | "sent";

interface PreparedSpend {
  txids: string[];
  addresses: string[];
  vouts: number[];
  values: bigint[];
  chains: number[];
  indexes: number[];
  feeSats: number;
  changeIndex: number;
}

export function BitcoinScreen({
  backend,
  config,
  initialIntent,
  onHome,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
  initialIntent?: Intent | null;
  onHome: () => void;
}) {
  const [view, setView] = useState<View>(
    initialIntent === "send" ? "send" : initialIntent === "receive" ? "receive" : "main",
  );
  const [balance, setBalance] = useState<WatchOnlyBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [prepared, setPrepared] = useState<PreparedSpend | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [refusal, setRefusal] = useState("");
  const [sentTxid, setSentTxid] = useState("");
  const [copied, setCopied] = useState(false);
  const [prices, setPrices] = useState<UsdPrices | null>(null);

  useEffect(() => {
    void fetchUsdPrices().then(setPrices).catch(() => {});
  }, []);

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

  const receiveAddress = (() => {
    if (balance === null) return null;
    const used = new Set(balance.usedAddresses);
    for (let i = 0; ; i++) {
      const address = xpub_to_address_js(config.xpub, config.network, 0, i);
      if (!used.has(address)) return address;
    }
  })();

  const amountSats = Number(amount);
  const sendValid =
    Number.isSafeInteger(amountSats) && amountSats > 0 && recipient.trim() !== "";

  /** Gather spendable coins and compute the fee for a ~3-block confirmation
   * from the chain endpoint's current rate. Runs before the confirm screen
   * so the user reviews the real, final fee. Any failure refuses. */
  const prepareSpend = async () => {
    if (balance === null) return;
    setError(null);
    setBusy(true);
    try {
      const used = new Set(balance.usedAddresses);
      const txids: string[] = [];
      const addresses: string[] = [];
      const vouts: number[] = [];
      const values: bigint[] = [];
      const chains: number[] = [];
      const indexes: number[] = [];
      for (const chain of [0, 1]) {
        for (let i = 0, misses = 0; misses < balance.usedAddresses.length + 20; i++) {
          const address = xpub_to_address_js(config.xpub, config.network, chain, i);
          if (!used.has(address)) { misses++; continue; }
          for (const utxo of await fetchUtxos(config.esploraUrl, address)) {
            if (!utxo.confirmed) continue;
            txids.push(utxo.txid);
            addresses.push(address);
            vouts.push(utxo.vout);
            values.push(BigInt(utxo.valueSats));
            chains.push(chain);
            indexes.push(i);
          }
        }
      }
      if (txids.length === 0) throw new Error("No confirmed coins to spend yet.");

      const rate = await fetchFeeRate(config.esploraUrl);
      let feeSats = estimateFeeSats(txids.length, 2, rate);
      const total = values.reduce((a, v) => a + v, 0n);
      if (BigInt(amountSats) + BigInt(feeSats) > total) {
        const max = total - BigInt(feeSats);
        throw new Error(
          max > 0n
            ? `Amount too high — you can send at most ${max.toLocaleString("en-US")} sats after the network fee.`
            : "Balance is too small to cover the network fee.",
        );
      }
      // A change output below dust cannot exist; fold the remainder into the
      // fee EXPLICITLY — the confirm screen shows the final number.
      const change = total - BigInt(amountSats) - BigInt(feeSats);
      if (change > 0n && change < 546n) feeSats += Number(change);

      let changeIndex = 0;
      while (used.has(xpub_to_address_js(config.xpub, config.network, 1, changeIndex))) {
        changeIndex++;
      }
      setPrepared({ txids, addresses, vouts, values, chains, indexes, feeSats, changeIndex });
      setView("pass");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const signAndSend = async () => {
    if (prepared === null) return;
    setError(null);
    setBusy(true);
    try {
      const pin = getSessionPin();
      if (pin === null) throw new Error("Session locked; reopen the app to unlock.");
      const entropy = await openSecret(backend, BTC_ENTROPY_KEY, pin);
      let mnemonic = "";
      try {
        mnemonic = entropy_to_mnemonic_js(entropy);
        const hex = sign_spend_js(
          mnemonic,
          passphrase,
          config.network,
          prepared.txids.join("\n"),
          prepared.addresses.join("\n"),
          new Uint32Array(prepared.vouts),
          new BigUint64Array(prepared.values),
          new Uint32Array(prepared.chains),
          new Uint32Array(prepared.indexes),
          recipient.trim(),
          BigInt(amountSats),
          BigInt(prepared.feeSats),
          prepared.changeIndex,
        );
        const txid = await broadcastTransaction(config.esploraUrl, hex);
        setSentTxid(txid);
        setView("sent");
        void refresh();
      } finally {
        entropy.fill(0);
        mnemonic = "";
      }
    } catch (e) {
      const message = errorMessage(e);
      if (message.includes("wrong passphrase")) {
        setView("refused");
        setRefusal("That passphrase doesn't open this wallet.");
      } else {
        setError(message);
      }
    } finally {
      // The passphrase never survives a signing attempt.
      setPassphrase("");
      setBusy(false);
    }
  };

  const copyAddress = async () => {
    if (receiveAddress === null) return;
    await navigator.clipboard.writeText(receiveAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (view === "receive") {
    return (
      <div className="screen">
        <TopBar title="Receive Bitcoin" onBack={() => setView("main")} />
        <div className="grow center" style={{ alignItems: "center", textAlign: "center" }}>
          {receiveAddress !== null && <QrCode value={`bitcoin:${receiveAddress}`} />}
          <div className="mono" style={{ fontSize: 13, lineHeight: 1.8, color: "var(--muted)", wordBreak: "break-all", maxWidth: 280 }}>
            {receiveAddress ?? "…"}
          </div>
          <div className="faint">Share this address to receive bitcoin ({config.network}).</div>
        </div>
        <button className="btn ghost small" onClick={() => void copyAddress()}>
          {copied ? "Copied" : "Copy address"}
        </button>
      </div>
    );
  }

  if (view === "send") {
    return (
      <div className="screen">
        <TopBar title="Send Bitcoin" onBack={() => setView("main")} />
        <ErrorBanner error={error} />
        <div className="stack" style={{ marginTop: 24 }}>
          <div className="amountbox">
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} placeholder="0" autoComplete="off" />
            <span className="unit">sats{amountSats > 0 ? ` ≈ ${satsToBtc(amountSats)} BTC` : ""}</span>
          </div>
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Address" spellCheck={false} autoComplete="off" style={{ fontSize: 13 }} />
        </div>
        <div className="faint" style={{ marginTop: 14 }}>
          The network fee is set automatically so the payment confirms
          promptly. You'll see it before signing.
        </div>
        <div className="grow" />
        <button className="btn primary" disabled={!sendValid || busy} onClick={() => void prepareSpend()}>
          {busy ? "Preparing…" : "Continue"}
        </button>
      </div>
    );
  }

  if (view === "pass" && prepared !== null) {
    const feeSats = prepared.feeSats;
    return (
      <div className="screen deep">
        <TopBar title="Confirm send" onBack={() => { setPassphrase(""); setPrepared(null); setView("send"); }} />
        <ErrorBanner error={error} />
        <div className="panel" style={{ marginTop: 20 }}>
          <div className="rowline"><span className="k">Amount</span><span className="v">{formatSats(amountSats)}</span></div>
          <div className="rowline"><span className="k">To</span><span className="v plain mono" style={{ fontSize: 12 }}>{truncateMiddle(recipient.trim(), 12)}</span></div>
          <div className="rowline"><span className="k">Fee</span><span className="v">{formatSats(feeSats)}</span></div>
          <div className="rowline"><span className="k" style={{ fontWeight: 600, color: "var(--text)" }}>Total</span><span className="v">{formatSats(amountSats + feeSats)}</span></div>
        </div>
        <div className="grow center" style={{ gap: 14 }}>
          <div style={{ font: "600 20px/1.3 var(--font)" }}>Type your spending passphrase</div>
          <input
            type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Passphrase" autoComplete="off" style={{ borderColor: "var(--accent)" }}
          />
          <div className="faint">Held in memory only for this signature, then discarded.</div>
        </div>
        <button className="btn primary" disabled={busy || passphrase === ""} onClick={() => void signAndSend()}>
          {busy ? "Signing…" : `Sign & send ${formatSats(amountSats)}`}
        </button>
      </div>
    );
  }

  if (view === "refused") {
    return (
      <div className="screen">
        <div className="grow center">
          <div className="mark bad" />
          <div className="h1" style={{ maxWidth: 320 }}>{refusal}</div>
          <div className="body-dim" style={{ maxWidth: 320, fontSize: 14, lineHeight: 1.7 }}>
            Nothing was signed or sent. Check spelling, capitals, and spaces —
            then try again.
          </div>
        </div>
        <div className="stack">
          <button className="btn primary" onClick={() => setView("pass")}>Try again</button>
          <button className="btn ghost" onClick={() => { setView("main"); setRecipient(""); setAmount(""); setPrepared(null); }}>
            Cancel this send
          </button>
        </div>
      </div>
    );
  }

  if (view === "sent") {
    return (
      <div className="screen">
        <div className="grow center">
          <div className="mark ok" />
          <div className="h1 big">Sent.</div>
          <div className="panel">
            <div className="rowline"><span className="k">Amount</span><span className="v">{formatSats(amountSats)}</span></div>
            <div className="rowline"><span className="k">To</span><span className="v plain mono" style={{ fontSize: 12 }}>{truncateMiddle(recipient.trim(), 12)}</span></div>
            <div className="rowline"><span className="k">Fee</span><span className="v">{prepared !== null ? formatSats(prepared.feeSats) : "—"}</span></div>
            <div className="rowline"><span className="k">Transaction</span><span className="v plain mono" style={{ fontSize: 11 }}>{truncateMiddle(sentTxid, 10)}</span></div>
          </div>
        </div>
        <button className="btn ghost" onClick={() => { setView("main"); setRecipient(""); setAmount(""); setPrepared(null); setSentTxid(""); }}>
          Done
        </button>
      </div>
    );
  }

  return (
    <PullToRefresh onRefresh={refresh}>
    <div className="screen">
      <TopBar title="Spending · Bitcoin" onBack={onHome} />
      <ErrorBanner error={error} />
      <div style={{ marginTop: 26 }}>
        {balance === null ? (
          <div className="sub">{busy ? "Checking balance…" : "Couldn't load your balance right now."}</div>
        ) : (
          <>
            <div className="balance-big">
              {prices !== null
                ? satsToUsd(balance.confirmedSats, prices.btcUsd)
                : formatSats(balance.confirmedSats)}
            </div>
            <div className="balance-sub">
              {prices !== null && <span>{formatSats(balance.confirmedSats)}</span>}
              <span>{satsToBtc(balance.confirmedSats)} BTC</span>
              {balance.pendingSats !== 0 && (
                <span style={{ color: "var(--amber)" }}>
                  {balance.pendingSats > 0 ? "+" : ""}{formatSats(balance.pendingSats)} incoming
                </span>
              )}
            </div>
          </>
        )}
      </div>
      <div className="btn-row" style={{ marginTop: 22 }}>
        <button className="btn ghost small" onClick={() => setView("receive")} disabled={receiveAddress === null}>Receive</button>
        <button className="btn primary small" onClick={() => setView("send")} disabled={balance === null}>Send</button>
      </div>
      <div className="grow" />
      <button className="linklike" onClick={() => void refresh()} disabled={busy}>
        {busy ? "refreshing…" : "refresh"}
      </button>
    </div>
    </PullToRefresh>
  );
}
