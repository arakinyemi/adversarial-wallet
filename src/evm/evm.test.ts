import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  type EIP1193Parameters,
} from "viem";
import { describe, expect, test } from "vitest";
import {
  deploySafe,
  entropyToEvmSigner,
  EvmError,
  readSafeConfig,
  SAFE_THRESHOLD,
  verifySafeDeployment,
  type DeploySafeParams,
} from "./index";

// Well-known reference vectors (independent of viem: these key→address pairs
// are fixed by secp256k1 + keccak and published in countless references).
const KEY_ONE_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"; // key 0x…01
const KEY_TWO_ADDRESS = "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF"; // key 0x…02

const entropyOfLastByte = (last: number): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return bytes;
};

describe("signer derivation from entropy", () => {
  test("known entropy derives the reference addresses", () => {
    expect(entropyToEvmSigner(entropyOfLastByte(1)).address).toBe(KEY_ONE_ADDRESS);
    expect(entropyToEvmSigner(entropyOfLastByte(2)).address).toBe(KEY_TWO_ADDRESS);
  });

  test("wrong entropy length refuses", () => {
    for (const len of [0, 16, 31, 33, 64]) {
      expect(() => entropyToEvmSigner(new Uint8Array(len).fill(7))).toThrow(
        EvmError,
      );
    }
  });

  test("all-zero entropy refuses", () => {
    expect(() => entropyToEvmSigner(new Uint8Array(32))).toThrow(EvmError);
  });

  test("the account object does not serialise its private key", () => {
    const keyHex = "01".padStart(64, "0");
    const account = entropyToEvmSigner(entropyOfLastByte(1));
    expect(JSON.stringify(account)).not.toContain(keyHex);
  });
});

const OWNER_A = KEY_ONE_ADDRESS;
const OWNER_B = KEY_TWO_ADDRESS;
const OWNER_C = "0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69"; // key 0x…03

// Owner validation must reject before any network access: the RPC URL points
// at a closed port, so reaching the network would fail differently.
const deployParams = (owners: readonly string[]): DeploySafeParams =>
  ({
    owners: owners as unknown as DeploySafeParams["owners"],
    chain: { id: 8453, name: "stub", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } },
    rpcUrl: "http://127.0.0.1:1",
    deployer: entropyToEvmSigner(entropyOfLastByte(1)),
  }) as DeploySafeParams;

describe("deploySafe input validation fails closed", () => {
  test("two owners refuse", async () => {
    await expect(deploySafe(deployParams([OWNER_A, OWNER_B]))).rejects.toThrow(
      EvmError,
    );
  });

  test("four owners refuse", async () => {
    await expect(
      deploySafe(deployParams([OWNER_A, OWNER_B, OWNER_C, OWNER_A])),
    ).rejects.toThrow(EvmError);
  });

  test("duplicate owners refuse, case-insensitively", async () => {
    await expect(
      deploySafe(deployParams([OWNER_A, OWNER_B, OWNER_A.toLowerCase()])),
    ).rejects.toThrow(EvmError);
  });

  test("a malformed owner address refuses", async () => {
    await expect(
      deploySafe(deployParams([OWNER_A, OWNER_B, "0xnot-an-address"])),
    ).rejects.toThrow();
  });
});

// --- verifySafeDeployment against a mocked chain -------------------------

const SAFE_ABI = [
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

const SAFE_ADDRESS = "0x1000000000000000000000000000000000000001";

function mockChainClient(owners: string[], threshold: bigint) {
  const getOwnersData = encodeFunctionData({ abi: SAFE_ABI, functionName: "getOwners" });
  const getThresholdData = encodeFunctionData({ abi: SAFE_ABI, functionName: "getThreshold" });
  return createPublicClient({
    transport: custom({
      async request({ method, params }: EIP1193Parameters) {
        if (method === "eth_chainId") return "0x2105";
        if (method === "eth_call") {
          const [call] = params as [{ to: string; data: string }];
          if (call.data === getOwnersData) {
            return encodeAbiParameters([{ type: "address[]" }], [owners as `0x${string}`[]]);
          }
          if (call.data === getThresholdData) {
            return encodeAbiParameters([{ type: "uint256" }], [threshold]);
          }
        }
        throw new Error(`unmocked RPC method: ${method}`);
      },
    }),
  });
}

describe("readSafeConfig (no expectation) still fails closed on shape", () => {
  test("returns owners and threshold from a healthy account", async () => {
    const client = mockChainClient([OWNER_A, OWNER_B, OWNER_C], 2n);
    const cfg = await readSafeConfig(client, SAFE_ADDRESS);
    expect(cfg.owners).toHaveLength(3);
    expect(cfg.threshold).toBe(2n);
  });

  test("wrong owner count or threshold refuses", async () => {
    await expect(readSafeConfig(mockChainClient([OWNER_A, OWNER_B], 2n), SAFE_ADDRESS)).rejects.toThrow(EvmError);
    await expect(readSafeConfig(mockChainClient([OWNER_A, OWNER_B, OWNER_C], 1n), SAFE_ADDRESS)).rejects.toThrow(EvmError);
  });
});

describe("verifySafeDeployment reads back from chain and fails closed", () => {
  const expected = [OWNER_A, OWNER_B, OWNER_C] as const;

  test("correct owners and threshold 2 verify", async () => {
    const client = mockChainClient([OWNER_A, OWNER_B, OWNER_C], 2n);
    const config = await verifySafeDeployment(client, SAFE_ADDRESS, expected);
    expect(config.threshold).toBe(BigInt(SAFE_THRESHOLD));
    expect(config.owners).toHaveLength(3);
  });

  test("owner order and casing from the chain do not matter", async () => {
    const client = mockChainClient(
      [OWNER_C.toLowerCase(), OWNER_A, OWNER_B.toLowerCase()],
      2n,
    );
    await expect(
      verifySafeDeployment(client, SAFE_ADDRESS, expected),
    ).resolves.toBeDefined();
  });

  test("threshold 1 refuses", async () => {
    const client = mockChainClient([OWNER_A, OWNER_B, OWNER_C], 1n);
    await expect(
      verifySafeDeployment(client, SAFE_ADDRESS, expected),
    ).rejects.toThrow(/threshold/);
  });

  test("threshold 3 refuses", async () => {
    const client = mockChainClient([OWNER_A, OWNER_B, OWNER_C], 3n);
    await expect(
      verifySafeDeployment(client, SAFE_ADDRESS, expected),
    ).rejects.toThrow(/threshold/);
  });

  test("two owners on chain refuse", async () => {
    const client = mockChainClient([OWNER_A, OWNER_B], 2n);
    await expect(
      verifySafeDeployment(client, SAFE_ADDRESS, expected),
    ).rejects.toThrow(EvmError);
  });

  test("an unexpected owner on chain refuses", async () => {
    const intruder = "0x1df62f291b2e969fb0849d99d9ce41e2f137006e";
    const client = mockChainClient([OWNER_A, OWNER_B, intruder], 2n);
    await expect(
      verifySafeDeployment(client, SAFE_ADDRESS, expected),
    ).rejects.toThrow(EvmError);
  });

  test("an RPC failure propagates — verification never passes on error", async () => {
    const client = createPublicClient({
      transport: custom({
        async request() {
          throw new Error("rpc unreachable");
        },
      }),
    });
    await expect(
      verifySafeDeployment(client, SAFE_ADDRESS, expected),
    ).rejects.toThrow();
  });
});
