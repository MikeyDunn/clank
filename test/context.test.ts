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

import { buildContext, ownAnswer } from '../src/lib/memory/context.js';

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

test('ownAnswer: image rows show the imagePrompt, text rows the spoken reply', () => {
    assert.equal(
        ownAnswer({ outcome: 'success', imagePrompt: 'a bronze hippo\n  robot' }),
        'you drew: a bronze hippo robot'
    );
    assert.equal(ownAnswer({ outcome: 'text_only', publicResponse: 'No.' }), 'you said: "No."');
    assert.equal(ownAnswer({ outcome: 'error', imagePrompt: 'x' }), null);
    assert.equal(ownAnswer({ outcome: 'success' }), null);
});

test('ownAnswer: prefers his own drew note over the imagePrompt opening', () => {
    assert.equal(
        ownAnswer({
            outcome: 'success',
            drew: 'Floyd at a parent-teacher night',
            imagePrompt: 'Candid 35mm flash photo',
        }),
        'you drew: Floyd at a parent-teacher night'
    );
    assert.equal(ownAnswer({ outcome: 'error', drew: 'x' }), null);
});

test('ownAnswer: long answers are clipped', () => {
    const out = ownAnswer({ outcome: 'success', imagePrompt: 'a'.repeat(500) }) as string;
    assert.ok(out.endsWith('…'));
    assert.ok(out.length < 260);
});

test('buildContext: recent memory pairs each ask with his answer', async () => {
    const store: any = {
        recentHistory: async () => [
            { prompt: 'draw a cat', outcome: 'success', imagePrompt: 'A tabby cat on a windowsill', handle: 'ian' },
        ],
        getIdentity: async () => ({ coreIdentity: 'I am Clank.', reflectionCount: 1 }),
        getJournal: async () => [],
        scanProfiles: async () => [],
    };
    const ctx = await buildContext(store, null, null, false);
    assert.ok(ctx.includes('ian: "draw a cat"\n    ↳ you drew: A tabby cat on a windowsill'));
});

test('buildContext: only the most recent rows carry his thoughts', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
        prompt: `ask ${i}`,
        outcome: 'success',
        imagePrompt: `drawing ${i}`,
        response: `thought ${i}`,
    })).reverse(); // newest-first, like the store
    const store: any = {
        recentHistory: async () => rows,
        getIdentity: async () => ({ coreIdentity: 'I am Clank.', reflectionCount: 1 }),
        getJournal: async () => [],
        scanProfiles: async () => [],
    };
    const ctx = await buildContext(store, null, null, false);
    assert.ok(!ctx.includes('thought 1"'));
    assert.ok(ctx.includes('drawing 1'));
    assert.ok(ctx.includes('you thought: "thought 2"'));
    assert.ok(ctx.includes('you thought: "thought 11"'));
});
