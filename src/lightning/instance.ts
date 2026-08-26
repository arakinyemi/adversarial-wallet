// The operator's LNbits server, baked in at build time. This is public
// information (every app user connects to it), so it belongs in the open
// repo. When set, the Lightning screen self-provisions a wallet on first
// use — app users never configure anything.
//
// Instant balances are CUSTODIAL: sats live on this server and app users
// trust its operator. See DECISIONS.md.
//
// Leave empty to disable Lightning in a build (dev builds without a server).
//
// Currently the LNbits team's free public demo server: fine for testing and
// for this wallet's zero-resting-balance design (sats exist only minutes
// before being swept), but it is a shared demo — no uptime promise, and it
// may be reset. Swap for an operator-controlled instance before relying on
// it.
export const LNBITS_INSTANCE_URL: string = "https://demo.lnbits.com";
