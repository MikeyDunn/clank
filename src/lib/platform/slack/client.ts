// ─── Slack Web API client ────────────────────────────────────────
// Wraps @slack/web-api's WebClient (built-in retries + rate-limit handling).
// The public helpers keep their original signatures and stay NON-throwing on
// API errors (they log + return the `{ok:false}` body) so no caller changes —
// WebClient throws on `ok:false`, so each wrapper catches and returns the error
// body. `sendResponse` (response_url) and `downloadSlackFile` (file download)
// aren't Web API methods, so they stay raw fetch.

import { WebClient } from '@slack/web-api';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const web = new WebClient(SLACK_BOT_TOKEN);

/** POST a message to a Slack response_url. (Slack replies with the plain text
 *  "ok" on success — not JSON — so read it as text, never res.json().) */
async function sendResponse(url, message) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
        });
        const text = (await res.text()).trim();
        if (!res.ok || text === 'false') {
            console.error('Slack response_url returned error:', res.status, text.substring(0, 200));
        } else {
            console.log('Slack response_url OK:', res.status, text.substring(0, 100));
        }
        return text;
    } catch (error) {
        console.error('Slack response error:', error.message);
        throw error;
    }
}

/** Ensure the bot is in the given channel. Auto-joins public channels. */
async function ensureBotInChannel(channelId): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
        const info = await web.conversations.info({ channel: channelId });
        if (!info.channel) return { ok: false, reason: 'channel_not_found' };
        if (info.channel.is_member) return { ok: true };
        if (info.channel.is_private) return { ok: false, reason: 'private_channel' };

        const join = await web.conversations.join({ channel: channelId });
        if (join.ok) {
            console.log('Auto-joined channel:', channelId);
            return { ok: true };
        }
        return { ok: false, reason: 'join_failed' };
    } catch (error: any) {
        // conversations.info throws channel_not_found etc. as a platform error.
        const reason = error?.data?.error || 'check_failed';
        console.error('Channel membership check failed:', reason);
        return { ok: false, reason };
    }
}

/** Send an ephemeral message via the Web API (more reliable than response_url). */
async function postEphemeral(channel, user, payload) {
    try {
        const data = await web.chat.postEphemeral({ channel, user, ...payload } as any);
        console.log('postEphemeral OK');
        return data;
    } catch (error: any) {
        console.error('postEphemeral error:', error?.data?.error || error.message);
        return error?.data ?? { ok: false };
    }
}

/** Post a message to a channel via the Web API. */
async function postMessage(channel, payload) {
    try {
        const data = await web.chat.postMessage({ channel, ...payload } as any);
        console.log('postMessage OK');
        return data;
    } catch (error: any) {
        console.error('postMessage error:', error?.data?.error || error.message);
        return error?.data ?? { ok: false };
    }
}

/** Open a modal via views.open. */
async function openModal(triggerId, view) {
    try {
        return await web.views.open({ trigger_id: triggerId, view } as any);
    } catch (error: any) {
        console.error('views.open error:', error?.data?.error || error.message);
        return error?.data ?? { ok: false };
    }
}

/**
 * Fetch a single message by (channel, ts), robust to thread replies.
 * conversations.history (latest=ts) only returns TOP-LEVEL messages; a threaded
 * reply isn't in channel history, so it comes back empty. conversations.replies
 * (ts=…) accepts ANY ts in a thread (parent OR reply), so we fall back to that
 * and match on ts. Returns null if the bot can't see the message.
 */
async function fetchMessage(channel: string, ts: string): Promise<any | null> {
    try {
        const hist: any = await web.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 });
        const top = hist?.messages?.[0];
        if (top && top.ts === ts) return top;

        const rep: any = await web.conversations.replies({ channel, ts, inclusive: true, limit: 100 });
        const match = rep?.messages?.find((m: any) => m.ts === ts);
        if (match) return match;

        return top || null;
    } catch (error: any) {
        console.error('fetchMessage error:', error?.data?.error || error.message);
        return null;
    }
}

