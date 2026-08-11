// ─── Discord webhook events (entitlements) ───────────────────────
// `POST /discord/webhook` — Discord's server-push channel for events an
// HTTP-only app can't get from the gateway. We subscribe to the entitlement
// lifecycle so purchases apply instantly and REFUNDS/CHARGEBACKS are visible:
//
//   ENTITLEMENT_CREATE → grant the pack's credits (idempotent) + consume it.
//   ENTITLEMENT_DELETE → the purchase was refunded, charged back, or revoked.
//                        Claw back whatever the user hasn't spent yet.
//
// Why this matters: Discord is the reseller, and refunds + chargebacks are
// deducted from OUR payout — so without this we'd eat the reversal AND the
// generation cost, silently. Clawback recovers the unspent remainder.
//
// Contract (docs.discord.com/developers/events/webhook-events): same Ed25519
// verification as interactions, and we must answer 204 with an empty body
// within 3 seconds — so the handler stays to a couple of fast writes.
//
// The wallet is GLOBAL per user, so this needs no tenant/mind: entitlement
// payloads carry a user id and no guild.

import { creditsForSku } from '../../lib/credits.js';
import * as memory from '../../lib/memory/index.js';
import { consumeEntitlement, rawBody, verifyDiscordRequest } from '../../lib/platform/discord/index.js';

// Outer payload types: 0 = PING (endpoint health-check), 1 = event.
const PING = 0;
const EVENT = 1;

const noContent = { statusCode: 204, body: '' };

export const handleDiscordWebhook = async (event: any) => {
    // Discord disables the endpoint if verification ever fails — 401 on bad sig.
    if (!(await verifyDiscordRequest(event))) {
        return { statusCode: 401, body: 'invalid request signature' };
    }

    const body = JSON.parse(rawBody(event) || '{}');
    if (body.type === PING) return noContent;
    if (body.type !== EVENT) return noContent;

    const { type, data } = body.event || {};
    const userId = data?.user_id;
    const amount = creditsForSku(data?.sku_id);

    // Not one of our credit packs (or no user to credit) — nothing to do.
    if (!userId || amount <= 0) return noContent;

    const wallet = memory.discordWallet();

    try {
        if (type === 'ENTITLEMENT_CREATE') {
            const applied = await wallet.grantEntitlement(userId, data.id, amount);
            if (applied) console.log(`[webhook] granted ${amount} credits to ${userId} (entitlement ${data.id})`);
            // Consume so the SKU can be repurchased. The grant is idempotent, so
            // a failure here is harmless — reconcile picks it up later.
            await consumeEntitlement(data.id).catch((e: any) =>
                console.error(`[webhook] consume ${data.id} failed (safe):`, e.message)
            );
        } else if (type === 'ENTITLEMENT_DELETE') {
            // Refund / chargeback / revocation. Recover what's left; already-spent
            // credits are gone (we ate those renders).
            const removed = await wallet.clawbackEntitlement(userId, data.id, amount);
            console.warn(
                `[webhook] ENTITLEMENT_DELETE ${data.id} user=${userId} sku=${data.sku_id}: reclaimed ${removed}/${amount} credits`
            );
        }
    } catch (err: any) {
        // Never 5xx at Discord — it would retry and could disable the endpoint.
        console.error('[webhook] entitlement handling failed:', err.message);
    }

    return noContent;
};
