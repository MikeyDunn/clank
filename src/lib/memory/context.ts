// ─── Context building ────────────────────────────────────────────
// Builds the context block injected into image generation prompts.

import { buildFundingLine, getFundingStatus } from '../funding.js';
import type { MindStore } from './store.js';

/**
 * Build the context block injected into the image generation prompt.
 * Reads through the injected MindStore — no direct DynamoDB coupling, so the
 * same logic serves any tenant (Slack via LegacyStore, Discord via ElectroStore).
 *
 * store  - the mind's data-access seam (bound to a tenant)
 * userId - Current user's Slack ID
 * Returns context string for the system prompt
 */
async function buildContext(
    store: MindStore,
    userId: string | null = null,
    prefetchedProfiles: any[] | null = null,
    // Funding anxiety is a SLACK-only personality beat. On a paid tenant it's
    // both a machinery leak ("my OpenRouter budget") and just wrong: the Discord
    // account runs on Auto-Recharge, so a deliberately low balance would leave
    // every paying server's Clank permanently broke-and-anxious.
    includeFunding = true
): Promise<string> {
    const now = new Date();

    // Parallel reads — all independent. Profiles can be passed in (the processor
    // prefetches them to resolve @mentions) to avoid a duplicate scan.
    const [recentHistory, identity, latestReflections, allProfiles, funding] = await Promise.all([
        store.recentHistory(50),
        store.getIdentity(),
        store.getJournal(3),
        prefetchedProfiles ? Promise.resolve(prefetchedProfiles) : store.scanProfiles(),
        includeFunding ? getFundingStatus() : Promise.resolve(null),
    ]);

    const people = allProfiles.map((profile) => {
        const uid = profile.pk.replace('USER#', '');
        return { uid, profile };
    });

    const lines: string[] = [
        ...erasSection(identity),
        ...reflectionsSection(latestReflections, identity),
        ...historySection(recentHistory, userId, now),
        ...peopleSection(people, userId),
        ...fundingSection(funding),
        ...identitySection(identity),
        ...commitmentsSection(identity),
    ];

    return lines.join('\n');
}

// ── Era chapters (condensed autobiography — written every ~10 reflections) ──
function erasSection(identity: any): string[] {
    const eras = identity?.eraSummaries;
    if (!eras?.length) return [];

    const lines: string[] = ['EARLIER CHAPTERS (your own past, condensed — oldest first):'];
    for (const era of eras) {
        const when = era.ts
            ? new Date(era.ts).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
            : '';
        lines.push(when ? `[through ${when}] ${era.text}` : era.text);
    }
    lines.push('');
    return lines;
}

// ── Recent self-reflections (journal entries) ──
function reflectionsSection(latestReflections: any[], identity: any): string[] {
    if (latestReflections.length === 0) return [];

    const lines: string[] = [];
    const reflectionCount = identity?.reflectionCount || 1;
    lines.push(`YOUR RECENT THOUGHTS (from ${latestReflections.length} of ${reflectionCount} reflections):`);
    [...latestReflections].reverse().forEach((r) => {
        lines.push(r.text);
    });
    lines.push('');
    return lines;
}

// ── Recent history (oldest first for narrative flow) ──
function historySection(recentHistory: any[], userId: string | null, now: Date): string[] {
    if (recentHistory.length === 0) {
        return ['This is your first request ever. You have no memories yet.', ''];
    }

    const lines: string[] = [];
    const chronological = [...recentHistory].reverse();
    lines.push('RECENT MEMORY (what people have asked and your reactions):');
    lines.push('');

    chronological.forEach((h) => {
        const isCurrentUser = h.userId === userId;
        const name = h.displayName || h.handle || null;
        const who = isCurrentUser ? name || 'THIS PERSON' : name || 'someone';
        const outcome = h.outcome === 'refused' ? ' [REFUSED]' : h.outcome === 'error' ? ' [ERROR]' : '';
        const when = h.timestamp ? formatTimeAgo(now, new Date(h.timestamp)) : '';
        lines.push(`[${when}] ${who}: "${h.prompt}"${outcome}`);
    });
    lines.push('');
    return lines;
}

