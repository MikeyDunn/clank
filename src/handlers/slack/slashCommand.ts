// ─── Slash command entry point ───────────────────────────────────
// Receives /clank from Slack, validates, invokes imageProcessor async.

import { invokeAsync } from '../../lib/lambda.js';
import { ensureBotInChannel, verifyRequest } from '../../lib/platform/slack/index.js';

/**
 * Parse Slack slash command fields from URL-encoded body
 */
function parseSlackCommand(body) {
    const params = new URLSearchParams(body);
    return {
        command: params.get('command'),
        text: params.get('text'),
        userId: params.get('user_id'),
        userName: params.get('user_name'),
        channelId: params.get('channel_id'),
        responseUrl: params.get('response_url'),
    };
}

/**
 * Main Lambda handler for /clank slash command
 */
export const slackImageCommand = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    if (!verifyRequest(event)) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid request signature' }) };
    }

    const slackCommand = parseSlackCommand(event.body);
    console.log('Parsed command:', slackCommand);

    if (!slackCommand.text || slackCommand.text.trim() === '') {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                response_type: 'ephemeral',
                text: 'Please provide a description for the image you want to generate.\nExample: `/clank a cat wearing a space suit on the moon`',
            }),
        };
    }

    // Ensure Clank is in the channel (auto-joins public, needs invite for private)
    const channelCheck = await ensureBotInChannel(slackCommand.channelId);
    if (!channelCheck.ok) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                response_type: 'ephemeral',
                text: 'Invite @Clank to this channel first, then try `/clank` again.',
            }),
        };
    }

    // Invoke image processor asynchronously (Slack requires ack within 3s)
    try {
        await invokeAsync(process.env.IMAGE_PROCESSOR_FUNCTION_NAME, {
            prompt: slackCommand.text,
            responseUrl: slackCommand.responseUrl,
            channelId: slackCommand.channelId,
            userId: slackCommand.userId,
            userName: slackCommand.userName,
            source: 'slash',
        });
        console.log('Image processor invoked successfully');
    } catch (error) {
        console.error('Error invoking image processor:', error);
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            response_type: 'ephemeral',
            text: `🎨 Generating: "${slackCommand.text}"...`,
        }),
    };
};
