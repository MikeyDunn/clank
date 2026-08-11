// ─── Discord platform adapter ────────────────────────────────────
// Public surface, mirroring the Slack adapter's shape:
//   verify  — inbound interaction signature verification (Ed25519)
//   client  — Discord REST calls + interaction/callback/flag constants
// The gateway worker (reactions, @mentions) will add a `gateway` concern later.

export * from './client.js';
export * from './message.js';
export * from './verify.js';
