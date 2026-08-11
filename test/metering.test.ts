// Tests for metering.ts — the free-daily/cooldown/credit gate. Pure logic over a
// mock MeterStore whose ops simulate DynamoDB's CONDITIONAL semantics (each
// mutation applies only if its condition holds), so these cover the concurrency
// invariants too: the cooldown claim serialises, credits can't go negative, and
// a purchase can never be granted twice.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeteredPolicy, type MeteringPolicy, UnmeteredPolicy } from '../src/lib/memory/metering.js';
import type { MeterStore } from '../src/lib/memory/store.js';

function mockStore(initial: Record<string, any> = {}) {
    // the per-guild shared pool
    const g = { freeUsedToday: 0, freeResetDate: null as string | null };
    const m = {
        freeUsedToday: 0,
        freeResetDate: null as string | null,
        creditBalance: 0,
        lastRequestAt: null as number | null,
        grantedEnts: new Set<string>(),
        clawedEnts: new Set<string>(),
        ...initial,
    };
    const store: MeterStore = {
        async getUserMeter() {
            return {
                freeUsedToday: m.freeUsedToday,
                freeResetDate: m.freeResetDate,
                creditBalance: m.creditBalance,
                lastRequestAt: m.lastRequestAt,
                givenName: null,
                familyInitial: null,
            };
        },
        async setNameOnce() {
            /* not exercised by metering tests */
        },
        async claimCooldown(_u, now, cooldownMs) {
            if (m.lastRequestAt !== null && m.lastRequestAt > now - cooldownMs) return false;
            m.lastRequestAt = now;
            return true;
        },
        async consumeFree(_u, today, cap) {
            if (cap < 1) return false;
            if (m.freeResetDate === today) {
                if (m.freeUsedToday >= cap) return false;
                m.freeUsedToday += 1;
                return true;
            }
            m.freeUsedToday = 1;
            m.freeResetDate = today;
            return true;
        },
        async getServerFreeUsed(_g, today) {
            return g.freeResetDate === today ? g.freeUsedToday : 0;
        },
        async consumeServerFree(_g, today, cap) {
            if (cap < 1) return false;
            if (g.freeResetDate === today) {
                if (g.freeUsedToday >= cap) return false;
                g.freeUsedToday += 1;
                return true;
            }
            g.freeUsedToday = 1;
            g.freeResetDate = today;
            return true;
        },
        async spendCredit() {
            if (m.creditBalance < 1) return false;
            m.creditBalance -= 1;
            return true;
        },
        async grantOnce(_u, entId, amount) {
            if (m.grantedEnts.has(entId)) return false;
            m.grantedEnts.add(entId);
            m.creditBalance += amount;
            return true;
        },
        async clawback(_u, entId, amount) {
            if (!m.grantedEnts.has(entId) || m.clawedEnts.has(entId)) return 0;
            const take = Math.min(amount, Math.max(0, m.creditBalance));
            m.creditBalance -= take;
            m.clawedEnts.add(entId);
            return take;
        },
    };
    return { store, peek: () => m, peekGuild: () => g };
}

test('UnmeteredPolicy (Slack): reserve always ok, charge is a no-op', async () => {
    const p: MeteringPolicy = new UnmeteredPolicy();
    assert.deepEqual(await p.reserve('U1'), { ok: true });
    await p.charge('U1'); // must not throw
    assert.deepEqual(await p.reserve('U1'), { ok: true });
});

test('UnmeteredPolicy (Slack): grants/clawbacks are inert, status is unmetered', async () => {
    const p: MeteringPolicy = new UnmeteredPolicy();
    assert.equal(await p.grantEntitlement('U1', 'E1', 50), false);
    assert.equal(await p.clawbackEntitlement('U1', 'E1', 50), 0);
    assert.equal((await p.status('U1')).metered, false);
});

test('MeteredPolicy: fresh user is allowed', async () => {
    const { store } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 3, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    assert.equal((await p.reserve('U1')).ok, true);
});

test('MeteredPolicy: denies once the free daily cap is spent (no credits)', async () => {
    const { store, peek } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 2, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    await p.reserve('U1');
    await p.charge('U1');
    await p.reserve('U1');
    await p.charge('U1');
    assert.equal(peek().freeUsedToday, 2);
    const r = await p.reserve('U1');
    assert.equal(r.ok, false);
    assert.match(r.message || '', /out of renders/);
    assert.equal(r.offerPacks, true); // out of free + credits → offer buy packs
});

