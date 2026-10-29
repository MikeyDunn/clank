// Tests for marketTools.ts — the pure shaping helpers (no Yahoo I/O).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downsample, pickSymbol, summarizeChart } from '../src/lib/marketTools.js';

test('pickSymbol: first real instrument, skipping futures', () => {
    const quotes = [
        { symbol: 'SNVDA=F', quoteType: 'FUTURE' },
        { symbol: 'NVDA', quoteType: 'EQUITY' },
    ];
    assert.equal(pickSymbol(quotes), 'NVDA');
});

test('pickSymbol: nothing usable → null', () => {
    assert.equal(pickSymbol([{ symbol: 'X=F', quoteType: 'FUTURE' }]), null);
    assert.equal(pickSymbol(undefined as any), null);
});

test('downsample: drops nulls, keeps first + last, caps length', () => {
    const vals = Array.from({ length: 100 }, (_, i) => (i === 50 ? null : 100 + i));
    const out = downsample(vals, 10);
    assert.equal(out.length, 10);
    assert.equal(out[0], 100);
    assert.equal(out[9], 199);
});

test('downsample: short series passes through, rounded by magnitude', () => {
    assert.deepEqual(downsample([214.0512, null, 0.123456789], 24), [214.05, 0.123457]);
});

test('summarizeChart: 1d change is vs the prior close', () => {
    const out = summarizeChart(
        {
            meta: { symbol: 'NVDA', longName: 'NVIDIA', regularMarketPrice: 210, chartPreviousClose: 200 },
            indicators: { quote: [{ close: [201, 205, 210] }] },
        },
        '1d'
    );
    assert.equal(out.changePct, 5);
    assert.deepEqual(out.series, [201, 205, 210]);
    assert.equal(out.name, 'NVIDIA');
});

test('summarizeChart: longer ranges measure from the first bar', () => {
    const out = summarizeChart(
        { meta: { symbol: 'BTC-USD', regularMarketPrice: 90 }, indicators: { quote: [{ close: [100, 95, 90] }] } },
        '1mo'
    );
    assert.equal(out.changePct, -10);
});
