// ─── LegacyStore: the current single-tenant MindStore ────────────
// Implements MindStore over the existing hand-rolled db.ts on `clank-mind-dev`,
// UNTENANTED. This is the live Slack Clank — every method reproduces exactly the
// keys and expressions the code used before the store seam existed, so the rows
// are byte-identical and Slack's behavior does not change. Slack binds this by
// default (memory/index.ts); ElectroStore is the tenant-scoped prod counterpart.

import { getItem, putItem, queryHistoryGSI, queryItems, queryRaw, scanUserProfiles, updateItem } from './db.js';
import type { IdentityRow, MindStore, ProfileRow, ProfileTouch } from './store.js';

export function createLegacyStore(): MindStore {
    return {
        // ── reads ──
        getIdentity: (): Promise<IdentityRow> => getItem('META', 'IDENTITY'),

        getJournal: (limit: number) => queryItems('META', 'REFLECTION#', { limit, forward: false }),

        recentHistory: (limit: number) => queryHistoryGSI({ limit, forward: false }),

        async unreflectedCount(since: string): Promise<number> {
            const result = await queryRaw({
                IndexName: 'gsi1',
                KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk > :since',
                ExpressionAttributeValues: { ':pk': 'HIST', ':since': since },
                Select: 'COUNT',
            });
            return result.Count || 0;
        },

        scanProfiles: (): Promise<ProfileRow[]> => scanUserProfiles(),

        // ── writes ── (each composes the physical keys the raw code always wrote)
        async putHistory(entry: Record<string, any>): Promise<void> {
            await putItem({
                ...entry,
                pk: `HIST#${entry.historyId}`,
                sk: 'ENTRY',
                gsi1pk: 'HIST',
                gsi1sk: entry.timestamp,
            });
        },

        async touchProfile(userId: string, o: ProfileTouch): Promise<void> {
            const setExprs = ['#lastSeen = :now'];
            const names: Record<string, string> = { '#lastSeen': 'lastSeen' };
            const values: Record<string, any> = { ':now': o.now };

            if (o.incrementCount) {
                setExprs.push('#firstSeen = if_not_exists(#firstSeen, :now)');
                names['#firstSeen'] = 'firstSeen';
                names['#requestCount'] = 'requestCount';
                values[':one'] = 1;
            }
            if (o.handle) {
                // Freeze the handle: set once, never overwrite (the canonical key
                // mention-resolution + lore recall anchor on).
                setExprs.push('#handle = if_not_exists(#handle, :handle)');
                names['#handle'] = 'handle';
                values[':handle'] = o.handle;
            }
            if (o.displayName) {
                setExprs.push('#displayName = :displayName');
                names['#displayName'] = 'displayName';
                values[':displayName'] = o.displayName;
            }

            let updateExpr = `SET ${setExprs.join(', ')}`;
            if (o.incrementCount) updateExpr += ' ADD #requestCount :one';

            await updateItem({
                Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
                UpdateExpression: updateExpr,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
            });
        },

        async claimReflectionLock(prevReflectedAt: string | null, now: string): Promise<boolean> {
            try {
                await updateItem({
                    Key: { pk: 'META', sk: 'IDENTITY' },
                    UpdateExpression: 'SET #lr = :now',
                    ExpressionAttributeNames: { '#lr': 'lastReflectedAt' },
                    ExpressionAttributeValues: { ':now': now, ':old': prevReflectedAt || '0' },
                    ConditionExpression: '#lr = :old OR attribute_not_exists(#lr)',
                });
                return true;
            } catch (err: any) {
                if (err.name === 'ConditionalCheckFailedException') return false;
                throw err;
            }
        },

        async appendReflection(entry: Record<string, any>): Promise<void> {
            await putItem({ ...entry, pk: 'META', sk: `REFLECTION#${entry.timestamp}` });
        },

        // Slack names come from the platform — no claim needed.
        async claimName(): Promise<boolean> {
            return true;
        },

        async putIdentity(fields: Record<string, any>): Promise<void> {
            await putItem({ ...fields, pk: 'META', sk: 'IDENTITY' });
        },
    };
}
