// Bitcoin: watch-only by default. The passphrase is requested per spend,
// held in state only while signing, and cleared in finally regardless of
// outcome. The confirm step shows amount, fee, recipient, and change — the
// fee is never hidden (see DECISIONS.md session 8).

import { useCallback, useEffect, useState } from "react";
import {
  entropy_to_mnemonic_js,
  sign_spend_js,
  xpub_to_address_js,
} from "../../core/pkg/adversarial_core";
import {
  broadcastTransaction,
  fetchUtxos,
  scanWatchOnlyBalance,
  type WatchOnlyBalance,
} from "../btc";
import { openSecret, type KeyValueBackend } from "../storage";
import { Card, ErrorBanner, Field, Row, SuccessBanner, errorMessage } from "./components";
import { formatSats, satsToBtc, truncateMiddle } from "./format";
import { BTC_ENTROPY_KEY } from "./SetupFlow";
import type { WalletConfig } from "./wallet-config";

interface SpendDraft {
  recipient: string;
  amountSats: number;
  feeSats: number;
}

export function BitcoinScreen({
  backend,
  config,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
}) {
  const [balance, setBalance] = useState<WatchOnlyBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("");
  const [draft, setDraft] = useState<SpendDraft | null>(null);
  const [pin, setPin] = useState("");
  const [passphrase, setPassphrase] = useState("");

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

  const reviewSpend = () => {
    setError(null);
    const amountSats = Number(amount);
    const feeSats = Number(fee);
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0)
      return setError("Amount must be a positive whole number of sats.");
    if (!Number.isSafeInteger(feeSats) || feeSats <= 0)
      return setError("Fee must be a positive whole number of sats.");
    if (recipient.trim() === "") return setError("Recipient address is required.");
    setDraft({ recipient: recipient.trim(), amountSats, feeSats });
  };

  const confirmSpend = async () => {
    if (draft === null || balance === null) return;
    setError(null);
    setBusy(true);
    try {
      // Locate spendable utxos and their derivation paths.
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
          if (!used.has(address)) {
            misses++;
            continue;
          }
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

      const entropy = await openSecret(backend, BTC_ENTROPY_KEY, pin);
      let mnemonic = "";
      try {
        mnemonic = entropy_to_mnemonic_js(entropy);
        let changeIndex = 0;
        while (used.has(xpub_to_address_js(config.xpub, config.network, 1, changeIndex))) {
          changeIndex++;
        }
        const hex = sign_spend_js(
          mnemonic,
          passphrase,
          config.network,
          txids.join("\n"),
          addresses.join("\n"),
          new Uint32Array(vouts),
          new BigUint64Array(values),
          new Uint32Array(chains),
          new Uint32Array(indexes),
          draft.recipient,
          BigInt(draft.amountSats),
          BigInt(draft.feeSats),
          changeIndex,
        );
        const txid = await broadcastTransaction(config.esploraUrl, hex);
        setSuccess(`Broadcast accepted: ${txid}`);
        setDraft(null);
        setRecipient("");
        setAmount("");
        setFee("");
        void refresh();
      } finally {
        entropy.fill(0);
        mnemonic = "";
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      // The passphrase and PIN never survive a signing attempt.
      setPassphrase("");
      setPin("");
      setBusy(false);
    }
  };

  return (
    <>
      <ErrorBanner error={error} />
      <SuccessBanner message={success} />
      <Card title="Bitcoin">
        {balance === null ? (
          <div className="muted">{busy ? "Checking balance…" : "Couldn't load your balance right now."}</div>
        ) : (
          <>
            <div className="balance">
              {satsToBtc(balance.confirmedSats)}
              <span className="balance-unit">BTC</span>
            </div>
            <div className="balance-sub">
              {formatSats(balance.confirmedSats)}
              {balance.pendingSats !== 0 && ` · pending ${formatSats(balance.pendingSats)}`}
            </div>
          </>
        )}
        <div className="spacer" />
        <button className="secondary" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </Card>
      {receiveAddress !== null && (
        <Card title="Receive">
          <div className="mono" style={{ wordBreak: "break-all" }}>{receiveAddress}</div>
          <div className="hint muted">Share this address to receive bitcoin.</div>
        </Card>
      )}
      {draft === null ? (
        <Card title="Send">
          <Field label="Recipient address">
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Amount (sats)">
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Fee (sats)" hint="Total network fee, shown again before signing.">
            <input inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value)} autoComplete="off" />
          </Field>
          <button className="primary" disabled={busy || balance === null} onClick={reviewSpend}>
            Review
          </button>
        </Card>
      ) : (
        <Card title="Confirm spend">
          <Row label="To" value={truncateMiddle(draft.recipient, 12)} mono />
          <Row label="Amount" value={formatSats(draft.amountSats)} />
          <Row label="Network fee" value={formatSats(draft.feeSats)} />
          <Row label="Total" value={formatSats(draft.amountSats + draft.feeSats)} />
          <div className="spacer" />
          <Field label="PIN">
            <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="Passphrase" hint="Held in memory only for this signature, then discarded.">
            <input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
          <button className="primary" disabled={busy} onClick={() => void confirmSpend()}>
            {busy ? "Signing…" : "Sign and broadcast"}
          </button>
          <button className="secondary" disabled={busy} onClick={() => { setDraft(null); setPin(""); setPassphrase(""); }}>
            Cancel
          </button>
        </Card>
      )}
    </>
  );
}
