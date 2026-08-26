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

## Session 7 — watch-only balance display (2026-08-23)

- **Zero new dependencies.** Watch-only address derivation went into the
  Rust core (`xpub_to_address`: public-key-only BIP32 from the account
  xpub); chain data uses the built-in `fetch` against an Esplora endpoint.
- **Watch-only never touches key material.** Balance display derives
  addresses from the stored xpub alone — the encrypted seed stays sealed
  and the passphrase is never requested for viewing. Chain 0/1 only
  (receive/change); the xpub's own network prefix is checked against the
  requested network and mismatches refuse.
- **Cross-path test:** addresses derived via the xpub-only path must equal
  the private-derivation path and the BIP84 spec vectors exactly.
- **Tests red-first** (3 Rust + 9 TS observed failing, then green; 57
  total).
- **A dead endpoint must never read as "balance: 0".** Any HTTP error,
  rejected fetch, malformed body, wrong-address response, unsafe-integer
  amount, or spent>funded inconsistency throws; a scan either completes
  for every address or throws — no partial sums. Standard gap limit of 20
  per chain, activity resets the gap.
- **Pending balance is a signed net delta** (mempool funded − spent), so an
  in-flight outgoing spend shows as negative pending rather than being
  hidden or clamped.

## Session 8 — passphrase-gated spending (2026-08-23)

- **Zero new dependencies** — transaction construction and signing come
  entirely from the already-approved `bitcoin` crate; broadcast is a plain
  `fetch` POST.
- **Tests red-first:** 10 Rust + 3 TS observed failing before
  implementation, then green (36 Rust, 63 total).
- **The address interlock is the passphrase check.** `sign_spend` takes
  each UTXO's address alongside its derivation path and refuses unless the
  passphrase-derived key reproduces that exact address. A wrong passphrase
  derives a different wallet, so without this the core would sign
  network-invalid transactions; with it, wrong passphrase = loud refusal
  before any signature exists. Tested.
- **Deviation from PLAN.md's "PSBT" wording, deliberately:** the core
  builds and signs the transaction in one step (SighashCache, RFC6979
  deterministic ECDSA) rather than materialising a PSBT. PSBT is an
  interchange format for multi-party signing; the Bitcoin component has
  exactly one signer inside one WASM call, and never letting a
  partially-signed artifact cross a boundary is strictly safer. The EVM
  component is where multi-party signing lives.
- **UTXO data crosses the WASM boundary as primitive arrays**
  (newline-joined strings, Uint32Array/BigUint64Array) instead of JSON —
  avoids adding serde_json just for parameter passing.
- **Fail-closed spend policy:** checked arithmetic throughout (overflow
  refuses); insufficient funds refuse; a change output below 546 sats
  refuses rather than silently inflating the fee; zero amount or zero fee
  refuses; recipient is network-checked; chains beyond 0/1 refuse. Change
  derives at m/84'/coin'/0'/1/change_index. RBF signalled, version 2.
- **Fee policy is the UI's job, not the core's:** the core enforces
  arithmetic consistency only; a deliberate high-fee sweep must remain
  possible, so there is no in-core "absurd fee" heuristic. The spend
  confirmation screen must display the fee explicitly.
- **Broadcast success must be provable:** `broadcastTransaction` accepts
  only a well-formed txid as proof; anything else — including an HTTP 200
  with junk — throws. Esplora's rejection reason is surfaced verbatim.

## Session 9 — Lightning via LNbits (2026-08-23)

- **Zero new dependencies** — LNbits is a REST API over the built-in
  `fetch`. Tests red-first (7 observed failing, then green; 77 total).
- **Payment proof is verified, never trusted.** A payment counts as
  settled only when the API's preimage SHA-256-hashes to the payment hash
  (verified locally with WebCrypto against independently computed
  vectors). An API claiming "paid" with a missing or wrong preimage
  refuses — the recorded preimages are handover evidence, so they must be
  cryptographically true, not reported.
- **`assertSweptToZero` is the checklist gate** for PLAN.md's zero-resting-
  balance requirement: it passes only on exactly 0 msat.
