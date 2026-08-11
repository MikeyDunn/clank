// ─── iMessage token signing (sessions + drafts) ──────────────────
// Compact HS256 JWTs via node:crypto — no dependency. Two token kinds share
// this: SESSION tokens (issued by /imessage/auth after Apple-identity or dev
// verification; the client's only credential) and DRAFT tokens (issued by
// /generate, presented to /commit — they carry the render's full evidence so
// two-phase commit needs NO server-side draft storage).

import crypto from 'node:crypto';

const b64u = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

export function signToken(payload: Record<string, any>, secret: string, ttlSec: number): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
    const mac = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${mac}`;
}

/** Verified payload, or null. Constant-time MAC compare; expiry enforced. */
export function verifyToken(token: string, secret: string): Record<string, any> | null {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [header, body, mac] = parts;
    const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest();
    let got: Buffer;
    try {
        got = Buffer.from(mac, 'base64url');
    } catch {
        return null;
    }
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
        return payload;
    } catch {
        return null;
    }
}
