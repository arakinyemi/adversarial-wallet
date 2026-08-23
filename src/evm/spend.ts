// Safe 2-of-3 spending. Device A proposes: builds the Safe transaction,
// signs with its key, and exports a proposal payload. Device B imports the
// payload, countersigns with a DIFFERENT owner key, and executes. No Safe
// Transaction Service, no extra backend — the payload travels by copy/paste
// or QR between the two devices.
//
// Fail-closed contract: malformed payloads, duplicate signers, and a
// countersign attempt by the same key that proposed all refuse. Signer keys
// are passed in per call by the caller (unsealed from encrypted storage) and
// never stored or logged here.

import Safe, { EthSafeSignature } from "@safe-global/protocol-kit";
import { createPublicClient, getAddress, http, type Chain, type Hex } from "viem";
// Explicit .ts extension so plain Node can run the rehearsal scripts that
// import this module.
import { EvmError } from "./index.ts";

export interface ProposalSignature {
  signer: string;
  data: string;
}

export interface SafeSpendProposal {
  v: 1;
  chainId: number;
  safeAddress: string;
  to: string;
  valueWei: string;
  data: string;
  nonce: number;
  signatures: ProposalSignature[];
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;
const DECIMAL_RE = /^[0-9]+$/;

/** Strictly validate an incoming proposal payload. Every field is checked;
 * anything unexpected refuses. */
export function parseProposal(json: string): SafeSpendProposal {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new EvmError("proposal is not valid JSON");
  }
  const p = raw as Partial<SafeSpendProposal> | null;
  if (
    p === null ||
    typeof p !== "object" ||
    p.v !== 1 ||
    typeof p.chainId !== "number" ||
    !Number.isSafeInteger(p.chainId) ||
    p.chainId <= 0 ||
    typeof p.safeAddress !== "string" ||
    typeof p.to !== "string" ||
    typeof p.valueWei !== "string" ||
    !DECIMAL_RE.test(p.valueWei) ||
    typeof p.data !== "string" ||
    !HEX_RE.test(p.data) ||
    typeof p.nonce !== "number" ||
    !Number.isSafeInteger(p.nonce) ||
    p.nonce < 0 ||
    !Array.isArray(p.signatures) ||
    p.signatures.length === 0
  ) {
    throw new EvmError("proposal payload is malformed");
  }
  let safeAddress: string;
  let to: string;
  let signatures: ProposalSignature[];
  try {
    safeAddress = getAddress(p.safeAddress);
    to = getAddress(p.to);
    signatures = p.signatures.map((s) => {
      const sig = s as Partial<ProposalSignature>;
      if (typeof sig.signer !== "string" || typeof sig.data !== "string" || !HEX_RE.test(sig.data)) {
        throw new EvmError("proposal signature entry is malformed");
      }
      return { signer: getAddress(sig.signer), data: sig.data };
    });
  } catch (e) {
    throw e instanceof EvmError ? e : new EvmError("proposal contains an invalid address");
  }
  if (new Set(signatures.map((s) => s.signer)).size !== signatures.length) {
    throw new EvmError("proposal contains duplicate signers");
  }
  return {
    v: 1,
    chainId: p.chainId,
    safeAddress,
    to,
    valueWei: p.valueWei,
    data: p.data,
    nonce: p.nonce,
    signatures,
  };
}

/** Refuse when the countersigning key is one that already signed. */
export function assertDistinctSigner(
  existingSigners: readonly string[],
  localSigner: string,
): void {
  const local = getAddress(localSigner);
  if (existingSigners.some((s) => getAddress(s) === local)) {
    throw new EvmError(
      "this device's key already signed the proposal; the second signature must come from a different owner",
    );
  }
}

/** Build and sign a Safe transaction with this device's owner key; returns
 * the proposal payload (JSON string) for the second device. */
export async function proposeSafeSpend(params: {
  rpcUrl: string;
  chain: Chain;
  safeAddress: string;
  signerKey: Hex;
  to: string;
  valueWei: bigint;
}): Promise<string> {
  const protocolKit = await Safe.init({
    provider: params.rpcUrl,
    signer: params.signerKey,
    safeAddress: getAddress(params.safeAddress),
  });
  const tx = await protocolKit.createTransaction({
    transactions: [{ to: getAddress(params.to), value: params.valueWei.toString(), data: "0x" }],
  });
  const signed = await protocolKit.signTransaction(tx);
  const signatures = [...signed.signatures.values()].map((s) => ({
    signer: getAddress(s.signer),
    data: s.data,
  }));
  if (signatures.length === 0) {
    throw new EvmError("signing produced no signature");
  }
  const proposal: SafeSpendProposal = {
    v: 1,
    chainId: params.chain.id,
    safeAddress: getAddress(params.safeAddress),
    to: getAddress(params.to),
    valueWei: params.valueWei.toString(),
    data: "0x",
    nonce: Number(signed.data.nonce),
    signatures,
  };
  return JSON.stringify(proposal);
}

/** Countersign a proposal with this device's DIFFERENT owner key and execute
 * the transaction on chain. Returns the mined transaction hash. */
export async function countersignAndExecute(params: {
  rpcUrl: string;
  chain: Chain;
  signerKey: Hex;
  localSignerAddress: string;
  proposalJson: string;
}): Promise<{ txHash: Hex }> {
  const proposal = parseProposal(params.proposalJson);
  if (proposal.chainId !== params.chain.id) {
    throw new EvmError(
      `proposal is for chain ${proposal.chainId}, this device is on ${params.chain.id}`,
    );
  }
  assertDistinctSigner(
    proposal.signatures.map((s) => s.signer),
    params.localSignerAddress,
  );

  const protocolKit = await Safe.init({
    provider: params.rpcUrl,
    signer: params.signerKey,
    safeAddress: proposal.safeAddress,
  });
  // Rebuild the identical transaction (same nonce) and graft the proposer's
  // signature onto it before adding ours.
  const tx = await protocolKit.createTransaction({
    transactions: [{ to: proposal.to, value: proposal.valueWei, data: proposal.data }],
    options: { nonce: proposal.nonce },
  });
  for (const sig of proposal.signatures) {
    tx.addSignature(new EthSafeSignature(sig.signer, sig.data));
  }
  const signed = await protocolKit.signTransaction(tx);
  const distinct = new Set([...signed.signatures.keys()]);
  if (distinct.size < 2) {
    throw new EvmError("fewer than two distinct owner signatures; refusing to execute");
  }
  const result = await protocolKit.executeTransaction(signed);
  const txHash = result.hash as Hex;

  const client = createPublicClient({ chain: params.chain, transport: http(params.rpcUrl) });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new EvmError(`Safe execution transaction ${txHash} reverted`);
  }
  return { txHash };
}
