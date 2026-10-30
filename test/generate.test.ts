// Unit tests for the deadline-aware generation budget (lib/imageProcessor/generate.js).

import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { generateViaXai, genTimeoutMs } from '../src/lib/imageProcessor/generate.js';
import { parseResponse } from '../src/lib/imageProcessor/parse.js';

const NOW = 1_700_000_000_000;
const SEC = 1000;

test('genTimeoutMs: no deadline → legacy 280s cap', () => {
    assert.equal(genTimeoutMs(null, NOW), 280_000);
});

test('genTimeoutMs: plenty of budget → capped at 280s', () => {
    // 400s remaining − 20s reserve = 380s, clamped to the 280s max.
    assert.equal(genTimeoutMs(NOW + 400 * SEC, NOW), 280_000);
});

test('genTimeoutMs: the 2026-08-06 timeout scenario — slow think shrinks the budget', () => {
    // Think took 43s of a 300s Lambda → 257s remain. Budget = 257 − 20 = 237s,
    // which FITS inside the Lambda; the old fixed 280s could never fire.
    const budget = genTimeoutMs(NOW + 257 * SEC, NOW);
    assert.equal(budget, 237_000);
    assert.ok(budget + 20_000 <= 257_000, 'attempt + reserve must fit in remaining time');
});

test('genTimeoutMs: nearly out of budget → floors at 10s (handled error, not a dead Lambda)', () => {
    assert.equal(genTimeoutMs(NOW + 15 * SEC, NOW), 10_000);
    assert.equal(genTimeoutMs(NOW - 5 * SEC, NOW), 10_000); // even past-deadline never goes negative
});

// ── Grok Imagine fallback: xAI responses shaped for parseResponse ──

afterEach(() => mock.restoreAll());

function xaiReply(status: number, body: any) {
    let seen: any = null;
    mock.method(globalThis, 'fetch', async (url: string, init: any) => {
        seen = { url, body: JSON.parse(init.body) };
        return new Response(JSON.stringify(body), { status });
    });
    return () => seen;
}

test('generateViaXai: an image parses as success, priced from ticks', async () => {
    const seen = xaiReply(200, { data: [{ b64_json: 'QUJD' }], usage: { cost_in_usd_ticks: 200000000 } });
    const r = parseResponse(await generateViaXai('a cat', [], 5000), Date.now());
    assert.equal(r.outcome, 'success');
    assert.equal(r.cost, 0.02);
    assert.equal(r.modelName, 'grok-imagine-image');
    assert.match(seen().url, /images\/generations$/);
});

test('generateViaXai: a moderation rejection parses as IMAGE_SAFETY (still billed)', async () => {
    xaiReply(400, {
        error: 'Generated image rejected by content moderation.',
        usage: { cost_in_usd_ticks: 200000000 },
    });
    const r = parseResponse(await generateViaXai('x', [], 5000), Date.now());
    assert.equal(r.outcome, 'no_image');
    assert.equal(r.errorType, 'IMAGE_SAFETY');
    assert.equal(r.cost, 0.02);
});

test('generateViaXai: a reference image goes to the edits endpoint (first ref only)', async () => {
    const seen = xaiReply(200, { data: [{ b64_json: 'QUJD' }] });
    await generateViaXai(
        'add hats',
        [{ url: 'data:image/png;base64,AAA' }, { url: 'data:image/png;base64,BBB' }],
        5000
    );
    assert.match(seen().url, /images\/edits$/);
    assert.equal(seen().body.image.url, 'data:image/png;base64,AAA');
});

test('generateViaXai: other errors throw', async () => {
    xaiReply(500, { error: 'boom' });
    await assert.rejects(generateViaXai('x', [], 5000), /xAI 500/);
});
