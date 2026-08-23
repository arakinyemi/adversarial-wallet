// Two-signature Safe spend rehearsal. Run by the developer, never CI.
//
// Proposes with PROPOSER_PRIVATE_KEY, countersigns and executes with
// EXECUTOR_PRIVATE_KEY — two different owners of the Safe. Run it with
// B and C (A unused) to satisfy the pre-funding checklist line
// "a transaction signed by signers B and C only executes".
//
//   RPC_URL=https://sepolia.base.org CHAIN=base-sepolia \
//   SAFE_ADDRESS=0x... \
//   PROPOSER_PRIVATE_KEY=0x...  EXECUTOR_PRIVATE_KEY=0x... \
//   TO=0x... VALUE_ETH=0.0001 \
//   node scripts/safe-rehearsal.ts
//
// The Safe must hold at least VALUE_ETH plus a little; the executor key
// pays the gas. Testnet throwaway keys only. Prints addresses, the payload,
// and tx hashes — never keys.

import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { countersignAndExecute, proposeSafeSpend } from "../src/evm/spend.ts";

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
const safeAddress = requireEnv("SAFE_ADDRESS");
const proposer = privateKeyToAccount(requireEnv("PROPOSER_PRIVATE_KEY") as `0x${string}`);
const executor = privateKeyToAccount(requireEnv("EXECUTOR_PRIVATE_KEY") as `0x${string}`);
const to = requireEnv("TO");
const valueWei = parseEther(requireEnv("VALUE_ETH"));

console.log(`proposer (signs first):        ${proposer.address}`);
console.log(`executor (countersigns, pays): ${executor.address}`);

console.log("signing proposal with the proposer key...");
const payload = await proposeSafeSpend({
  rpcUrl,
  chain,
  safeAddress,
  signerKey: requireEnv("PROPOSER_PRIVATE_KEY") as `0x${string}`,
  to,
  valueWei,
});
console.log(`proposal payload (${payload.length} bytes):`);
console.log(payload);

console.log("countersigning and executing with the executor key...");
const { txHash } = await countersignAndExecute({
  rpcUrl,
  chain,
  signerKey: requireEnv("EXECUTOR_PRIVATE_KEY") as `0x${string}`,
  localSignerAddress: executor.address,
  proposalJson: payload,
});
console.log(`executed and mined: ${txHash}`);
console.log("two-signature rehearsal complete");
