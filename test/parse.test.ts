// Unit tests for the pure response-classification helpers (lib/imageProcessor/parse.js).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    classifyError,
    getUserFriendlyError,
    isContentPolicyRefusal,
    parseResponse,
} from '../src/lib/imageProcessor/parse.js';

const imageBody = (extra = {}) => ({
    choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,AAAA' } }] } }],
    usage: { cost: 0 },
    ...extra,
});

test('classifyError: maps status codes to error types', () => {
    assert.equal(classifyError(401, ''), 'AUTH_ERROR');
    assert.equal(classifyError(402, ''), 'INSUFFICIENT_CREDITS');
    assert.equal(classifyError(429, ''), 'RATE_LIMIT');
    assert.equal(classifyError(400, ''), 'INVALID_REQUEST');
    assert.equal(classifyError(500, ''), 'UPSTREAM_ERROR');
    assert.equal(classifyError(404, ''), 'MODEL_NOT_FOUND');
});

test('classifyError: maps message text when status is absent', () => {
    assert.equal(classifyError(null, 'the request timed out'), 'TIMEOUT');
    assert.equal(classifyError(null, 'socket hang up'), 'CONNECTION_ERROR');
    assert.equal(classifyError(null, 'rate limit reached'), 'RATE_LIMIT');
});

test('classifyError: unknown input falls back to UNKNOWN_ERROR', () => {
    assert.equal(classifyError(200, 'all good'), 'UNKNOWN_ERROR');
    assert.equal(classifyError(undefined, ''), 'UNKNOWN_ERROR');
});

test('isContentPolicyRefusal: detects refusal phrasing', () => {
    assert.equal(isContentPolicyRefusal("I can't create that image"), true);
    assert.equal(isContentPolicyRefusal('Sorry, that violates content policy'), true);
});

test('isContentPolicyRefusal: ordinary text is not a refusal', () => {
    assert.equal(isContentPolicyRefusal('Here is your cosmic dragon'), false);
});

// This predicate decides whether a user is CHARGED for a failed render, so a
// false positive takes someone's credit for an outage that was our fault.
test('isContentPolicyRefusal: a plain apology is NOT a refusal', () => {
    assert.equal(isContentPolicyRefusal('Sorry, something went wrong. Please try again.'), false);
    assert.equal(isContentPolicyRefusal("Sorry, I'm having trouble right now"), false);
    assert.equal(isContentPolicyRefusal('Sorry for the delay'), false);
});

test('isContentPolicyRefusal: technical failures are NOT refusals', () => {
    assert.equal(isContentPolicyRefusal('The upstream service is unavailable'), false);
    assert.equal(isContentPolicyRefusal('Request timed out'), false);
    assert.equal(isContentPolicyRefusal('No response content'), false);
});

test('isContentPolicyRefusal: real refusals still match', () => {
    assert.equal(isContentPolicyRefusal("I can't create that image"), true);
    assert.equal(isContentPolicyRefusal('I cannot generate this content'), true);
    assert.equal(isContentPolicyRefusal("I won't depict a real person that way"), true);
    assert.equal(isContentPolicyRefusal('That request violates our usage policies'), true);
    assert.equal(isContentPolicyRefusal('This goes against my guidelines'), true);
    assert.equal(isContentPolicyRefusal('Unable to generate that image'), true);
});

test('isContentPolicyRefusal: non-string input is safe', () => {
    assert.equal(isContentPolicyRefusal(undefined), false);
    assert.equal(isContentPolicyRefusal(null), false);
    assert.equal(isContentPolicyRefusal({ text: 'nope' }), false);
});

test('getUserFriendlyError: returns the mapped message for a known type', () => {
    assert.match(getUserFriendlyError('RATE_LIMIT'), /Rate Limit/);
});

test('getUserFriendlyError: appends the model text on a content refusal', () => {
    const msg = getUserFriendlyError('CONTENT_POLICY', null, 'I refuse because reasons');
    assert.match(msg, /Model says: I refuse because reasons/);
});

test('getUserFriendlyError: unknown type falls back gracefully', () => {
    assert.match(getUserFriendlyError('SOMETHING_NEW'), /Something Went Wrong/);
});

test('parseResponse: a Wolf (vLLM) image is $0, tagged backend=wolf with the real model name', () => {
    const r = parseResponse(imageBody({ _backend: 'wolf', _modelLabel: 'FLUX.2-klein-9B' }), Date.now());
    assert.equal(r.outcome, 'success');
    assert.equal(r.cost, 0); // self-hosted — image step is free, only think costs
    assert.equal(r.backend, 'wolf');
    assert.equal(r.modelName, 'FLUX.2-klein-9B');
});

test('parseResponse: an OpenRouter image carries no backend tag or model name', () => {
    const r = parseResponse(imageBody({ usage: { cost: 0.14 } }), Date.now());
    assert.equal(r.outcome, 'success');
    assert.equal(r.cost, 0.14);
    assert.equal(r.backend, null);
    assert.equal(r.modelName, null);
});

// ── image-model safety block detection (finish_reason) ──
const noImage = (choice) => ({ choices: [{ message: { content: null }, ...choice }] });

test('parseResponse: finish_reason content_filter → IMAGE_SAFETY', () => {
    const r = parseResponse(noImage({ finish_reason: 'content_filter' }), Date.now());
    assert.equal(r.outcome, 'no_image');
    assert.equal(r.errorType, 'IMAGE_SAFETY');
});

test('parseResponse: native IMAGE_PROHIBITED_CONTENT → IMAGE_SAFETY', () => {
    const r = parseResponse(noImage({ native_finish_reason: 'IMAGE_PROHIBITED_CONTENT' }), Date.now());
    assert.equal(r.errorType, 'IMAGE_SAFETY');
});

test('parseResponse: empty STOP with no image → NO_IMAGE_GENERATED, not a safety block', () => {
    const r = parseResponse(noImage({ finish_reason: 'stop', native_finish_reason: 'STOP' }), Date.now());
    assert.equal(r.outcome, 'no_image');
    assert.equal(r.errorType, 'NO_IMAGE_GENERATED');
});

test('getUserFriendlyError: IMAGE_SAFETY has its own message', () => {
    assert.match(getUserFriendlyError('IMAGE_SAFETY'), /filter blocked/i);
});
