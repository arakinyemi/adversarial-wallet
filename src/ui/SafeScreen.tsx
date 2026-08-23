// Savings (2-of-3 Safe on Base). This device holds one owner key of three;
// every transaction needs approval from a second device. Sending is a
// two-step handoff: propose here, approve on the other device (or vice
// versa) — the payload travels by copy/paste.
//
// The signer key gets its own dice ceremony, deliberately independent of
// the Bitcoin seed (see DECISIONS.md session 10), and is sealed under the
// PIN. Key bytes are unsealed per action and zeroed in finally.

import { useEffect, useState } from "react";
import { createPublicClient, formatEther, getAddress, http, parseEther, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { entropyToEvmSigner, verifySafeDeployment } from "../evm";
import { countersignAndExecute, proposeSafeSpend } from "../evm/spend";
import { generateSeedEntropy, MIN_DICE_ROLLS } from "../entropy";
import { hasSecret, openSecret, sealSecret, type KeyValueBackend } from "../storage";
import { Card, ErrorBanner, Field, Row, SuccessBanner, errorMessage } from "./components";
import { DicePad } from "./DicePad";
import { truncateMiddle } from "./format";
import type { WalletConfig } from "./wallet-config";

export const EVM_SIGNER_KEY = "wallet.evm-signer-a.v1";

const toHex = (bytes: Uint8Array): Hex =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;

export function SafeScreen({
  backend,
  config,
}: {
  backend: KeyValueBackend;
  config: WalletConfig;
}) {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signerSealed, setSignerSealed] = useState<boolean | null>(null);
  const [signerAddress, setSignerAddress] = useState<string | null>(null);
  const [dice, setDice] = useState("");
  const [pin, setPin] = useState("");
  const [verified, setVerified] = useState<{ owners: string[]; threshold: string } | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [sendTo, setSendTo] = useState("");
  const [sendEth, setSendEth] = useState("");
  const [proposal, setProposal] = useState<string | null>(null);
  const [incoming, setIncoming] = useState("");

  const chain = config.network === "mainnet" ? base : baseSepolia;
  const rpcUrl = chain.rpcUrls.default.http[0]!;
  const diceClean = dice.replace(/[^1-6]/g, "");

  useEffect(() => {
    void hasSecret(backend, EVM_SIGNER_KEY).then(setSignerSealed);
  }, [backend]);

  const withSignerKey = async <T,>(
    fn: (key: Hex, address: string) => Promise<T>,
  ): Promise<T> => {
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
      if (pin.length < 6) throw new Error("Enter your wallet PIN (at least 6 digits).");
      const { entropy } = generateSeedEntropy(diceClean);
      try {
        const account = entropyToEvmSigner(entropy as Uint8Array<ArrayBuffer>);
        await sealSecret(backend, EVM_SIGNER_KEY, entropy as Uint8Array<ArrayBuffer>, pin);
        setSignerAddress(account.address);
        setSignerSealed(true);
        setSuccess("Signing key created. Add this address as an owner of your Safe.");
      } finally {
        entropy.fill(0);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDice("");
      setPin("");
      setBusy(false);
    }
  };

  const showSignerAddress = async () => {
    setError(null);
    setBusy(true);
    try {
      await withSignerKey(async (_key, address) => {
        setSignerAddress(address);
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPin("");
      setBusy(false);
    }
  };

  const verify = async () => {
    setError(null);
    setBusy(true);
    setVerified(null);
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
      setVerified({ owners: result.owners, threshold: result.threshold.toString() });
      setBalance(
        formatEther(await client.getBalance({ address: getAddress(config.safeAddress) })),
      );
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
          rpcUrl,
          chain,
          safeAddress: config.safeAddress,
          signerKey: key,
          to: sendTo.trim(),
          valueWei,
        }),
      );
      setProposal(payload);
      setSuccess("Signed on this device. Approve it on your second device to send.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPin("");
      setBusy(false);
    }
  };

  const approveAndSend = async () => {
    setError(null);
    setBusy(true);
    try {
      const { txHash } = await withSignerKey((key, address) =>
        countersignAndExecute({
          rpcUrl,
          chain,
          signerKey: key,
          localSignerAddress: address,
          proposalJson: incoming.trim(),
        }),
      );
      setSuccess(`Sent. Transaction: ${txHash}`);
      setIncoming("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPin("");
      setBusy(false);
    }
  };

  const pinField = (
    <Field label="PIN">
      <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
    </Field>
  );

  return (
    <>
      <ErrorBanner error={error} />
      <SuccessBanner message={success} />

      {signerSealed === false && (
        <Card title="Create your signing key">
          <p className="muted">
            This device needs its own signing key. Roll a real die at least{" "}
            {MIN_DICE_ROLLS} times and tap each result — same as when you
            created your wallet.
          </p>
          <div className="spacer" />
          <DicePad value={diceClean} min={MIN_DICE_ROLLS} onChange={setDice} />
          {pinField}
          <button
            className="primary"
            disabled={busy || diceClean.length < MIN_DICE_ROLLS}
            onClick={() => void createSigner()}
          >
            Create signing key
          </button>
        </Card>
      )}

      {signerSealed === true && (
        <Card title="Savings">
          {config.safeAddress === "" ? (
            <div className="muted">Add your Safe address in Settings to see it here.</div>
          ) : (
            <>
              <Row label="Account" value={truncateMiddle(config.safeAddress, 10)} mono />
              {balance !== null && <Row label="Balance" value={`${balance} ETH`} />}
              <div className="spacer" />
              <button className="secondary" disabled={busy} onClick={() => void verify()}>
                {busy ? "Checking…" : "Check account on chain"}
              </button>
            </>
          )}
          {verified !== null && (
            <>
              <div className="spacer" />
              <div className="banner success">
                Confirmed on chain: {verified.owners.length} owners, {verified.threshold} approvals
                required.
              </div>
            </>
          )}
          {signerAddress !== null ? (
            <Row label="This device's key" value={truncateMiddle(signerAddress, 10)} mono />
          ) : (
            <>
              {pinField}
              <button className="secondary" disabled={busy} onClick={() => void showSignerAddress()}>
                Show this device's key address
              </button>
            </>
          )}
        </Card>
      )}

      {signerSealed === true && config.safeAddress !== "" && proposal === null && (
        <Card title="Send">
          <p className="muted">
            Sending needs approval from two devices. Start here, then finish
            on your second device.
          </p>
          <div className="spacer" />
          <Field label="Recipient address">
            <input value={sendTo} onChange={(e) => setSendTo(e.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Amount (ETH)">
            <input inputMode="decimal" value={sendEth} onChange={(e) => setSendEth(e.target.value)} autoComplete="off" />
          </Field>
          {pinField}
          <button className="primary" disabled={busy} onClick={() => void propose()}>
            {busy ? "Signing…" : "Sign on this device"}
          </button>
        </Card>
      )}

      {proposal !== null && (
        <Card title="Waiting for second approval">
          <p className="muted">
            Copy this to your second device and approve it there to complete
            the send.
          </p>
          <div className="spacer" />
          <textarea rows={5} readOnly value={proposal} className="mono" onFocus={(e) => e.target.select()} />
          <button className="secondary" onClick={() => setProposal(null)}>Done</button>
        </Card>
      )}

      {signerSealed === true && (
        <Card title="Approve a send from your other device">
          <Field label="Paste the request">
            <textarea rows={4} value={incoming} onChange={(e) => setIncoming(e.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
          {pinField}
          <button className="primary" disabled={busy || incoming.trim() === ""} onClick={() => void approveAndSend()}>
            {busy ? "Sending…" : "Approve and send"}
          </button>
        </Card>
      )}
    </>
  );
}
