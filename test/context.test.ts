// Unit tests for the pure relative-time formatter (lib/memory/context.js).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTimeAgo } from '../src/lib/memory/context.js';

const NOW = 1_700_000_000_000;
const ago = (ms) => formatTimeAgo(NOW, NOW - ms);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatTimeAgo: under a minute is "just now"', () => {
    assert.equal(ago(0), 'just now');
    assert.equal(ago(30 * SEC), 'just now');
});

test('formatTimeAgo: minutes, singular and plural', () => {
    assert.equal(ago(MIN), '1 minute ago');
    assert.equal(ago(2 * MIN), '2 minutes ago');
});

test('formatTimeAgo: hours', () => {
    assert.equal(ago(HOUR), '1 hour ago');
    assert.equal(ago(5 * HOUR), '5 hours ago');
});

test('formatTimeAgo: days', () => {
    assert.equal(ago(DAY), '1 day ago');
    assert.equal(ago(3 * DAY), '3 days ago');
});

test('formatTimeAgo: months', () => {
    assert.equal(ago(30 * DAY), '1 month ago');
    assert.equal(ago(90 * DAY), '3 months ago');
});

// ── buildContext: era chapters (stub MindStore, no network — funding off) ──

import { buildContext } from '../src/lib/memory/context.js';

// Partial stub — buildContext only touches these four reads.
const stubStore = (identity): any => ({
    recentHistory: async () => [],
    getIdentity: async () => identity,
    getJournal: async () => [{ text: 'journal entry one' }],
    scanProfiles: async () => [],
});

test('buildContext: renders era chapters before recent thoughts', async () => {
    const ctx = await buildContext(
        stubStore({
            coreIdentity: 'I am Clank.',
            reflectionCount: 20,
            eraSummaries: [
                { ts: '2026-07-15T00:00:00.000Z', text: 'The first stretch was chaos.' },
                { ts: '2026-08-08T00:00:00.000Z', text: 'Then things settled.' },
            ],
        }),
        null,
        null,
        false
    );
    assert.ok(ctx.includes('EARLIER CHAPTERS'));
    assert.ok(ctx.includes('[through Jul 2026] The first stretch was chaos.'));
    assert.ok(ctx.includes('[through Aug 2026] Then things settled.'));
    assert.ok(ctx.indexOf('EARLIER CHAPTERS') < ctx.indexOf('YOUR RECENT THOUGHTS'));
});

test('buildContext: no era section when identity has none', async () => {
    const ctx = await buildContext(stubStore({ coreIdentity: 'I am Clank.', reflectionCount: 3 }), null, null, false);
    assert.ok(!ctx.includes('EARLIER CHAPTERS'));
});
