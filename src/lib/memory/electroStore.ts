// ─── ElectroStore: the prod, tenant-scoped MindStore ─────────────
// Implements MindStore over the ElectroDB entities on the PROD table. Every
// operation is bound to one `tenant` ('discord:G…' / 'slack:T…'), so a mind can
// only ever touch its own rows. Returned items use LOGICAL (un-prefixed) keys —
// the `TENANT#<id>#` prefix is composed/stripped here and never leaks upward.
//
// ElectroDB specifics that matter here:
//   • .go({ order: 'desc' })                → newest-first (ScanIndexForward:false)
//   • .go({ data:'raw', params:{Select:'COUNT'} }) → server-side COUNT, paginated
//   • .update() is an UPSERT (no attribute_exists guard) — the reflection-lock
//     conditional write must create IDENTITY on the first-ever reflection.
//   • .put() fully replaces the item — matches the legacy putItem overwrite.

import {
    HistoryEntity,
    IdentityEntity,
    isConditionalFailure,
    NameClaimEntity,
    ProfileEntity,
    ReflectionEntity,
} from './entities.js';
import type { IdentityRow, MindStore, ProfileRow, ProfileTouch } from './store.js';

/** Drop null/undefined values (ElectroDB rejects null for typed attributes) and
 *  any stray physical-key fields the caller might carry (the store owns keys). */
function clean(obj: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined) continue;
        if (k === 'pk' || k === 'sk' || k === 'gsi1pk' || k === 'gsi1sk') continue;
        out[k] = v;
    }
    return out;
}

/**
 * Build a MindStore for one tenant on the prod table. `bindTableFn` binds the
 * shared entities to the prod table once (idempotent). The returned store is a
 * plain object of the 10 domain operations.
 */
export function createElectroStore(opts: {
    tenant: string;
    tableName: string;
    bindTableFn: (tableName: string) => void;
}): MindStore {
    const { tenant, tableName, bindTableFn } = opts;
    if (!tenant) throw new Error('createElectroStore: tenant is required');
    bindTableFn(tableName);

    return {
        async getIdentity(): Promise<IdentityRow> {
            const { data } = await IdentityEntity.get({ tenant }).go();
            return data ?? null;
        },

        async getJournal(limit: number) {
            const { data } = await ReflectionEntity.query.record({ tenant }).go({ order: 'desc', limit, pages: 1 });
            return data;
        },

        async recentHistory(limit: number) {
            const { data } = await HistoryEntity.query.byTime({ tenant }).go({ order: 'desc', limit, pages: 1 });
            return data;
        },

        async unreflectedCount(since: string): Promise<number> {
            let count = 0;
            let cursor: string | null = null;
            do {
                const resp: any = await HistoryEntity.query
                    .byTime({ tenant })
                    .gt({ timestamp: since })
                    .go({ data: 'raw', cursor, params: { Select: 'COUNT' } });
                count += resp.data?.Count || 0;
                cursor = resp.cursor;
            } while (cursor);
            return count;
        },

        async scanProfiles(): Promise<ProfileRow[]> {
            const { data } = await ProfileEntity.query.byTenant({ tenant }).go({ pages: 'all' });
            // Present a logical `pk: 'USER#<uid>'` so the existing readers (which
            // parse `profile.pk`) work unchanged across both stores.
            return data.map((p: any) => ({ ...p, pk: `USER#${p.userId}` }));
        },

        async putHistory(entry: Record<string, any>): Promise<void> {
            await HistoryEntity.put({ tenant, ...clean(entry) } as any).go();
        },

        async touchProfile(userId: string, o: ProfileTouch): Promise<void> {
            // upsert (NOT update): it's insert-capable, so on first contact it
            // writes the byTenant gsi1 keys too — an update() only writes index
            // keys when their composites are in the SET clause, so an
            // update-created profile is invisible to the roster query. `add`
            // applies against 0 on a new row; `ifNotExists` freezes handle +
            // firstSeen (written once, never overwritten).
            const set: Record<string, any> = { lastSeen: o.now };
            if (o.displayName) set.displayName = o.displayName;

            const frozen: Record<string, any> = {};
            if (o.handle) frozen.handle = o.handle;
            if (o.incrementCount) frozen.firstSeen = o.now;

            let op = ProfileEntity.upsert({ tenant, userId }).set(set);
            if (Object.keys(frozen).length) op = op.ifNotExists(frozen);
            if (o.incrementCount) op = op.add({ requestCount: 1 });
            await op.go();
        },

        async claimReflectionLock(prevReflectedAt: string | null, now: string): Promise<boolean> {
            try {
                await IdentityEntity.update({ tenant })
                    .set({ lastReflectedAt: now })
                    .where(
                        (attr, op) =>
                            `${op.eq(attr.lastReflectedAt, prevReflectedAt || '0')} OR ${op.notExists(attr.lastReflectedAt)}`
                    )
                    .go();
                return true;
            } catch (err) {
                if (isConditionalFailure(err)) return false; // another invocation won the race
                throw err;
            }
        },

        async appendReflection(entry: Record<string, any>): Promise<void> {
            await ReflectionEntity.put({ tenant, ...clean(entry) } as any).go();
        },

        async claimName(userId: string, name: string): Promise<boolean> {
            const normalized = name.trim().toLowerCase();
            if (!normalized) return false;
            try {
                // create() = conditional put (fails if the row exists) — first
                // claimer wins, forever.
                await NameClaimEntity.create({ tenant, name: normalized, userId } as any).go();
                return true;
            } catch (err) {
                if (!isConditionalFailure(err)) throw err;
                const { data } = await NameClaimEntity.get({ tenant, name: normalized } as any).go();
                return (data as any)?.userId === userId;
            }
        },

        async putIdentity(fields: Record<string, any>): Promise<void> {
            // Full replace (matches legacy putItem). reflect() always includes
            // coreIdentity, so no field is silently dropped.
            await IdentityEntity.put({ tenant, ...clean(fields) } as any).go();
        },
    };
}
