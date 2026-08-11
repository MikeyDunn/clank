// ─── S3 Vectors store ────────────────────────────────────────────
// Managed vector storage + similarity search (AWS-native). Holds Clank's
// recallable memory: history entries + lore descriptions. One index per store,
// distinguished by metadata.type. Bring-your-own vectors (embedded via
// lib/embeddings.js).
//
// Tenant isolation lives HERE, at the boundary — putVectors STAMPS the tenant
// into metadata, queryVectors ADDS the tenant to the filter — so a caller can't
// forget it (same philosophy as the DynamoDB stores owning their key prefix).
// A VectorScope names the bucket + index + tenant; the default LEGACY_SCOPE is
// the single-tenant Slack store (tenant: null → no stamp, no filter), so every
// untenanted caller stays byte-identical to today.

import { PutVectorsCommand, QueryVectorsCommand, S3VectorsClient } from '@aws-sdk/client-s3vectors';
import type { Tenant } from './memory/tenant.js';

const REGION = 'us-east-1';

export interface VectorScope {
    bucket: string;
    index: string;
    tenant: Tenant;
}

/** The original single-tenant Slack store — the default everywhere, so all
 *  untenanted (Slack) recall/sync hits the same bucket/index with no tenant
 *  filter, exactly as before multi-tenancy. */
export const LEGACY_SCOPE: VectorScope = {
    bucket: 'clank-memory-vectors-dev',
    index: 'clank-memory',
    tenant: null,
};

const client = new S3VectorsClient({ region: REGION });

/**
 * Combine a base metadata filter (e.g. { type: 'history' }) with the tenant into
 * a VALID S3 Vectors filter. S3 Vectors rejects a bare multi-key map, so two+
 * conditions must be wrapped in `$and`; a single condition stays a plain map
 * (the untenanted Slack form, byte-identical to before). Returns undefined when
 * there's nothing to filter on.
 */
function buildFilter(base: Record<string, any> | undefined, tenant: Tenant): any {
    const conds: any[] = [];
    if (base) for (const [k, v] of Object.entries(base)) conds.push({ [k]: v });
    if (tenant) conds.push({ tenant });
    if (conds.length === 0) return undefined;
    if (conds.length === 1) return conds[0];
    return { $and: conds };
}

/**
 * Store vectors. Each item: { key, vector: number[], metadata: {...} }.
 * metadata should include `type` ('lore_description'|'history') and `text` (the
 * raw payload). Other keys (handle, timestamp, historyId) are filterable; `text`
 * is non-filterable (set at index creation). The scope's tenant is stamped into
 * every item's metadata so tenant-scoped queries can find (only) it. Batches of
 * up to 500 per PutVectors call.
 */
async function putVectors(items, scope: VectorScope = LEGACY_SCOPE) {
    if (!items.length) return;
    for (let i = 0; i < items.length; i += 500) {
        const batch = items.slice(i, i + 500).map((it) => ({
            key: it.key,
            data: { float32: it.vector },
            metadata: scope.tenant ? { ...(it.metadata || {}), tenant: scope.tenant } : it.metadata || {},
        }));
        await client.send(
            new PutVectorsCommand({
                vectorBucketName: scope.bucket,
                indexName: scope.index,
                vectors: batch,
            })
        );
    }
}

/**
 * Query the top-K most similar vectors to `queryVector`. `opts.filter` narrows
 * by metadata (e.g. { type: 'history' }); the scope's tenant is AND-ed into that
 * filter automatically, so a query can never cross tenants. `opts.maxDistance`
 * is a cosine-distance ceiling (lower = more similar; distance = 1 - cosine_sim).
 */
async function queryVectors(
    queryVector: number[],
    opts: { topK?: number; filter?: any; maxDistance?: number } = {},
    scope: VectorScope = LEGACY_SCOPE
): Promise<Array<{ key; distance; metadata }>> {
    const { topK = 8, filter, maxDistance } = opts;
    const scopedFilter = buildFilter(filter, scope.tenant);
    const resp = await client.send(
        new QueryVectorsCommand({
            vectorBucketName: scope.bucket,
            indexName: scope.index,
            topK,
            queryVector: { float32: queryVector },
            ...(scopedFilter ? { filter: scopedFilter } : {}),
            returnMetadata: true,
            returnDistance: true,
        })
    );
    let matches = (resp.vectors || []).map((v) => ({
        key: v.key,
        distance: v.distance,
        metadata: v.metadata || {},
    }));
    if (maxDistance != null) matches = matches.filter((m) => m.distance != null && m.distance <= maxDistance);
    return matches;
}

export { putVectors, queryVectors };
