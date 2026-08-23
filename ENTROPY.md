# Seed entropy design

How this wallet generates the randomness behind every Bitcoin seed and Base
signer key.

## Two sources, combined

1. **Platform CSPRNG** — 32 bytes from `crypto.getRandomValues()`.
2. **User dice** — the user rolls a physical die at least 50 times and
   enters every result; the roll string is hashed with SHA-256 to 32 bytes.

The two are XOR-combined in the Rust core. The XOR construction means the
output is at least as strong as the stronger source: an attacker would need
to compromise both the device generator and the physical dice to weaken the
seed. Fifty rolls of a fair die contribute about 129 bits of entropy on
their own.

## Fail-closed behavior

There is no fallback path. Seed generation aborts with a visible error when:

- the platform CSPRNG is missing, throws, or returns the wrong length;
- a draw returns degenerate output (all bytes identical);
- two consecutive draws are identical;
- fewer than 50 dice rolls are provided, or any roll is outside 1–6.

The TypeScript layer performs these checks when drawing; the Rust core
independently re-validates everything it receives and refuses on the same
conditions. No code path produces a seed from fewer than two healthy
sources.

Inputs that are never used as entropy, kept as a named list in the code:
device identifiers, timestamps or clock registers, boot time, process IDs,
network addresses, and `Math.random` (banned repository-wide by lint rule).

## On-screen verification

After generation the app displays which sources contributed and how many
bytes each supplied, so the user can see where their randomness came from.

## Derivation

The 32 combined bytes become a 24-word BIP39 mnemonic (the only length this
wallet generates or restores). With the user's passphrase applied, keys
derive via BIP84 (`m/84'/coin'/0'`). All derivation happens in the Rust
core, verified against the published BIP39 and BIP84 test vectors; the
tests also assert that a passphrase-bearing derivation differs from a bare
one and that error messages never echo secret material.

## Base signer keys

Each device's Safe owner key runs the same two-source ceremony with its own
fresh dice rolls. Signer entropy is never derived from or shared with the
Bitcoin seed, so the two components have no mathematical relationship.
