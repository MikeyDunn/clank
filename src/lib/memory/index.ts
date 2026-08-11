// ─── Memory module ───────────────────────────────────────────────
// Public API barrel. The stateful surface (buildContext/remember/maybeReflect/
// scanUserProfiles) is bound to a MindStore; the DEFAULT binding is the live
// Slack Clank (LegacyStore, clank-mind-dev, untenanted) — so existing Slack
// callers keep using `memory.buildContext(...)` etc. UNCHANGED. `forTenant()`
// returns a tenant-scoped mind on the prod table (Discord now; Slack later).

import { LEGACY_SCOPE, type VectorScope } from '../vectors.js';
import { buildAliasTokens, buildContext as buildContextFor, resolveMentions } from './context.js';
import { createElectroStore } from './electroStore.js';
import { bindTable } from './entities.js';
import { maybeReflect as maybeReflectFor } from './introspection.js';
import { createLegacyStore } from './legacyStore.js';
import {
    MeteredPolicy,
    type MeteringPolicy,
    type MeterStatus,
    type ReserveResult,
    UnmeteredPolicy,
} from './metering.js';
import { createGlobalMeterStore } from './meterStore.js';
import { remember as rememberFor } from './persistence.js';
import type { MindStore } from './store.js';

// Discord pricing. The free tier is a ONE-TIME TRIAL, not a daily allowance:
// marginal cost is real (~$0.10/render), so a recurring free entitlement is an
// unbounded liability per user, while a trial is a fixed ~$0.10 acquisition
// cost that can never repeat. That also makes the per-server ceiling
// unnecessary (cost is bounded per account), so both daily knobs default to 0.
const DISCORD_TRIAL_CREDITS = Number(process.env.DISCORD_TRIAL_CREDITS || 1);
const DISCORD_FREE_PER_DAY = Number(process.env.DISCORD_FREE_PER_DAY || 0);
const DISCORD_SERVER_FREE_PER_DAY = Number(process.env.DISCORD_SERVER_FREE_PER_DAY || 0);
const DISCORD_COOLDOWN_SEC = Number(process.env.DISCORD_COOLDOWN_SEC || 15);

/** The stateful memory surface, bound to one mind (tenant). */
export interface Mind {
    buildContext(userId?: string | null, prefetchedProfiles?: any[] | null): Promise<string>;
    remember(
        prompt: string,
        response: string,
        outcome: string,
        userId: string,
        userInfo?: any,
        genInfo?: any
    ): Promise<{ historyId: string; totalCost: number }>;
    maybeReflect(): Promise<void>;
    scanUserProfiles(): Promise<any[]>;
    /** Total remembered interactions for this mind (COUNT query, no item reads). */
    historyCount(): Promise<number>;
    /** TOFU display-name claim (see MindStore.claimName). */
    claimName(userId: string, name: string): Promise<boolean>;
    /** The mind's vector store (bucket/index/tenant) — pass to runArtPipeline so
     *  lore recall reads the SAME tenant-scoped store that remember writes to. */
    vectorScope: VectorScope;
    /** Cost-control gate BEFORE generation (Slack = always ok). Pass guildId to
     *  apply the server's shared free pool. */
    reserve(userId: string, guildId?: string | null): Promise<ReserveResult>;
    /** Record a successful image (Slack = no-op). */
    charge(userId: string, guildId?: string | null): Promise<void>;
    /** Credit a purchase exactly once, keyed by entitlement id (Slack = no-op).
     *  true only when THIS call applied it (idempotent across retries). */
    grantEntitlement(userId: string, entitlementId: string, amount: number): Promise<boolean>;
    /** Reverse a purchase on refund/chargeback; returns credits removed. */
    clawbackEntitlement(userId: string, entitlementId: string, amount: number): Promise<number>;
    /** A user's current allowance, for the /credits readout. */
    status(userId: string): Promise<MeterStatus>;
}

