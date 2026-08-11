// ─── Interaction handler ─────────────────────────────────────────
// Handles the "Ask Clank" / "Make T-Shirt" message shortcuts and the Ask Clank
// modal submission. (No Send/Cancel buttons — results post straight to channel.)

import { invokeAsync } from '../../lib/lambda.js';
import { extractImage } from '../../lib/platform/slack/flows/messageContent.js';
import {
    ensureBotInChannel,
    openModal,
    postEphemeral,
    postMessage,
    verifyRequest,
} from '../../lib/platform/slack/index.js';

/** Invoke the image processor Lambda asynchronously. */
async function invokeImageProcessor(payload) {
    await invokeAsync(process.env.IMAGE_PROCESSOR_FUNCTION_NAME, payload);
    console.log('Image processor invoked, ref:', !!payload.referenceImage);
}

// extractImage lives in lib/imageProcessor/messageContent.ts — shared with the
// 🤖-reaction trigger so there's one definition of "pull an image out of a
// Slack message."

// ─── Payload type handlers ───────────────────────────────────────

/**
 * Handle "Ask Clank" message shortcut — open a modal for the prompt
 */
async function handleMessageAction(payload) {
    const image = extractImage(payload.message);
    if (!image) {
        // No image on this message — can't use as reference
        await openModal(payload.trigger_id, {
            type: 'modal',
            title: { type: 'plain_text', text: 'Ask Clank' },
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: 'No image found on that message. Use this shortcut on a message with an image.',
                    },
                },
            ],
        });
        return;
    }

    const channelId = payload.channel?.id;
    const threadTs = payload.message.thread_ts || payload.message.ts;
    const messageTs = payload.message.ts;
    const userId = payload.user.id;

    // Ensure Clank is in the channel before proceeding
    const channelCheck = await ensureBotInChannel(channelId);
    if (!channelCheck.ok) {
        await openModal(payload.trigger_id, {
            type: 'modal',
            title: { type: 'plain_text', text: 'Ask Clank' },
            blocks: [
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: 'Invite @Clank to this channel first, then try again.' },
                },
            ],
        });
        return;
    }

    // Build Slack deep link to the source message
    const teamDomain = payload.team?.domain || 'thedallasdevs';
    const messageLink = `https://${teamDomain}.slack.com/archives/${channelId}/p${messageTs.replace('.', '')}`;
    image.permalink = messageLink;

    // Capture original message text and author for context
    const messageText = payload.message.text || '';
    const messageAuthor = payload.message.username || payload.message.user || null;

    const metadata = JSON.stringify({
        referenceImage: image,
        messageText: messageText.substring(0, 500),
        messageAuthor,
        channelId,
        threadTs,
        userId,
        userName: payload.user?.username || null,
        displayName: payload.user?.name || null,
    });

    await openModal(payload.trigger_id, {
        type: 'modal',
        callback_id: 'ask_clank_submit',
        title: { type: 'plain_text', text: 'Ask Clank' },
        submit: { type: 'plain_text', text: 'Generate' },
        private_metadata: metadata,
        blocks: [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: `📎 Reference: <${image.permalink}|${image.name}>` },
            },
            {
                type: 'input',
                block_id: 'prompt_block',
                element: {
                    type: 'plain_text_input',
                    action_id: 'prompt_input',
                    multiline: true,
                    placeholder: { type: 'plain_text', text: 'What should Clank do with this image?' },
                },
                label: { type: 'plain_text', text: 'Prompt' },
            },
        ],
    });
}

/**
 * Handle "Make T-Shirt" message shortcut — extract image, invoke tshirt mode
 */
async function handleTshirtAction(payload) {
    const image = extractImage(payload.message);
    if (!image) {
        await openModal(payload.trigger_id, {
            type: 'modal',
            title: { type: 'plain_text', text: 'Make T-Shirt' },
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: 'No image found on that message. Use this shortcut on a message with an image.',
                    },
                },
            ],
        });
        return;
    }

    const channelId = payload.channel?.id;
    const userId = payload.user.id;

    // Get the prompt from the message context (Clank's posted images have it in the context block)
    const contextBlock = payload.message.blocks?.find((b) => b.type === 'context');
    const contextText = contextBlock?.elements?.[0]?.text || '';
    const promptMatch = contextText.match(/\*([^*]+)\*/);
    const prompt = promptMatch
        ? promptMatch[1].replace(/^["']|["']$/g, '')
        : payload.message.text?.substring(0, 100) || 'Clank art';

    const messageTs = payload.message.ts;

    // Send public "generating" message
    postMessage(channelId, {
        thread_ts: messageTs,
        reply_broadcast: true,
        text: '👕 Making a t-shirt from this image...',
    }).catch((err) => console.error('Tshirt ack error:', err.message));

    // Get the image URL (public S3 or download from Slack)
    const imageUrl = image.isPublic ? image.url : null;
    if (!imageUrl) {
        postMessage(channelId, {
            thread_ts: messageTs,
            text: "⚠️ Can only make t-shirts from Clank's posted images.",
        }).catch(() => {});
        return;
    }

    await invokeImageProcessor({
        prompt,
        channelId,
        userId,
        tshirtMode: true,
        originalImageUrl: imageUrl,
        threadTs: messageTs,
    });
}

/**
 * Handle modal submission from "Ask Clank"
 */
async function handleViewSubmission(payload) {
    const meta = JSON.parse(payload.view.private_metadata);
    const prompt = payload.view.state.values.prompt_block.prompt_input.value;

    postEphemeral(meta.channelId, meta.userId, {
        text: `🎨 Generating: "${prompt}"...`,
        ...(meta.threadTs && { thread_ts: meta.threadTs }),
    }).catch((err) => console.error('Failed to send generating notice:', err.message));

    await invokeImageProcessor({
        prompt,
        channelId: meta.channelId,
        threadTs: meta.threadTs,
        userId: meta.userId,
        userName: meta.userName,
        displayName: meta.displayName,
        referenceImage: meta.referenceImage,
        messageContext: meta.messageText ? { text: meta.messageText, author: meta.messageAuthor } : null,
        source: 'shortcut',
    });
}

// ─── Main handler ────────────────────────────────────────────────

export const handleInteraction = async (event) => {
    console.log('Interaction received:', JSON.stringify(event, null, 2));

    if (!verifyRequest(event)) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    const body = new URLSearchParams(event.body);
    const payload = JSON.parse(body.get('payload') || '{}');
    console.log(
        'Interaction type:',
        payload.type,
        payload.callback_id || payload.view?.callback_id || payload.actions?.[0]?.action_id || ''
    );

    const ack = { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '' };

    try {
        if (payload.type === 'message_action' && payload.callback_id === 'ask_clank') {
            await handleMessageAction(payload);
        } else if (payload.type === 'message_action' && payload.callback_id === 'make_tshirt') {
            await handleTshirtAction(payload);
        } else if (payload.type === 'view_submission' && payload.view?.callback_id === 'ask_clank_submit') {
            await handleViewSubmission(payload);
        } else {
            console.log('Unhandled interaction:', payload.type, payload.callback_id);
        }
    } catch (error) {
        console.error('Interaction handler error:', error);
    }

    return ack;
};
