// Manual Safe deployment. Run by the developer, never by CI:
//
//   RPC_URL=https://sepolia.base.org \
//   CHAIN=base-sepolia \
//   DEPLOYER_PRIVATE_KEY=0x... \
//   OWNER_A=0x... OWNER_B=0x... OWNER_C=0x... \
//   node scripts/deploy-safe.ts
//
// DEPLOYER_PRIVATE_KEY only pays gas. On testnet use a throwaway key. At
// funding time this runs against Base with the real owner addresses, and the
// printed read-back is the pre-funding checklist evidence.
// This script prints addresses, hashes, and the on-chain config — never keys.

import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { deploySafe, verifySafeDeployment } from "../src/evm/index.ts";

declare const process: {
  env: Record<string, string | undefined>;
  exit(code: number): never;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const chainName = requireEnv("CHAIN");
const chain = chainName === "base" ? base : chainName === "base-sepolia" ? baseSepolia : undefined;
if (chain === undefined) {
  console.error(`CHAIN must be "base" or "base-sepolia", got "${chainName}"`);
  process.exit(1);
}

const rpcUrl = requireEnv("RPC_URL");
const deployer = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const owners = [
  requireEnv("OWNER_A"),
  requireEnv("OWNER_B"),
  requireEnv("OWNER_C"),
] as const;

console.log(`deploying 2-of-3 Safe on ${chain.name} (deployer ${deployer.address})`);
const { safeAddress, txHash } = await deploySafe({ owners, chain, rpcUrl, deployer });
console.log(`deployment transaction mined: ${txHash}`);
console.log(`predicted Safe address: ${safeAddress}`);

console.log("reading configuration back from the chain...");
const client = createPublicClient({ chain, transport: http(rpcUrl) });

// Public RPCs are load balanced and a read replica can lag the node that
// confirmed the receipt, making a freshly deployed contract briefly look
// absent. Wait (bounded) for the code to become visible. This is
// availability plumbing, not a security fallback: if the code never
// appears, the strict verification below still fails hard.
for (let attempt = 0; attempt < 15; attempt++) {
  const code = await client.getCode({ address: safeAddress });
  if (code !== undefined && code !== "0x") break;
  console.log("  contract code not visible yet, waiting 2s...");
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
const config = await verifySafeDeployment(client, safeAddress, owners);
console.log(`on-chain owners (${config.owners.length}):`);
for (const owner of config.owners) console.log(`  ${owner}`);
console.log(`on-chain threshold: ${config.threshold}`);
console.log("read-back verification passed: 3 owners, threshold 2");
