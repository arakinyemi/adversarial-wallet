# Decisions log

One entry per choice made over an alternative, with the why. This log becomes
most of the handover documentation. Newest entries at the bottom.

## Session 1 — scaffold and WASM boundary (2026-08-23)

- **Hand-written scaffold over `npm create vite`.** Every file in the repo is
  one the developer has read; a generator drops in files nobody audits.
- **All npm versions pinned exact** (`.npmrc` with `save-exact`), lockfiles
  committed. Integrity pinning comes from the SHA-512 hashes in
  `package-lock.json` and the checksums in `Cargo.lock`.
- **TypeScript 5.9.3, not 7.x.** The Go-native 7.0 compiler shipped weeks
  before this session. This project wants battle-tested, not new.
- **`Math.random` ban via ESLint core rules** (`no-restricted-properties` +
  `no-restricted-syntax`), no plugin dependency. Covers dot access, literal
  and computed bracket access (all computed access to `Math` is banned as an
  evasion vector), and destructuring. Verified by linting a canary file
  containing each form and seeing each flagged. Known limit: aliasing
  (`const M = Math; M.random()`) is beyond static linting and is a
  code-review responsibility.
- **No jsdom / testing-library / prettier / husky.** Each is attack surface;
  none is needed yet. Ask before adding when UI testing becomes real.
- **`@types/react` and `@types/react-dom` added** (dev-only, types-only —
  no runtime or build-time code executes from them). TSX cannot typecheck
  without them. A hand-written 4-line shim (`src/node-fs-shim.d.ts`) covers
  the single `node:fs` call in the boundary test instead of adding
  `@types/node`.
- **wasm-pack installed via `cargo install --locked` from crates.io source**,
  not the npm-distributed prebuilt binary. Slower once, better provenance.
- **`wasm-opt` disabled** in `core/Cargo.toml`. wasm-pack downloads it as an
  unpinned prebuilt binary from GitHub releases at build time; nothing today
  justifies that in the build path. Re-evaluate, pinned, if APK size matters.
- **No Vite WASM plugin.** `wasm-pack --target web` output is plain ESM plus a
  `.wasm` asset; the browser initialises it via a `?url` import Vite handles
  natively, and the Vitest test hands the same init function raw bytes read
  off disk. Zero glue dependencies. Rejected: `vite-plugin-wasm-pack` and
  similar third-party wrappers.
- **`core/pkg/` (generated WASM artifacts) gitignored.** The adversary audits
  Rust source and rebuilds with `npm run build:wasm`; compiled artifacts in
  the repo are unauditable bytes.
- **Boundary proof is a string round trip** (`round_trip` reverses a string):
  strings exercise wasm-bindgen's allocation/encode/decode path, which
  numbers do not. No wallet logic in the core yet, by design.
- **Known dev-only advisory accepted:** `npm audit` reports a moderate issue
  in `uuid` (via `xcode` via `@capacitor/cli`). Dev-time CLI path only,
  nothing ships in the APK. Not "fixed" because the offered fix force-
  downgrades the Capacitor CLI. Revisit when Capacitor publishes a clean
  release.
- **Android SDK note (not a dependency yet):** the NDK/native-core path stays
  cut per PLAN.md. The plain Android SDK + JDK 21 + Gradle are still required
  at step 7 to produce the APK. Neither is installed on this machine yet;
  install before step 7.

## Session 2 — entropy module, tests first (2026-08-23)

- **Tests written red-first.** Both suites were run against `todo!()` /
  throwing stubs and observed failing (10 Rust failures, TS suite red)
  before any implementation was written, then observed green after.
- **New crates, approved before adding: `sha2` =0.10.9 and `zeroize` =1.9.0.**
  sha2 pinned to the years-hardened 0.10 line, not the weeks-old 0.11.0 —
  same boring-over-new reasoning as TypeScript. zeroize is mandated by
  CLAUDE.md for key material.
- **Entropy combining lives in the Rust core, not TS.** CLAUDE.md assigns
  seed generation to the core. The alternative (WebCrypto `subtle.digest` in
  TS, zero new deps) was rejected because it puts seed derivation outside
  the core and would be migrated at step 5 anyway.
- **The WebCrypto draw stays in TS.** `getRandomValues` is a JS platform
  API; reaching it from Rust means the `getrandom`/`js-sys` glue chain —
  more supply-chain surface for zero benefit. The Rust core independently
  re-validates everything TS hands it and trusts nothing from the JS layer.
