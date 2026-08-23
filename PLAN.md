# Adversarial Wallet Challenge: Plan of Action

**Deliverable:** Open source wallet supporting Bitcoin onchain, Lightning, and EVM on Base, shipped as an APK
**Win condition for the challenger:** He must move the coins. Anything less does not count.
**Rules:** He receives the APK, the full source, and a test device. No access to your device. Social engineering out of scope. Attacking the Lightning Service Provider out of scope. If he fails, he matches the wallet contents.

---

## 1. The governing principle

The original architecture put its faith in key storage: encrypt well, and the secret on the phone stays secret. That approach needs time you no longer have, because storage hardening is only as good as the code review behind it, and unreviewed code is exactly where a paid adversary starts.

The replacement principle is stronger and cheaper to build: **no secret held by the app is sufficient to move funds.** Not because it is well encrypted, but because it is structurally incomplete. He can extract every byte the APK holds, on a rooted device, with unlimited time, and still be unable to spend.

Each of the three components achieves this differently:

| Component | What the APK holds | Why that is not enough |
|---|---|---|
| EVM on Base | One Safe signer key of three | Contract requires two signatures |
| Bitcoin onchain | A seed with no passphrase | Spending needs a passphrase that exists only in your head |
| Lightning | A live channel key | The channel holds nothing at rest |

This is the same lesson the Coldcard incident taught from the other direction. Roughly $116 million left single-signature wallets whose seeds could be reconstructed offline. The attack skipped every multisig setup, without exception, because reconstructing one key out of several buys you nothing.

---

## 2. Stack

React and TypeScript packaged into an APK with Capacitor, with a Rust core compiled to WebAssembly handling everything that touches key material.

The WASM boundary is the important choice here. A native Rust core on Android would give stronger memory isolation, but reaching it means NDK setup, cross-compilation across four ABIs, and generated FFI bindings, and that toolchain is where the remaining hours disappear. WebAssembly gives most of the benefit for one `wasm-pack` command: the `bitcoin` and `bip39` crates for seed derivation, passphrase handling, and PSBT construction, plus real `secp256k1` rather than a JavaScript reimplementation of curve arithmetic.

The honest trade-off, which belongs in the limitations document: WASM linear memory is readable from JavaScript, so `zeroize` reduces residue without providing the isolation a native core would. Under the original architecture that gap would matter. Under this one it does not decide anything, because a recovered app-resident secret cannot move funds in any of the three components.

Libraries: a Rust WASM core for Bitcoin key handling and signing, `viem` with the Safe SDK for Base, an Esplora or mempool.space endpoint for chain data and broadcast, and an LNbits backend you control for Lightning.

---

## 3. Entropy

Build this first, before any wallet feature. It is the one component where a flaw is unrecoverable, because a weak seed cannot be fixed by any later hardening.

The Coldcard failure was not that a weak generator existed. It was that the system degraded to it silently: a build setting was present but set to zero, the library checked whether the setting existed rather than whether it was enabled, and seed generation quietly fell through to a software generator seeded from a chip serial number and clock registers. Key strength dropped from 128 bits to around 40 on the worst-affected devices. No error, no warning, nothing a user could see.

JavaScript has an exactly equivalent trap in `Math.random()`. It is fast, it is everywhere, and it is not cryptographically secure. Ban it from the repository with a lint rule, not a code comment.

**Design.** Draw 32 bytes from `crypto.getRandomValues()`, and 32 bytes derived from user-entered dice rolls with a minimum of 50. XOR them together. If either source fails, throws, or returns short, seed generation aborts with a visible error. There is no fallback path.

The dice requirement is the mitigation that empirically worked: Coinkite confirmed that owners who used at least 50 private dice rolls were unaffected by the entire incident.

**Verification on screen.** Display which sources contributed and how many bytes each supplied. A user who cannot see where their randomness came from cannot detect when it disappears.

**Forbidden inputs.** No device identifiers, timestamps, boot times, or any value an attacker can enumerate. Name them in a rejected list in the code.

---

## 4. EVM on Base: holds the bulk

Deploy a Safe with three owners and a threshold of two.

- Signer A: generated in the app, present in the APK
- Signer B: a separate device you control
- Signer C: paper backup in a locked drawer

Fund this with nearly all of the value. It is the strongest component and the one you can build fastest, since it is `viem` and the Safe SDK against a chain where fees are cents.

Spending requires two signatures. The app builds and signs with A, then you approve on the second device with B, and the contract executes. He can hold A indefinitely and the contract will refuse every transaction he submits.

**Verify the deployment by reading it back from the chain.** Query the contract for its owner list and threshold rather than trusting the deployment script's output.

**Test signer C before funding.** Sign one transaction using B and C together, with A deliberately unused. An untested paper key leaves you with an effective 2-of-2 and no recovery path, and this is the failure people discover only when they need it.

