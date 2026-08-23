// Standalone Safe read-back verification. Run any time, deploys nothing:
//
//   RPC_URL=https://sepolia.base.org \
//   CHAIN=base-sepolia \
//   SAFE_ADDRESS=0x... \
//   OWNER_A=0x... OWNER_B=0x... OWNER_C=0x... \
//   node scripts/verify-safe.ts
//
// At funding time this run against CHAIN=base is the pre-funding checklist
// evidence for "owner list and threshold read back from the chain".

import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { verifySafeDeployment } from "../src/evm/index.ts";

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

const safeAddress = requireEnv("SAFE_ADDRESS");
const owners = [
  requireEnv("OWNER_A"),
  requireEnv("OWNER_B"),
  requireEnv("OWNER_C"),
] as const;

const client = createPublicClient({ chain, transport: http(requireEnv("RPC_URL")) });
console.log(`reading Safe ${safeAddress} back from ${chain.name}...`);
const config = await verifySafeDeployment(client, safeAddress, owners);
console.log(`on-chain owners (${config.owners.length}):`);
for (const owner of config.owners) console.log(`  ${owner}`);
console.log(`on-chain threshold: ${config.threshold}`);
console.log("read-back verification passed: 3 owners, threshold 2");
