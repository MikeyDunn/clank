// ─── 🤖-reaction trigger ─────────────────────────────────────────
// A 🤖 reaction on ANY message summons Clank to respond to it. Distinct from
// the core /clank flow (index.ts): there's no typed prompt — the reacted
// message IS the prompt (its text, links, files, and image), and Clank knows
// WHO summoned him onto WHOSE message (the social triangle that gives it life).
//
// Design decisions (Mike, this thread):
//   • Fires on the FIRST 🤖 (instant), not a threshold.
//   • Fires EXACTLY ONCE per message, forever — a conditional-write claim lock
//     absorbs every later add / remove+re-add / second reactor.
//   • Delivers to the ROOT channel, never threaded — with a permalink back to
//     the source so the orphaned response keeps its anchor.
//   • Skips Clank's own messages (no self-loops).

import { consumeOutcome, type DeliveryAdapter } from '../../../imageProcessor/consume.js';
import { downloadReferenceImage, runArtPipeline } from '../../../imageProcessor/pipeline.js';
import { updateItem } from '../../../memory/db.js';
import * as memory from '../../../memory/index.js';
import {
    ensureBotInChannel,
    fetchMessageContext,
    getBotIdentity,
    getChannelContext,
    getPermalink,
    isOwnMessage,
    postEphemeral,
    postMessage,
    stripMrkdwn,
} from '../index.js';
import { describeConversation, describeMessage, extractImage } from './messageContent.js';

/** The one-line credit under Clank's response: who summoned him onto whose
 *  message, plus a permalink back to the source (since we post at channel root,
 *  not in-thread). `<@UID>` mentions render as names; the permalink stays a bare
 *  link so it doesn't nest inside another `<…>`. */
function summonCredit(
    summonerId: string | null,
    authorId: string | null,
    self: boolean,
    permalink: string | null
): string {
    let head: string;
    if (self) head = `🤖 <@${summonerId}> summoned Clank on their own message`;
    else if (authorId) head = `🤖 <@${summonerId}> summoned Clank on <@${authorId}>'s message`;
    else head = `🤖 <@${summonerId}> summoned Clank`;
    return permalink ? `${head} · <${permalink}|source>` : head;
}

// Images in the surrounding conversation can hold the premise (a summon on a
// text reply that's riffing on a picture shared moments earlier). Pull up to a
// few of the most recent neighbours' images as CONTEXT — Clank decides whether
// any are integral (submitResponse.references). The reacted message's OWN image
// is the primary reference and is handled separately. Skips the target itself
// and Clank's own messages; downloads run in parallel; failures are dropped.
const MAX_CONTEXT_IMAGES = 3;
async function collectContextImages(
    surrounding: any[],
    targetTs: string,
    botUserId: string | null,
    byUid: Map<string, any>
): Promise<{ base64: string; note?: string | null }[]> {
    const candidates = (surrounding || [])
        .filter((m) => m.ts !== targetTs && !(m.user && botUserId && m.user === botUserId))
        .map((m) => ({ m, img: extractImage(m) }))
        .filter((x) => x.img)
        .slice(-MAX_CONTEXT_IMAGES); // most recent neighbours

    const downloads = await Promise.all(
        candidates.map(async ({ m, img }) => {
            const dl = await downloadReferenceImage(img);
            if (!dl.ok || !dl.base64) return null;
            const profile = m.user ? byUid.get(m.user) : null;
            const handle = profile?.handle || profile?.displayName || null;
            return { base64: dl.base64, note: handle ? `from @${handle}` : 'shared earlier in the conversation' };
        })
    );
    return downloads.filter((d): d is { base64: string; note: string } => !!d);
}

