// Instant · Lightning (LNbits). The admin key is sealed under the PIN and
// unsealed per payment while the session is unlocked. Settled payments show
// the locally verified preimage as proof.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createInvoice,
  createWallet,
  fetchPaymentProof,
  getBalanceMsat,
  payInvoice,
  type LnbitsConfig,
} from "../lightning";
import { LNBITS_INSTANCE_URL } from "../lightning/instance";
import { hasSecret, openSecret, sealSecret, type KeyValueBackend } from "../storage";
import { ErrorBanner, TopBar, errorMessage } from "./components";
import { msatToSats } from "./format";
import { getSessionPin } from "./session-lock";
import { saveConfig, type WalletConfig } from "./wallet-config";

export const LNBITS_ADMIN_KEY = "wallet.lnbits-admin.v1";

type View = "main" | "request" | "pay" | "paid";

export function LightningScreen({
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
  const [view, setView] = useState<View>("main");
  const [balanceMsat, setBalanceMsat] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceMemo, setInvoiceMemo] = useState("");
  const [invoice, setInvoice] = useState<{ bolt11: string; paymentHash: string } | null>(null);
  const [bolt11ToPay, setBolt11ToPay] = useState("");
  const [adminSealed, setAdminSealed] = useState(false);
  const [proofLine, setProofLine] = useState("");
  const [copied, setCopied] = useState(false);

  const configured = config.lnbitsUrl !== "" && config.lnbitsInvoiceKey !== "";
  const readConfig: LnbitsConfig = { baseUrl: config.lnbitsUrl, apiKey: config.lnbitsInvoiceKey };

  const refresh = useCallback(async () => {
    setError(null);
    if (!configured) { setBalanceMsat(null); return; }
    try {
      setBalanceMsat(await getBalanceMsat({ baseUrl: config.lnbitsUrl, apiKey: config.lnbitsInvoiceKey }));
    } catch (e) {
      setBalanceMsat(null);
      setError(errorMessage(e));
    }
  }, [config.lnbitsUrl, config.lnbitsInvoiceKey, configured]);

  useEffect(() => {
    void refresh();
    void hasSecret(backend, LNBITS_ADMIN_KEY).then(setAdminSealed);
  }, [refresh, backend]);

  // Instant payments set themselves up: no button, no configuration. The
  // wallet self-provisions on first visit; a failure shows a retry.
  const provisioning = useRef(false);
  useEffect(() => {
    if (configured || LNBITS_INSTANCE_URL === "" || provisioning.current) return;
    if (getSessionPin() === null) return;
    provisioning.current = true;
    void provision();
  }, [configured]);

  const makeInvoice = async () => {
    setError(null);
    setBusy(true);
    try {
      setInvoice(await createInvoice(readConfig, Number(invoiceAmount), invoiceMemo));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const provision = async () => {
    setError(null);
    setBusy(true);
    try {
      const pin = getSessionPin();
      if (pin === null) throw new Error("Session locked; reopen the app to unlock.");
      const wallet = await createWallet(LNBITS_INSTANCE_URL);
      // Admin key sealed first: if sealing fails, nothing is configured and
      // the next attempt provisions a fresh wallet — never a half-set-up one.
      await sealSecret(
        backend,
        LNBITS_ADMIN_KEY,
        new TextEncoder().encode(wallet.adminKey) as Uint8Array<ArrayBuffer>,
        pin,
      );
      setAdminSealed(true);
      const next = { ...config, lnbitsUrl: LNBITS_INSTANCE_URL, lnbitsInvoiceKey: wallet.invoiceKey };
      await saveConfig(backend, next);
      onConfigChange(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    setError(null);
    setBusy(true);
    try {
      const pin = getSessionPin();
      if (pin === null) throw new Error("Session locked; reopen the app to unlock.");
      const keyBytes = await openSecret(backend, LNBITS_ADMIN_KEY, pin);
      try {
        const payConfig: LnbitsConfig = {
          baseUrl: config.lnbitsUrl,
          apiKey: new TextDecoder().decode(keyBytes),
        };
        const { paymentHash } = await payInvoice(payConfig, bolt11ToPay.trim());
        const proof = await fetchPaymentProof(payConfig, paymentHash);
        setProofLine(
          proof !== null
            ? "payment receipt verified"
            : "payment on its way — receipt pending",
        );
        setBolt11ToPay("");
        setView("paid");
        void refresh();
      } finally {
        keyBytes.fill(0);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copyInvoice = async () => {
    if (invoice === null) return;
    await navigator.clipboard.writeText(invoice.bolt11);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (view === "request") {
    return (
      <div className="screen">
        <TopBar title="Request" onBack={() => { setInvoice(null); setView("main"); }} />
        <ErrorBanner error={error} />
        <div className="stack" style={{ marginTop: 24 }}>
          <div className="amountbox">
            <input inputMode="numeric" value={invoiceAmount} onChange={(e) => setInvoiceAmount(e.target.value.replace(/\D/g, ""))} placeholder="0" autoComplete="off" />
            <span className="unit">sats</span>
          </div>
          <input value={invoiceMemo} onChange={(e) => setInvoiceMemo(e.target.value)} placeholder="Memo (optional)" autoComplete="off" style={{ fontFamily: "var(--font)", fontSize: 14 }} />
        </div>
        {invoice !== null && (
          <div className="panel pad" style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 14, alignItems: "center" }}>
            <div className="mono" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--muted)", wordBreak: "break-all" }}>{invoice.bolt11}</div>
            <button className="btn ghost small" style={{ height: 44 }} onClick={() => void copyInvoice()}>
              {copied ? "Copied" : "Copy invoice"}
            </button>
          </div>
        )}
        <div className="grow" />
        {invoice === null && (
          <button className="btn primary" disabled={busy || invoiceAmount === ""} onClick={() => void makeInvoice()}>
            {busy ? "Creating…" : "Create invoice"}
          </button>
        )}
      </div>
    );
  }

  if (view === "pay") {
    return (
      <div className="screen">
        <TopBar title="Pay" onBack={() => setView("main")} />
        <ErrorBanner error={error} />
        {!adminSealed ? (
          <>
            <div className="sub" style={{ marginTop: 20 }}>
              This wallet isn't set up for payments yet. Go back and turn on
              Instant payments first.
            </div>
            <div className="grow" />
          </>
        ) : (
          <>
            <div className="stack" style={{ marginTop: 20 }}>
              <textarea rows={4} value={bolt11ToPay} onChange={(e) => setBolt11ToPay(e.target.value)} placeholder="Paste a Lightning invoice" spellCheck={false} autoComplete="off" />
            </div>
            <div className="grow" />
            <button className="btn primary" disabled={busy || bolt11ToPay.trim() === ""} onClick={() => void pay()}>
              {busy ? "Paying…" : "Pay invoice"}
            </button>
          </>
        )}
      </div>
    );
  }

  if (view === "paid") {
    return (
      <div className="screen">
        <div className="grow center">
          <div className="mark ok" />
          <div className="h1 big">Paid.</div>
          <div className="panel pad mono" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--faint)" }}>
            {proofLine}
          </div>
        </div>
        <button className="btn ghost" onClick={() => setView("main")}>Done</button>
      </div>
    );
  }

  return (
    <div className="screen">
      <TopBar title="Instant · Lightning" onBack={onHome} />
      <ErrorBanner error={error} />
      <div style={{ marginTop: 26 }}>
        {balanceMsat === null ? (
          <div className="sub">
            {!configured
              ? LNBITS_INSTANCE_URL === ""
                ? "Instant payments are not available in this build."
                : busy
                  ? "Setting up instant payments…"
                  : error !== null
                    ? "Setup didn't finish — tap retry below."
                    : "Setting up instant payments…"
              : "Couldn't load your balance right now."}
          </div>
        ) : (
          <>
            <div className="balance-big">{msatToSats(balanceMsat).toLocaleString("en-US")} <span style={{ fontSize: 18, color: "var(--muted)" }}>sats</span></div>
          </>
        )}
      </div>
      <div className="btn-row" style={{ marginTop: 22 }}>
        <button className="btn ghost small" disabled={!configured} onClick={() => setView("request")}>Request</button>
        <button className="btn primary small" disabled={!configured} onClick={() => setView("pay")}>Pay</button>
      </div>
      <div className="grow" />
      {configured ? (
        <>
          <div className="statusdot">
            <i className={balanceMsat === null ? "warn" : ""} />
            {balanceMsat === null ? "server unreachable" : "connected"}
          </div>
          <button className="linklike" onClick={() => void refresh()}>refresh</button>
        </>
      ) : (
        error !== null &&
        LNBITS_INSTANCE_URL !== "" && (
          <button className="btn primary" disabled={busy} onClick={() => void provision()}>
            Retry setup
          </button>
        )
      )}
    </div>
  );
}
