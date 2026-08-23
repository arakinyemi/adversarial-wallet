import { beforeAll, describe, expect, test, vi } from "vitest";
import {
  hasSecret,
  KeyValueBackend,
  MIN_PIN_LENGTH,
  openSecret,
  PBKDF2_ITERATIONS,
  removeSecret,
  sealSecret,
  StorageError,
  type SealedEnvelopeV1,
} from "./index";

const PIN = "483920";
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function memoryBackend() {
  const map = new Map<string, string>();
  const setCalls: string[] = [];
  const backend: KeyValueBackend = {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      setCalls.push(value);
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
  };
  return { backend, map, setCalls };
}

// Sealed once, shared by the read-side tests: PBKDF2 at 600k iterations is
// deliberately slow, so we don't re-seal per test.
let shared: ReturnType<typeof memoryBackend>;
beforeAll(async () => {
  shared = memoryBackend();
  await sealSecret(shared.backend, "shared", SECRET, PIN);
});

const tampered = (mutate: (e: SealedEnvelopeV1) => void) => {
  const envelope = JSON.parse(shared.map.get("shared")!) as SealedEnvelopeV1;
  mutate(envelope);
  const { backend } = memoryBackend();
  return { backend, write: () => backend.set("shared", JSON.stringify(envelope)) };
};

describe("round trip", () => {
  test("seal then open returns the original bytes", async () => {
    const opened = await openSecret(shared.backend, "shared", PIN);
    expect(Array.from(opened)).toEqual(Array.from(SECRET));
  });

  test("what is persisted is a sealed envelope, never the plaintext", () => {
    const [stored] = shared.setCalls;
    expect(stored).toBeDefined();
    const envelope = JSON.parse(stored!) as SealedEnvelopeV1;
    expect(envelope.v).toBe(1);
    expect(envelope.iter).toBeGreaterThanOrEqual(PBKDF2_ITERATIONS);
    expect(stored).not.toContain(toB64(SECRET));
    expect(fromB64(envelope.ct)).not.toEqual(SECRET);
  });

  test("sealing the same secret twice produces different salts, ivs and ciphertexts", async () => {
    const { backend, map } = memoryBackend();
    await sealSecret(backend, "a", SECRET, PIN);
    await sealSecret(backend, "b", SECRET, PIN);
    const a = JSON.parse(map.get("a")!) as SealedEnvelopeV1;
    const b = JSON.parse(map.get("b")!) as SealedEnvelopeV1;
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("decryption fails closed", () => {
  test("wrong PIN refuses", async () => {
    await expect(openSecret(shared.backend, "shared", "483921")).rejects.toThrow(
      StorageError,
    );
  });

  test("tampered ciphertext refuses", async () => {
    const { backend, write } = tampered((e) => {
      const ct = fromB64(e.ct);
      ct[0]! ^= 0xff;
      e.ct = toB64(ct);
    });
    await write();
    await expect(openSecret(backend, "shared", PIN)).rejects.toThrow(StorageError);
  });

  test("tampered iv refuses", async () => {
    const { backend, write } = tampered((e) => {
      const iv = fromB64(e.iv);
      iv[0]! ^= 0xff;
      e.iv = toB64(iv);
    });
    await write();
    await expect(openSecret(backend, "shared", PIN)).rejects.toThrow(StorageError);
  });

  test("an envelope claiming fewer KDF iterations refuses before decrypting", async () => {
    const { backend, write } = tampered((e) => {
      e.iter = 1_000;
    });
    await write();
    await expect(openSecret(backend, "shared", PIN)).rejects.toThrow(/iteration/);
  });

  test("malformed and wrong-version envelopes refuse", async () => {
    const { backend } = memoryBackend();
    for (const bad of [
      "not json",
      "{}",
      JSON.stringify({ v: 2, kdf: "PBKDF2-HMAC-SHA256", iter: PBKDF2_ITERATIONS, salt: "", iv: "", ct: "" }),
      JSON.stringify({ v: 1, kdf: "PBKDF2-HMAC-SHA256", iter: PBKDF2_ITERATIONS }),
    ]) {
      await backend.set("bad", bad);
      await expect(openSecret(backend, "bad", PIN)).rejects.toThrow(StorageError);
    }
  });

  test("a missing entry refuses", async () => {
    const { backend } = memoryBackend();
    await expect(openSecret(backend, "absent", PIN)).rejects.toThrow(/no stored secret/);
  });
});

describe("storage and crypto unavailability fail closed — never plaintext", () => {
  test("a backend that cannot write refuses the seal and stores nothing anywhere", async () => {
    const attempts: string[] = [];
    const dead: KeyValueBackend = {
      async get() {
        return null;
      },
      async set(_key, value) {
        attempts.push(value);
        throw new Error("storage unavailable");
      },
      async remove() {},
    };
    await expect(sealSecret(dead, "x", SECRET, PIN)).rejects.toThrow();
    // Exactly one write attempt, and it was a sealed envelope — no retry
    // with a plaintext or downgraded payload.
    expect(attempts).toHaveLength(1);
    const envelope = JSON.parse(attempts[0]!) as SealedEnvelopeV1;
    expect(envelope.ct).toBeDefined();
    expect(attempts[0]).not.toContain(toB64(SECRET));
  });

  test("WebCrypto unavailable refuses before anything reaches the backend", async () => {
    const { backend, setCalls } = memoryBackend();
    vi.stubGlobal("crypto", undefined);
    try {
      await expect(sealSecret(backend, "x", SECRET, PIN)).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(setCalls).toHaveLength(0);
  });
});

describe("input validation", () => {
  test(`a PIN shorter than ${MIN_PIN_LENGTH} refuses`, async () => {
    const { backend, setCalls } = memoryBackend();
    await expect(sealSecret(backend, "x", SECRET, "12345")).rejects.toThrow(
      StorageError,
    );
    expect(setCalls).toHaveLength(0);
  });

  test("an empty secret refuses", async () => {
    const { backend } = memoryBackend();
    await expect(
      sealSecret(backend, "x", new Uint8Array(0), PIN),
    ).rejects.toThrow(StorageError);
  });
});

describe("lifecycle helpers", () => {
  test("hasSecret and removeSecret", async () => {
    const { backend } = memoryBackend();
    expect(await hasSecret(backend, "x")).toBe(false);
    await sealSecret(backend, "x", SECRET, PIN);
    expect(await hasSecret(backend, "x")).toBe(true);
    await removeSecret(backend, "x");
    expect(await hasSecret(backend, "x")).toBe(false);
    await expect(openSecret(backend, "x", PIN)).rejects.toThrow(/no stored secret/);
  });
});
