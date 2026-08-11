// ─── ElectroDB entity models (PROD, multi-tenant) ────────────────
// Single-table models for the PRODUCTION store, where every mind is scoped to a
// tenant ('slack:T…' / 'discord:G…'). Keys carry a `TENANT#<id>#` prefix on the
// partition, matching `scopeKey(tenant, base)` in tenant.ts EXACTLY:
//   scopeKey(t,'META')          → TENANT#<t>#META            (IDENTITY, REFLECTION#, …)
//   scopeKey(t,'USER#<uid>')    → TENANT#<t>#USER#<uid>      (PROFILE)
//   scopeKey(t,'HIST#<uuid>')   → TENANT#<t>#HIST#<uuid>     (ENTRY) + gsi1pk TENANT#<t>#HIST
// so the byTime GSI is a per-tenant partition — reflection + recency see only
// that tenant's history, never another's.
//
// These are PROD-ONLY. The legacy Slack table (clank-mind-dev, untenanted) keeps
// the hand-rolled db.ts — ElectroDB's client-side `__edb_e__` entity stamp means
// it can't read un-stamped legacy rows anyway (verified). Slack migrates onto
// this model later (dual-write → backfill ElectroDB-native → cutover).
//
// CRITICAL: every pk/sk carries `casing: 'none'`. ElectroDB lowercases keys by
// default (`META` → `meta`); `casing: 'none'` preserves the literal template
// case (tenant ids are case-sensitive — 'discord:G…' must not be mangled).
//
// Attribute schemas are derived from the real live items (inspected, not guessed).

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Entity } from 'electrodb';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });

const SERVICE = 'clank';
const NC = 'none' as const; // preserve literal key case (see header)

// The tenant composite shared by every entity's partition key. Required — there
// are no untenanted rows on the prod table.
const TENANT_ATTR = { type: 'string', required: true } as const;

// META / IDENTITY — the evolving self (core identity + commitments + reflect counter).
export const IdentityEntity = new Entity(
    {
        model: { entity: 'identity', version: '1', service: SERVICE },
        attributes: {
            tenant: TENANT_ATTR,
            coreIdentity: { type: 'string' },
            reflectionCount: { type: 'number' },
            lastReflectedAt: { type: 'string' },
            commitments: { type: 'string' },
            // Era summaries — one condensed "chapter" per ERA_EVERY reflections,
            // last ERA_KEEP kept. Written by introspection, rendered by buildContext.
            eraSummaries: {
                type: 'list',
                items: { type: 'map', properties: { ts: { type: 'string' }, text: { type: 'string' } } },
            },
        },
        indexes: {
            record: {
                pk: { field: 'pk', composite: ['tenant'], template: 'TENANT#${tenant}#META', casing: NC },
                sk: { field: 'sk', composite: [], template: 'IDENTITY', casing: NC },
            },
        },
    },
    { client }
);

// TENANT#<t>#NAMES / NAME#<name> — per-tenant display-name claims (iMessage).
// TOFU: first sub to use a name in a chat owns it there; prevents typing a
// friend's name to poison their attribution (the platform gives us no identity
// to lean on, unlike Slack/Discord handles).
export const NameClaimEntity = new Entity(
    {
        model: { entity: 'nameclaim', version: '1', service: SERVICE },
        attributes: {
            tenant: TENANT_ATTR,
            name: { type: 'string', required: true }, // normalized (trim+lower)
            userId: { type: 'string', required: true },
        },
        indexes: {
            record: {
                pk: { field: 'pk', composite: ['tenant'], template: 'TENANT#${tenant}#NAMES', casing: NC },
                sk: { field: 'sk', composite: ['name'], template: 'NAME#${name}', casing: NC },
            },
        },
    },
    { client }
);

// META / REFLECTION#<ts> — append-only journal entries.
export const ReflectionEntity = new Entity(
    {
        model: { entity: 'reflection', version: '1', service: SERVICE },
        attributes: {
            tenant: TENANT_ATTR,
            timestamp: { type: 'string', required: true },
            text: { type: 'string' },
            coreIdentitySnapshot: { type: 'string' },
            commitmentsSnapshot: { type: 'string' },
            costUsd: { type: 'number' },
        },
        indexes: {
            record: {
                pk: { field: 'pk', composite: ['tenant'], template: 'TENANT#${tenant}#META', casing: NC },
                sk: { field: 'sk', composite: ['timestamp'], template: 'REFLECTION#${timestamp}', casing: NC },
            },
        },
    },
    { client }
);

