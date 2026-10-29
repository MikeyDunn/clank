// ─── Capabilities ────────────────────────────────────────────────
// Optional outside-world tools a mind may grant its think step, on top of the
// always-on lore recall. A property of the MIND (like its metering policy), not
// a platform branch: Slack's legacy mind grants them; tenants get none unless
// forTenant() is handed an override. Both cost real money per call and bill the
// mind's OpenRouter account, so they're opt-in per mind.

export interface Capabilities {
    /** OpenRouter's server-side web search (Exa) — news / current events. */
    webSearch?: boolean;
    /** getMarketData — live quotes + a price-curve series (Yahoo Finance). */
    market?: boolean;
}

/** The default for any caller that doesn't pass a mind's capabilities: fail closed. */
export const NO_CAPABILITIES: Capabilities = Object.freeze({});