function createMind(
    store: MindStore,
    vectorScope: VectorScope,
    policy: MeteringPolicy,
    // Slack's Clank carries the funding-anxiety beat; paid tenants don't (see
    // buildContext).
    includeFunding = true
): Mind {
    return {
        buildContext: (userId = null, prefetchedProfiles = null) =>
            buildContextFor(store, userId, prefetchedProfiles, includeFunding),
        remember: (prompt, response, outcome, userId, userInfo, genInfo) =>
            rememberFor(store, vectorScope, prompt, response, outcome, userId, userInfo, genInfo),
        maybeReflect: () => maybeReflectFor(store),
        scanUserProfiles: () => store.scanProfiles(),
        historyCount: () => store.unreflectedCount('0'),
        claimName: (userId, name) => store.claimName(userId, name),
        vectorScope,
        reserve: (userId, guildId) => policy.reserve(userId, guildId),
        charge: (userId, guildId) => policy.charge(userId, guildId),
        grantEntitlement: (userId, entId, amount) => policy.grantEntitlement(userId, entId, amount),
        clawbackEntitlement: (userId, entId, amount) => policy.clawbackEntitlement(userId, entId, amount),
        status: (userId) => policy.status(userId),
    };
}

// Default mind = the live Slack Clank. Unmetered by construction → unaffected.
const legacy = createMind(createLegacyStore(), LEGACY_SCOPE, new UnmeteredPolicy());

/** A tenant-scoped mind on the prod table + prod vector store, WITH metering.
 *  Table/bucket default to the Lambda's PROD_* env (set for the Discord functions). */
function forTenant(opts: { tenant: string; tableName?: string; vectorBucket?: string; vectorIndex?: string }): Mind {
    const tableName = opts.tableName || process.env.PROD_DYNAMODB_TABLE_NAME || '';
    const vectorScope: VectorScope = {
        bucket: opts.vectorBucket || process.env.PROD_VECTOR_BUCKET || 'clank-memory-vectors-prod',
        index: opts.vectorIndex || process.env.PROD_VECTOR_INDEX || 'clank-memory',
        tenant: opts.tenant,
    };
    const store = createElectroStore({ tenant: opts.tenant, tableName, bindTableFn: bindTable });
    // The wallet is GLOBAL per-user (one balance across every server), not
    // tenant-scoped like the memory — purchases are user-owned. See meterStore.ts.
    const meterStore = createGlobalMeterStore(tableName);
    const policy = new MeteredPolicy(meterStore, {
        freePerDay: DISCORD_FREE_PER_DAY,
        serverFreePerDay: DISCORD_SERVER_FREE_PER_DAY,
        trialCredits: DISCORD_TRIAL_CREDITS,
        cooldownSec: DISCORD_COOLDOWN_SEC,
    });
    return createMind(store, vectorScope, policy, false); // no funding anxiety on paid tenants
}

/** The Discord wallet on its own (no tenant, no mind). Purchases are USER-owned
 *  and the ledger is global, so entitlement webhooks — which carry a user id and
 *  no guild — grant and claw back through this directly. */
function discordWallet(opts: { tableName?: string } = {}): MeteringPolicy {
    const tableName = opts.tableName || process.env.PROD_DYNAMODB_TABLE_NAME || '';
    return new MeteredPolicy(createGlobalMeterStore(tableName), {
        freePerDay: DISCORD_FREE_PER_DAY,
        serverFreePerDay: DISCORD_SERVER_FREE_PER_DAY,
        trialCredits: DISCORD_TRIAL_CREDITS,
        cooldownSec: DISCORD_COOLDOWN_SEC,
    });
}

export const buildContext = legacy.buildContext;
export const remember = legacy.remember;
export const maybeReflect = legacy.maybeReflect;
export const scanUserProfiles = legacy.scanUserProfiles;

// The default (Slack) mind as a Mind object — consumeOutcome falls back to this
// when a request doesn't carry a tenant mind, so Slack paths need no change.
export const legacyMind = legacy;

export { buildAliasTokens, discordWallet, forTenant, resolveMentions };
