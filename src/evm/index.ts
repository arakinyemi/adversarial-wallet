// EVM component: one Safe on Base with three owners and a threshold of two.
// Signer A lives in the app and is deliberately insufficient on its own —
// the strength of this component is the contract's 2-of-3 requirement, not
// the secrecy of any single key. See PLAN.md §4.
//
// Fail-closed contract: every function either returns verified output or
// throws. Deployment output is never trusted; verifySafeDeployment reads the
// owner set and threshold back from the chain independently.

import Safe from "@safe-global/protocol-kit";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const SAFE_OWNER_COUNT = 3;
export const SAFE_THRESHOLD = 2;

export class EvmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvmError";
  }
}

export interface DeploySafeParams {
  /** Exactly three distinct owner addresses: A (app), B (second device), C (paper). */
  owners: readonly [string, string, string];
  chain: Chain;
  rpcUrl: string;
  /** Pays gas for the deployment transaction. */
  deployer: PrivateKeyAccount;
}

export interface SafeOnChainConfig {
  owners: Address[];
  threshold: bigint;
}

// The two Safe view functions the read-back verification needs. Standard
// signatures from the Safe contract interface; no addresses are hardcoded.
const SAFE_READBACK_ABI = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Turn 32 bytes of verified seed entropy into an EVM signer account. */
export function entropyToEvmSigner(entropy: Uint8Array): PrivateKeyAccount {
  if (entropy.byteLength !== 32) {
    throw new EvmError(
      `signer entropy must be exactly 32 bytes, got ${entropy.byteLength}`,
    );
  }
  if (entropy.every((b) => b === 0)) {
    throw new EvmError("signer entropy is all zero");
  }
  // The hex string is an unavoidable transient copy of the key; JavaScript
  // strings cannot be zeroed. Recorded in LIMITATIONS.md.
  const keyHex = `0x${Array.from(entropy, (b) => b.toString(16).padStart(2, "0")).join("")}` as const;
  // viem/noble rejects scalars outside the secp256k1 range — no silent wrap.
  return privateKeyToAccount(keyHex as Hex);
}

/** Checksum-normalise, and refuse anything but 3 distinct addresses. */
function normalizeOwners(owners: readonly string[]): [Address, Address, Address] {
  if (owners.length !== SAFE_OWNER_COUNT) {
    throw new EvmError(
      `a Safe needs exactly ${SAFE_OWNER_COUNT} owners, got ${owners.length}`,
    );
  }
  const normalized = owners.map((o) => getAddress(o));
  if (new Set(normalized).size !== SAFE_OWNER_COUNT) {
    throw new EvmError("Safe owners must be three distinct addresses");
  }
  return normalized as [Address, Address, Address];
}

/** Deploy a 2-of-3 Safe. The returned address is a prediction plus a mined
 * deployment transaction — callers MUST run verifySafeDeployment before
 * treating the Safe as real. */
export async function deploySafe(
  params: DeploySafeParams,
): Promise<{ safeAddress: Address; txHash: Hex }> {
  const owners = normalizeOwners(params.owners);

  const protocolKit = await Safe.init({
    provider: params.rpcUrl,
    predictedSafe: {
      safeAccountConfig: { owners, threshold: SAFE_THRESHOLD },
    },
  });
  const safeAddress = getAddress(await protocolKit.getAddress());
  if (await protocolKit.isSafeDeployed()) {
    throw new EvmError(`a Safe already exists at ${safeAddress}`);
  }

  const deploymentTx = await protocolKit.createSafeDeploymentTransaction();
  const walletClient = createWalletClient({
    account: params.deployer,
    chain: params.chain,
    transport: http(params.rpcUrl),
  });
  const txHash = await walletClient.sendTransaction({
    to: getAddress(deploymentTx.to),
    value: BigInt(deploymentTx.value),
    data: deploymentTx.data as Hex,
  });

  const publicClient = createPublicClient({
    chain: params.chain,
    transport: http(params.rpcUrl),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new EvmError(`Safe deployment transaction ${txHash} reverted`);
  }

  return { safeAddress, txHash };
}

/** The one client capability verification needs. Chain-specific viem clients
 * (Base has OP-stack formatters) all satisfy this, where the full
 * PublicClient type would reject them over irrelevant methods. */
export type SafeReader = Pick<PublicClient, "readContract">;

/** Read the owner set and threshold back from the contract itself and refuse
 * unless they are exactly the three expected owners with threshold 2.
 * All values in errors here are public on-chain data. */
export async function verifySafeDeployment(
  client: SafeReader,
  safeAddress: string,
  expectedOwners: readonly [string, string, string],
): Promise<SafeOnChainConfig> {
  const expected = normalizeOwners(expectedOwners);
  const address = getAddress(safeAddress);

  const chainOwnersRaw = await client.readContract({
    address,
    abi: SAFE_READBACK_ABI,
    functionName: "getOwners",
  });
  const threshold = await client.readContract({
    address,
    abi: SAFE_READBACK_ABI,
    functionName: "getThreshold",
  });

  const chainOwners = chainOwnersRaw.map((o) => getAddress(o));
  if (chainOwners.length !== SAFE_OWNER_COUNT) {
    throw new EvmError(
      `Safe at ${address} has ${chainOwners.length} owners on chain, expected ${SAFE_OWNER_COUNT}`,
    );
  }
  const chainSet = new Set(chainOwners);
  for (const owner of expected) {
    if (!chainSet.has(owner)) {
      throw new EvmError(
        `Safe at ${address} is missing expected owner ${owner}; on-chain owners: ${chainOwners.join(", ")}`,
      );
    }
  }
  if (threshold !== BigInt(SAFE_THRESHOLD)) {
    throw new EvmError(
      `Safe at ${address} has threshold ${threshold} on chain, expected ${SAFE_THRESHOLD}`,
    );
  }

  return { owners: chainOwners, threshold };
}
