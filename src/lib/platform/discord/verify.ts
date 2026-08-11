// ─── Discord interaction verification ────────────────────────────
// Delegates the Ed25519 crypto to `discord-interactions` (verifyKey); this
// module just adapts the Lambda event (header casing, base64 body) to it.
// Discord de-registers the interactions URL if verification ever fails its
// routine pings, so the handler returns 401 on a false result.
//   headers: X-Signature-Ed25519 (hex) · X-Signature-Timestamp
//   key:     DISCORD_PUBLIC_KEY (hex, from the Developer Portal)

import { verifyKey } from 'discord-interactions';

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';

/** Case-insensitive header lookup — API Gateway header casing varies. */
function header(headers: Record<string, string | undefined> | undefined, name: string): string {
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers || {})) if (k.toLowerCase() === lower) return headers?.[k] || '';
    return '';
}

/** Raw request body as a string (API Gateway may base64-encode it). */
export function rawBody(event: any): string {
    if (event?.body == null) return '';
    return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : String(event.body);
}

/**
 * Verify a Discord interaction request (async — discord-interactions v4 uses
 * Web Crypto). True only if the Ed25519 signature over (timestamp + rawBody)
 * checks out against DISCORD_PUBLIC_KEY.
 */
export async function verifyDiscordRequest(event: any): Promise<boolean> {
    const signature = header(event?.headers, 'X-Signature-Ed25519');
    const timestamp = header(event?.headers, 'X-Signature-Timestamp');
    if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) return false;
    try {
        return await verifyKey(rawBody(event), signature, timestamp, DISCORD_PUBLIC_KEY);
    } catch (err: any) {
        console.error('Discord verify error:', err.message);
        return false;
    }
}
