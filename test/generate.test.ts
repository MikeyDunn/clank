// Unit tests for the deadline-aware generation budget (lib/imageProcessor/generate.js).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { genTimeoutMs } from '../src/lib/imageProcessor/generate.js';

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
