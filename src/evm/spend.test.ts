import { describe, expect, test } from "vitest";
import { EvmError } from "./index";
import { assertDistinctSigner, parseProposal, type SafeSpendProposal } from "./spend";

const OWNER_A = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const OWNER_B = "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF";
const SAFE = "0x1000000000000000000000000000000000000001";

const good: SafeSpendProposal = {
  v: 1,
  chainId: 84532,
  safeAddress: SAFE,
  to: OWNER_B,
  valueWei: "1000000000000000",
  data: "0x",
  nonce: 0,
  signatures: [{ signer: OWNER_A, data: `0x${"ab".repeat(65)}` }],
};

describe("parseProposal fails closed", () => {
  test("a valid proposal parses with checksummed addresses", () => {
    const parsed = parseProposal(JSON.stringify({ ...good, safeAddress: SAFE.toLowerCase() }));
    expect(parsed.safeAddress).toBe(SAFE);
    expect(parsed.signatures[0]!.signer).toBe(OWNER_A);
  });

  test("malformed payloads refuse", () => {
    const bads: unknown[] = [
      "not json",
      JSON.stringify({}),
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, chainId: "84532" }),
      JSON.stringify({ ...good, safeAddress: "0xnope" }),
      JSON.stringify({ ...good, valueWei: "1.5" }),
      JSON.stringify({ ...good, valueWei: "-1" }),
      JSON.stringify({ ...good, data: "cafe" }),
      JSON.stringify({ ...good, nonce: -1 }),
      JSON.stringify({ ...good, nonce: 1.5 }),
      JSON.stringify({ ...good, signatures: [] }),
      JSON.stringify({ ...good, signatures: [{ signer: OWNER_A, data: "nope" }] }),
    ];
    for (const bad of bads) {
      expect(() => parseProposal(bad as string), String(bad).slice(0, 60)).toThrow(EvmError);
    }
  });

  test("duplicate signers in a payload refuse", () => {
    const dup = {
      ...good,
      signatures: [
        { signer: OWNER_A, data: `0x${"ab".repeat(65)}` },
        { signer: OWNER_A.toLowerCase(), data: `0x${"cd".repeat(65)}` },
      ],
    };
    expect(() => parseProposal(JSON.stringify(dup))).toThrow(/duplicate/i);
  });
});

describe("countersign identity check", () => {
  test("a different owner may countersign", () => {
    expect(() => assertDistinctSigner([OWNER_A], OWNER_B)).not.toThrow();
  });

  test("the proposing key may not countersign its own proposal, case-insensitively", () => {
    expect(() => assertDistinctSigner([OWNER_A], OWNER_A)).toThrow(EvmError);
    expect(() => assertDistinctSigner([OWNER_A], OWNER_A.toLowerCase())).toThrow(EvmError);
  });
});
