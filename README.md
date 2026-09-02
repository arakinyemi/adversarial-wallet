# Adversarial Wallet

A self-custody wallet for Android supporting three networks:

- **Bitcoin** on-chain (BIP39/BIP84, native segwit)
- **Lightning**, through an [LNbits](https://lnbits.com) instance
- **ETH on Base**, held in a [Safe](https://safe.global) smart account with
  three owners and a threshold of two

Built with React + TypeScript, packaged with Capacitor, with a Rust core
compiled to WebAssembly handling all key material: seed generation, key
derivation, and transaction signing.

## How funds are held

**Bitcoin.** The wallet generates a 24-word BIP39 seed. On top of it the user
chooses a BIP39 passphrase, entered at setup and again for every spend; it is
never written to storage. Day to day the app is watch-only, deriving
addresses from the account xpub. Spending derives the keys in memory for one
signature and discards them.

**Seed generation** has two user-chosen tiers: quick (platform CSPRNG,
`crypto.getRandomValues`) and advanced, which XORs the CSPRNG output with
SHA-256 of at least 50 user-entered physical dice rolls. Each tier fails
closed — a source that throws, returns short, or fails its health check
aborts generation with a visible error, with no fallback between tiers.
See [ENTROPY.md](ENTROPY.md).

**Base.** The Safe contract requires signatures from two of its three owner
keys for every transaction. One key lives on this device (generated
independently of the Bitcoin seed), one on a second device, one on paper. Sending is a
two-device flow: one device signs and exports a proposal payload, the other
countersigns and executes.

**Lightning.** A wallet the app provisions for itself on its built-in
LNbits instance. The invoice
(read) key is stored as configuration; the admin (pay) key is stored
encrypted and unlocked per payment. Settled payments are accepted only when
the preimage verifiably hashes to the payment hash.

**At-rest encryption.** Device secrets (the Bitcoin seed, the Base signer
key, the LNbits admin key) are sealed with AES-256-GCM under a key derived
from the user's PIN via PBKDF2-HMAC-SHA256 (600,000 iterations). The Bitcoin
passphrase is never stored in any form.

The app makes network calls only to the configured Esplora endpoint, the
configured LNbits instance, and the Base RPC. There is no telemetry, no
analytics, and no crash reporting.

## Repository layout

| Path | Contents |
|---|---|
| `core/` | Rust WASM core: entropy combining, BIP39/BIP84 derivation, transaction signing (`bitcoin`, `bip39`, `secp256k1` crates) |
| `src/entropy/` | Platform entropy draws with health checks; two-source seed generation |
| `src/storage/` | PIN-sealed encrypted storage (WebCrypto), Capacitor Preferences backend |
| `src/btc/` | Watch-only balance scanning, UTXO fetch, broadcast (Esplora) |
| `src/lightning/` | LNbits client with local preimage verification |
| `src/evm/` | Safe deployment, on-chain verification, two-signature spending |
| `src/ui/` | React screens |
| `scripts/` | Operator tools: Safe deploy/verify/rehearsal, Lightning proofs |
| `android/` | Capacitor Android project |
| `DECISIONS.md` | Running log of every design decision and why |
| `PROOFS.md` | Operational verification runbook |

## Building from source

Prerequisites:

- Node.js ≥ 26 and npm (lockfile committed; all versions pinned exact)
- Rust ≥ 1.96 with the `wasm32-unknown-unknown` target
- `wasm-pack` 0.15 (`cargo install wasm-pack --version 0.15.0 --locked`)
- A clang able to target wasm32 for the secp256k1 C sources. Apple's Xcode
  clang cannot; on macOS install LLVM (`brew install llvm`) — the
  `build:wasm` script points `CC`/`AR` at it for the wasm target only
- For the APK: JDK 21 and the Android SDK (platform 36, build-tools 36)

Build and test:

```
npm ci
npm run build:wasm     # Rust core → core/pkg (wasm + JS glue)
npm test               # TypeScript test suite (Vitest)
cargo test --manifest-path core/Cargo.toml
npm run lint
npm run build          # type-check + production web build
```

Android APK:

```
npx cap sync android
cd android && ./gradlew assembleRelease
```

Debug builds (`assembleDebug`) install directly for development.

## The challenge build

The APK handed over with the challenge device was built via `assembleDebug`
from the application source at the commit tagged `handover` (documentation
commits may postdate the build; the app source is identical). The device's
installed app keeps its data across updates only under the same signing key,
so the challenge build stays on the debug key deliberately.

```
SHA-256(Aegis.apk) = 064c0306ac9ba06d103f374f125c5fea94fc047ef87a478e9d03fdee14e93aee
```

## Running the web build

`npm run dev` serves the app locally (WASM must be built first). The app is
fully static; `npm run build && npx vite preview` serves the production
bundle.

## Configuration

There is deliberately almost none. The network (`mainnet`/`testnet`, which
also selects Base/Base Sepolia) is chosen once at wallet creation and is
immutable for the life of the wallet; chain endpoints are built in; the
Lightning account provisions itself on first visit; the Safe is linked by
pasting its address, after which the app reads the owner set from the chain
and refuses to link unless this device's key is among the owners. Settings
hold only appearance and security options. Secrets never appear anywhere in
the UI.

## Operator scripts

All scripts are run manually with plain Node (never CI) and take their
inputs from environment variables; run any of them without arguments to see
what they need.

- `scripts/deploy-safe.ts` — deploy a 2-of-3 Safe and read its
  configuration back from the chain
- `scripts/verify-safe.ts` — standalone owner/threshold read-back
- `scripts/safe-rehearsal.ts` — full two-owner spend
- `scripts/lightning-proof.ts` — Lightning receive/send with verified
  preimages, and the zero-balance check

See [PROOFS.md](PROOFS.md) for the verification runbook.

## Development conventions

- `Math.random` is banned repository-wide by lint rule; all randomness comes
  from the platform CSPRNG or user-supplied dice entropy
- No custom cryptography: primitives come from the `bitcoin`, `bip39`, and
  `secp256k1` crates, WebCrypto, `viem`, and the Safe SDK
- Every dependency is version-pinned; `Cargo.lock` and `package-lock.json`
  are committed
- Security-relevant behavior is developed test-first; the suite asserts
  refusal paths (failed entropy sources, wrong passphrases, malformed
  payloads, unavailable storage) as first-class requirements
- `DECISIONS.md` records every choice made over an alternative
