# CLAUDE.md

## What this project is

An open source wallet supporting Bitcoin onchain, Lightning, and EVM on Base, shipped as an Android APK. It will be handed to a paid adversary along with the full source and a test device. He wins only by moving funds, and he has a week.

This is adversarial software. Code that merely works is not sufficient. Assume every line will be read by someone motivated to break it.

Read `PLAN.md` for the full architecture before starting any task.

## The governing principle

**No secret held by the app is sufficient to move funds.** Not because it is well encrypted, but because it is structurally incomplete.

| Component | What the app holds | Why that is not enough |
|---|---|---|
| EVM on Base | One Safe signer key of three | Contract requires two signatures |
| Bitcoin onchain | A seed with no passphrase | Spending needs a passphrase never written to storage |
| Lightning | A live channel key | The channel holds nothing at rest |

Any change that would make an app-resident secret sufficient on its own is a design regression, no matter how convenient. Flag it rather than implementing it.

## Stack

React and TypeScript, packaged with Capacitor. A Rust core compiled to WebAssembly handles everything touching key material: seed generation, passphrase derivation, PSBT construction and signing.

Do not introduce a native Android Rust core or FFI bindings. That decision was made deliberately and is documented in `PLAN.md`.

## Non-negotiable rules

**`Math.random` is banned.** Enforced by lint rule, not convention. It is not cryptographically secure and it is the JavaScript equivalent of the weak generator that cost Coldcard users $116 million in 2026. There is no acceptable use of it in this repository, including in tests, mocks, and UI code.

**Never write custom cryptography.** No hand-rolled key derivation, signing, encryption, or random number generation. Use the `bitcoin` and `bip39` crates, `secp256k1`, WebCrypto, `viem`, and the Safe SDK. If a task appears to need a novel primitive, stop and ask.

**Never add a dependency without asking.** Every crate and npm package is attack surface and must be justified and pinned. Supply chain is the highest-probability attack path against this project.

**Entropy fails closed.** Any source that throws, returns short, or fails its health check aborts seed generation with a visible error. No fallback, no default value, no catch-and-continue. The Coldcard bug was a config check that tested whether a setting existed rather than whether it was enabled, so seed generation silently dropped to a weak generator with no error and no visible difference to the user. Do not create any code path where a missing or failed source still produces a seed.

*Amended 2026-08-24 (see DECISIONS.md session 15):* seed generation has two explicitly user-chosen tiers — quick (platform CSPRNG only) and advanced (the two-source dice ceremony). Each tier fails closed internally; there is no fallback between tiers, and the on-screen source report shows which tier produced a seed. The dice requirement (≥50 rolls, refuse below) applies within the advanced tier. The challenge wallet itself is created with the advanced tier per the pre-funding checklist.

**Never log, print, or serialise key material.** No seeds, private keys, extended keys, passphrases, or PINs in console output, logs, exceptions, stack traces, or error messages. This includes truncated or "safe" prefixes.

**The Bitcoin passphrase is never persisted.** Not to localStorage, IndexedDB, Capacitor Preferences, session state, or any cache. It is entered per transaction, held in memory for the duration of signing, and discarded. Any code that stores it, even temporarily for convenience, defeats the entire Bitcoin component.

**No telemetry.** No analytics, no crash reporting, no error-tracking SDK. The only network calls are to the Bitcoin chain endpoint, the LNbits instance, and Base.

**Zeroize in the Rust core.** Use the `zeroize` crate for key material. WASM linear memory is readable from JavaScript, so this reduces residue rather than providing isolation, but it is still the correct discipline.

## Build order

Do not reorder. Each step depends on the one before it.

1. Repository scaffold, dependencies pinned, `Math.random` lint rule active
2. Rust WASM core building and callable from the web layer, proven with a trivial round trip before any real logic goes in it
3. Entropy module, with fail-closed tests written before the implementation
4. Safe deployment on Base, three signers generated, threshold read back from chain
5. Bitcoin onchain, watch-only display plus passphrase-gated spending
6. Lightning through LNbits, send and receive proven, then swept to zero
7. Capacitor packaging, APK builds and installs on a physical device
8. Documentation and the pre-funding checklist

If scope must be cut, cut from the bottom. Two components that are verified beat three that are not.

## Test-first for anything security relevant

Write the failing test before the implementation. The properties that matter here are negative ones, and negative properties are the ones people forget when writing implementation first.

- Each entropy source mocked into failure, asserting no seed is produced
- Two consecutive draws from the same source asserting they differ
- Fewer than 50 dice rolls asserting the flow refuses to proceed
- A seed with a passphrase asserting it derives a different address than the same seed without one
- Storage unavailable asserting the app refuses rather than falling back to plaintext

## Working discipline

**Small diffs, one module per session.** If a change spans many files, split it. The developer is reviewing this code personally and cannot review what he did not read.

**Never generate or handle real key material in a session.** Use test vectors and throwaway seeds. Production seeds are generated on device at funding time and nowhere else.

**Commit lockfiles.** `Cargo.lock` and the npm lockfile belong in version control.

**Maintain `DECISIONS.md`.** Every time an approach is chosen over an alternative, add a sentence on why. This becomes most of the handover documentation.

## When to stop and ask

- Any task that seems to need a new dependency
- Any task that seems to need custom cryptographic code
- Any situation where the natural implementation involves a fallback, default, or catch-and-continue in security-relevant code
- Any change that would make a single app-resident secret sufficient to spend
- Any point where a shortcut would weaken a rule above

Shipping late is recoverable. Shipping a weak seed is not.