- **Health checks are deliberately minimal:** exact length, not-all-identical
  bytes, and two consecutive draws must differ. No invented statistical
  tests — a randomness test suite we designed ourselves would be custom
  crypto by another name.
- **Dice rules exactly per PLAN.md:** ≥50 rolls, chars 1–6 only. All-identical
  dice are accepted by design — the dice source guards against a weak
  platform RNG; the platform source guards against lazy dice. Each source
  alone failing aborts; neither alone is trusted.
- **Known-answer vector computed independently** with Python `hashlib`
  (not the code under test) and hard-coded in both suites; the TS copy runs
  through the WASM boundary to prove the boundary carries bytes faithfully.
- **Error messages name the failed check, never the material.** A test
  asserts messages contain no source bytes or roll values. Public error
  text is safe because nothing in this design depends on secrecy of the
  code — only of the runtime draws (Kerckhoffs).
- **JS-side buffers are `fill(0)`-ed after use, via try/finally only** —
  best-effort residue reduction, no catch blocks anywhere in the module.
  JS cannot guarantee erasure; goes in LIMITATIONS.md at step 8.
- **Verification UI deferred:** the module returns a source report
  (name + bytes + roll count per source) for the on-screen display PLAN.md
  requires; the screen itself lands with the seed-generation flow.

## Session 3 — EVM module: Safe on Base (2026-08-23)

- **New deps, approved before adding: `viem` =2.55.19 and
  `@safe-global/protocol-kit` =8.0.6** (transitives: abitype, semver, three
  Safe-official packages, all lockfile-pinned). The SDK was chosen over
  viem-only Safe deployment because `safe-deployments` supplies canonical
  contract addresses; hand-copied addresses are a subtle-error class we
  refuse to own. No new advisories: `npm audit` still shows only the known
  dev-only Capacitor CLI item from session 1.
- **Tests red-first again:** 15 EVM tests written against a throwing stub
  (10 observed failing — refusal tests can't distinguish stub throws from
  real refusals, which is a known limit of throw-stub TDD), then green.
- **Threshold is a constant, not a parameter.** `deploySafe` hard-codes
  2-of-3; a configurable threshold is an invitation to misdeploy. Owner
  validation (exactly 3, checksummed, distinct case-insensitively) runs
  before any network access.
- **Deployment output is never trusted.** `verifySafeDeployment` reads
  `getOwners()`/`getThreshold()` from the contract with a plain viem client
  and inline two-function ABI, compares against the expected owner set, and
  hard-errors on any mismatch, wrong count, or RPC failure. The pre-funding
  checklist relies on this read-back, not on the SDK's return values.
- **EVM signing stays in the JS layer via viem, per CLAUDE.md.** The Rust
  core's mandate covers Bitcoin key material; the EVM component's strength
  is the contract's 2-of-3, not signer A's location. A test asserts the
  viem account object never serialises its private key.
- **Signer derivation is one signer-agnostic function** taking 32 entropy
  bytes; A/B/C differ only in where the flow is run. Fail-closed checks:
  wrong length and all-zero refuse; out-of-range scalars are rejected by
  viem/noble. The transient hex string of the key cannot be zeroed in JS —
  LIMITATIONS.md material.
- **`deploySafe`'s network path is exercised by `scripts/deploy-safe.ts`
  on Base Sepolia manually, not by automated tests.** Mock-testing the
  SDK's own RPC conversation would test the mock; the security-relevant
  logic (validation + read-back) is what the automated suite covers, with
  mocked transports for the read-back's good and bad chain states.
- **Not in this session, by scope:** encrypted at-rest storage of signer A
  (next), the second-device approval flow, transaction building/signing.

## Session 4 — encrypted at-rest storage (2026-08-23)

- **New dep, approved before adding: `@capacitor/preferences` =8.0.1**
  (Android SharedPreferences). Chosen over WebView localStorage, which the
  OS may evict. The adapter is a dumb pass-through; every security decision
  lives in the injectable-backend store module and is tested there.
- **Tests red-first:** the storage suite was observed failing against a
  throwing stub before implementation, then green (14 tests).
- **Scheme per PLAN.md §7's named cut:** WebCrypto PBKDF2-HMAC-SHA256 at
  600,000 iterations deriving AES-256-GCM, instead of Argon2id/StrongBox.
  This layer is defence in depth only — a fully decrypted signer A still
  cannot move funds against the 2-of-3 contract.
- **The store is generic (`sealSecret`/`openSecret`)** so the Bitcoin seed
  reuses it at step 5. The Bitcoin passphrase will never touch it — that is
  a hard rule, not a storage-layer decision.
