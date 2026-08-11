// ─── Slack Events handler ────────────────────────────────────────
// Receives reaction_added events: 4 👕 → t-shirt, 🤖 → summon Clank onto
// the message.

import { invokeAsync } from '../../lib/lambda.js';
import { verifyRequest } from '../../lib/platform/slack/index.js';

export const handleEvent = async (event) => {
    // Verify the Slack signature FIRST — same gate as slashCommand/interactions.
    // Without it anyone could forge a reaction_added and drive the paid
    // think→generate pipeline (and impersonate any user in the credit line).
    // Slack signs the url_verification challenge too, so this precedes it.
    if (!verifyRequest(event)) {
        console.warn('Rejected unsigned/invalid Slack event');
        return { statusCode: 401, body: 'Invalid signature' };
    }

    console.log('Event received:', event.body?.substring(0, 200));
    const body = JSON.parse(event.body || '{}');

    // Slack URL verification challenge
    if (body.type === 'url_verification') {
        console.log('Challenge:', body.challenge);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'text/plain' },
            body: body.challenge,
        };
    }

    // Only process reaction_added events on messages.
    const slackEvent = body.event;
    if (body.type !== 'event_callback' || slackEvent?.type !== 'reaction_added') {
        return { statusCode: 200, body: 'ok' };
    }
    if (slackEvent.item?.type !== 'message') {
        return { statusCode: 200, body: 'ok' };
    }

    const reaction = slackEvent.reaction || '';
    const isShirt = reaction === 'tshirt' || reaction === 'shirt';
    // Match ANY robot emoji, not just the two standard names — workspaces often
    // add a custom `:robot:` (a pixel-art bot ≠ the standard 🤖 `robot_face`)
    // whose event name our old `=== 'robot'` check missed, silently dropping the
    // summon. `includes('robot')` covers robot_face, robot, and custom variants.
    const isRobot = reaction.includes('robot');
    if (!isShirt && !isRobot) {
        console.log(`Ignored reaction (not shirt/robot): ${reaction}`);
        return { statusCode: 200, body: 'ok' };
    }

    // 👕 → t-shirt check (needs a vote threshold). 🤖 → respond to the message.
    // The reactPrompt processor holds a claim-once lock, so firing on EVERY 🤖
    // (second reactor, remove+re-add) is safe — duplicates no-op there.
    const payload = isShirt
        ? {
              tshirtReaction: true,
              channelId: slackEvent.item.channel,
              messageTs: slackEvent.item.ts,
              reactingUser: slackEvent.user,
          }
        : {
              reactPrompt: true,
              channelId: slackEvent.item.channel,
              messageTs: slackEvent.item.ts,
              reactingUser: slackEvent.user,
              itemUser: slackEvent.item_user, // author of the reacted message
          };

    console.log(`${isShirt ? 'Shirt' : 'Robot'} reaction detected:`, JSON.stringify(slackEvent));

    try {
        await invokeAsync(process.env.IMAGE_PROCESSOR_FUNCTION_NAME, payload);
    } catch (error) {
        console.error('Failed to invoke processor for reaction:', error.message);
    }

    return { statusCode: 200, body: 'ok' };
};