// USER#<uid> / PROFILE — a real person (frozen appearance + aliases, request stats).
export const ProfileEntity = new Entity(
    {
        model: { entity: 'profile', version: '1', service: SERVICE },
        attributes: {
            tenant: TENANT_ATTR,
            userId: { type: 'string', required: true },
            handle: { type: 'string' },
            displayName: { type: 'string' },
            appearance: { type: 'list', items: { type: 'string' } },
            aliases: { type: 'list', items: { type: 'string' } },
            requestCount: { type: 'number' },
            firstSeen: { type: 'string' },
            lastSeen: { type: 'string' },
            // Metering ledger (metering.ts) — free daily allowance + paid credits.
            freeUsedToday: { type: 'number' },
            freeResetDate: { type: 'string' },
            creditBalance: { type: 'number' },
            lastRequestAt: { type: 'number' },
        },
        indexes: {
            record: {
                pk: {
                    field: 'pk',
                    composite: ['tenant', 'userId'],
                    template: 'TENANT#${tenant}#USER#${userId}',
                    casing: NC,
                },
                sk: { field: 'sk', composite: [], template: 'PROFILE', casing: NC },
            },
            // All of a tenant's profiles in ONE gsi1 partition, so the roster is a
            // single Query (not a whole-table scan). Shares the physical gsi1 with
            // history's byTime — different gsi1pk values (…#USER vs …#HIST) never
            // collide — so the prod table needs no extra index.
            byTenant: {
                index: 'gsi1',
                pk: { field: 'gsi1pk', composite: ['tenant'], template: 'TENANT#${tenant}#USER', casing: NC },
                sk: { field: 'gsi1sk', composite: ['userId'], template: '${userId}', casing: NC },
            },
        },
    },
    { client }
);

// HIST#<uuid> / ENTRY — one interaction. `byTime` GSI (gsi1) gives time-order.
export const HistoryEntity = new Entity(
    {
        model: { entity: 'history', version: '1', service: SERVICE },
        attributes: {
            tenant: TENANT_ATTR,
            historyId: { type: 'string', required: true },
            timestamp: { type: 'string', required: true },
            prompt: { type: 'string' },
            response: { type: 'string' },
            outcome: { type: 'string' },
            source: { type: 'string' },
            handle: { type: 'string' },
            displayName: { type: 'string' },
            userId: { type: 'string' },
            // Reaction/summon entries: author of the reacted message (userId is
            // the summoner). Null on typed prompts.
            authorUserId: { type: 'string' },
            imageUrl: { type: 'string' },
            referenceUrl: { type: 'string' },
            imagePrompt: { type: 'string' },
            publicResponse: { type: 'string' },
            errorMessage: { type: 'string' },
            model: { type: 'string' },
            cost: { type: 'number' },
            totalCost: { type: 'number' },
            regenerations: { type: 'number' },
        },
        indexes: {
            record: {
                pk: {
                    field: 'pk',
                    composite: ['tenant', 'historyId'],
                    template: 'TENANT#${tenant}#HIST#${historyId}',
                    casing: NC,
                },
                sk: { field: 'sk', composite: [], template: 'ENTRY', casing: NC },
            },
            byTime: {
                index: 'gsi1',
                pk: { field: 'gsi1pk', composite: ['tenant'], template: 'TENANT#${tenant}#HIST', casing: NC },
                sk: { field: 'gsi1sk', composite: ['timestamp'], template: '${timestamp}', casing: NC },
            },
        },
    },
    { client }
);

// META / REACTED#<channel>#<ts> — the 🤖-reaction claim-once lock (create-if-absent).
export const ReactedEntity = new Entity(
    {
        model: { entity: 'reacted', version: '1', service: SERVICE },
        attributes: {
            tenant: TENANT_ATTR,
            channelId: { type: 'string', required: true },
            messageTs: { type: 'string', required: true },
            claimedAt: { type: 'string' },
            reactor: { type: 'string' },
            author: { type: 'string' },
        },
        indexes: {
            record: {
                pk: { field: 'pk', composite: ['tenant'], template: 'TENANT#${tenant}#META', casing: NC },
                sk: {
                    field: 'sk',
                    composite: ['channelId', 'messageTs'],
                    template: 'REACTED#${channelId}#${messageTs}',
                    casing: NC,
                },
            },
        },
    },
    { client }
);

// META / SHIRT_LOG — dedup list of image URLs already turned into t-shirts.
export const ShirtLogEntity = new Entity(
    {
        model: { entity: 'shirtlog', version: '1', service: SERVICE },
        attributes: {
            tenant: TENANT_ATTR,
            urls: { type: 'list', items: { type: 'string' } },
        },
        indexes: {
            record: {
                pk: { field: 'pk', composite: ['tenant'], template: 'TENANT#${tenant}#META', casing: NC },
                sk: { field: 'sk', composite: [], template: 'SHIRT_LOG', casing: NC },
            },
        },
    },
    { client }
);

const ALL = [
    IdentityEntity,
    ReflectionEntity,
    ProfileEntity,
    HistoryEntity,
    ReactedEntity,
    ShirtLogEntity,
    NameClaimEntity,
];

let boundTo: string | null = null;
/**
 * Bind the prod table name to every entity (lazy — importing this module never
 * requires env at load). Idempotent for the same table; all tenants share the
 * one prod table, so this is called once with the prod table name.
 */
export function bindTable(tableName: string): void {
    if (!tableName) throw new Error('bindTable: prod table name is required');
    if (boundTo === tableName) return;
    for (const e of ALL) e.setTableName(tableName);
    boundTo = tableName;
}

/** True when a write failed its create-if-absent condition (the reaction lock). */
export function isConditionalFailure(err: unknown): boolean {
    return /conditional/i.test(String((err as any)?.message ?? err));
}