/**
 * Fetch the reacted message PLUS a window of surrounding messages for context.
 * thread reply → the whole thread (from conversations.replies), windowed around
 * the target with the parent kept. top-level → conversations.history in both
 * directions (older via latest=, newer via oldest=), merged + time-sorted.
 * Returns { target, surrounding } where surrounding INCLUDES the target.
 */
async function fetchMessageContext(
    channel: string,
    ts: string,
    { before = 8, after = 5 }: { before?: number; after?: number } = {}
): Promise<{ target: any | null; surrounding: any[] }> {
    const dedupSort = (msgs: any[]) => {
        const seen = new Set<string>();
        const out: any[] = [];
        for (const m of msgs) if (m?.ts && !seen.has(m.ts)) seen.add(m.ts), out.push(m);
        return out.sort((a, b) => Number(a.ts) - Number(b.ts));
    };
    try {
        // Older messages + the target itself (history is newest-first).
        const older: any = await web.conversations.history({ channel, latest: ts, inclusive: true, limit: before + 1 });
        const olderMsgs: any[] = older?.messages || [];
        const target = olderMsgs.find((m) => m.ts === ts);

        if (target) {
            // Top-level message → also pull the messages posted AFTER it.
            const newer: any = await web.conversations.history({ channel, oldest: ts, inclusive: false, limit: after });
            return { target, surrounding: dedupSort([...olderMsgs, ...(newer?.messages || [])]) };
        }

        // Not in history → thread reply. The whole thread is one replies call.
        const rep: any = await web.conversations.replies({ channel, ts, inclusive: true, limit: 100 });
        const thread: any[] = rep?.messages || [];
        const tgt = thread.find((m) => m.ts === ts);
        if (!tgt) return { target: null, surrounding: [] };

        const idx = thread.indexOf(tgt);
        const window = thread.slice(Math.max(0, idx - before), idx + after + 1);
        // Always keep the thread parent (thread[0]) as the topic anchor.
        const withParent = idx - before > 0 && thread[0] ? [thread[0], ...window] : window;
        return { target: tgt, surrounding: dedupSort(withParent) };
    } catch (error: any) {
        console.error('fetchMessageContext error:', error?.data?.error || error.message);
        return { target: null, surrounding: [] };
    }
}

// Clank's own Slack identity, memoized across warm invocations so we can tell
// when a reacted message is his (skip it — reacting to his own art shouldn't
// make him "respond" to himself). One auth.test per cold start.
let _botIdentity: { userId: string | null; botId: string | null } | null = null;
async function getBotIdentity(): Promise<{ userId: string | null; botId: string | null }> {
    if (_botIdentity) return _botIdentity;
    try {
        const data: any = await web.auth.test();
        _botIdentity = { userId: data?.user_id || null, botId: data?.bot_id || null };
    } catch (error: any) {
        console.error('auth.test error:', error?.data?.error || error.message);
        _botIdentity = { userId: null, botId: null };
    }
    return _botIdentity;
}

/** True when a fetched message was posted by Clank himself. */
async function isOwnMessage(message: any): Promise<boolean> {
    if (!message) return false;
    const { userId, botId } = await getBotIdentity();
    if (botId && message.bot_id === botId) return true;
    if (userId && message.user === userId) return true;
    // Fallback for when auth.test is unavailable: his images live on the public
    // S3 bucket, so a message carrying one is his.
    return (message.blocks || []).some(
        (b: any) => b.type === 'image' && b.image_url?.includes('clank-image-generator-images')
    );
}

/** Get a shareable permalink for a message (works for thread replies too). */
async function getPermalink(channel: string, messageTs: string): Promise<string | null> {
    try {
        const data: any = await web.chat.getPermalink({ channel, message_ts: messageTs });
        return data?.ok ? data.permalink : null;
    } catch (error: any) {
        console.error('getPermalink error:', error?.data?.error || error.message);
        return null;
    }
}

/** Download a file from Slack using the bot token (not a Web API method). */
async function downloadSlackFile(url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
    return Buffer.from(await res.arrayBuffer());
}

export {
    downloadSlackFile,
    ensureBotInChannel,
    fetchMessage,
    fetchMessageContext,
    getBotIdentity,
    getPermalink,
    isOwnMessage,
    openModal,
    postEphemeral,
    postMessage,
    sendResponse,
};
