// ─── Slack message content extraction (pure) ─────────────────────
// Two readers over a raw Slack message object, shared by the "Ask Clank"
// shortcut and the 🤖-reaction trigger:
//   • extractImage    — the first usable image → reference-image ref
//   • describeMessage — a robust text flattening of EVERYTHING else
//     (text, unfurled links, attached files, and block-only content) so a
//     reacted message becomes a prompt Clank can actually respond to.
// No I/O — pure functions over the message shape Slack hands us.

export interface ExtractedImage {
    url: string;
    name: string;
    mimetype: string | null;
    permalink: string;
    isPublic: boolean;
}

// Implicit contract between describeConversation (which stamps this on the
// reacted line) and the think prompt (which instructs the model to answer the
// message bearing it). Shared so producer + consumer can't silently drift.
import { REACTED_MARKER } from '../../../imageProcessor/summon.js';

export { REACTED_MARKER };

/**
 * Extract the first image from a Slack message (files, attachments, or blocks).
 * Uploaded files come back as private (need the bot token to download);
 * unfurled/block images are already public URLs.
 */
export function extractImage(message: any): ExtractedImage | null {
    // Uploaded files (most common for user-shared images)
    if (message?.files?.length) {
        const img = message.files.find((f: any) => f.mimetype?.startsWith('image/'));
        if (img) {
            return {
                url: img.url_private_download || img.url_private,
                name: img.name,
                mimetype: img.mimetype,
                permalink: img.permalink,
                isPublic: false,
            };
        }
    }
    // Unfurled URL attachments
    if (message?.attachments?.length) {
        const att = message.attachments.find((a: any) => a.image_url);
        if (att) {
            return {
                url: att.image_url,
                name: att.title || att.fallback || 'image',
                mimetype: null,
                permalink: att.original_url || att.image_url,
                isPublic: true,
            };
        }
    }
    // Block Kit image blocks (e.g. Clank's own posted images)
    if (message?.blocks?.length) {
        const imgBlock = message.blocks.find((b: any) => b.type === 'image' && b.image_url);
        if (imgBlock) {
            return {
                url: imgBlock.image_url,
                name: imgBlock.alt_text?.substring(0, 50) || 'image',
                mimetype: null,
                permalink: imgBlock.image_url,
                isPublic: true,
            };
        }
    }
    return null;
}

/** Reconstruct plain text from Block Kit blocks (bot messages sometimes carry
 *  content ONLY in blocks, with an empty top-level `text`). Handles rich_text,
 *  section, header, and context blocks — everything else is skipped. */
function flattenBlocks(blocks: any[]): string {
    const out: string[] = [];

    const walkRich = (elements: any[]): string =>
        (elements || [])
            .map((el: any) => {
                if (el.type === 'text' || el.type === 'emoji') return el.text || el.name || '';
                if (el.type === 'link') return el.text ? `${el.text} (${el.url})` : el.url || '';
                if (el.type === 'user') return el.user_id ? `<@${el.user_id}>` : '';
                if (el.type === 'usergroup') return '@group';
                if (el.type === 'broadcast') return `@${el.range || 'channel'}`;
                if (Array.isArray(el.elements)) return walkRich(el.elements); // nested sections/lists
                return '';
            })
            .join('');

    for (const b of blocks || []) {
        if (b.type === 'rich_text') out.push(walkRich(b.elements));
        else if (b.type === 'section' && b.text?.text) out.push(b.text.text);
        else if (b.type === 'header' && b.text?.text) out.push(b.text.text);
        else if (b.type === 'context') out.push((b.elements || []).map((e: any) => e.text || '').join(' '));
    }
    return out.join('\n').trim();
}

/**
 * Flatten a Slack message into a single prompt string Clank can respond to.
 * Priority: the human-visible text, plus the *content* of any unfurled links
 * (title/description, not just the bare URL) and notes about attached files —
 * so a shared article, a screenshot with a caption, or a doc all arrive as
 * something meaningful, not an empty string. Returns '' when there's genuinely
 * nothing to work with. `hasImage` lets the caller mention that a picture rode
 * along even in a text-only reply.
 */
