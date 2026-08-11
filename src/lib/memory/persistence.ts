// ─── Memory persistence ─────────────────────────────────────────
// Core write operation: remember (history entry + profile touch + vector sync).
// Data access goes through the injected MindStore (physical keys + tenant scoping
// are the store's concern), so the same remember serves Slack and Discord.

import crypto from 'node:crypto';
import { syncHistoryEntry } from '../vectorSync.js';
import type { VectorScope } from '../vectors.js';
import type { MindStore } from './store.js';

/**
 * Record an interaction — called on EVERY request (success, refusal, or error).
 * The store's putHistory + touchProfile are each atomic — no read-modify-write.
 *
 * store        - the mind's data-access seam (bound to a tenant)
 * prompt       - What the user asked for
 * response     - Clank's reaction / model text
 * outcome      - 'success' | 'text_only' | 'refused' | 'error'
 * userId       - Slack user ID
 * userInfo     - { handle, displayName, source } — source = 'slash'|'shortcut'|'reaction'
 * genInfo      - { model, cost } from generation
 */
async function remember(
    store: MindStore,
    scope: VectorScope,
    prompt: string,
    response: string,
    outcome: string,
    userId: string,
    userInfo: any = {},
    genInfo: any = {}
): Promise<{ historyId: string; totalCost: number }> {
    const now = new Date().toISOString();
    // Callers may pre-mint the id (iMessage: generate mints it so the message
    // payload can reference the row commit will later write).
    const historyId = genInfo.historyId || crypto.randomUUID();
    const handle = userInfo.handle || null;
    const displayName = userInfo.displayName || null;
    // How the request arrived: 'slash' (/clank) | 'shortcut' (Ask Clank) |
    // 'reaction' (🤖). Rides on userInfo (constructed once per request). Lets
    // report.ts filter reaction traffic apart from /clank.
    const source = userInfo.source || 'slash';
    // 🤖-reaction only: the AUTHOR of the reacted message (userId is the
    // summoner). Write-only today — lets us later ask whose messages attract
    // summons (author-prior for the auto-suggest experiment + analytics).
    const authorUserId = userInfo.authorUserId || null;
    const cost = genInfo.cost || 0;

    // Write history entry (the store composes keys / tenant prefix).
    await store.putHistory({
        historyId,
        timestamp: now,
        prompt,
        handle,
        displayName,
        userId: userId || null,
        response: response || '',
        outcome: outcome || 'success',
        imageUrl: genInfo.imageUrl || null,
        referenceUrl: genInfo.referenceUrl || null,
        imagePrompt: genInfo.imagePrompt || null,
        publicResponse: genInfo.publicResponse || null,
        errorMessage: genInfo.errorMessage || null,
        model: genInfo.model || null,
        source,
        authorUserId,
        cost,
        totalCost: cost,
        regenerations: 0,
    });

    // One uniform line per stored interaction — every path (/clank, Ask Clank,
    // 🤖-reaction; image/text/refusal/error) funnels through here, so this
    // is the single consistent "what got remembered" log across all of them.
    console.log(
        `Remembered ${outcome} [${source}]: $${cost.toFixed(4)} · ${handle || userId || 'unknown'} · ${historyId}`
    );

    // Upsert user profile (bump lastSeen, set-once handle/firstSeen, +1 count).
    if (userId) {
        await store.touchProfile(userId, { now, handle, displayName, incrementCount: true });
    }

    // Dual-write to vector store (best-effort, never throws) — the mind's scope
    // targets its bucket/index and stamps the tenant.
    await syncHistoryEntry({ historyId, prompt, handle, timestamp: now }, scope);

    return { historyId, totalCost: cost };
}

export { remember };
