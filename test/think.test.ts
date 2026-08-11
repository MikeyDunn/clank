// Tests for think.js. Two layers:
//   1. buildUserContent — a pure helper, tested directly.
//   2. think() control flow — the model HTTP call is mocked so we assert the
//      tool-loop's behavior (submit / nudge / bad-args / error) deterministically
//      and for free. These paths don't trigger lore tools, so no other I/O runs.

import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { buildUserContent, think } from '../src/lib/imageProcessor/think.js';

// ── buildUserContent (pure) ──────────────────────────────────────

test('buildUserContent: a bare prompt is unchanged', () => {
    assert.equal(buildUserContent('draw a cat'), 'draw a cat');
});

test('buildUserContent: prefixes the requester so "me" resolves', () => {
    const out = buildUserContent('draw me', null, 'mike');
    assert.match(out, /This request is from mike/);
    assert.match(out, /draw me$/);
});

test('buildUserContent: includes the source message + author', () => {
    const out = buildUserContent('make it better', { text: 'original post', author: 'ted' }, null);
    assert.match(out, /Original message from @ted: "original post"/);
    assert.match(out, /make it better$/);
});

test('buildUserContent: anonymous author when missing', () => {
    assert.match(buildUserContent('x', { text: 'hi' }, null), /from someone:/);
});

test('buildUserContent: context and requester compose together', () => {
    const out = buildUserContent('p', { text: 'msg', author: 'a' }, 'mike');
    assert.match(out, /This request is from mike/);
    assert.match(out, /Original message from @a/);
});

// ── buildUserContent: 🤖-reaction summon framing ─────────────────

test('buildUserContent: other-summon names summoner + author, pins first-person to author', () => {
    const out = buildUserContent('I could bench 315', null, null, {
        author: 'patrick',
        summoner: 'ted',
        self: false,
    });
    assert.match(out, /@ted reacted with 🤖 to summon you onto @patrick's message/);
    // Critical: "I/me/my" in the message must resolve to the AUTHOR, not the summoner.
    assert.match(out, /"I"\/"me"\/"my" in the message below is @patrick talking, NOT @ted/);
    assert.match(out, /I could bench 315$/);
});

test('buildUserContent: self-summon (author === summoner) reads as run-with-it', () => {
    const out = buildUserContent('behold my cursed lunch', null, null, {
        author: 'mike',
        summoner: 'mike',
        self: true,
    });
    assert.match(out, /@mike reacted to their OWN message/);
    assert.match(out, /behold my cursed lunch$/);
});

test('buildUserContent: summon falls back to "someone" when handles unknown', () => {
    const out = buildUserContent('x', null, null, { author: null, summoner: null, self: false });
    assert.match(out, /someone reacted with 🤖 to summon you onto someone's message/);
});

test('buildUserContent: summon overrides messageContext/requester framing', () => {
    const out = buildUserContent('x', { text: 'ignored', author: 'z' }, 'req', {
        author: 'a',
        summoner: 's',
        self: false,
    });
    assert.doesNotMatch(out, /This request is from req/);
    assert.doesNotMatch(out, /Original message from/);
    assert.match(out, /summon you onto @a's message/);
});

test('buildUserContent: summon with conversation embeds the transcript as context-only', () => {
    const transcript =
        '<@a>: premise\n→ <@a>: the reacted message   ⟵ THE REACTED MESSAGE (respond to THIS)\n<@b>: reply';
    const out = buildUserContent('the reacted message', null, null, {
        author: 'a',
        summoner: 's',
        self: false,
        conversation: transcript,
    });
    // anti-dilution: explicit instruction to answer the marked message, not the whole convo
    assert.match(out, /do NOT respond to the whole conversation/i);
    assert.match(out, /RECENT CONVERSATION/);
    assert.match(out, /⟵ THE REACTED MESSAGE/);
    // first-person still pinned to the author, not the summoner
    assert.match(out, /is @a talking, NOT @s/);
});

test('buildUserContent: summon WITHOUT conversation keeps the simple single-message framing', () => {
    const out = buildUserContent('hi', null, null, { author: 'a', summoner: 's', self: false });
    assert.doesNotMatch(out, /RECENT CONVERSATION/);
    assert.match(out, /summon you onto @a's message/);
    assert.match(out, /hi$/);
});

// ── think() control flow (model HTTP mocked) ─────────────────────

/** Queue scripted model responses for successive fetch calls (Error → throw). */
function mockResponses(...responses) {
    let i = 0;
    mock.method(globalThis, 'fetch', async () => {
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        if (r instanceof Error) throw r;
        // openrouter.ts does `await res.json()` and checks `res.ok`.
        return { ok: true, status: 200, json: async () => r };
    });
}

const chat = (message, cost = 0.01) => ({ choices: [{ message }], usage: { cost } });
const submit = (args) => ({
    tool_calls: [
        {
            id: 'c1',
            function: { name: 'submitResponse', arguments: typeof args === 'string' ? args : JSON.stringify(args) },
        },
    ],
});

afterEach(() => mock.restoreAll());

test('think: a submitResponse image call returns a structured image result', async () => {
    mockResponses(chat(submit({ type: 'image', thoughts: 'regal', imagePrompt: 'a regal cat' })));
    const r = await think('draw a cat', 'CONTEXT');
    assert.equal(r.type, 'image');
    assert.equal(r.imagePrompt, 'a regal cat');
    assert.equal(r.thoughts, 'regal');
    assert.ok(r.cost > 0);
    assert.equal(r.error, undefined);
});

test('think: a submitResponse text call returns a text result', async () => {
    mockResponses(chat(submit({ type: 'text', thoughts: 't', response: 'cryptic' })));
    const r = await think('how do you work', 'CONTEXT');
    assert.equal(r.type, 'text');
    assert.equal(r.response, 'cryptic');
});

test('think: unparseable submitResponse args returns a NO_ANSWER error', async () => {
    mockResponses(chat(submit('{ not valid json')));
    const r = await think('x', 'CONTEXT');
    assert.equal(r.error?.type, 'NO_ANSWER');
});

test('think: a prose reply is nudged, then the retry submits', async () => {
    mockResponses(
        chat({ content: 'thinking out loud, no tool call' }), // no tool_calls → nudge
        chat(submit({ type: 'image', thoughts: 'ok', imagePrompt: 'a dog' }))
    );
    const r = await think('draw a dog', 'CONTEXT');
    assert.equal(r.type, 'image');
    assert.equal(r.imagePrompt, 'a dog');
    assert.ok(r.cost >= 0.02 - 1e-9); // cost accrued across both turns
});

test('think: a transport error is caught and returned, not thrown', async () => {
    mockResponses(new Error('network boom'));
    const r = await think('x', 'CONTEXT');
    assert.ok(r.error);
    assert.equal(r.type, 'text');
});
