// ─── Metering policy ─────────────────────────────────────────────
// Cost control as a per-tenant POLICY on the Mind, NOT a platform branch. Every
// caller runs the same two seams — reserve() before spending on generation,
// charge() on a successful image — and the policy behind them decides behaviour:
//   • UnmeteredPolicy (Slack / any free mind): reserve always ok, charge no-op.
//     Slack is unaffected BY CONSTRUCTION — there's no branch to skip.
//   • MeteredPolicy (Discord): a free daily allowance + cooldown, then a paid
//     credit balance (bought via consumable SKUs — see credits.ts).
//
// The ledger is a GLOBAL per-user wallet (meterStore.ts), keyed by Discord user
// id, NOT per guild — purchases are user-owned and follow the user across every
// server, so one balance works everywhere.
//
// CONCURRENCY: a user's requests are separate Lambdas and genuinely race, so
// every mutation is a conditional write. reserve() ends by atomically CLAIMING
// the cooldown slot — only one in-flight request per user can win it, which
// serialises the rest and keeps the allowance checks honest.

import type { MeterStore } from './store.js';

export interface ReserveResult {
    ok: boolean;
    /** Shown to the user when denied (cooldown / out of allowance). */
    message?: string;
    /** true when the denial is "out of free AND credits" → caller offers packs. */
    offerPacks?: boolean;
}

/** A user's current allowance, for the /credits readout. */
export interface MeterStatus {
    metered: boolean;
    credits: number;
    freeRemaining: number;
    freePerDay: number;
}

export interface MeteringPolicy {
    /** Gate BEFORE think/generate so a denied user costs nothing. `guildId`
     *  applies the server's shared free pool (omit for unmetered/Slack). */
    reserve(userId: string, guildId?: string | null): Promise<ReserveResult>;
    /** Record consumption AFTER a successful image (free first, then credits). */
    charge(userId: string, guildId?: string | null): Promise<void>;
    /** Credit a purchase exactly once, keyed by entitlement id (Slack = no-op).
     *  Returns true only when this call is the one that applied it. */
    grantEntitlement(userId: string, entitlementId: string, amount: number): Promise<boolean>;
    /** Reverse a purchase on refund/chargeback; returns credits removed (Slack = 0). */
    clawbackEntitlement(userId: string, entitlementId: string, amount: number): Promise<number>;
    /** A user's current allowance for display (Slack = unmetered). */
    status(userId: string): Promise<MeterStatus>;
}

/** Slack + any free/internal mind: never gate, never charge. */
export class UnmeteredPolicy implements MeteringPolicy {
    async reserve(): Promise<ReserveResult> {
        return { ok: true };
    }
    async charge(): Promise<void> {
        /* no-op */
    }
    async grantEntitlement(): Promise<boolean> {
        return false;
    }
    async clawbackEntitlement(): Promise<number> {
        return 0;
    }
    async status(): Promise<MeterStatus> {
        return { metered: false, credits: 0, freeRemaining: 0, freePerDay: 0 };
    }
}

export interface MeterConfig {
    /** Free renders per USER per UTC day. Tuned for conversion: low enough that
     *  an engaged person meets a wall regularly, high enough to allow a retry
     *  when a render disappoints. */
    freePerDay: number;
    /** Free renders per SERVER per UTC day, shared by everyone in it. This is the
     *  cost ceiling: without it, one large guild's free usage scales with its
     *  member count and is effectively unbounded. Paid renders ignore it, so a
     *  paying user is never blocked by their server's pool running dry. */
    serverFreePerDay: number;
    /** One-time trial credits, granted on a user's first ever request. This is
     *  the whole free tier: a FIXED acquisition cost per person (~$0.30), not a
     *  recurring daily entitlement. Freemium assumes near-zero marginal cost;
     *  ours is ~$0.10/render, so a daily allowance is an unbounded liability. */
    trialCredits: number;
    /** Minimum seconds between a user's renders. Also the concurrency serialiser. */
    cooldownSec: number;
}

/** Idempotency key for the trial grant. Reuses the entitlement ledger, so
 *  "exactly once per user, ever" is free and survives retries. */
const trialKey = (userId: string) => `trial:${userId}`;

/** UTC calendar day (YYYY-MM-DD) — the free allowance resets on this boundary. */
function utcDay(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
}

