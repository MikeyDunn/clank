// ─── Discord async processor ─────────────────────────────────────
// The Discord counterpart of lib/imageProcessor. Invoked async after the
// interactions endpoint defers; reuses the SHARED core — a tenant Mind +
// runArtPipeline + consumeOutcome — and provides only a Discord DeliveryAdapter
// (edit the deferred interaction reply via the interaction token).
//
// Each Discord GUILD is its own tenant/mind on the PROD table + prod vector
// store (memory.forTenant). So every server gets a blank-slate Clank that
// evolves with THAT community — isolated from Slack and from other guilds.

import { buyButtonRows, CREDIT_PACKS, creditsForSku } from '../../lib/credits.js';
import { consumeOutcome, type DeliveryAdapter } from '../../lib/imageProcessor/consume.js';
import { downloadReferenceImage, runArtPipeline } from '../../lib/imageProcessor/pipeline.js';
import { REACTED_MARKER } from '../../lib/imageProcessor/summon.js';
import * as memory from '../../lib/memory/index.js';
import { tenantId } from '../../lib/memory/tenant.js';
import {
    consumeEntitlement,
    deleteOriginalResponse,
    editOriginalResponse,
    fetchGuildContext,
    followupMessage,
    listEntitlements,
} from '../../lib/platform/discord/index.js';

// Grant any unconsumed credit-pack entitlements the user owns, then consume
// them. Queries the List Entitlements API — the interaction-payload entitlements
// array is unreliable for HTTP apps (discord-api-docs#7038), so we never trust
// it. (Refunded entitlements are already excluded: exclude_deleted defaults true.)
//
// The grant is IDEMPOTENT per entitlement id (a conditional write recording the
// id alongside the balance bump), so none of these double-credit: a failed
// consume leaving the entitlement unconsumed, a Lambda retry, or /credits racing
// a /clank denial. Returns credits actually granted by THIS call.
async function reconcileCredits(userId: string, mind: memory.Mind): Promise<number> {
    let granted = 0;
    try {
        const ents = await listEntitlements(
            userId,
            CREDIT_PACKS.map((p) => p.skuId)
        );
        for (const e of ents) {
            if (e.consumed || e.deleted) continue;
            // Never credit an entitlement that isn't this user's.
            if (e.user_id && e.user_id !== userId) continue;
            const amount = creditsForSku(e.sku_id);
            if (amount <= 0) continue;
            const applied = await mind.grantEntitlement(userId, e.id, amount);
            if (applied) {
                granted += amount;
                console.log(`Granted ${amount} credits to ${userId} (entitlement ${e.id})`);
            }
            // Consume even when already granted — that's what clears it from the
            // list. Safe to fail: the grant can't apply twice.
            await consumeEntitlement(e.id).catch((err: any) =>
                console.error(`consumeEntitlement ${e.id} failed (grant is idempotent, safe):`, err.message)
            );
        }
    } catch (err: any) {
        console.error('reconcileCredits failed:', err.message);
    }
    return granted;
}

