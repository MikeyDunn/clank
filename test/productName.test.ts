// Unit tests for the pure product-name helpers (lib/imageProcessor/productName.js).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    cleanModelName,
    deriveProductName,
    isValidProductName,
    pickProductName,
} from '../src/lib/platform/slack/flows/productName.js';

test('deriveProductName: strips stop-words and Title-Cases', () => {
    assert.equal(deriveProductName('draw a robot in space'), 'Robot Space');
});

test('deriveProductName: caps at 4 words', () => {
    assert.equal(deriveProductName('cosmic neon disco dragon battle royale'), 'Cosmic Neon Disco Dragon');
});

test('deriveProductName: empty / all-stopwords falls back to Clank Original', () => {
    assert.equal(deriveProductName(''), 'Clank Original');
    assert.equal(deriveProductName('the a an of'), 'Clank Original');
});

test('cleanModelName: strips surrounding quotes and markdown', () => {
    assert.equal(cleanModelName('"Cosmic Robot"'), 'Cosmic Robot');
    assert.equal(cleanModelName('**Space Cow**'), 'Space Cow');
});

test('cleanModelName: strips a leading label', () => {
    assert.equal(cleanModelName('Title: Space Cow'), 'Space Cow');
});

test('cleanModelName: drops trailing commentary after a spaced delimiter', () => {
    assert.equal(cleanModelName('Rad Shirt — here you go'), 'Rad Shirt');
    assert.equal(cleanModelName('Cosmic Cat - my best work'), 'Cosmic Cat');
    assert.equal(cleanModelName('Space Dog : a description'), 'Space Dog');
});

test('isValidProductName: accepts sane titles', () => {
    assert.equal(isValidProductName('Cosmic Robot'), true);
});

test('isValidProductName: rejects empty, too-short, too-many-words', () => {
    assert.equal(isValidProductName(''), false);
    assert.equal(isValidProductName('ab'), false);
    assert.equal(isValidProductName('one two three four five six seven eight'), false);
});

test('isValidProductName: rejects titles that end mid-phrase (truncated)', () => {
    assert.equal(isValidProductName('Cool Shirt for'), false);
    assert.equal(isValidProductName('Big Dragon and'), false);
});

test('pickProductName: uses a valid model name', () => {
    assert.equal(pickProductName('"Galaxy Cat"', 'draw a cat'), 'Galaxy Cat');
});

test('pickProductName: falls back to the prompt when the model name is unusable', () => {
    assert.equal(pickProductName('', 'draw a space cat'), 'Space Cat');
    assert.equal(pickProductName('Cool Shirt for', 'draw a dog'), 'Dog');
});
