// The operator's LNbits server, baked in at build time. This is public
// information (every app user connects to it), so it belongs in the open
// repo. When set, the Lightning screen self-provisions a wallet on first
// use — app users never configure anything.
//
// Instant balances are CUSTODIAL: sats live on this server and app users
// trust its operator. See DECISIONS.md.
//
// Leave empty to disable Lightning in a build (dev builds without a server).
export const LNBITS_INSTANCE_URL = "";