- **Fail-closed properties tested:** unavailable storage refuses with
  exactly one write attempt and that attempt already sealed (no plaintext
  retry); missing WebCrypto refuses before anything reaches the backend;
  wrong PIN, tampered ciphertext/iv, malformed or wrong-version envelopes,
  and missing entries all refuse; envelopes claiming fewer KDF iterations
  than required are rejected before decryption (downgrade refusal — GCM
  would catch it anyway, but the explicit check costs nothing).
- **Salts and ivs come from `drawPlatformEntropy`** — the same health-checked
  fail-closed draw as seed generation, so a dead RNG aborts sealing rather
  than producing a weak salt or reused iv. Two seals of the same secret are
  tested to produce different salt, iv, and ciphertext.
- **Envelope is versioned (`v: 1`)** so a future KDF upgrade is an explicit
  migration, not a silent format guess.
- **PIN policy: minimum 6 characters,** enforced at seal and open. The PIN
  gates convenience, not funds — brute-forcing it yields a key that is
  insufficient by design.
- **TS 5.9 typed-array strictness:** entropy draws and sealed secrets are
  typed `Uint8Array<ArrayBuffer>` end-to-end so WebCrypto's BufferSource
  accepts them without casts.

## Session 5 — Base Sepolia dry run (2026-08-23)

- **First 2-of-3 Safe deployed and verified on Base Sepolia**
  (`0xE33cD51c1a9dbE83663d3e1F137090B431B92E9D`, throwaway owners). The
  read-back returned 3 owners, threshold 2, via our own verification path
  and independently via raw `eth_call`.
- **Load-balanced public RPCs can serve stale reads:** verification
  immediately after the deployment receipt hit a lagging replica and saw no
  code at the Safe address. Fix: the deploy script now waits (bounded, 15 ×
  2s) for code to become visible before the strict read-back. The wait is
  availability plumbing in the script only — `verifySafeDeployment` itself
  stays strict with no retries, and if code never appears it still fails
  hard.
- **Added `scripts/verify-safe.ts`:** read-back verification decoupled from
  deployment, so checklist evidence can be produced any time without
  touching deployment paths. This, run against `CHAIN=base`, is the
  intended pre-funding checklist artifact.
- **Node runs the scripts directly** (native type stripping); relative
  imports in scripts use explicit `.ts` extensions, enabled by
  `allowImportingTsExtensions`.

## Session 6 — Bitcoin key derivation in the Rust core (2026-08-23)

- **New crates, approved before adding: `bitcoin` =0.32.102 and
  `bip39` =2.2.2** (rust-bitcoin org, both explicitly sanctioned by
  CLAUDE.md). No rand features anywhere — entropy is always supplied by the
  entropy module, never generated inside a crate. bip39's zeroize feature
  enabled.
- **Tests red-first:** 12 Rust tests written against `todo!()` stubs,
  observed failing, then green (23 total core tests). Boundary tests added
  on the TS side (48 total).
- **24-word mnemonics only.** `entropy_to_mnemonic` takes exactly 32 bytes;
  16 bytes would be valid BIP39 but is refused — no 12-word path exists in
  this wallet.
- **BIP84 native segwit (m/84'/coin'/0'/0/index),** mainnet/testnet
  parametrized, verified against the BIP84 spec reference vectors exactly.
- **The passphrase is a per-call argument** — never a struct field, never
  stored, no default, no remembered value. Tests assert: passphrase changes
  the derived address (CLAUDE.md's required negative property), passphrases
  are case-sensitive, and error messages never echo mnemonic words.
- **BIP39 seed zeroized after master-key derivation**; xprvs live only
  inside the derivation call. Residue reduction, not isolation — WASM
  linear memory stays JS-readable (LIMITATIONS.md).
- **Toolchain decision (approved): Homebrew LLVM for wasm builds.** Apple's
  Xcode clang cannot target wasm32-unknown-unknown, which secp256k1's C
  code requires. `brew install llvm` (keg-only) with `CC_/AR_` variables
  scoped to the wasm32 target only in `build:wasm` — host builds still use
  Xcode clang. Build-environment prerequisite for the README. Alternatives
  rejected: pure-Rust k256 (means abandoning the sanctioned bitcoin/bip39
  crates — custom-derivation territory), Docker (slower iteration; may
  still return at step 8 as a pinned reproducible release-build recipe).
- **Deferred to next sessions:** Esplora watch-only balance display, PSBT
  construction and passphrase-gated signing, sweep UI.
