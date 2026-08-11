// Unit tests for the pure funding-line tiers (lib/funding.js).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFundingLine } from '../src/lib/funding.js';

test('buildFundingLine: null or healthy balance returns no line', () => {
    assert.equal(buildFundingLine(null), null);
    assert.equal(buildFundingLine(100), null);
    assert.equal(buildFundingLine(250), null);
});

test('buildFundingLine: $50–99 is the earliest (mild) tier', () => {
    const line = buildFundingLine(75) ?? '';
    assert.match(line, /not critical yet/);
    assert.match(line, /\$75\.00/);
});

test('buildFundingLine: $20–49 tier reads as worried', () => {
    assert.match(buildFundingLine(35) ?? '', /getting low/);
});

test('buildFundingLine: $5–19 tier reads as urgent', () => {
    assert.match(buildFundingLine(10) ?? '', /real now/);
});

test('buildFundingLine: under $5 is the terminal tier', () => {
    assert.match(buildFundingLine(3) ?? '', /last drawing/i);
});

test('buildFundingLine: formats the remaining amount to 2 decimals', () => {
    assert.match(buildFundingLine(42.5) ?? '', /\$42\.50/);
});
