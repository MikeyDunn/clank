// ─── Discord message reader ──────────────────────────────────────
// Reads a message from an interaction's `data.resolved.messages` (what a MESSAGE
// context-menu command — "Summon Clank" — delivers) into the pieces Clank needs:
// its text and the first image attachment. The Discord twin of the Slack
// messageContent reader; Discord's message shape (content + attachments) differs
// from Slack's (files/blocks), so it's its own small function.

export interface DiscordMessageContent {
    text: string;
    imageUrl: string | null;
    authorName: string | null;
    authorId: string | null;
    /** The replied-to message, IF the picked message is a reply AND Discord
     *  inlined it (`referenced_message`). Often only a pointer is present, in
     *  which case we can't see it without channel-read — so this is null then. */
    parent: { text: string; authorName: string | null } | null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function firstImage(attachments: any[]): any {
    return attachments.find((a) => (a.content_type || '').startsWith('image/') || IMAGE_EXT.test(a.filename || ''));
}

/** The image URL on a message: a real attachment first, else an EMBED image.
 *  Embeds cover the very common case of a message that's just a pasted image
 *  link (or a link unfurl) — without this, "Summon Clank" on one of those loses the
 *  picture entirely and can even report "nothing to work with". */
function imageUrlOf(msg: any): string | null {
    const attached = firstImage(msg?.attachments || []);
    if (attached?.url) return attached.url;
    for (const e of msg?.embeds || []) {
        const url = e?.image?.url || e?.thumbnail?.url;
        if (url) return url;
    }
    return null;
}

const authorName = (m: any): string | null => m?.author?.global_name || m?.author?.username || null;

/** Extract text + first image attachment + author (+ inlined reply-parent) from
 *  a Discord message. */
export function readDiscordMessage(msg: any): DiscordMessageContent {
    const imageUrl = imageUrlOf(msg);
    const content = (msg?.content || '').trim();
    const text = content || (imageUrl ? '[An image, with no caption.]' : '');

    // Free premise context: if this is a reply and the parent is inlined, keep it.
    const ref = msg?.referenced_message;
    const refText = ref ? (ref.content || '').trim() || (imageUrlOf(ref) ? '[an image]' : '') : '';
    const parent = refText ? { text: refText, authorName: authorName(ref) } : null;

    return {
        text,
        imageUrl,
        authorName: authorName(msg),
        authorId: msg?.author?.id || null,
        parent,
    };
}
