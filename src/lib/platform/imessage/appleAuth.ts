// ─── Sign in with Apple — identity-token verification ────────────
// The extension sends the identityToken from ASAuthorizationAppleIDCredential;
// we verify it against Apple's published JWKS (RS256) and the claims contract:
// iss = appleid.apple.com, aud ∈ our bundle ids, unexpired. The verified `sub`
// (opaque, stable per user per developer account) IS the user's identity —
// wallet key, roster key, everything. No scopes are requested client-side, so
// this token carries no email or name, by design.

import crypto from 'node:crypto';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISS = 'https://appleid.apple.com';

let jwksCache: { keys: any[]; fetchedAt: number } | null = null;

async function fetchAppleKeys(): Promise<any[]> {
    if (jwksCache && Date.now() - jwksCache.fetchedAt < 3600_000) return jwksCache.keys;
    const res = await fetch(APPLE_JWKS_URL);
    if (!res.ok) throw new Error(`Apple JWKS fetch failed: ${res.status}`);
    const body: any = await res.json();
    jwksCache = { keys: body.keys || [], fetchedAt: Date.now() };
    return jwksCache.keys;
}

/**
 * Verify an Apple identity token. Returns { sub } on success, null on ANY
 * failure. `keysProvider` is injectable for tests (generated RSA JWKs).
 */
export async function verifyAppleIdentityToken(
    idToken: string,
    audiences: string[],
    keysProvider: () => Promise<any[]> = fetchAppleKeys
): Promise<{ sub: string } | null> {
    try {
        const parts = String(idToken).split('.');
        if (parts.length !== 3) return null;

        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        if (header.alg !== 'RS256') return null;
        const keys = await keysProvider();
        const jwk = keys.find((k) => k.kid === header.kid);
        if (!jwk) return null;

        const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
        const signature = Buffer.from(parts[2], 'base64url');
        if (!crypto.verify('RSA-SHA256', signed, publicKey, signature)) return null;

        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        if (claims.iss !== APPLE_ISS) return null;
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!aud.some((a: string) => audiences.includes(a))) return null;
        if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return null;
        if (typeof claims.sub !== 'string' || !claims.sub) return null;

        return { sub: claims.sub };
    } catch {
        return null;
    }
}
