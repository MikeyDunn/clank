// ─── Slack Block Kit builders (pure) ─────────────────────────────
// Build the message/preview block structures. No I/O — pure functions.

/** Strip mrkdwn emphasis (`**`, `*`, `_`) and collapse blank-line runs. */
function stripMrkdwn(text: string): string {
    return (text || '').replace(/\*\*/g, '').replace(/\*/g, '').replace(/_/g, '').replace(/\n\n+/g, '\n');
}

/**
 * Sanitize user text for a single mrkdwn *bold* run — the context-line "human's
 * words" convention consumed by t-shirt naming and Postie. A literal `*` would
 * terminate the run early and bold can't span newlines, so both go; whitespace
 * collapses to one spaced line; long text truncates at a word boundary with an
 * ellipsis (also keeps the context element under Slack's length cap). Broadcast
 * sequences (`<!here>`, `<!channel>`, `<!everyone>`, `<!subteam^…>`) are
 * downgraded to plain `@here`-style text so echoing a message never re-pings.
 * Returns null when nothing survives (callers omit the bold run entirely).
 */
function boldEcho(raw: string, max = 300): string | null {
    let t = (raw || '')
        .replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/gi, '@$1')
        .replace(/<!subteam\^[^>|]+\|@?([^>]*)>/g, '@$1')
        .replace(/<!subteam\^[^>|]+>/g, '@group')
        .replace(/\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!t) return null;
    if (t.length > max) {
        const cut = t.slice(0, max);
        const space = cut.lastIndexOf(' ');
        t = `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
    }
    return t;
}

function buildReferenceBlock(referenceImage) {
    if (!referenceImage?.permalink) return null;
    return {
        type: 'context',
        elements: [
            { type: 'mrkdwn', text: `📎 Reference: <${referenceImage.permalink}|${referenceImage.name || 'image'}>` },
        ],
    };
}

/**
 * Build the public message blocks (image + context line), posted directly.
 */
function buildPublicBlocks({
    imageUrl,
    prompt,
    userId,
    authorId,
    modelName,
    duration,
    cost,
    referenceImage,
    thoughts,
    fromWolf,
}) {
    const author = authorId || userId;
    // The bold run must be the line's ONLY one and can't contain `*`/newlines,
    // or the first-bold-run parse (tshirt.ts, Postie) captures garbage. The
    // raw prompt still rides in alt_text below. A null echo (prompt was all
    // asterisks/whitespace) omits the field — parsers fall back to alt_text.
    const bold = boldEcho(prompt);
    let contextText = `_Prompt: ${prompt}_`;
    if (author && modelName && duration && cost) {
        contextText = `<@${author}>${bold ? ` | *${bold}*` : ''} | ${modelName} | ${duration}s | ${cost}${fromWolf ? ' | ❤️ wolf' : ''}`;
    }

    const blocks: any[] = [];

    const refBlock = buildReferenceBlock(referenceImage);
    if (refBlock) blocks.push(refBlock);

    blocks.push({ type: 'image', image_url: imageUrl, alt_text: (thoughts || prompt).substring(0, 2000) });

    blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: contextText }],
    });

    return blocks;
}

/**
 * Build the public message blocks for a text-only response (posted directly).
 */
function buildTextPublicBlocks({ prompt, userId, thoughts, modelName, cost }) {
    const bold = boldEcho(prompt);
    const contextParts = [`<@${userId}>`];
    if (bold) contextParts.push(`*${bold}*`);
    contextParts.push(modelName);
    if (cost) contextParts.push(cost);

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: `> _${prompt}_` },
        },
        {
            type: 'section',
            text: { type: 'mrkdwn', text: thoughts },
        },
        {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: contextParts.join(' | ') }],
        },
    ];
}

export { boldEcho, buildPublicBlocks, buildTextPublicBlocks, stripMrkdwn };
