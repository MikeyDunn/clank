// Tests for the two pure pieces of the image-context / channel-context feature:
//   1. resolveReferences — which images Clank forwards to the generator (the
//      omit→primary vs explicit-[]→none vs unknown-id vs cap logic). A silent
//      bug here sends the wrong image (or none) to the image model.
//   2. buildUserContent's channel "where" line — renders when present, omits
//      when empty, and never displaces the prompt.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveReferences } from '../src/lib/imageProcessor/pipeline.js';
import { buildUserContent, type ThinkImage } from '../src/lib/imageProcessor/think.js';

const primary: ThinkImage = { id: 'primary', base64: 'd:PRIMARY', role: 'primary' };
const ctx1: ThinkImage = { id: 'ctx1', base64: 'd:CTX1', role: 'context' };
const ctx2: ThinkImage = { id: 'ctx2', base64: 'd:CTX2', role: 'context' };

// ── resolveReferences ────────────────────────────────────────────

test('resolveReferences: field omitted → defaults to the primary image', () => {
    assert.deepEqual(resolveReferences([primary, ctx1], undefined), [primary.base64]);
});

test('resolveReferences: omitted with no primary shown → no reference', () => {
    assert.deepEqual(resolveReferences([ctx1, ctx2], undefined), []);
});

test('resolveReferences: explicit empty array → no reference (pure imagination)', () => {
    assert.deepEqual(resolveReferences([primary, ctx1], []), []);
});

test('resolveReferences: named ids map to their data, in the order named', () => {
    assert.deepEqual(resolveReferences([primary, ctx1, ctx2], ['ctx1', 'primary']), [ctx1.base64, primary.base64]);
});

test('resolveReferences: unknown ids are dropped', () => {
    assert.deepEqual(resolveReferences([primary, ctx1], ['nope', 'ctx1']), [ctx1.base64]);
});

test('resolveReferences: non-string entries are ignored', () => {
    assert.deepEqual(resolveReferences([primary], ['primary', 5, null]), [primary.base64]);
});

test('resolveReferences: forwarded images are capped at 3', () => {
    const many: ThinkImage[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, base64: `d:${id}`, role: 'context' as const }));
    assert.equal(resolveReferences(many, ['a', 'b', 'c', 'd']).length, 3);
});

// ── channel "where" line (via buildUserContent) ──────────────────

test('buildUserContent: no channel → prompt unchanged', () => {
    assert.equal(buildUserContent('draw a cat'), 'draw a cat');
});

test('buildUserContent: channel renders a where-line above the prompt', () => {
    const out = buildUserContent('draw a cat', null, null, null, {
        channel: '#dogspotting',
        topic: 'post your dogs',
        space: 'Photo Club',
    });
    assert.match(out, /#dogspotting/);
    assert.match(out, /post your dogs/);
    assert.match(out, /Photo Club/);
    assert.ok(out.endsWith('draw a cat'), 'prompt stays at the end');
});

test('buildUserContent: all-empty channel fields → nothing rendered', () => {
    assert.equal(buildUserContent('draw a cat', null, null, null, { channel: null, topic: null }), 'draw a cat');
});

test('buildUserContent: channel line coexists with the requester prefix', () => {
    const out = buildUserContent('draw me', null, 'mike', null, { channel: '#random' });
    assert.match(out, /#random/);
    assert.match(out, /from mike/);
    assert.ok(out.endsWith('draw me'));
});
