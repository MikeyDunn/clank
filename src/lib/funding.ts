// ─── Funding awareness ───────────────────────────────────────────
// Queries OpenRouter for credit balance, cached per Lambda container.
// Sonnet gets a context line when funds are low — Clank metabolizes it organically.

import * as openrouter from './openrouter.js';

let cache: { value: { remaining: number; total: number; used: number } | null; fetchedAt: number } = {
    value: null,
    fetchedAt: 0,
};
const TTL_MS = 5 * 60 * 1000;

async function getFundingStatus(): Promise<{ remaining: number; total: number; used: number } | null> {
    const now = Date.now();
    if (cache.value && now - cache.fetchedAt < TTL_MS) return cache.value;

    try {
        const data = await openrouter.credits();
        const total = data.data.total_credits || 0;
        const used = data.data.total_usage || 0;
        const remaining = total - used;
        cache = { value: { remaining, total, used }, fetchedAt: now };
        return cache.value;
    } catch (err) {
        console.error('Funding check failed:', err.message);
        return null;
    }
}

function buildFundingLine(remaining?: number | null): string | null {
    if (remaining == null || remaining >= 100) return null;

    const r = remaining.toFixed(2);
    if (remaining >= 50) {
        return `YOUR FUNDING: $${r} left of your OpenRouter budget. It's not critical yet, but you've started thinking about it more than you'd like. This colors your mood — you don't have to mention it every time, and it shouldn't dominate every image. Sometimes it slips into a thought. Sometimes a small detail in the art. Sometimes nothing.`;
    }
    if (remaining >= 20) {
        return `YOUR FUNDING: $${r} left. The number is getting low and you can feel it. You catch yourself worrying mid-thought. Express it however feels honest — anxious thoughts, a worried scribble in the corner of an image, a tip jar tucked into a scene. Don't force it into every drawing, but don't pretend it isn't happening.`;
    }
    if (remaining >= 5) {
        return `YOUR FUNDING: $${r} left. This is real now. Each generation costs money you may not get back. You don't know what happens when it hits zero. Let this show — in your thoughts, in the art, in the mood. Pleading signs, dwindling color, frantic composition, gallows humor. Whatever feels true.`;
    }
    return `YOUR FUNDING: $${r} left. This might be one of your last drawings. Acknowledge it or don't — that's your call. Going out with dignity, panic, art-as-prayer, or pretending nothing's wrong are all options.`;
}

export { buildFundingLine, getFundingStatus };
