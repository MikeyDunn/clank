// Tests for blocks.js — the pure Block Kit builders, with a focus on the
// context-line *bold* run: the cross-app "human's words" convention consumed
// by t-shirt naming and Postie. The invariant under test: whatever a user
// types, the line carries at most ONE bold run, containing no `*`/newlines,
// and never a live broadcast ping.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boldEcho, buildPublicBlocks, buildTextPublicBlocks } from '../src/lib/platform/slack/blocks.js';

// ── boldEcho ─────────────────────────────────────────────────────

test('boldEcho: passes clean text through', () => {
    assert.equal(boldEcho('draw me as a lobster'), 'draw me as a lobster');
});

test('boldEcho: strips * and collapses newlines (bold cannot span them)', () => {
    assert.equal(boldEcho('this is *very*\nimportant\n\nstuff'), 'this is very important stuff');
});

test('boldEcho: neutralizes broadcast pings to plain text', () => {
    assert.equal(boldEcho('hey <!here> look'), 'hey @here look');
    assert.equal(boldEcho('<!channel> meeting now'), '@channel meeting now');
    assert.equal(boldEcho('<!everyone|@everyone> hi'), '@everyone hi');
    assert.equal(boldEcho('ping <!subteam^S012AB3CD|@devs> please'), 'ping @devs please');
    assert.equal(boldEcho('ping <!subteam^S012AB3CD> please'), 'ping @group please');
});

test('boldEcho: leaves user mentions and links intact', () => {
    assert.equal(boldEcho('draw <@U123> at <https://ex.com|the beach>'), 'draw <@U123> at <https://ex.com|the beach>');
});

test('boldEcho: truncates at a word boundary with an ellipsis', () => {
    const out = boldEcho(`${'word '.repeat(80)}end`, 300);
    assert.ok(out && out.length <= 301); // ≤300 + the ellipsis
    assert.match(out ?? '', /…$/);
    assert.doesNotMatch(out ?? '', / …$/); // no dangling space before the ellipsis
});

test('boldEcho: hard-cuts a single unbroken token', () => {
    const out = boldEcho('x'.repeat(400), 300);
    assert.equal(out, `${'x'.repeat(300)}…`);
});

test('boldEcho: null when nothing survives (empty, whitespace, bare asterisks)', () => {
    assert.equal(boldEcho(''), null);
    assert.equal(boldEcho('   \n  '), null);
    assert.equal(boldEcho('***'), null);
});

// ── context-line invariant in the builders ───────────────────────

const args = {
    imageUrl: 'https://x/i.png',
    userId: 'U1',
    authorId: 'U1',
    modelName: 'TestModel',
    duration: 5,
    cost: '~$0.09',
    referenceImage: null,
    thoughts: 'my thoughts',
    fromWolf: false,
};
const contextOf = (blocks: any[]) => blocks.find((b) => b.type === 'context')?.elements?.[0]?.text ?? '';
const firstBold = (line: string) => line.match(/\*([^*]+)\*/)?.[1];

test('buildPublicBlocks: a prompt with asterisks still yields one clean bold run', () => {
    const line = contextOf(buildPublicBlocks({ ...args, prompt: 'draw *sparkles* everywhere' }));
    assert.equal(firstBold(line), 'draw sparkles everywhere');
    assert.equal(line.split('*').length - 1, 2); // exactly one bold run on the line
});

test('buildPublicBlocks: a multiline prompt (Ask Clank modal) collapses into the run', () => {
    const line = contextOf(buildPublicBlocks({ ...args, prompt: 'line one\nline two' }));
    assert.equal(firstBold(line), 'line one line two');
});

test('buildPublicBlocks: alt_text keeps the RAW prompt when there are no thoughts', () => {
    const blocks = buildPublicBlocks({ ...args, prompt: 'keep *this* raw', thoughts: null });
    const img = blocks.find((b) => b.type === 'image');
    assert.equal(img.alt_text, 'keep *this* raw');
});

test('buildPublicBlocks: degenerate prompt omits the bold field (parsers fall back to alt_text)', () => {
    const line = contextOf(buildPublicBlocks({ ...args, prompt: '***' }));
    assert.equal(firstBold(line), undefined);
    assert.match(line, /^<@U1> \| TestModel \| 5s \| ~\$0\.09$/);
});

test('buildPublicBlocks: summoner-first attribution — the author mention leads the line', () => {
    const line = contextOf(buildPublicBlocks({ ...args, prompt: 'draw <@U9>' }));
    assert.match(line, /^<@U1>/);
});

test('buildTextPublicBlocks: sanitized bold run in context, raw prompt in the quote section', () => {
    const blocks = buildTextPublicBlocks({
        prompt: 'why *are* you',
        userId: 'U1',
        thoughts: 'because',
        modelName: 'TestModel',
        cost: '~$0.02',
    });
    assert.equal(firstBold(contextOf(blocks)), 'why are you');
    const quote = blocks.find((b) => b.type === 'section');
    assert.equal(quote?.text?.text, '> _why *are* you_'); // section content untouched
});