export function describeMessage(message: any, hasImage = false): string {
    const parts: string[] = [];

    // 1. The message's own text — already carries <url|label> links, <@U…>
    //    mentions and :emoji: which downstream steps understand.
    const text = (message?.text || '').trim();
    if (text) parts.push(text);
    // 1b. …or reconstruct from blocks when there's no top-level text.
    else if (message?.blocks?.length) {
        const blockText = flattenBlocks(message.blocks);
        if (blockText) parts.push(blockText);
    }

    // 2. Unfurled links / legacy attachments → fold in their CONTENT so Clank
    //    reacts to what was shared, not just that something was shared.
    for (const att of message?.attachments || []) {
        const bits = [att.title, att.text].filter(Boolean).join(' — ').trim();
        const url = att.title_link || att.from_url || att.original_url || '';
        if (bits) parts.push(`[Shared link: ${bits}${url ? ` (${url})` : ''}]`);
        else if (url && !text.includes(url)) parts.push(`[Shared link: ${url}]`);
    }

    // 3. Non-image files → note them by name/type (images become the reference).
    for (const f of message?.files || []) {
        if (f.mimetype?.startsWith('image/')) continue;
        const label = [f.name, f.filetype && `(${f.filetype})`].filter(Boolean).join(' ');
        if (label) parts.push(`[Attached file: ${label}]`);
    }

    let combined = parts.join('\n\n').trim();
    if (!combined && hasImage) combined = '[An image, with no caption.]';
    // Keep the think input lean — a pasted wall of text shouldn't blow the turn.
    return combined.slice(0, 2000);
}

/**
 * Render a window of surrounding messages into a compact transcript for the
 * 🤖-reaction trigger, so Clank understands a back-and-forth premise — WITHOUT
 * diluting which message he was actually summoned onto. The reacted message is
 * marked; neighbours are context only. Author labels stay as `<@UID>` so the
 * caller can resolve them with the same resolveMentions pass as the prompt.
 *
 * messages    — ordered oldest→newest, INCLUDING the target (from fetchMessageContext)
 * targetTs    — ts of the reacted message (gets the marker + full flatten)
 * botUserId   — Clank's uid; his messages and other bots are dropped as neighbours
 * Returns '' when there's no useful surrounding context (caller falls back to the
 * single-message framing).
 */
export function describeConversation(
    messages: any[],
    targetTs: string,
    botUserId: string | null = null,
    opts: { perMsgCap?: number; totalCap?: number } = {}
): string {
    const perMsgCap = opts.perMsgCap ?? 350;
    const totalCap = opts.totalCap ?? 3200;
    const lines: string[] = [];
    let total = 0;

    for (const m of messages || []) {
        const isTarget = m?.ts === targetTs;
        // Drop bot/Clank noise from the surrounding context, but NEVER the target.
        if (!isTarget && (m?.bot_id || (botUserId && m?.user === botUserId))) continue;

        // Target gets the full flatten (incl. its image placeholder); neighbours
        // are text-only (an image-only neighbour is noise, not premise).
        const body = describeMessage(m, isTarget ? !!extractImage(m) : false)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, perMsgCap);
        if (!body) continue;

        const who = m?.user ? `<@${m.user}>` : m?.username || 'someone';
        const line = isTarget ? `→ ${who}: ${body}   ${REACTED_MARKER} (respond to THIS)` : `${who}: ${body}`;

        // Budget-limit neighbours, but the target line is always kept.
        if (!isTarget && total + line.length > totalCap) continue;
        lines.push(line);
        total += line.length;
    }

    // Only meaningful when there's more than the target itself.
    return lines.length > 1 ? lines.join('\n') : '';
}