- **The LNbits admin key is the named weak point, by design.** It is an
  app-resident secret that can move Lightning funds; mitigation is
  operational (sweep to zero before the attack window), documented rather
  than disguised. The key is passed per call by the caller — the module
  never stores it, and a test asserts error messages never contain it. At
  wire-up, the key lives in the same sealed storage as signer A.
- **Config validation refuses before any network call** (empty base URL or
  key), and invoice amounts must be positive whole sats.
- **Compat note:** invoice responses accept `bolt11` (current LNbits) or
  `payment_request` (older) — a naming shim, not a fallback in any
  security-relevant path.

## Session 10 — UI (2026-08-23)

- **Zero new dependencies.** Hand-written CSS with design tokens (dark,
  minimalist, single accent, tabular numerals); no CSS framework, no
  component library, no state library. Every style rule is reviewable.
- **The UI is a thin shell over tested modules.** Component tests would
  require jsdom/testing-library (rejected as attack surface); instead all
  logic stays in the tested modules and the only new logic — display
  formatting — has unit tests (81 total).
- **Secrets discipline in the UI:** PIN and passphrase are password fields
  in component state, cleared in `finally` after every use; the mnemonic is
  shown once during the ceremony and wiped from state when it ends; the
  LNbits admin key is sealed under the PIN from the Lightning screen and
  unsealed per payment. Nothing secret touches config or persists plain.