export const processDiscord = async (event: any, lambdaCtx: any = null) => {
    // Absolute deadline — generation budgets itself against it (generate.ts).
    const deadlineMs = lambdaCtx?.getRemainingTimeInMillis ? Date.now() + lambdaCtx.getRemainingTimeInMillis() : null;
    const { source, interactionToken, userId, userName, guildId } = event;
    const isMessage = source === 'discord-message';
    // Slash: the typed prompt. Message menu ("Clank It"): the target message's
    // text IS the prompt, and it may carry an image + an author to summon onto.
    const rawPrompt = isMessage ? event.messageText || '' : event.prompt || '';
    const userInfo = {
        handle: userName,
        displayName: userName,
        source: isMessage ? 'discord-message' : 'discord-slash',
    };
    const requestStartTime = Date.now();

    // This guild's mind (its own rows on the prod table + prod vector scope). A
    // DM (no guild) gets a per-user mind so strangers don't share memory.
    const mind = memory.forTenant({ tenant: tenantId('discord', guildId || `dm:${userId}`) });

    // Deliver by editing the deferred "Clank is thinking…" reply (PUBLIC on
    // /clank + "Clank It"). Only a finished image or Clank's text reply uses this.
    const deliver = (payload: any) =>
        editOriginalResponse(interactionToken, payload).catch((e: any) =>
            console.error('Discord editOriginal failed:', e.message)
        );

    // Ephemeral (private-to-invoker) reply. On a PUBLIC-deferred command we drop
    // the public "thinking…" placeholder, then send an ephemeral followup. Used
    // for EVERYTHING that isn't a finished image or Clank's text reply — errors,
    // refusals, credit/limit denials — so the channel only ever sees real output.
    const ephemeral = async (content: string, components?: unknown[]) => {
        await deleteOriginalResponse(interactionToken).catch(() => {});
        await followupMessage(interactionToken, {
            content: content || '…',
            flags: 64, // EPHEMERAL
            ...(components ? { components } : {}),
        }).catch((e: any) => console.error('Discord ephemeral followup failed:', e.message));
    };

    // ── /credits — balance + buy buttons. Reconcile any purchase first (via the
    // List Entitlements API), so the number shown is current. ──
    if (source === 'discord-credits') {
        // Own try/catch: this runs before the main one, and an unhandled throw
        // would strand the deferred "thinking…" reply forever (and trigger a
        // Lambda retry).
        try {
            await reconcileCredits(userId, mind);
            const st = await mind.status(userId);
            const s = st.credits === 1 ? '' : 's';
            // Only mention a daily allowance when one actually exists.
            const daily =
                st.freePerDay > 0 ? ` and **${st.freeRemaining}/${st.freePerDay}** free renders left today` : '';
            const line =
                st.credits > 0 ? `You have **${st.credits}** credit${s}${daily}.` : `You're out of credits${daily}.`;
            await deliver({ content: `${line}\n\nGrab more:`, components: buyButtonRows() });
        } catch (err: any) {
            console.error('Discord /credits failed:', err.message);
            await deliver({ content: '⚠️ Could not read your balance. Try again.' });
        }
        return { statusCode: 200, body: 'Discord credits' };
    }

    // Discord delivery: images upload as a FILE whose `description` is Clank's
    // thoughts — Discord's alt-text channel (the "ALT" badge on the image), the
    // same hidden signature that rides in Slack's alt_text. NO stats line on
    // Discord (model/cost/duration leak the machine + break the ARG; they're in
    // the logs). Just the prompt as a caption. Plain content for text/errors.
    const adapter: DeliveryAdapter = {
        image: async ({ publicUrl, thoughts }) => {
            const content = `**${rawPrompt.slice(0, 300)}**`;
            const alt = (thoughts || rawPrompt).slice(0, 1024); // Discord alt-text cap
            try {
                const bytes = Buffer.from(await (await fetch(publicUrl)).arrayBuffer());
                await editOriginalResponse(
                    interactionToken,
                    { content, attachments: [{ id: 0, filename: 'clank.png', description: alt }] },
                    [{ name: 'clank.png', data: bytes }]
                );
            } catch (e: any) {
                console.error('Discord image attach failed, embedding URL instead:', e.message);
                await deliver({ content, embeds: [{ image: { url: publicUrl } }] });
            }
        },
        text: async ({ text }) => {
            await deliver({ content: text || '…' });
        },
        error: async (message) => {
            // Errors + refusals are PRIVATE — only the invoker sees them.
            await ephemeral(message);
        },
    };

    try {
        // Cost-control gate — check the guild's free-daily/credit allowance +
        // cooldown BEFORE spending on think/generate. Slack never reaches here;
        // its mind is unmetered anyway.
        let gate = await mind.reserve(userId, guildId);
        // Out of free + known credits? They may have just bought a pack, and the
        // interaction payload won't tell us (discord-api-docs#7038). Check the
        // entitlements API, grant anything new, and re-gate before denying.
        if (!gate.ok && gate.offerPacks) {
            const granted = await reconcileCredits(userId, mind);
            if (granted > 0) gate = await mind.reserve(userId, guildId);
        }
        if (!gate.ok) {
            await ephemeral(
                gate.message || "You're out of renders for now.",
                gate.offerPacks ? buyButtonRows() : undefined
            );
            return { statusCode: 200, body: 'Metered: denied' };
        }

        // A message-menu target may carry an image → reference-image editing.
        // Discord CDN URLs are public, so the shared downloader fetches directly.
        const ref =
            isMessage && event.imageUrl
                ? await downloadReferenceImage({ url: event.imageUrl, isPublic: true, name: 'discord-image' })
                : { ok: true as const, base64: null };
        const referenceImageBase64 = ref.ok ? ref.base64 : null;

        const profiles = await mind.scanUserProfiles();
        const prompt = memory.resolveMentions(rawPrompt, profiles); // resolveMentions is pure
        const tokenMap = memory.buildAliasTokens(profiles);
        const context = await mind.buildContext(userId, profiles);

        // Where this came from: channel name/topic ride in free on the interaction
        // payload; the guild name/description (the "what community is this" line,
        // high-signal since the guild IS the tenant) is a cached fetch. Ephemeral.
        const guild = await fetchGuildContext(guildId);
        const channelName = event.channelName ? `#${event.channelName}` : null;
        const channel =
            channelName || event.channelTopic || guild?.name || guild?.description
                ? {
                      channel: channelName,
                      topic: event.channelTopic || null,
                      space: guild?.name || null,
                      spaceDescription: guild?.description || null,
                  }
                : null;

        // Acting on someone's message → give Clank the social triangle (who
        // summoned / whose message / self-vs-other), same framing as Slack's 🤖.
        // If the picked message was a reply and Discord inlined the parent, feed
        // it as premise context (mirrors Slack's thread-parent anchor) — free, no
        // channel-read. The target stays the request (marked in the transcript).
        let summon: any = null;
        if (isMessage) {
            let conversation: string | null = null;
            if (event.parentText) {
                const pAuthor = event.parentAuthor ? `@${event.parentAuthor}` : 'someone';
                const tAuthor = event.authorName ? `@${event.authorName}` : 'someone';
                const parentLine = memory.resolveMentions(event.parentText, profiles).slice(0, 350);
                conversation = `${pAuthor}: "${parentLine}"\n${tAuthor}: "${prompt.slice(0, 350)}" ${REACTED_MARKER}`;
                console.log('Discord Clank It: reply-parent context attached');
            }
            summon = {
                author: event.authorName || null,
                summoner: userName || null,
                self: !!event.authorId && event.authorId === userId,
                conversation,
            };
        }

        // Pass the guild's vectorScope so lore recall reads the SAME store this
        // mind writes to.
        const pipe = await runArtPipeline({
            prompt,
            context,
            referenceImageBase64,
            channel,
            requester: userName,
            tokenMap,
            summon,
            deadlineMs,
            vectorScope: mind.vectorScope,
        });

        const ctx = {
            prompt,
            userId,
            userInfo,
            requestStartTime,
            guildId,
            referenceUrl: null,
            mind,
        };
        await consumeOutcome(pipe, ctx, adapter);
        return { statusCode: 200, body: 'Discord delivered' };
    } catch (error: any) {
        console.error('Discord processor error:', error.message);
        await ephemeral('⚠️ Something went wrong. Try again.');
        return { statusCode: 500, body: 'Discord processor error' };
    }
};
