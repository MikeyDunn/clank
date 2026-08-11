// ─── Lore tools ──────────────────────────────────────────────────
// Clank's memory-recall tools, called by the think step itself.
// Both are vector searches over type=history (the group's user-authored
// prompts). Returns raw prompt text — lore stays user-authored.

import { embedOne } from './embeddings.js';
import { LEGACY_SCOPE, queryVectors, type VectorScope } from './vectors.js';

const TOPK = 8;
const MAX_DISTANCE = 0.6;
// Definition gate. Validated across 17 entities: every REAL definition matched at
// ≤0.53, while entities with no canonical description (an emergent character, a bare @handle, a running gag
// farm) only pulled wrong/noise defs at ≥0.71. 0.6 sits in that empty band — keeps
// every true def, drops the noise so undefined entities fall back to history usage
// instead of getting an unrelated character injected as their "definition".
const MAX_DEF_DISTANCE = 0.6;
// Over-fetch + looser gate for exact-name hits; see recallEntityHistory's docstring.
const ENTITY_OVERFETCH = 60;
const MAX_EXACT_DISTANCE = 0.7;

const LORE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'getEntityLore',
            description:
                "Recall the defining lore and history for a SPECIFIC named character (a person, creature, pet, or recurring concept in the group's mythology). Use to remember who a character is and their key story. Pass ONLY the character's name or alias.",
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The character name or alias, e.g. "bosse" or "pissatron".' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'getSemanticLore',
            description:
                'Recall past moments, scenes, or events relevant to a theme, action, or situation. Use to remember what the group has done around a topic. Pass a short descriptive phrase of the scene or theme.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'A short descriptive phrase, e.g. "late-night rave chaos".' },
                },
                required: ['query'],
            },
        },
    },
];

/**
 * History recall for a named entity across ALL its search tokens (a person's handle +
 * aliases, or just a lore character's own name). We UNION the over-fetch from each token,
 * then float prompts that literally contain any token (word-boundary matched, so "ted"
 * doesn't hit "wanted") to the front. That lexical sieve drops embedding-noise (the
 * "continue" cluster that a common word like "will" pulls in doesn't contain "will"), and
 * the distance sort sinks homonym junk (actual "wolf" animals rank below a person's own
 * names). Net: searching every name a person might be stored under, kept accurate.
 */
async function recallEntityHistory(tokens: string[], scope: VectorScope): Promise<string[]> {
    const seen = new Map<string, { distance: number; text: string }>();
    await Promise.all(
        tokens.map(async (token) => {
            const { vector } = await embedOne(token);
            const hits = await queryVectors(
                vector,
                {
                    topK: ENTITY_OVERFETCH,
                    filter: { type: 'history' },
                    maxDistance: MAX_EXACT_DISTANCE,
                },
                scope
            );
            for (const m of hits) {
                const text = m.metadata.text || '';
                const prev = seen.get(text);
                if (!prev || m.distance < prev.distance) seen.set(text, { distance: m.distance, text });
            }
        })
    );
    const esc = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const tokenRe = new RegExp(`\\b(${esc})\\b`, 'i');
    const pool = [...seen.values()];
    const exact = pool.filter((m) => tokenRe.test(m.text)).sort((a, b) => a.distance - b.distance);
    const rest = pool
        .filter((m) => m.distance <= MAX_DISTANCE && !tokenRe.test(m.text))
        .sort((a, b) => a.distance - b.distance);
    return [...exact, ...rest].slice(0, TOPK).map((m) => m.text);
}

/** Execute a lore tool call → array of lore texts. Never throws. `tokenMap` (any of a
 *  person's names → the full list of their search tokens) lets entity recall search
 *  ALL of a person's names at once, so lore stored under any nickname still surfaces. */
async function executeLoreTool(name, args, tokenMap: Record<string, string[]> = {}, scope: VectorScope = LEGACY_SCOPE) {
    try {
        const rawQ = name === 'getEntityLore' ? args?.name : args?.query;
        if (!rawQ) return [];

        if (name === 'getEntityLore') {
            // Real person → union across ALL their names; lore character → just its own.
            // tokens[0] is the canonical handle, used for the definition query.
            const key = String(rawQ).toLowerCase().replace(/^@/, '');
            const tokens = tokenMap[key] || [rawQ];
            if (tokens.length > 1) console.log(`Lore recall union: "${rawQ}" → [${tokens.join(', ')}]`);
            const [defs, usage] = await Promise.all([
                embedOne(tokens[0]).then(({ vector }) =>
                    queryVectors(
                        vector,
                        {
                            topK: 2,
                            filter: { type: 'lore_description' },
                            maxDistance: MAX_DEF_DISTANCE,
                        },
                        scope
                    )
                ),
                recallEntityHistory(tokens, scope),
            ]);
            return [...defs.map((m) => m.metadata.text), ...usage];
        }

        // Semantic recall: single embed, history only.
        const { vector } = await embedOne(rawQ);
        const matches = await queryVectors(
            vector,
            {
                topK: TOPK,
                filter: { type: 'history' },
                maxDistance: MAX_DISTANCE,
            },
            scope
        );
        return matches.map((m) => m.metadata.text);
    } catch (err) {
        console.error('Lore tool failed:', name, err.message);
        return [];
    }
}

export { executeLoreTool, LORE_TOOLS };