test('MeteredPolicy: credits are spent after free is exhausted', async () => {
    const { store, peek } = mockStore({ creditBalance: 2 });
    const p = new MeteredPolicy(store, { freePerDay: 1, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    await p.reserve('U1');
    await p.charge('U1'); // uses the 1 free
    assert.equal(peek().freeUsedToday, 1);
    const r = await p.reserve('U1'); // free gone, but 2 credits → allowed
    assert.equal(r.ok, true);
    await p.charge('U1');
    assert.equal(peek().creditBalance, 1); // one credit spent
});

test('MeteredPolicy: charge never drives the balance negative', async () => {
    const { store, peek } = mockStore({ creditBalance: 1, freeResetDate: '2000-01-01' });
    const p = new MeteredPolicy(store, { freePerDay: 0, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    await p.charge('U1'); // spends the single credit
    await p.charge('U1'); // nothing left — must not go to -1
    assert.equal(peek().creditBalance, 0);
});

test('MeteredPolicy: cooldown blocks back-to-back requests', async () => {
    const { store } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 99, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 60 });
    assert.equal((await p.reserve('U1')).ok, true); // claims the slot
    const r = await p.reserve('U1'); // immediately again → within cooldown
    assert.equal(r.ok, false);
    assert.match(r.message || '', /between renders/);
});

test('MeteredPolicy: concurrent reserves — only ONE wins the cooldown claim', async () => {
    const { store } = mockStore({ creditBalance: 10 });
    const p = new MeteredPolicy(store, { freePerDay: 3, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 15 });
    // Five simultaneous requests (the multi-server race that previously let a
    // user bypass the cap entirely).
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => p.reserve('U1')));
    assert.equal(results.filter((r) => r.ok).length, 1);
});

test('MeteredPolicy: an out-of-renders denial does NOT stamp the cooldown', async () => {
    // So a user who buys a pack can retry immediately instead of waiting.
    const { store, peek } = mockStore({ freeResetDate: new Date().toISOString().slice(0, 10), freeUsedToday: 3 });
    const p = new MeteredPolicy(store, { freePerDay: 3, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 60 });
    const r = await p.reserve('U1');
    assert.equal(r.ok, false);
    assert.equal(r.offerPacks, true);
    assert.equal(peek().lastRequestAt, null);
});

test('MeteredPolicy: free allowance resets on a new UTC day', async () => {
    const { store } = mockStore({ freeResetDate: '2000-01-01', freeUsedToday: 99 });
    const p = new MeteredPolicy(store, { freePerDay: 3, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    const r = await p.reserve('U1'); // yesterday's 99 doesn't count today
    assert.equal(r.ok, true);
});

test('MeteredPolicy: charge on a new day starts the count at 1', async () => {
    const { store, peek } = mockStore({ freeResetDate: '2000-01-01', freeUsedToday: 99 });
    const p = new MeteredPolicy(store, { freePerDay: 3, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    await p.charge('U1');
    assert.equal(peek().freeUsedToday, 1);
    assert.notEqual(peek().freeResetDate, '2000-01-01');
});

test('MeteredPolicy: an entitlement grants exactly once, however many times we retry', async () => {
    const { store, peek } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 3, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    assert.equal(await p.grantEntitlement('U1', 'ENT-1', 12), true);
    // A failed consume, a Lambda retry, and a concurrent /credits all re-run this.
    assert.equal(await p.grantEntitlement('U1', 'ENT-1', 12), false);
    assert.equal(await p.grantEntitlement('U1', 'ENT-1', 12), false);
    assert.equal(peek().creditBalance, 12);
});

test('MeteredPolicy: distinct entitlements each grant', async () => {
    const { store, peek } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 3, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    await p.grantEntitlement('U1', 'ENT-1', 12);
    await p.grantEntitlement('U1', 'ENT-2', 35);
    assert.equal(peek().creditBalance, 47);
});

test('MeteredPolicy: clawback reclaims the unspent remainder, once', async () => {
    const { store, peek } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 0, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    await p.grantEntitlement('U1', 'ENT-1', 12);
    await p.charge('U1'); // user spends 1 before the chargeback
    assert.equal(peek().creditBalance, 11);
    assert.equal(await p.clawbackEntitlement('U1', 'ENT-1', 12), 11); // only what's left
    assert.equal(peek().creditBalance, 0); // never negative
    assert.equal(await p.clawbackEntitlement('U1', 'ENT-1', 12), 0); // not twice
});

test('MeteredPolicy: clawback ignores an entitlement we never granted', async () => {
    const { store, peek } = mockStore({ creditBalance: 50 });
    const p = new MeteredPolicy(store, { freePerDay: 0, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    assert.equal(await p.clawbackEntitlement('U1', 'UNKNOWN', 12), 0);
    assert.equal(peek().creditBalance, 50);
});

test('MeteredPolicy: status reports credits and remaining free', async () => {
    const { store } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 3, serverFreePerDay: 9999, trialCredits: 0, cooldownSec: 0 });
    await p.grantEntitlement('U1', 'ENT-1', 12);
    assert.deepEqual(await p.status('U1'), { metered: true, credits: 12, freeRemaining: 3, freePerDay: 3 });
});

// ── Server-level free pool ───────────────────────────────────────────
// The per-user cap limits ONE person; without a per-server cap a big guild's
// free usage scales with member count and is effectively unbounded spend.

test('server pool: a free render draws on BOTH the user and the server', async () => {
    const { store, peek, peekGuild } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 2, serverFreePerDay: 50, trialCredits: 0, cooldownSec: 0 });
    await p.reserve('U1', 'G1');
    await p.charge('U1', 'G1');
    assert.equal(peek().freeUsedToday, 1);
    assert.equal(peekGuild().freeUsedToday, 1);
});

test('server pool: exhausted server blocks free users even with allowance left', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { store } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 2, serverFreePerDay: 1, trialCredits: 0, cooldownSec: 0 });
    await p.charge('U1', 'G1'); // burns the server's only free render
    const r = await p.reserve('U2', 'G1'); // different user, full personal allowance
    assert.equal(r.ok, false);
    assert.match(r.message || '', /server has used its free renders/i);
    assert.equal(r.offerPacks, true);
});

