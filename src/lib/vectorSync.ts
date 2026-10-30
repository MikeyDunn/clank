// ─── Vector dual-write ───────────────────────────────────────────
// Best-effort mirror of lore + history into the S3 Vectors store.
// DynamoDB remains the source of truth; these calls NEVER throw —
// a failed sync logs and moves on (backfill + dedup reconcile later).
// Kill switch: env VECTOR_DUAL_WRITE='false' disables all writes.

import { embedOne } from './embeddings.js';
import { LEGACY_SCOPE, putVectors, type VectorScope } from './vectors.js';

const enabled = () => process.env.VECTOR_DUAL_WRITE !== 'false';

/**
 * Mirror one history entry's prompt into the vector store.
 * Deterministic key (history#<id>) → idempotent upsert. `scope` targets the
 * mind's bucket/index and stamps its tenant (default: the Slack store).
 * `imageUrl` (the render, when there was one) rides along so lore recall can
 * hand Clank the picture he made, not just the words that asked for it.
 */
async function syncHistoryEntry(
    {
        historyId,
        prompt,
        handle,
        timestamp,
        imageUrl = null,
    }: { historyId: string; prompt: string; handle?: string | null; timestamp?: string; imageUrl?: string | null },
    scope: VectorScope = LEGACY_SCOPE
) {
    if (!enabled() || !prompt || !historyId) return;
    try {
        const { vector } = await embedOne(prompt);
        await putVectors(
            [
                {
                    key: `history#${historyId}`,
                    vector,
                    metadata: {
                        type: 'history',
                        text: prompt.slice(0, 2000),
                        handle: handle || 'unknown',
                        historyId,
                        timestamp: timestamp || '',
                        ...(imageUrl ? { imageUrl } : {}),
                    },
                },
            ],
            scope
        );
    } catch (err) {
        console.error('Vector sync (history) failed:', err.message);
    }
}

export { syncHistoryEntry };
