// ─── Image processor orchestrator ────────────────────────────────
// Flow: think (Sonnet) → generate (Mini) if image → deliver to Slack.

import { consumeOutcome, type DeliveryAdapter } from '../../lib/imageProcessor/consume.js';
import { downloadReferenceImage, runArtPipeline } from '../../lib/imageProcessor/pipeline.js';
import * as memory from '../../lib/memory/index.js';
import { processReactPrompt } from '../../lib/platform/slack/flows/reactPrompt.js';
import { processTshirt, processTshirtReaction } from '../../lib/platform/slack/flows/tshirt.js';
import {
    buildPublicBlocks,
    buildTextPublicBlocks,
    postEphemeral,
    postMessage,
    sendResponse,
    stripMrkdwn,
} from '../../lib/platform/slack/index.js';

// Clear the original Slack "Generating..." message (best-effort, fire-and-forget).
function clearOriginal(responseUrl) {
    if (responseUrl) sendResponse(responseUrl, { delete_original: true, text: '.' }).catch(() => {});
}

async function processImage(event, lambdaCtx: any = null) {
    console.log('Image processor invoked:', JSON.stringify(event));

    // Absolute deadline for this invocation — generation budgets itself against
    // it (see generate.ts). Null outside Lambda (scripts/tests) → legacy caps.
    const deadlineMs = lambdaCtx?.getRemainingTimeInMillis ? Date.now() + lambdaCtx.getRemainingTimeInMillis() : null;

    // ── T-shirt mode: generate shirt design and create Printify product ──
    if (event.tshirtMode) {
        return processTshirt(event);
    }

    // ── T-shirt reaction: check emoji count and create product if 4+ ──
    if (event.tshirtReaction) {
        return processTshirtReaction(event);
    }

    // ── 🤖 reaction: respond to the reacted message (once per message, ever) ──
    if (event.reactPrompt) {
        return processReactPrompt(event, deadlineMs);
    }

    const {
        prompt: rawPrompt,
        responseUrl,
        channelId,
        threadTs = null,
        userId,
        userName = null,
        displayName = null,
        referenceImage = null,
        messageContext = null,
    } = event;

    // Ephemeral sink — used ONLY for technical errors (private to the requester).
    const ephemeral = (payload) =>
        postEphemeral(channelId, userId, { ...payload, ...(threadTs && { thread_ts: threadTs }) });
    // Public sink — the result posts straight to the channel (no preview gate).
    // Ask Clank (threadTs set) broadcasts to the thread AND the channel; /clank
    // (no threadTs) posts to the channel.
    const postPublic = (payload) =>
        postMessage(channelId, {
            unfurl_links: false,
            unfurl_media: false,
            ...(threadTs && { thread_ts: threadTs, reply_broadcast: true }),
            ...payload,
        });
    // source set by the entry handler: 'slash' (/clank) or 'shortcut' (Ask Clank).
    const userInfo = { handle: userName, displayName, source: event.source || 'slash' };
    const requestStartTime = Date.now();
    let prompt = rawPrompt; // resolved from <@UID> mentions once profiles load (below)

    try {
        // ── Download reference image if provided (shared with the 🤖 flow) ──
        const ref = await downloadReferenceImage(referenceImage);
        if (!ref.ok) {
            const msg =
                ref.reason === 'invalid'
                    ? `⚠️ Couldn't read the reference image (${referenceImage.name}). Try a different image.`
                    : `⚠️ Couldn't download the reference image. Try a different image.`;
            await ephemeral({ text: msg });
            return {
                statusCode: 200,
                body: ref.reason === 'invalid' ? 'Invalid reference image' : 'Reference download failed',
            };
        }
        const referenceImageBase64 = ref.base64;

        // ── Build context ──
        // Clank recalls his own lore via tools inside the think step (no
        // separate orchestrator) — one coherent mind, with prompt caching.
        // Escaping is on, so tags arrive as <@UID> — resolve them to stable @handles via
        // a direct ID→profile lookup (no name-collision guesswork), reusing the profiles
        // for context. Done before think + remember so tagged people also store cleanly.
        const profiles = await memory.scanUserProfiles();
        prompt = memory.resolveMentions(rawPrompt, profiles);
        const tokenMap = memory.buildAliasTokens(profiles);

        const context = await memory.buildContext(userId, profiles);
        console.log('Context built, length:', context.length);

        // ── think → generate → classify (shared pipeline) ──
        const pipe = await runArtPipeline({
            prompt,
            context,
            referenceImageBase64,
            messageContext,
            requester: userInfo.displayName || userInfo.handle,
            tokenMap,
            deadlineMs,
            // /clank has a visible "Generating…" message — swap it for a retry notice.
            onRetry: responseUrl
                ? async (errorType) => {
                      await sendResponse(responseUrl, {
                          replace_original: true,
                          response_type: 'ephemeral',
                          text: `⚠️ OpenRouter hiccup (${errorType}) — retrying...`,
                      });
                  }
                : null,
        });

        // ── Delivery adapter: /clank posts results publicly (rich Block Kit),
        // clearing the "Generating…" placeholder first; only technical errors
        // stay ephemeral to the requester.
        const adapter: DeliveryAdapter = {
            image: async ({ publicUrl, thoughts, modelName, duration, cost, fromWolf }) => {
                const blocks = buildPublicBlocks({
                    imageUrl: publicUrl,
                    prompt,
                    userId,
                    authorId: userId,
                    modelName,
                    duration,
                    cost,
                    referenceImage,
                    thoughts, // full text; blocks.ts caps alt_text (2000)
                    fromWolf,
                });
                clearOriginal(responseUrl);
                await postPublic({ text: `✨ ${prompt}`, blocks });
            },
            text: async ({ text, modelName, cost }) => {
                const blocks = buildTextPublicBlocks({ prompt, userId, thoughts: text, modelName, cost });
                clearOriginal(responseUrl);
                await postPublic({ text: `Clank on "${prompt}"`, blocks });
            },
            error: async (msg) => {
                clearOriginal(responseUrl);
                await ephemeral({ text: stripMrkdwn(msg) });
            },
        };

        // ── Deliver: content posts publicly; only technical errors stay ephemeral ──
        // Everything funnels through the shared consumer + adapter above.
        await consumeOutcome(
            pipe,
            {
                prompt,
                userId,
                userInfo,
                requestStartTime,
                referenceUrl: referenceImage?.permalink || null,
            },
            adapter
        );
        return { statusCode: 200, body: 'Processing complete' };
    } catch (error) {
        console.error('Unexpected error in image processor:', error);
        try {
            clearOriginal(responseUrl);
            await ephemeral({ text: '⚠️ Something Went Wrong\nAn unexpected error occurred. Please try again.' });
        } catch (err) {
            console.error('Failed to send error response:', err);
        }
        return { statusCode: 500, body: 'Error processing image' };
    }
}

export { processImage };
