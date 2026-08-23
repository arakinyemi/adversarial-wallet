# Operational proof runs

Every run here produces evidence for the handover package. Save the full
terminal output (and screenshots where noted) into `proofs/` as you go.
Testnet first; the mainnet/funding-time repeats are marked.

## 1. EVM — two-signature Safe spend

Prereqs: a deployed Safe (see `scripts/deploy-safe.ts`), its address funded
with a little testnet ETH, and the owner keys.

Rehearsal (any two owners):

```
RPC_URL=https://sepolia.base.org CHAIN=base-sepolia \
SAFE_ADDRESS=0x... \
PROPOSER_PRIVATE_KEY=0x... EXECUTOR_PRIVATE_KEY=0x... \
TO=0x... VALUE_ETH=0.0001 \
node scripts/safe-rehearsal.ts
```

Checklist runs required before funding:

- [ ] A + B execute a spend (the normal flow, also exercised in-app)
- [ ] **B + C only, with A unused** — proves the paper key works and there
      is a recovery path without this device
- [ ] `scripts/verify-safe.ts` read-back: 3 owners, threshold 2

## 2. Lightning — send, receive, sweep

Prereqs: your LNbits instance URL, its invoice key and admin key, and an
external Lightning wallet with a few sats.

```
# Receive: prints an invoice, waits, then prints the verified preimage proof
LNBITS_URL=... LNBITS_INVOICE_KEY=... AMOUNT_SATS=100 MODE=receive \
node scripts/lightning-proof.ts

# Send: pays an external invoice, prints the verified preimage proof
LNBITS_URL=... LNBITS_ADMIN_KEY=... BOLT11=lnbc... MODE=send \
node scripts/lightning-proof.ts

# Sweep gate: must print "SWEEP GATE PASSED" before handover
LNBITS_URL=... LNBITS_INVOICE_KEY=... MODE=sweep-check \
node scripts/lightning-proof.ts
```

- [ ] Receive proof recorded (payment_hash + preimage)
- [ ] Send proof recorded (payment_hash + preimage)
- [ ] Balance swept to an external wallet, sweep gate passed

## 3. Bitcoin — on-device testnet round trip

On the phone, with the app on testnet:

- [ ] Create a wallet with real dice; fund the receive address from a
      testnet faucet
- [ ] Balance appears after Refresh (screenshot)
- [ ] Send back to the faucet: correct passphrase → broadcast accepted,
      txid recorded
- [ ] **Negative check:** attempt the same send with a WRONG passphrase —
      the app must refuse with "wrong passphrase or mnemonic" and nothing
      must be broadcast
- [ ] Same seed restored with a different passphrase shows a different
      (empty) first address

## At funding time (mainnet repeats)

- [ ] Deploy the real Safe on Base with the real signer A (from the app),
      B (second device), C (paper); read-back verification saved
- [ ] B + C rehearsal on the REAL Safe before funding it
- [ ] Small send-and-return on each of the three networks
- [ ] Lightning swept to zero, sweep gate output saved
- [ ] Release APK signed; SHA-256 published in the README
