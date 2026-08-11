// ─── Slack Block Kit builders (pure) ─────────────────────────────
// Build the message/preview block structures. No I/O — pure functions.

/** Strip mrkdwn emphasis (`**`, `*`, `_`) and collapse blank-line runs. */
function stripMrkdwn(text: string): string {
    return (text || '').replace(/\*\*/g, '').replace(/\*/g, '').replace(/_/g, '').replace(/\n\n+/g, '\n');
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
    let contextText = `_Prompt: ${prompt}_`;
    if (author && modelName && duration && cost) {
        contextText = `<@${author}> | *${prompt}* | ${modelName} | ${duration}s | ${cost}${fromWolf ? ' | ❤️ wolf' : ''}`;
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
    const contextParts = [`<@${userId}>`, `*${prompt}*`, modelName];
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

export { buildPublicBlocks, buildTextPublicBlocks, stripMrkdwn };