async function processReactPrompt(event, deadlineMs: number | null = null) {
    const { channelId, messageTs, reactingUser, itemUser } = event;
    console.log('React-prompt trigger:', JSON.stringify({ channelId, messageTs, reactingUser }));

    // Cheap early skip: reacting to Clank's own message (item author == his uid).
    const { userId: botUserId } = await getBotIdentity();
    if (itemUser && botUserId && itemUser === botUserId) {
        return { statusCode: 200, body: "Skipped — Clank's own message" };
    }

    // Must be a member to read the message and post the response.
    const membership = await ensureBotInChannel(channelId);
    if (!membership.ok) {
        console.log('React-prompt: not in channel:', membership.reason);
        return { statusCode: 200, body: 'Not in channel' };
    }

    // Fetch the reacted message + a window of surrounding messages (thread-reply-
    // safe). The neighbours give Clank the premise when the group is riffing
    // back-and-forth; the reacted message stays the request (see the summon
    // framing — context is read-only, he answers the ONE marked message).
    const { target: message, surrounding } = await fetchMessageContext(channelId, messageTs);
    if (!message) return { statusCode: 200, body: 'Message not found' };
    if (await isOwnMessage(message)) return { statusCode: 200, body: "Skipped — Clank's own message" };

    // Pull out the reference image + a robust text description of everything else.
    const image = extractImage(message);
    const promptText = describeMessage(message, !!image);
    if (!promptText && !image) return { statusCode: 200, body: 'Nothing to respond to' };

    // ── Claim-once lock ──────────────────────────────────────────────
    // Conditional write: first event to create this marker wins and proceeds;
    // every later 🤖 (another reactor, or remove+re-add) fails the condition and
    // no-ops. Permanent (no TTL) so "only once per message, ever" holds. Claim
    // only AFTER we know there's content, so an empty message doesn't burn it.
    try {
        await updateItem({
            Key: { pk: 'META', sk: `REACTED#${channelId}#${messageTs}` },
            UpdateExpression: 'SET claimedAt = :now, reactor = :r, author = :a',
            ConditionExpression: 'attribute_not_exists(pk)',
            ExpressionAttributeValues: {
                ':now': new Date().toISOString(),
                ':r': reactingUser || 'unknown',
                ':a': message.user || 'unknown',
            },
        });
    } catch (err: any) {
        if (err.name === 'ConditionalCheckFailedException') {
            console.log('React-prompt: already handled, skipping');
            return { statusCode: 200, body: 'Already handled' };
        }
        console.error('React-prompt lock error:', err.message);
        return { statusCode: 200, body: 'Lock error' };
    }

    // We own the response now. Everything below is best-effort in one try/catch.
    const requestStartTime = Date.now();
    const authorUserId = message.user || itemUser || null;
    const self = !!authorUserId && authorUserId === reactingUser;

    // Where the summoner reacted from — anchor the private notice there so they
    // see it (this is the ONLY threaded thing; the response itself goes to root).
    const reactedInThread = !!message.thread_ts && message.thread_ts !== message.ts;
    const noticeThread = reactedInThread ? message.thread_ts : undefined;
    postEphemeral(channelId, reactingUser, {
        text: '🎨 On it — reacting to that message…',
        ...(noticeThread && { thread_ts: noticeThread }),
    }).catch((e) => console.error('React-prompt notice failed:', e.message));

    // Root-channel delivery sink + graceful bail-out.
    const postToRoot = (payload) => postMessage(channelId, { unfurl_links: false, unfurl_media: false, ...payload });
    const bail = (msg: string) =>
        postEphemeral(channelId, reactingUser, {
            text: msg,
            ...(noticeThread && { thread_ts: noticeThread }),
        }).catch(() => {});

    try {
        // Kick off the reference-image download NOW — it's a Slack file fetch
        // that depends on nothing below, so it overlaps the profile scan +
        // context build instead of blocking serially behind them.
        const refPromise = downloadReferenceImage(image);

        // Resolve people: profiles give handles for the think prompt; user IDs
        // render as names in the credit line. Mentions in the message text
        // (<@UID>) resolve to stable @handles, same as the /clank path.
        const profiles = await memory.scanUserProfiles();
        const byUid = new Map<string, any>(profiles.map((p: any) => [p.pk.replace('USER#', ''), p]));
        const authorProfile = authorUserId ? byUid.get(authorUserId) : null;
        const summonerProfile = reactingUser ? byUid.get(reactingUser) : null;
        const authorHandle = authorProfile?.handle || authorProfile?.displayName || null;
        const summonerHandle = summonerProfile?.handle || summonerProfile?.displayName || null;

        const resolvedPrompt = memory.resolveMentions(promptText, profiles);
        const tokenMap = memory.buildAliasTokens(profiles);
        const [context, permalink, channel] = await Promise.all([
            memory.buildContext(reactingUser, profiles),
            getPermalink(channelId, messageTs),
            getChannelContext(channelId),
        ]);
        const credit = summonCredit(reactingUser, authorUserId, self, permalink);

        // Root post shared by the text / refusal branches: a body
        // section + the summon-credit context line. (The image branch posts its
        // own image block.)
        const postText = (body: string, creditLine: string = credit) =>
            postToRoot({
                text: 'Clank reacted to a message',
                blocks: [
                    { type: 'section', text: { type: 'mrkdwn', text: body } },
                    { type: 'context', elements: [{ type: 'mrkdwn', text: creditLine }] },
                ],
            });

        // Surrounding-conversation transcript (context only — the reacted message
        // stays the request). `<@UID>` labels resolve to @handles in the same pass
        // as the prompt. Empty when there's nothing but the target itself.
        const conversationRaw = describeConversation(surrounding, messageTs, botUserId);
        const conversation = conversationRaw ? memory.resolveMentions(conversationRaw, profiles) : null;

        // Await the reference download kicked off above (best-effort — reactPrompt
        // can still respond to the text if it failed).
        const ref = await refPromise;
        const referenceImageBase64 = ref.ok ? ref.base64 : null;
        // Only had an (unreadable) image and no real text → nothing to do.
        if (!referenceImageBase64 && promptText === '[An image, with no caption.]') {
            await bail("⚠️ I couldn't read that image, and there was nothing else to go on.");
            return { statusCode: 200, body: 'Unreadable image, no text' };
        }

        const userId = reactingUser;
        const userInfo = {
            handle: summonerHandle,
            displayName: summonerProfile?.displayName || null,
            source: 'reaction',
            // Author of the reacted message — persisted on the history entry so
            // "whose messages attract summons" is answerable later.
            authorUserId: authorUserId || null,
        };

        // Context images from the surrounding conversation — Clank judges whether
        // any are integral to the reacted message (submitResponse.references).
        const contextImages = await collectContextImages(surrounding, messageTs, botUserId, byUid);

        // ── think → generate → classify (shared pipeline; summon-aware) ──
        // Silent retry: no visible "Generating…" message to swap, so no onRetry.
        const pipe = await runArtPipeline({
            prompt: resolvedPrompt,
            context,
            referenceImageBase64,
            contextImages,
            channel,
            tokenMap,
            summon: { author: authorHandle, summoner: summonerHandle, self, conversation },
            deadlineMs,
        });
        // ── Delivery adapter for the shared consumer ──────────────────────
        // consumeOutcome owns remember/reflect/classify; these three methods are
        // the only reaction-specific part — a root-channel post carrying the
        // summon credit line. Refusals/text share `postText`; images post their
        // own image block.
        const adapter: DeliveryAdapter = {
            image: async ({ publicUrl, thoughts, modelName, duration, cost }) => {
                await postToRoot({
                    text: 'Clank reacted to a message',
                    blocks: [
                        { type: 'image', image_url: publicUrl, alt_text: (thoughts || resolvedPrompt).slice(0, 2000) },
                        {
                            type: 'context',
                            elements: [{ type: 'mrkdwn', text: `${credit} | ${modelName} | ${duration}s | ${cost}` }],
                        },
                    ],
                });
            },
            text: async ({ text, modelName, cost }) => {
                await postText(stripMrkdwn(text).slice(0, 1500), `${credit} | ${modelName}${cost ? ` | ${cost}` : ''}`);
            },
            error: async (msg) => {
                await bail(stripMrkdwn(msg));
            },
        };

        // think_error / text / generation_error / image / refusal → the shared
        // consumer with the reaction adapter above.
        await consumeOutcome(
            pipe,
            {
                prompt: resolvedPrompt,
                userId,
                userInfo,
                requestStartTime,
                referenceUrl: image?.permalink || permalink || null,
            },
            adapter
        );
        return { statusCode: 200, body: 'React delivered' };
    } catch (error: any) {
        console.error('React-prompt error:', error.message);
        await bail('⚠️ Something went wrong reacting to that message.');
        return { statusCode: 200, body: 'React-prompt error' };
    }
}

export { processReactPrompt };
