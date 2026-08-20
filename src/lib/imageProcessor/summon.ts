// ─── Summon framing (cross-platform) ─────────────────────────────
// The marker that tags THE reacted/targeted message inside a conversation
// transcript. Shared by the think prompt (which explains it to Clank), Slack's
// 🤖-reaction flow, and Discord's "Summon Clank" — it is the anti-dilution anchor:
// respond to THIS message, use the rest as context only.

export const REACTED_MARKER = '⟵ THE REACTED MESSAGE';