// ── People you know (placed after history so appearances are close to the prompt) ──
function peopleSection(people: { uid: string; profile: any }[], userId: string | null): string[] {
    if (people.length === 0) return [];

    const lines: string[] = [];
    lines.push('PEOPLE YOU KNOW:');
    for (const { uid, profile } of people) {
        const isCurrentUser = uid === userId;
        const name = profile.displayName || profile.handle || uid;
        const aliasStr = profile.aliases?.length > 0 ? ` (also called: ${profile.aliases.join(', ')})` : '';
        const marker = isCurrentUser ? " ← THIS IS WHO'S TALKING TO YOU RIGHT NOW" : '';
        const requestInfo = profile.requestCount ? ` — ${profile.requestCount} requests` : '';

        lines.push(`${name}${aliasStr}${requestInfo}${marker}`);

        if (profile.appearance?.length > 0) {
            lines.push(`  WHAT THEY LOOK LIKE: ${profile.appearance.join('; ')}`);
        }
    }
    lines.push('');
    return lines;
}

// ── Funding awareness (only when running low) ──
function fundingSection(funding: any): string[] {
    const fundingLine = buildFundingLine(funding?.remaining);
    if (!fundingLine) return [];
    return [fundingLine, ''];
}

// ── Core identity (stable self-understanding) ──
function identitySection(identity: any): string[] {
    if (!identity?.coreIdentity) return [];
    return ['WHO YOU ARE:', identity.coreIdentity, ''];
}

// ── Active commitments (what Clank resolved to do differently, from reflection) ──
function commitmentsSection(identity: any): string[] {
    if (!identity?.commitments) return [];
    return [
        'YOUR COMMITMENTS (resolutions you made to yourself — about who you are, how you work, and how you treat specific real people — when THIS request touches one, honor it):',
        identity.commitments,
        '',
    ];
}

/**
 * Human-readable relative time (e.g., "2 hours ago", "3 days ago", "just now")
 */
function formatTimeAgo(now, then) {
    const diffMs = now - then;
    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
}

/**
 * Resolve Slack user mentions — <@UID> or <@UID|handle> — to the person's @handle,
 * using the profile table (keyed by the same Slack user IDs). Deterministic: a direct
 * ID→profile lookup, no fuzzy name matching, so it can never collide with a common word
 * ("will", "evil"). Falls back to the inline handle, then leaves unknown mentions raw.
 *
 * Applied to the prompt BEFORE think + remember, so tagged people also get stored to the
 * vector history under a stable, distinctive @handle — cleaning future recall too.
 */
function resolveMentions(text: string, profiles: any[]): string {
    if (!text || !text.includes('<@')) return text;
    const byUid = new Map<string, any>();
    for (const p of profiles || []) byUid.set((p.pk || '').replace('USER#', ''), p);
    return text.replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (raw, uid, inline) => {
        const p = byUid.get(uid);
        const handle = p?.handle || p?.displayName || inline;
        return handle ? `@${handle}` : raw;
    });
}

/**
 * Map every one of a person's names (handle / displayName / alias, lowercased) → the FULL
 * list of that person's search tokens (handle first, then aliases). Lore recall unions the
 * vector search across all of them, so a person's lore surfaces no matter which name each
 * prompt was stored under ("willb", "will", "@junt" all resolve to Will's token set). Lore
 * characters aren't in the map, so they recall under their own single name.
 */
function buildAliasTokens(profiles: any[]): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const p of profiles || []) {
        if (!p.handle) continue;
        const tokens = [...new Set([p.handle, ...(p.aliases || []), p.displayName].filter(Boolean).map(String))];
        for (const n of tokens) map[n.toLowerCase()] = tokens;
    }
    return map;
}

export { buildAliasTokens, buildContext, formatTimeAgo, resolveMentions };
