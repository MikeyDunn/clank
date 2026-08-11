// ─── Slack platform adapter ──────────────────────────────────────
// Public surface, composed from three concerns:
//   verify  — inbound request signature verification
//   client  — Slack Web API + response_url calls
//   blocks  — Block Kit message builders (pure)
// Consumers import the directory to get the full set.

export * from './blocks.js';
export * from './client.js';
export * from './verify.js';
