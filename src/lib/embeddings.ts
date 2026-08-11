// ─── Embeddings ──────────────────────────────────────────────────
// Turn text into vectors via OpenRouter (text-embedding-3-small, 1536-dim).
// Pluggable: swap the model/endpoint here if we ever move off OpenRouter.
// Note: switching embedding models requires re-embedding the whole store —
// vectors from different models are not comparable.

import * as openrouter from './openrouter.js';

const EMBED_MODEL = 'openai/text-embedding-3-small';

/**
 * Embed one string or an array of strings. Returns one vector per input,
 * aligned to input order, plus the call's cost and token count.
 */
async function embed(input: string | string[]): Promise<{ vectors: number[][]; cost: number; tokens: number }> {
    const texts = Array.isArray(input) ? input : [input];
    const data = await openrouter.embed({ model: EMBED_MODEL, input: texts });

    // OpenRouter returns data[] with an `index` per embedding — sort to be safe.
    const vectors = (data.data || [])
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);

    const cost = data.usage?.cost || 0;
    const tokens = data.usage?.total_tokens || 0;
    return { vectors, cost, tokens };
}

/**
 * Convenience: embed a single string, return just its vector + cost.
 */
async function embedOne(text) {
    const { vectors, cost, tokens } = await embed(text);
    return { vector: vectors[0], cost, tokens };
}

export { embed, embedOne };
