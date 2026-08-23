// Encrypted at-rest storage for app-resident secrets (signer A now, the
// Bitcoin seed at step 5 — never the Bitcoin passphrase, which is never
// persisted anywhere).
//
// Scheme: WebCrypto PBKDF2-HMAC-SHA256 (600k iterations) deriving an
// AES-256-GCM key from a user PIN. Argon2id/StrongBox were cut deliberately —
// see PLAN.md §7. This layer is defence in depth: even a fully decrypted
// signer A cannot move funds on its own (2-of-3 contract).
//
// Fail-closed contract: storage or WebCrypto being unavailable refuses with
// an error. There is no plaintext fallback, no in-memory fallback, and no
// path that stores anything but a sealed envelope. The only catch block
// rethrows a decryption failure as StorageError; nothing is swallowed.

import { drawPlatformEntropy } from "../entropy";

export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PIN_LENGTH = 6;
export const SIGNER_A_STORAGE_KEY = "wallet.signer-a.v1";

const SALT_LENGTH = 32;
const IV_LENGTH = 12;

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/** Minimal persistence surface; adapters exist for Capacitor Preferences.
 * Injectable so tests can simulate unavailable or hostile storage. */
export interface KeyValueBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Versioned sealed envelope as persisted (all binary fields base64). */
export interface SealedEnvelopeV1 {
  v: 1;
  kdf: "PBKDF2-HMAC-SHA256";
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function subtleOrThrow(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new StorageError("WebCrypto is unavailable; refusing to store secrets");
  }
  return subtle;
}

async function deriveAesKey(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const subtle = subtleOrThrow();
  const pinBytes = new TextEncoder().encode(pin);
  const material = await subtle.importKey("raw", pinBytes, "PBKDF2", false, [
    "deriveKey",
  ]);
  pinBytes.fill(0); // best-effort residue reduction; see LIMITATIONS.md
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

function validatePin(pin: string): void {
  if (pin.length < MIN_PIN_LENGTH) {
    throw new StorageError(`PIN must be at least ${MIN_PIN_LENGTH} characters`);
  }
}

/** Encrypt secret under pin and persist it, or throw with nothing stored. */
export async function sealSecret(
  backend: KeyValueBackend,
  name: string,
  secret: Uint8Array<ArrayBuffer>,
  pin: string,
): Promise<void> {
  validatePin(pin);
  if (secret.byteLength === 0) {
    throw new StorageError("refusing to seal an empty secret");
  }

  // Health-checked draws from the entropy module; a failing platform RNG
  // aborts the seal rather than producing a weak salt or reused iv.
  const salt = drawPlatformEntropy().subarray(0, SALT_LENGTH);
  const iv = drawPlatformEntropy().subarray(0, IV_LENGTH);

  const key = await deriveAesKey(pin, salt, PBKDF2_ITERATIONS, "encrypt");
  const ciphertext = new Uint8Array(
    await subtleOrThrow().encrypt({ name: "AES-GCM", iv }, key, secret),
  );

  const envelope: SealedEnvelopeV1 = {
    v: 1,
    kdf: "PBKDF2-HMAC-SHA256",
    iter: PBKDF2_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ciphertext),
  };
  await backend.set(name, JSON.stringify(envelope));
}

function parseEnvelope(raw: string): SealedEnvelopeV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageError("stored envelope is not valid JSON");
  }
  const e = parsed as Partial<SealedEnvelopeV1> | null;
  if (
    e === null ||
    typeof e !== "object" ||
    e.v !== 1 ||
    e.kdf !== "PBKDF2-HMAC-SHA256" ||
    typeof e.iter !== "number" ||
    typeof e.salt !== "string" ||
    typeof e.iv !== "string" ||
    typeof e.ct !== "string"
  ) {
    throw new StorageError("stored envelope has an unknown format or version");
  }
  if (e.iter < PBKDF2_ITERATIONS) {
    throw new StorageError(
      `stored envelope claims ${e.iter} KDF iterations, below the required ${PBKDF2_ITERATIONS}`,
    );
  }
  return e as SealedEnvelopeV1;
}

/** Load, validate, and decrypt a sealed secret, or throw. */
export async function openSecret(
  backend: KeyValueBackend,
  name: string,
  pin: string,
): Promise<Uint8Array> {
  validatePin(pin);
  const raw = await backend.get(name);
  if (raw === null) {
    throw new StorageError(`no stored secret named "${name}"`);
  }
  const envelope = parseEnvelope(raw);
  const salt = fromB64(envelope.salt);
  const iv = fromB64(envelope.iv);
  if (salt.byteLength !== SALT_LENGTH || iv.byteLength !== IV_LENGTH) {
    throw new StorageError("stored envelope has malformed salt or iv");
  }

  const key = await deriveAesKey(pin, salt, envelope.iter, "decrypt");
  try {
    const plaintext = await subtleOrThrow().decrypt(
      { name: "AES-GCM", iv },
      key,
      fromB64(envelope.ct),
    );
    return new Uint8Array(plaintext);
  } catch {
    // AES-GCM authentication failed: wrong PIN or tampered data. Rethrow —
    // never continue — with a message that names the failure, not the material.
    throw new StorageError("decryption failed: wrong PIN or tampered data");
  }
}

export async function hasSecret(
  backend: KeyValueBackend,
  name: string,
): Promise<boolean> {
  return (await backend.get(name)) !== null;
}

export async function removeSecret(
  backend: KeyValueBackend,
  name: string,
): Promise<void> {
  await backend.remove(name);
}
