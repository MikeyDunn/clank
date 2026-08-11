// ─── Formatting helpers (platform-neutral) ───────────────────────
// Small shared idioms that were scattered/duplicated across the Slack + Discord
// paths. Platform-neutral on purpose — the Discord processor was re-declaring
// fmtCost only because it lived in the Slack adapter.

/** Per-request cost for a stats line: `~$0.0421`, or `fallback` when free/unknown. */
export function fmtCost(n: number, fallback = ''): string {
    return n > 0 ? `~$${n.toFixed(4)}` : fallback;
}

/** Truncate a possibly-undefined string to n chars (the `(x || '').slice(0,n)` idiom). */
export function trunc(s: string | null | undefined, n: number): string {
    return (s || '').slice(0, n);
}

/** Elapsed seconds since a start timestamp, as a fixed-1 string. */
export function elapsed(startMs: number): string {
    return ((Date.now() - startMs) / 1000).toFixed(1);
}