---

## 5. Bitcoin onchain: passphrase never stored

Standard BIP39 seed, generated by the entropy module, encrypted on the device. On top of it, a BIP39 passphrase, sometimes called the twenty-fifth word, which is never written to storage, never cached, and never leaves your head.

The passphrase changes the derived keys entirely. A seed without the correct passphrase produces a completely different and empty wallet. So the APK contains a seed that unlocks nothing.

The app runs watch-only by default, showing balances from the public descriptor. Entering the passphrase derives the spending key in memory for a single transaction, and it is discarded immediately afterwards.

Hold a small amount here. It is the component with the least architectural depth, since the passphrase is a single secret rather than a threshold.

---

## 6. Lightning: zero resting balance

Self-custodial Lightning requires keys that stay online and able to sign, because catching a counterparty who broadcasts a revoked channel state means broadcasting a penalty transaction inside a fixed timelock. There is no cold variant. This is structurally the weakest component, and it cannot be made strong in the time available.

So it holds nothing.

Run the channel through an LNbits instance you control, which is a stack you have already worked in. Demonstrate a real send and a real receive with preimages recorded, proving the implementation functions. Then sweep the local balance to zero and leave it there for the attack window.

Both requirements from the brief survive: balances are readable and money can be transferred. There is simply nothing parked in the hot component while he works.

**Document this as the weak point.** Do not present it as equally hardened. A challenge where you claim uniform strength invites him to define any weakness as a win. A challenge where you have already named your soft spot forces him to find something you did not know about.

---

## 7. What was cut, and why

**Native Android Rust core with FFI bindings.** The memory isolation is real, but the cost is the NDK and cross-compilation toolchain rather than the Rust itself, and that is the part that consumes a day without producing any security. The WASM core captures the library quality and most of the discipline at a fraction of the setup cost.

**LDK Node with an embedded self-custodial node.** Excellent and correct, but it is not a one-day integration from zero. LNbits with a zero resting balance reaches an acceptable position by a different route.

**Argon2id, StrongBox wrapping, and zeroization.** Worth having, not worth the remaining hours. Use WebCrypto PBKDF2 with a high iteration count for at-rest encryption and move on. The threat this defends against, offline brute force of a captured keystore, wins him nothing when the recovered key is insufficient anyway.

**Root detection and obfuscation.** These were already cut. They are theatre against an adversary holding the device.

Take these cuts deliberately and write them into the limitations document. A cut you named is a design decision. A cut you hid is a finding he gets to report.

---

## 8. Build order

Do not reorder. Each step depends on the one before it.

1. Repository scaffold, dependencies pinned by hash, `Math.random` banned by lint rule
2. Rust WASM core building and callable from the web layer, proven with a trivial round trip before any real logic goes in it
3. Entropy module, with fail-closed tests written before the implementation
4. Safe deployment on Base, all three signers generated, threshold read back from chain
5. Bitcoin onchain, watch-only display plus passphrase-gated spending
6. Lightning through LNbits, send and receive proven, then swept to zero
7. Capacitor packaging, APK builds and installs on the physical device
8. Documentation and the pre-funding checklist

If time runs short, cut from the bottom of the feature set rather than the top. An entropy module you trust with two working components beats three components you have not verified.

---

## 9. Pre-funding checklist

Nothing of real value goes in until every line here is checked.

- Fail-closed entropy tests run, each source mocked into failure, no seed produced
- Two consecutive draws from the same source differ
- Fewer than 50 dice rolls refuses to proceed
- Safe owner list and threshold read back from the chain and confirmed as three and two
- A transaction signed by signers B and C only, with A unused, executes successfully
- Passphrase-derived Bitcoin address differs from the no-passphrase address, confirming the passphrase is actually applied
- Lightning send and receive completed and recorded, local balance swept to zero
- Small test transaction sent and returned on each of the three networks
- Release APK unzipped and its compiled manifest checked for backup and debuggable flags
- Handover commit tagged, APK SHA-256 published in the README

---

## 10. Documentation package

He receives:

- `README.md` with build instructions and the APK SHA-256
- `THREAT-MODEL.md` covering what is in scope and what is not
- `ENTROPY.md` documenting the two-source design, the fail-closed guarantee, and the Coldcard incident that motivated both
- `LIMITATIONS.md` naming the JavaScript memory-handling weakness, the Lightning hot key, the reduced key-derivation parameters, and every other accepted trade-off
- `RULES.md`, signed by both parties before funding
- Recorded transaction proofs for each of the three networks

Keep a running decisions log as you build. Every time you choose one approach over another, write a sentence about why. That log becomes most of this package, and documentation reconstructed from memory at the end is where mistakes hide.