/** Next UTC midnight as a unix seconds stamp (for a <t:…:R> Discord timestamp). */
function nextUtcMidnight(nowMs: number): number {
    const n = new Date(nowMs);
    return Math.floor(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) / 1000);
}

export class MeteredPolicy implements MeteringPolicy {
    constructor(
        private store: MeterStore,
        private cfg: MeterConfig
    ) {}

    async reserve(userId: string, guildId?: string | null): Promise<ReserveResult> {
        if (!userId) return { ok: true }; // no identity to meter (shouldn't happen)
        const now = Date.now();
        const today = utcDay(now);

        // First contact ever: hand out the trial. grantOnce is idempotent, so
        // this is a no-op on every subsequent request.
        if (this.cfg.trialCredits > 0) {
            await this.store.grantOnce(userId, trialKey(userId), this.cfg.trialCredits);
        }

        const m = await this.store.getUserMeter(userId);

        // Advisory allowance check FIRST, so someone who's simply out of renders
        // isn't charged a cooldown stamp (they can buy and retry immediately).
        const freeUsed = m.freeResetDate === today ? m.freeUsedToday || 0 : 0;
        const credits = m.creditBalance || 0;
        const userHasFree = freeUsed < this.cfg.freePerDay;

        // A free render needs BOTH the user's allowance and the server's shared
        // pool. Credits bypass the server pool entirely — a paying user must
        // never be blocked because their server's free budget ran out.
        let serverHasFree = true;
        if (userHasFree && guildId) {
            const used = await this.store.getServerFreeUsed(guildId, today);
            serverHasFree = used < this.cfg.serverFreePerDay;
        }

        if (!(userHasFree && serverHasFree) && credits <= 0) {
            // Discord renders <t:unix:R> in each viewer's own timezone.
            const reason =
                this.cfg.freePerDay > 0
                    ? userHasFree
                        ? `This server has used its free renders for today (they reset <t:${nextUtcMidnight(now)}:R>).`
                        : `You're out of renders for today. Your ${this.cfg.freePerDay} free reset <t:${nextUtcMidnight(now)}:R>.`
                    : "You're out of credits.";
            return { ok: false, offerPacks: true, message: `${reason} Grab a pack below to keep going.` };
        }

        // Atomically claim the cooldown slot. Exactly one concurrent request wins,
        // so the allowance read above can't be raced into an overspend.
        const claimed = await this.store.claimCooldown(userId, now, this.cfg.cooldownSec * 1000);
        if (!claimed) {
            return { ok: false, message: `Give me ${this.cfg.cooldownSec}s to breathe between renders.` };
        }
        return { ok: true };
    }

    async charge(userId: string, guildId?: string | null): Promise<void> {
        if (!userId) return;
        const today = utcDay(Date.now());

        // Free path needs the SERVER's shared pool too. Claim that first: if the
        // pool is dry we fall through to credits without having spent the user's
        // free allowance on a render they'd have paid for anyway.
        const serverOk = guildId ? await this.store.consumeServerFree(guildId, today, this.cfg.serverFreePerDay) : true;
        if (serverOk) {
            // Conditional writes, so the decision is made by what actually
            // succeeds, never by a stale read.
            const usedFree = await this.store.consumeFree(userId, today, this.cfg.freePerDay);
            if (usedFree) return;
        }

        const spent = await this.store.spendCredit(userId);
        if (!spent) {
            // Shouldn't happen (reserve gated it), but never fail a delivered image.
            console.warn(`charge: no free or credits left for ${userId}; image already delivered`);
        }
    }

    grantEntitlement(userId: string, entitlementId: string, amount: number): Promise<boolean> {
        if (!userId || !entitlementId || amount <= 0) return Promise.resolve(false);
        return this.store.grantOnce(userId, entitlementId, amount);
    }

    clawbackEntitlement(userId: string, entitlementId: string, amount: number): Promise<number> {
        if (!userId || !entitlementId || amount <= 0) return Promise.resolve(0);
        return this.store.clawback(userId, entitlementId, amount);
    }

    async status(userId: string): Promise<MeterStatus> {
        const m = await this.store.getUserMeter(userId);
        const today = utcDay(Date.now());
        const freeUsed = m.freeResetDate === today ? m.freeUsedToday || 0 : 0;
        return {
            metered: true,
            credits: m.creditBalance || 0,
            freeRemaining: Math.max(0, this.cfg.freePerDay - freeUsed),
            freePerDay: this.cfg.freePerDay,
        };
    }
}
