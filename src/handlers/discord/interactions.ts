// ─── Discord interactions endpoint (HTTP) ────────────────────────
// The Discord equivalent of slashCommand.ts + interactions.ts. Verifies the
// Ed25519 signature, answers Discord's PING health-check, and routes both
// application commands:
//   • /clank              — CHAT_INPUT slash command (typed prompt)
//   • "Clank It"          — MESSAGE context-menu command (summon onto a message)
// Both ack with a DEFERRED response (Discord requires a reply within 3s), then
// hand off to the async processor, which edits the deferred message via the
// interaction token (valid 15 min). Same ack-then-async shape as Slack.

import { InteractionResponseFlags, InteractionResponseType, InteractionType } from 'discord-interactions';
import { invokeAsync } from '../../lib/lambda.js';
import { rawBody, readDiscordMessage, verifyDiscordRequest } from '../../lib/platform/discord/index.js';

// Application-command types (Discord numeric enum): 1 = CHAT_INPUT (slash),
// 3 = MESSAGE (context menu). discord-interactions doesn't export these.
const MESSAGE_COMMAND = 3;

const json = (statusCode: number, obj: any) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

// An immediate ephemeral reply (visible only to the invoker) — used for the
// unknown-command fallback and error acks.
const ephemeralReply = (content: string) =>
    json(200, {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content, flags: InteractionResponseFlags.EPHEMERAL },
    });

export const handleDiscordInteraction = async (event: any) => {
    // Discord de-registers the URL if verification ever fails — 401 on bad sig.
    if (!(await verifyDiscordRequest(event))) {
        return { statusCode: 401, body: 'invalid request signature' };
    }

    const body = JSON.parse(rawBody(event) || '{}');

    // 1. Health-check ping (Discord sends this on save + routinely).
    if (body.type === InteractionType.PING) {
        return json(200, { type: InteractionResponseType.PONG });
    }

    // 2. Application command (slash /clank OR the "Clank It" message menu).
    if (body.type === InteractionType.APPLICATION_COMMAND) {
        const data = body.data || {};
        // Discord nests the user under `member` in a guild, `user` in a DM.
        const user = body.member?.user || body.user || {};
        const common = {
            interactionToken: body.token,
            channelId: body.channel_id,
            // The interaction carries a partial channel object — name + topic for
            // free (no REST fetch). Guild name/description is fetched (cached) in
            // the processor. Both feed the think step's "where" line.
            channelName: body.channel?.name || null,
            channelTopic: body.channel?.topic || null,
            guildId: body.guild_id,
            userId: user.id || null,
            userName: user.global_name || user.username || null,
        };

        // "Clank It" — MESSAGE context menu: the target message IS the prompt.
        if (data.type === MESSAGE_COMMAND) {
            const target = data.resolved?.messages?.[data.target_id];
            const msg = target ? readDiscordMessage(target) : null;
            if (!msg || (!msg.text && !msg.imageUrl)) {
                return ephemeralReply("There's nothing on that message for me to work with.");
            }
            try {
                await invokeAsync(process.env.DISCORD_PROCESSOR_FUNCTION_NAME, {
                    source: 'discord-message',
                    messageText: msg.text,
                    imageUrl: msg.imageUrl,
                    authorName: msg.authorName,
                    authorId: msg.authorId,
                    parentText: msg.parent?.text || null,
                    parentAuthor: msg.parent?.authorName || null,
                    ...common,
                });
            } catch (err: any) {
                console.error('Failed to invoke Discord processor (message):', err.message);
                return ephemeralReply('⚠️ Something went wrong reaching Clank. Try again.');
            }
            return json(200, { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
        }

        // /clank — CHAT_INPUT slash command.
        if (data.name === 'clank') {
            const prompt = data.options?.find((o: any) => o.name === 'prompt')?.value || '';
            if (!prompt.trim()) {
                return ephemeralReply('Give me something to draw — `/clank a cat in a spacesuit`');
            }
            try {
                await invokeAsync(process.env.DISCORD_PROCESSOR_FUNCTION_NAME, {
                    source: 'discord-slash',
                    prompt,
                    ...common,
                });
            } catch (err: any) {
                console.error('Failed to invoke Discord processor:', err.message);
                return ephemeralReply('⚠️ Something went wrong reaching Clank. Try again.');
            }
            return json(200, { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
        }

        // /credits — show balance + buy buttons. Deferred ephemeral (private to
        // the invoker); the processor reads the meter and edits the reply.
        if (data.name === 'credits') {
            try {
                await invokeAsync(process.env.DISCORD_PROCESSOR_FUNCTION_NAME, {
                    source: 'discord-credits',
                    ...common,
                });
            } catch (err: any) {
                console.error('Failed to invoke Discord processor (credits):', err.message);
                return ephemeralReply('⚠️ Something went wrong. Try again.');
            }
            return json(200, {
                type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
                data: { flags: InteractionResponseFlags.EPHEMERAL },
            });
        }

        return ephemeralReply(`Unknown command: ${data.name}`);
    }

    // Message components / modal submits — not handled yet; ack benignly.
    console.log('Unhandled Discord interaction type:', body.type);
    return ephemeralReply('Not implemented yet.');
};
