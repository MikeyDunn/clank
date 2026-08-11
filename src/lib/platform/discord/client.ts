// ─── Discord REST client ─────────────────────────────────────────
// Thin wrappers over @discordjs/rest (rate-limit handling + retries for free).
// Two auth modes:
//   • Interaction followups use the INTERACTION TOKEN in the URL (auth: false —
//     no bot token; valid 15 min) — how a deferred /clank reply gets its result.
//   • Channel posts (future gateway worker: reactions, @mentions) use the bot
//     token (the REST client's default auth).
// Interaction/response TYPE + FLAG enums come from `discord-interactions`
// (imported directly where needed) — no hand-rolled copies here.

import { type RawFile, REST } from '@discordjs/rest';

const APP_ID = process.env.DISCORD_APP_ID || '';

// setToken is required to initialise the client; bot-token routes use it, the
// interaction-webhook routes below pass `auth: false` so it's not sent.
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN || 'unset');

/**
 * Replace the deferred "thinking…" response with the final content. Uses the
 * interaction token (auth: false). The primary /clank delivery call.
 */
export async function editOriginalResponse(
    interactionToken: string,
    payload: unknown,
    files?: RawFile[]
): Promise<unknown> {
    return rest.patch(`/webhooks/${APP_ID}/${interactionToken}/messages/@original`, {
        body: payload,
        files,
        auth: false,
    });
}

/** Post an additional followup message on an interaction (interaction token). */
export async function followupMessage(interactionToken: string, payload: unknown): Promise<unknown> {
    return rest.post(`/webhooks/${APP_ID}/${interactionToken}`, { body: payload, auth: false });
}

/** Delete the deferred/initial response (interaction token). Used to drop the
 *  public "thinking…" placeholder before sending an ephemeral followup. */
export async function deleteOriginalResponse(interactionToken: string): Promise<void> {
    await rest.delete(`/webhooks/${APP_ID}/${interactionToken}/messages/@original`, { auth: false });
}

/** Post a message to a channel via the bot token (future gateway worker). */
export async function postChannelMessage(channelId: string, payload: unknown): Promise<unknown> {
    return rest.post(`/channels/${channelId}/messages`, { body: payload });
}

/**
 * Mark a one-time-purchase (consumable) entitlement as consumed (bot token,
 * 204 on success). Called after granting the pack's credits so the SKU can be
 * bought again.
 */
export async function consumeEntitlement(entitlementId: string): Promise<void> {
    await rest.post(`/applications/${APP_ID}/entitlements/${entitlementId}/consume`);
}

/**
 * List a user's entitlements for the given SKUs (bot token). This is the
 * RELIABLE way to detect a purchase: the entitlements array on HTTP interaction
 * payloads is buggy/empty for HTTP apps (discord-api-docs#7038), so we query
 * here instead. `exclude_ended` drops expired ones; consumables still appear
 * with `consumed: true` until consumed, so the caller filters those out.
 */
export async function listEntitlements(userId: string, skuIds: string[]): Promise<any[]> {
    const q = new URLSearchParams({ user_id: userId, sku_ids: skuIds.join(','), exclude_ended: 'true' });
    const res = await rest.get(`/applications/${APP_ID}/entitlements?${q.toString()}`);
    return Array.isArray(res) ? res : [];
}
