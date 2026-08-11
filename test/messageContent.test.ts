// Tests for messageContent.js — the pure Slack-message readers shared by the
// "Ask Clank" shortcut and the 🤖-reaction trigger. No I/O: we hand in raw
// message shapes Slack would send and assert on the extraction.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeConversation, describeMessage, extractImage } from '../src/lib/platform/slack/flows/messageContent.js';

// ── extractImage ─────────────────────────────────────────────────

test('extractImage: prefers an uploaded image file (private)', () => {
    const img = extractImage({
        files: [
            { mimetype: 'application/pdf', name: 'doc.pdf' },
            { mimetype: 'image/png', name: 'pic.png', url_private_download: 'https://x/dl', permalink: 'https://x/p' },
        ],
    });
    assert.equal(img?.name, 'pic.png');
    assert.equal(img?.url, 'https://x/dl');
    assert.equal(img?.isPublic, false);
});

test('extractImage: falls back to an unfurled attachment image (public)', () => {
    const img = extractImage({ attachments: [{ image_url: 'https://x/i.jpg', title: 'A thing' }] });
    assert.equal(img?.url, 'https://x/i.jpg');
    assert.equal(img?.isPublic, true);
});

test('extractImage: reads a Block Kit image block', () => {
    const img = extractImage({ blocks: [{ type: 'image', image_url: 'https://x/b.png', alt_text: 'alt' }] });
    assert.equal(img?.url, 'https://x/b.png');
    assert.equal(img?.isPublic, true);
});

test('extractImage: null when there is no image', () => {
    assert.equal(extractImage({ text: 'just words' }), null);
    assert.equal(extractImage({}), null);
});

// ── describeMessage ──────────────────────────────────────────────

test('describeMessage: plain text passes through', () => {
    assert.equal(describeMessage({ text: 'ship it 🚀' }), 'ship it 🚀');
});

test("describeMessage: folds an unfurled link's CONTENT, not just the URL", () => {
    const out = describeMessage({
        text: 'look at this',
        attachments: [{ title: 'Cool Article', text: 'a summary', title_link: 'https://ex.com/a' }],
    });
    assert.match(out, /look at this/);
    assert.match(out, /Shared link: Cool Article — a summary \(https:\/\/ex\.com\/a\)/);
});

test('describeMessage: notes a non-image attached file but not image files', () => {
    const out = describeMessage(
        {
            text: 'here',
            files: [
                { mimetype: 'application/pdf', name: 'spec.pdf', filetype: 'pdf' },
                { mimetype: 'image/png', name: 'shot.png' },
            ],
        },
        true
    );
    assert.match(out, /Attached file: spec\.pdf \(pdf\)/);
    assert.doesNotMatch(out, /shot\.png/); // the image is the reference, not text
});

test('describeMessage: reconstructs text from rich_text blocks when top-level text is empty', () => {
    const out = describeMessage({
        text: '',
        blocks: [
            {
                type: 'rich_text',
                elements: [
                    {
                        type: 'rich_text_section',
                        elements: [
                            { type: 'text', text: 'see ' },
                            { type: 'link', url: 'https://ex.com', text: 'this' },
                            { type: 'text', text: ' now' },
                        ],
                    },
                ],
            },
        ],
    });
    assert.match(out, /see this \(https:\/\/ex\.com\) now/);
});

test('describeMessage: image-only message gets a caption placeholder', () => {
    assert.equal(describeMessage({ text: '' }, true), '[An image, with no caption.]');
});

test('describeMessage: truly empty message yields empty string', () => {
    assert.equal(describeMessage({ text: '' }, false), '');
    assert.equal(describeMessage({}), '');
});

test('describeMessage: caps runaway walls of text at 2000 chars', () => {
    const out = describeMessage({ text: 'x'.repeat(5000) });
    assert.equal(out.length, 2000);
});

// ── describeConversation ─────────────────────────────────────────

const convo = [
    { ts: '1', user: 'U1', text: 'is the lobster thing real' },
    { ts: '2', user: 'U2', text: 'obviously' },
    { ts: '3', user: 'U1', text: "then I won't devour that lobstussy???" }, // the reacted one
    { ts: '4', user: 'U2', text: 'do it' },
];

test('describeConversation: marks the reacted message and keeps neighbours as context', () => {
    const out = describeConversation(convo, '3');
    assert.match(out, /⟵ THE REACTED MESSAGE/);
    // the marker sits on the reacted line, not the neighbours
    const target = out.split('\n').find((l) => l.includes('lobstussy')) ?? '';
    assert.match(target, /^→ <@U1>:.*⟵ THE REACTED MESSAGE/);
    assert.match(out, /<@U2>: obviously/);
    assert.match(out, /<@U2>: do it/);
});

test('describeConversation: preserves <@UID> author labels for later resolveMentions', () => {
    const out = describeConversation(convo, '3');
    assert.match(out, /<@U1>:/);
    assert.match(out, /<@U2>:/);
});

test('describeConversation: drops bot/Clank neighbours but never the target', () => {
    const withBot = [
        { ts: '1', user: 'UCLANK', text: 'i made this' }, // Clank → dropped
        { ts: '2', bot_id: 'B1', text: 'github: build passed' }, // bot → dropped
        { ts: '3', user: 'U9', text: 'real human premise' }, // kept
        { ts: '4', user: 'U2', text: 'the reacted message' }, // target
    ];
    const out = describeConversation(withBot, '4', 'UCLANK');
    assert.doesNotMatch(out, /i made this/); // Clank's own neighbour dropped
    assert.doesNotMatch(out, /build passed/); // bot neighbour dropped
    assert.match(out, /real human premise/); // genuine context kept
    assert.match(out, /the reacted message/);
});

test('describeConversation: returns empty when only the target is present (fall back to single-message)', () => {
    assert.equal(describeConversation([{ ts: '3', user: 'U1', text: 'lonely' }], '3'), '');
    assert.equal(describeConversation([], '3'), '');
});

test('describeConversation: image-only neighbours are dropped as noise', () => {
    const msgs = [
        { ts: '1', user: 'U1', files: [{ mimetype: 'image/png', name: 'x.png' }] }, // no caption
        { ts: '2', user: 'U2', text: 'the reacted message' },
    ];
    const out = describeConversation(msgs, '2');
    // only the target survived → not "more than the target" → empty
    assert.equal(out, '');
});