test('server pool: PAID users are never blocked by an exhausted server pool', async () => {
    // The important one: a paying customer must not be denied because their
    // server's free budget ran dry.
    const { store, peek } = mockStore({ creditBalance: 5 });
    const p = new MeteredPolicy(store, { freePerDay: 2, serverFreePerDay: 1, trialCredits: 0, cooldownSec: 0 });
    await p.charge('U1', 'G1'); // server pool now dry
    const r = await p.reserve('U2', 'G1');
    assert.equal(r.ok, true);
    await p.charge('U2', 'G1');
    assert.equal(peek().creditBalance, 4); // spent a credit, not free
});

test('server pool: a dry server does not consume the user free allowance', async () => {
    const { store, peek } = mockStore({ creditBalance: 5 });
    const p = new MeteredPolicy(store, { freePerDay: 2, serverFreePerDay: 0, trialCredits: 0, cooldownSec: 0 });
    await p.charge('U1', 'G1');
    assert.equal(peek().freeUsedToday, 0); // untouched
    assert.equal(peek().creditBalance, 4); // credit spent instead
});

test('server pool: no guild id (Slack-style) ignores the server cap entirely', async () => {
    const { store, peek } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 2, serverFreePerDay: 0, trialCredits: 0, cooldownSec: 0 });
    await p.charge('U1'); // no guild
    assert.equal(peek().freeUsedToday, 1);
});

// ── One-time trial (the whole free tier) ─────────────────────────────
test('trial: granted once ever, never again', async () => {
    const { store, peek } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 0, serverFreePerDay: 0, trialCredits: 3, cooldownSec: 0 });
    await p.reserve('U1', 'G1');
    assert.equal(peek().creditBalance, 3);
    await p.reserve('U1', 'G1');
    await p.reserve('U1', 'G2'); // different server, same person
    assert.equal(peek().creditBalance, 3);
});

test('trial: spends down and then denies with a buy prompt', async () => {
    const { store, peek } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 0, serverFreePerDay: 0, trialCredits: 2, cooldownSec: 0 });
    await p.reserve('U1', 'G1');
    await p.charge('U1', 'G1');
    await p.charge('U1', 'G1');
    assert.equal(peek().creditBalance, 0);
    const r = await p.reserve('U1', 'G1');
    assert.equal(r.ok, false);
    assert.equal(r.offerPacks, true);
    assert.match(r.message || '', /out of credits/i);
    assert.doesNotMatch(r.message || '', /today|reset/i); // no phantom daily allowance
});

test('trial: with no daily tier, charge always spends credits', async () => {
    const { store, peek } = mockStore();
    const p = new MeteredPolicy(store, { freePerDay: 0, serverFreePerDay: 0, trialCredits: 3, cooldownSec: 0 });
    await p.reserve('U1', 'G1');
    await p.charge('U1', 'G1');
    assert.equal(peek().creditBalance, 2);
    assert.equal(peek().freeUsedToday, 0);
});
