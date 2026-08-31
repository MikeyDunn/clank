// Tests for consume.js — the shared delivery back-half. The high-stakes logic
// here is the CHARGE classification: a policy refusal costs a credit (we did
// the work; the prompt was the cause), a technical failure never does (that's
// ours to eat). Also under test: charge/reflect fire AFTER delivery, and a
// reflection failure never breaks a delivered response.
//
// The image-success branch is exercised only up to its upload call (S3 — not
// unit-testable); every other branch runs end-to-end with a mock mind+adapter.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeOutcome } from '../src/lib/imageProcessor/consume.js';

// A mock Mind that records every call in order, so ordering is assertable.
function mockMind(overrides: Record<string, any> = {}) {
    const calls: string[] = [];
    const mind: any = {
        remember: async (...args: any[]) => {
            calls.push('remember');
            mind.remembered.push(args);
            return 'hist-1';
        },
        charge: async () => {
            calls.push('charge');
        },
        maybeReflect: async () => {
            calls.push('reflect');
        },
        remembered: [] as any[][],
        calls,
        ...overrides,
    };
    return mind;
}

function mockAdapter() {
    const calls: string[] = [];
    const seen: any = {};
    return {
        calls,
        seen,
        adapter: {
            image: async (a: any) => {
                calls.push('image');
                seen.image = a;
            },
            text: async (a: any) => {
                calls.push('text');
                seen.text = a;
            },
            error: async (m: string) => {
                calls.push('error');
                seen.error = m;
            },
        },
    };
}

const baseCtx = (mind: any) => ({
    prompt: 'draw a thing',
    userId: 'U1',
    userInfo: { handle: 'someone' },
    requestStartTime: Date.now(),
    referenceUrl: null,
    mind,
});

const refusal = (errorType: string | undefined, textResponse = 'nope') => ({
    kind: 'refusal' as const,
    thinkResult: { thoughts: 'hmm' },
    result: { outcome: 'no_image', errorType, textResponse, message: 'no image' },
    imagePrompt: 'a thing',
    cost: 0.04,
});

// ── charge classification ────────────────────────────────────────

test('refusal: CONTENT_POLICY is charged and remembered as refused', async () => {
    const mind = mockMind();
    const { adapter, calls } = mockAdapter();
    await consumeOutcome(refusal('CONTENT_POLICY'), baseCtx(mind), adapter);
    assert.ok(mind.calls.includes('charge'), 'policy refusal must charge');
    assert.equal(mind.remembered[0][2], 'refused');
    assert.deepEqual(calls, ['error']); // generic error to the user, never Clank's voice
});

test('refusal: NO_IMAGE_GENERATED is NOT charged, remembered as error', async () => {
    const mind = mockMind();
    const { adapter } = mockAdapter();
    await consumeOutcome(refusal('NO_IMAGE_GENERATED'), baseCtx(mind), adapter);
    assert.ok(!mind.calls.includes('charge'), 'technical no-image must not charge');
    assert.equal(mind.remembered[0][2], 'error');
});

test('refusal: IMAGE_SAFETY (stochastic filter block) is NOT charged', async () => {
    const mind = mockMind();
    const { adapter } = mockAdapter();
    await consumeOutcome(refusal('IMAGE_SAFETY'), baseCtx(mind), adapter);
    assert.ok(!mind.calls.includes('charge'));
});

test('generation_error: 403/moderation classifies as CONTENT_POLICY and charges', async () => {
    const mind = mockMind();
    const { adapter } = mockAdapter();
    const pipe = {
        kind: 'generation_error' as const,
        thinkResult: { thoughts: 'trying' },
        genResult: { error: { response: { status: 403, data: { error: { message: 'flagged by moderation' } } } } },
        imagePrompt: 'a thing',
        cost: 0.04,
    };
    await consumeOutcome(pipe, baseCtx(mind), adapter);
    assert.ok(mind.calls.includes('charge'));
    assert.equal(mind.remembered[0][2], 'error');
});

test('generation_error: a timeout is NOT charged', async () => {
    const mind = mockMind();
    const { adapter, seen } = mockAdapter();
    const pipe = {
        kind: 'generation_error' as const,
        thinkResult: { thoughts: 'trying' },
        genResult: { error: { message: 'timeout of 120000ms exceeded' } },
        imagePrompt: 'a thing',
        cost: 0.04,
    };
    await consumeOutcome(pipe, baseCtx(mind), adapter);
    assert.ok(!mind.calls.includes('charge'), 'our outage must not spend a credit');
    assert.match(seen.error, /Timeout/i);
});

// ── ordering + resilience ────────────────────────────────────────

test('text: remembered, delivered, never charged; reflect runs after delivery', async () => {
    const mind = mockMind();
    const { adapter, seen } = mockAdapter();
    const order: string[] = [];
    mind.charge = async () => order.push('charge');
    const origReflect = mind.maybeReflect;
    adapter.text = async (a: any) => {
        order.push('deliver');
        seen.text = a;
    };
    mind.maybeReflect = async () => {
        order.push('reflect');
        return origReflect();
    };
    const pipe = {
        kind: 'text' as const,
        thinkResult: { thoughts: 'a thought', response: 'words for the channel' },
        cost: 0.02,
    };
    await consumeOutcome(pipe, baseCtx(mind), adapter);
    assert.deepEqual(order, ['deliver', 'reflect']); // no charge, reflect strictly after delivery
    assert.equal(seen.text.text, 'words for the channel');
    assert.equal(mind.remembered[0][2], 'text_only');
});

test('charge and reflect fire AFTER the error delivery on a charged refusal', async () => {
    const mind = mockMind();
    const { adapter } = mockAdapter();
    const order: string[] = [];
    adapter.error = async () => {
        order.push('deliver');
    };
    mind.charge = async () => order.push('charge');
    mind.maybeReflect = async () => order.push('reflect');
    await consumeOutcome(refusal('CONTENT_POLICY'), baseCtx(mind), adapter);
    assert.deepEqual(order, ['deliver', 'charge', 'reflect']);
});

test('a reflection failure is swallowed — the delivered response still resolves', async () => {
    const mind = mockMind({
        maybeReflect: async () => {
            throw new Error('reflection exploded');
        },
    });
    const { adapter, calls } = mockAdapter();
    await consumeOutcome(refusal('NO_IMAGE_GENERATED'), baseCtx(mind), adapter);
    assert.deepEqual(calls, ['error']); // delivery happened; no throw escaped
});

test('think_error: generic error only — nothing remembered, nothing charged', async () => {
    const mind = mockMind();
    const { adapter, calls } = mockAdapter();
    await consumeOutcome({ kind: 'think_error' as const, thinkResult: {}, cost: 0 }, baseCtx(mind), adapter);
    assert.deepEqual(calls, ['error']);
    assert.deepEqual(mind.calls, []);
});
