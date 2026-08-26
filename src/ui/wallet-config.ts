// Non-secret wallet configuration (network, endpoints, public keys).
// Secrets never belong here: the seed is sealed by the storage module, the
// Bitcoin passphrase is never persisted anywhere, and the LNbits admin key
// is sealed separately.

import type { KeyValueBackend } from "../storage";

export const CONFIG_KEY = "wallet.config.v1";

export interface WalletConfig {
  network: "mainnet" | "testnet";
  theme: "dark" | "light";
  biometricUnlock: boolean;
  esploraUrl: string;
  /** Account xpub of the passphrase wallet — public, watch-only. */
  xpub: string;
  lnbitsUrl: string;
  /** Invoice/read key. The admin (pay) key is sealed, never stored plain. */
  lnbitsInvoiceKey: string;
  safeAddress: string;
  safeOwners: string[];
}

export const DEFAULT_CONFIG: WalletConfig = {
  network: "testnet",
  theme: "dark",
  biometricUnlock: false,
  esploraUrl: "https://blockstream.info/testnet/api",
  xpub: "",
  lnbitsUrl: "",
  lnbitsInvoiceKey: "",
  safeAddress: "",
  safeOwners: [],
};

export async function loadConfig(backend: KeyValueBackend): Promise<WalletConfig> {
  const raw = await backend.get(CONFIG_KEY);
  if (raw === null) return { ...DEFAULT_CONFIG };
  const parsed = JSON.parse(raw) as Partial<WalletConfig>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export async function saveConfig(
  backend: KeyValueBackend,
  config: WalletConfig,
): Promise<void> {
  await backend.set(CONFIG_KEY, JSON.stringify(config));
}
