// ─── Slack request verification ──────────────────────────────────
// Signature verification for inbound Slack webhooks (replay + timing safe).

import crypto from 'node:crypto';

/** Case-insensitive header lookup (API Gateway header casing varies). */
function getHeader(headers, name) {
    const lower = name.toLowerCase();
    for (const key in headers) {
        if (key.toLowerCase() === lower) return headers[key];
    }
    return undefined;
}

/** Verify a Slack request signature (replay-safe, timing-safe). */
function verifyRequest(event) {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    const signature = getHeader(event.headers, 'x-slack-signature');
    const timestamp = getHeader(event.headers, 'x-slack-request-timestamp');
    const body = event.body;

    if (!signingSecret || !signature || !timestamp || !body) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;

    const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`, 'utf8').digest('hex')}`;

    // timingSafeEqual THROWS on a length mismatch, so a truncated signature would
    // escape as a 5xx instead of a clean 401. Length is not a secret; compare it first.
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

export { verifyRequest };
