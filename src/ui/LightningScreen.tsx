// Lightning via LNbits. The admin (pay) key is sealed under the PIN and
// unsealed per payment; the invoice key is read-only and lives in config.
// The sweep badge is the visible face of the zero-resting-balance design.

import { useCallback, useEffect, useState } from "react";
import {
  createInvoice,
  fetchPaymentProof,
  getBalanceMsat,
  payInvoice,
  type LnbitsConfig,
} from "../lightning";
import { hasSecret, openSecret, sealSecret, type KeyValueBackend } from "../storage";
import { Card, ErrorBanner, Field, Row, SuccessBanner, errorMessage } from "./components";
import { msatToSats, truncateMiddle } from "./format";
import type { WalletConfig } from "./wallet-config";

export const LNBITS_ADMIN_KEY = "wallet.lnbits-admin.v1";

export function LightningScreen({
  backend,
  config,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
}) {
  const [balanceMsat, setBalanceMsat] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceMemo, setInvoiceMemo] = useState("");
  const [invoice, setInvoice] = useState<{ bolt11: string; paymentHash: string } | null>(null);
  const [bolt11ToPay, setBolt11ToPay] = useState("");
  const [pin, setPin] = useState("");
  const [adminKeyInput, setAdminKeyInput] = useState("");
  const [adminSealed, setAdminSealed] = useState(false);

  const readConfig: LnbitsConfig = {
    baseUrl: config.lnbitsUrl,
    apiKey: config.lnbitsInvoiceKey,
  };

  const refresh = useCallback(async () => {
    setError(null);
    if (config.lnbitsUrl === "" || config.lnbitsInvoiceKey === "") {
      setBalanceMsat(null);
      return;
    }
    try {
      setBalanceMsat(await getBalanceMsat(readConfig));
    } catch (e) {
      setBalanceMsat(null);
      setError(errorMessage(e));
    }
  }, [config.lnbitsUrl, config.lnbitsInvoiceKey]);

  useEffect(() => {
    void refresh();
    void hasSecret(backend, LNBITS_ADMIN_KEY).then(setAdminSealed);
  }, [refresh, backend]);

  const makeInvoice = async () => {
    setError(null);
    setBusy(true);
    try {
      const amount = Number(invoiceAmount);
      setInvoice(await createInvoice(readConfig, amount, invoiceMemo));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sealAdminKey = async () => {
    setError(null);
    setBusy(true);
    try {
      await sealSecret(
        backend,
        LNBITS_ADMIN_KEY,
        new TextEncoder().encode(adminKeyInput) as Uint8Array<ArrayBuffer>,
        pin,
      );
      setAdminSealed(true);
      setSuccess("Admin key sealed under PIN.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAdminKeyInput("");
      setPin("");
      setBusy(false);
    }
  };

  const pay = async () => {
    setError(null);
    setBusy(true);
    try {
      const keyBytes = await openSecret(backend, LNBITS_ADMIN_KEY, pin);
      let adminKey = "";
      try {
        adminKey = new TextDecoder().decode(keyBytes);
        const payConfig: LnbitsConfig = { baseUrl: config.lnbitsUrl, apiKey: adminKey };
        const { paymentHash } = await payInvoice(payConfig, bolt11ToPay.trim());
        const proof = await fetchPaymentProof(payConfig, paymentHash);
        if (proof === null) {
          setSuccess(`Payment in flight: ${truncateMiddle(paymentHash, 10)} (no proof yet — check again)`);
        } else {
          setSuccess(`Paid. Preimage proof: ${proof.preimage}`);
        }
        setBolt11ToPay("");
        void refresh();
      } finally {
        keyBytes.fill(0);
        adminKey = "";
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPin("");
      setBusy(false);
    }
  };

  const swept = balanceMsat === 0;

  return (
    <>
      <ErrorBanner error={error} />
      <SuccessBanner message={success} />
      <Card title="Lightning">
        {balanceMsat === null ? (
          <div className="muted">
            {config.lnbitsUrl === ""
              ? "Add your Lightning connection in Settings to get started."
              : "Couldn't load your balance right now."}
          </div>
        ) : (
          <>
            <div className="balance">
              {msatToSats(balanceMsat).toLocaleString("en-US")}
              <span className="balance-unit">sats</span>
            </div>
            <div className="balance-sub">
              {swept ? <span className="badge ok">empty</span> : "spendable now"}
            </div>
          </>
        )}
        <div className="spacer" />
        <button className="secondary" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </Card>
      <Card title="Receive">
        <Field label="Amount (sats)">
          <input inputMode="numeric" value={invoiceAmount} onChange={(e) => setInvoiceAmount(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Memo">
          <input value={invoiceMemo} onChange={(e) => setInvoiceMemo(e.target.value)} autoComplete="off" />
        </Field>
        <button className="primary" disabled={busy} onClick={() => void makeInvoice()}>
          Create invoice
        </button>
        {invoice !== null && (
          <>
            <div className="spacer" />
            <Row label="Invoice" value={<span className="mono" style={{ wordBreak: "break-all" }}>{invoice.bolt11}</span>} />
            <Row label="Payment hash" value={truncateMiddle(invoice.paymentHash, 10)} mono />
          </>
        )}
      </Card>
      <Card title="Send">
        {!adminSealed ? (
          <>
            <p className="muted">
              Seal the LNbits admin key under your PIN once; it is unsealed per
              payment and never stored in plain text.
            </p>
            <div className="spacer" />
            <Field label="LNbits admin key">
              <input type="password" autoComplete="off" value={adminKeyInput} onChange={(e) => setAdminKeyInput(e.target.value)} />
            </Field>
            <Field label="PIN">
              <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <button className="primary" disabled={busy} onClick={() => void sealAdminKey()}>
              Seal admin key
            </button>
          </>
        ) : (
          <>
            <Field label="bolt11 invoice">
              <textarea rows={3} value={bolt11ToPay} onChange={(e) => setBolt11ToPay(e.target.value)} spellCheck={false} autoComplete="off" />
            </Field>
            <Field label="PIN">
              <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <button className="primary" disabled={busy} onClick={() => void pay()}>
              {busy ? "Paying…" : "Pay invoice"}
            </button>
          </>
        )}
      </Card>
    </>
  );
}