- **Setup ceremony order is enforced by step state:** PIN → dice (live
  count, button disabled below 50) → entropy source report displayed
  (PLAN.md's on-screen verification) → 24 words with explicit backed-up
  confirmation → passphrase entered twice (a typo here means funds in an
  unreachable wallet) → xpub derived from the PASSPHRASE wallet and stored.
- **Balances refuse to render 0 on failure** — the screens show "balance
  unavailable" with the error, mirroring the module contract.
- **The spend confirm screen shows amount, fee, and total explicitly**
  before requesting PIN + passphrase (the fee-display obligation from
  session 8).
- **EVM signer A is NOT derived from the Bitcoin entropy.** Identical bytes
  would mathematically link the two components (extracting the "insufficient"
  Safe key would also reveal the Bitcoin seed). Signer A gets its own
  ceremony in the Safe-spending session.
- **Default network is testnet** — mainnet is an explicit settings change
  at funding time.
- **Verified by:** full test suite, lint, tsc, production Vite build, and
  the built app served and fetched. Visual smoke test on device pending
  (gstack browse tool was still building); Capacitor packaging is step 7.

## Session 11 — standard wallet onboarding (2026-08-23)

- **Onboarding reworked to the industry-standard shape:** welcome screen
  with Create / Restore, step-dot progress, back navigation, a backup
  **verification quiz** (three word positions typed back; a wrong word
  refuses and clears the answers), and a "Wallet ready" success screen
  showing the first receive address. Tab bar hidden until setup completes.
- **Restore path added** — previously device loss stranded the user. New
  core function `mnemonic_to_entropy` (test-first: round-trip vector,
  12-word valid BIP39 refused, bad checksum refused) validates and converts
  the phrase so restore seals the same entropy format as create. 24 words
  only, same policy as generation.
- **Quiz word positions come from `drawPlatformEntropy` with rejection
  sampling** — `Math.random` is banned repo-wide including UI, and the
  modulo is kept unbiased even though this is UX-only.
- **Whole flow walked end-to-end in a headless browser:** create path with
  throwaway dice, wrong-quiz-word refusal observed, correct answers
  proceed, passphrase double-entry, seal (real 600k-iteration PBKDF2 in
  browser), success screen with derived testnet address. Test wallet wiped
  from browser storage afterwards.

## Session 12 — step 7, APK packaging (2026-08-23)

- **Toolchain installed:** OpenJDK 21 (brew formula, keg-only) and the
  Android SDK via command-line tools only — no Android Studio. Packages:
  platform-tools, platforms;android-36, build-tools;36.0.0, licenses
  accepted. `android/local.properties` points Gradle at the SDK.
- **Both APK variants build:** `assembleDebug` (5.8 MB, installable
  immediately) and `assembleRelease` (4.8 MB, unsigned). The WASM core and
  JS bundle verified present inside the APK.
- **`allowBackup` set to `false` in the manifest** — Android backup would
  hand out a copy of the sealed key storage. Verified in the COMPILED
  manifest of both variants with aapt2, not just the source file. The
  release APK carries no `debuggable` attribute (defaults false) —
  both pre-funding checklist flags pass on the release artifact.
- **Signing deferred to handover:** the release APK is unsigned by design.
  At funding time: generate a keystore, sign, and publish the APK SHA-256
  in the README per the checklist. Debug builds are auto-signed and are
  the artifact for test-device installs meanwhile.
- **No physical device was attached** during this session; `adb install`
  of the debug APK on the test device is the remaining step-7 action.

## Session 13 — UX cleanup, Safe spending, proof tooling (2026-08-23)

- **User feedback applied:** operator/threat-model language removed from
  the UI (Coldcard, "$116M", "watch-only", "handover", "refusing to show
  0") — that story lives in the docs, not user-facing screens. Balances
  still never render 0 on failure; the wording is just human. All PIN
  fields are digit-only with the numeric mobile keyboard; amount fields use
  numeric/decimal input modes.
- **Dice entry is a tap pad** (six buttons, live counter, progress bar,
  undo/clear) instead of a textarea. The die stays physical — the pad only
  records; nothing generates rolls in software.
- **Safe spending flow shipped, device-to-device with no extra backend:**
  device A signs and exports a JSON proposal payload; device B pastes it,
  countersigns with a different owner key, and executes (protocol-kit,
  nonce pinned in the payload). Fail-closed validation (test-first, 5 new
  tests): strict payload parsing, duplicate signers refuse, chain mismatch
  refuses, and the same key that proposed can never countersign — the
  contract's 2-of-3 is enforced socially by the payload flow and
  cryptographically by the contract itself.
- **Signer A has its own dice ceremony** on the Safe screen (independent
  entropy from the Bitcoin seed, per session 10's decision), sealed under
  the PIN, unsealed per action and zeroed in finally.
- **Proof tooling:** `scripts/safe-rehearsal.ts` (two-owner spend rehearsal;
  run with B+C for the checklist's A-unused test), `scripts/lightning-proof.ts`
  (receive/send with locally verified preimage proofs, sweep gate), and
  `PROOFS.md` — the runbook mapping every operational proof to a command
  and the evidence to save. The funded runs need the developer's keys,
  instance, and coins, so they are runbook-driven rather than automated.
- **Verified:** 86 tests green, tsc/lint/build clean, scripts load under
  plain Node, and the new onboarding + dice pad + Safe signing-key screen
  walked in the headless browser (quiz re-randomizes positions on re-entry
  — observed live). Test wallet wiped afterwards.

## Session 14 — documentation package, revised scope (2026-08-24)

- **Documentation reframed as application documentation, per the
  developer's direction:** THREAT-MODEL.md, RULES.md, and LIMITATIONS.md
  are dropped from the handover package. The docs describe what the
  application is and how to build and verify it — not a guided tour of its
  attack surface. This supersedes PLAN.md §10.
- **Why this is safe:** the security model never depended on documentation
  (or its absence) — the code is fully public either way. PLAN.md's
  rationale for naming the weak point was to prevent "any weakness counts
  as a win" disputes, but the agreed win condition is already funds-moved-
  only, so that rationale doesn't apply. The honest engineering trade-off
  notes that LIMITATIONS.md would have contained live in this file.
- **Written:** README.md (application overview, custody model in plain
  terms, repository layout, full build-from-source instructions including
  the wasm32 clang requirement, operator scripts, conventions) and
  ENTROPY.md (two-source design, fail-closed behavior, rejected inputs,
  derivation, per-device signer ceremonies). Both are engineering docs any
  builder could use to rebuild and verify the app.
- Remaining for release: recorded transaction proofs (PROOFS.md runbook),
  signed APK + published SHA-256, tagged handover commit.

## Session 15 — two-tier entropy (2026-08-24)

- **Mandatory dice replaced with two explicit setup tiers, per the
  developer's product judgment** ("humans will never roll a die to set up a
  wallet"): Quick setup (platform CSPRNG only, default — the mainstream
  wallet baseline) and Advanced setup (the unchanged two-source dice
  ceremony). Amends CLAUDE.md's entropy rule; the amendment is recorded in
  CLAUDE.md itself.
- **Why this is not the Coldcard failure:** that incident's harm came from
  a SILENT downgrade. Here the tier is a deliberate user choice, the paths
  are separate functions with no fallback between them, both fail closed
  internally (the quick tier keeps every health check including the
  consecutive-draws-differ test), and the post-generation source report
  makes the tier visible and auditable after the fact.
- **Test-first:** 4 new quick-tier tests observed red, then green (90
  total): stuck source refuses, replayed draws refuse, single-source
  report, runs differ.
- **The Safe signing-key ceremony got the same choice** (checkbox, default
  quick).
- **The challenge wallet still uses the advanced tier** — the pre-funding
  checklist keeps its dice-backed-seed line; head-typed digits were
  considered and rejected as theater (XOR means they never hurt, but they
  defend nothing).
- Rejected alternative: harvesting touch-timing/sensor jitter as an
  invisible second source — custom entropy collection is exactly the kind
  of hand-rolled primitive this project bans.

## Session 16 — session unlock (2026-08-24)

- **Added a session-unlock model** (developer chose it over per-action PIN):
  the app is locked on cold start, after 2 minutes of inactivity, and
  whenever it is backgrounded (`visibilitychange` hidden). Unlocking once
  per session lets Lightning payments and Safe approvals proceed without
  re-entering the PIN. A "Lock now" control sits in Settings.
- **What is cached, and why it is acceptable:** only the PIN string, in
  JS memory, for the session — never a decrypted seed or signer key. Each
  secret is still unsealed per use and zeroized after. The governing
  principle is unchanged: a recovered PIN (or even a fully decrypted
  app-resident secret) still cannot move funds — Bitcoin needs the
  passphrase, Base needs a second signer, Lightning holds nothing at rest.
- **The Bitcoin passphrase is explicitly NOT part of this.** It is never
  cached and is entered on every Bitcoin spend, unchanged. Session unlock
  only removes the redundant PIN prompt, not the passphrase gate.
- **Unlock verifies against real ciphertext:** the unlock screen decrypts
  the stored BTC entropy to check the PIN, so a wrong PIN is rejected at
  the gate via the same AES-GCM path as everywhere else. Fresh setup starts
  unlocked (the user just set the PIN), so no immediate re-prompt.
- **Net effect on residue:** the PIN now lives in memory for up to the
  inactivity window instead of only the moment of a spend. This is a real
  but bounded increase, mitigated by background-lock and the 2-minute
  timeout, and accepted because the PIN is the lowest-value secret in the
  system. Recorded here as the honest trade for the convenience.
- **Verified:** 3 new pure unit tests for the lock module (93 total),
  tsc/lint/build clean, and the lock → gate → wrong-PIN-rejected →
  correct-PIN-unlocks flow walked in the browser.

## Session 18 — device bug fixes (2026-08-26)

- **Onboarding repeated on every launch — fixed.** Setup completion only
  updated React state; the xpub was never persisted (saveConfig was only
  called from Settings), so each launch saw an empty config. Now saved at
  completion, with a failed save surfaced as a fatal error rather than
  swallowed. Verified by completing setup in the browser, reloading, and
  landing on the unlock keypad with the wallet intact.
- **Balance could refresh forever — fixed twice over.** (1) No network call
  in the app had a timeout, so a stalled connection hung fetch and the
  spinner indefinitely; every default fetch now carries a hard
  AbortSignal.timeout (15s reads, 30s broadcast, 20s LNbits) so a stall
  becomes a visible error — fail-closed, never fail-silent. (2) The
  watch-only scan was 40 sequential round trips; it now fetches in
  concurrent chunks of 10 (~10x faster on high-latency mobile links).
  Promise.all preserves the all-or-nothing contract; results are processed
  in index order so gap accounting and address order are unchanged (a
  chunk may fetch a few public addresses past the stopping point —
  harmless). One test's expected fetch count updated for chunking.

## Session 19 — zero-config Lightning + light mode (2026-08-26)

- **Lightning is now zero-configuration for app users, per the developer's
  product direction.** The operator's LNbits server URL is baked in at
  build time (`src/lightning/instance.ts` — public information, fine in
  the open repo). On first use, one tap self-provisions a wallet via the
  server's open account endpoint (`POST /api/v1/account`, no credentials
  when the server allows new accounts, which the operator's instance must
  enable). The admin key is sealed under the PIN before anything is saved —
  a failed seal leaves nothing half-configured. The LNbits section is gone
  from Settings entirely. Test-first: 4 new createWallet tests (97 total),
  covering both LNbits response shapes, HTTP refusal, and missing-key
  refusal.
- **This makes Instant explicitly custodial:** sats live on the operator's
  server and app users trust its operator. For the challenge this is the
  design (zero resting balance; the operator is the user). Stated in the
  instance file's comment rather than at the user.
- **Operational note:** at proof time the operator reads the app wallet's
  keys from their LNbits admin UI for `lightning-proof.ts`; the sweep gate
  applies to the app's provisioned wallet.
- **Light mode added:** a second token palette (warm off-white, ink text,
  darker violet for contrast) stamped as `data-theme` on <html>, chosen in
  Settings → Appearance and persisted in config. Deliberately does not
  follow the OS setting — the choice is explicit and stable. Verified in
  the browser across reload and the unlock screen.

## Session 17 — Cairn redesign from the Claude Design prototype (2026-08-24)

- **UI rebuilt to the designer's prototype:** product name "Cairn", violet
  accent, editorial dark layout, segmented step progress, on-screen PIN
  keypad with dots (PINs now exactly 6 digits), pip-face dice buttons with
  a 50-tick progress bar and undo, tier choice as radio cards, 24 words in
  a numbered two-column grid marked "Displayed once", one-word-at-a-time
  backup quiz with a refusal state, the passphrase moment on a darker
  screen with three plain warnings + an explicit "cannot be recovered"
  acknowledgment + a hold-to-commit button, and a "wallet is ready" screen
  showing the entropy sources (PLAN.md's on-screen report moved here).
- **IA change: tab bar replaced by a home screen** of three accounts —
  Spending (Bitcoin), Instant (Lightning), Savings (Base 2-of-3) — each
  labeled with what spending takes ("spends with passphrase / while
  unlocked / with two devices"). Sub-flows are pushed screens with back
  arrows; wrong-passphrase and success are full screens, with refusal copy
  "nothing was signed or sent".
- **FLAG_SECURE set in MainActivity** — the OS now actually blocks
  screenshots/recording app-wide, protecting the words screen.
- **Deviations from the prototype, deliberate:** no "copy words" button
  (seed → clipboard is exfiltration surface; the 60s-clear promise isn't
  keepable from a WebView); sats/BTC primary instead of fiat (a price feed
  is a new network dependency — future ask); no QR codes yet (needs a
  library — future ask); no PIN keypad on each payment (session unlock was
  already chosen; the Bitcoin passphrase screen remains per-send); no
  network toggle on home (switching networks invalidates the stored xpub —
  stays in Settings).
- **Verified:** 93 tests green, tsc/lint/build clean; the full create flow
  walked in a phone-sized browser viewport — keypad PIN set+confirm, quick
  tier, words, quiz (including a live refusal on a wrong submission),
  passphrase hold-to-commit, ready, home, and a live testnet scan on the
  Spending screen. The inactivity auto-lock fired mid-walkthrough and the
  keypad unlock recovered it — observed working. Test wallet wiped.
