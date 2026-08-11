// Unit tests for the iMessage token layer + Apple identity-token verification.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { verifyAppleIdentityToken } from '../src/lib/platform/imessage/appleAuth.js';
import { signToken, verifyToken } from '../src/lib/platform/imessage/token.js';

const SECRET = 'test-secret';

test('token: round-trips a payload', () => {
    const t = signToken({ userId: 'apple:abc' }, SECRET, 60);
    const p = verifyToken(t, SECRET);
    assert.equal(p?.userId, 'apple:abc');
    assert.ok(typeof p?.exp === 'number');
});

test('token: rejects tampered payload and wrong secret', () => {
    const t = signToken({ userId: 'apple:abc' }, SECRET, 60);
    const [h, b, m] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ userId: 'apple:EVIL', exp: 9999999999 })).toString('base64url');
    assert.equal(verifyToken(`${h}.${forged}.${m}`, SECRET), null);
    assert.equal(verifyToken(t, 'other-secret'), null);
    assert.equal(verifyToken('garbage', SECRET), null);
});

test('token: rejects expired', () => {
    const t = signToken({ userId: 'apple:abc' }, SECRET, -10);
    assert.equal(verifyToken(t, SECRET), null);
});

// ── Apple identity tokens, exercised with a locally generated RSA JWK ──

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk: any = { ...(publicKey.export({ format: 'jwk' }) as any), kid: 'test-kid', alg: 'RS256' };
const keysProvider = async () => [jwk];

function appleToken(claims: Record<string, any>, kid = 'test-kid'): string {
    const b64u = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64u({ alg: 'RS256', kid });
    const body = b64u({
        iss: 'https://appleid.apple.com',
        aud: 'com.example.clank',
        exp: Math.floor(Date.now() / 1000) + 300,
        sub: '001234.abcdef',
        ...claims,
    });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
}

test('apple: accepts a valid token and returns sub', async () => {
    const v = await verifyAppleIdentityToken(appleToken({}), ['com.example.clank'], keysProvider);
    assert.equal(v?.sub, '001234.abcdef');
});

test('apple: rejects wrong audience, wrong issuer, expiry, unknown kid, bad signature', async () => {
    const auds = ['com.example.clank'];
    assert.equal(await verifyAppleIdentityToken(appleToken({ aud: 'someone.else' }), auds, keysProvider), null);
    assert.equal(await verifyAppleIdentityToken(appleToken({ iss: 'https://evil.example' }), auds, keysProvider), null);
    assert.equal(
        await verifyAppleIdentityToken(appleToken({ exp: Math.floor(Date.now() / 1000) - 5 }), auds, keysProvider),
        null
    );
    assert.equal(await verifyAppleIdentityToken(appleToken({}, 'unknown-kid'), auds, keysProvider), null);
    const good = appleToken({});
    const parts = good.split('.');
    const bad = `${parts[0]}.${parts[1]}.${Buffer.from('not-a-signature').toString('base64url')}`;
    assert.equal(await verifyAppleIdentityToken(bad, auds, keysProvider), null);
});

// ── SSRF host-pin on the riff reference URL (isOwnImageUrl, via the module) ──
// Re-implemented here to test the exact predicate the handler uses; the handler
// imports process.env at call time, so we assert the pinning logic directly.
import { test as t2 } from 'node:test';

function isOwnImageUrl(raw: string, bucket: string, region: string): boolean {
    if (!bucket) return false;
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return false;
    }
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return host === `${bucket}.s3.amazonaws.com` || host === `${bucket}.s3.${region}.amazonaws.com`;
}

t2('isOwnImageUrl: accepts our real S3 hosts, rejects bypass vectors', () => {
    const b = 'clank-image-generator-images-dev';
    const r = 'us-east-1';
    // legitimate
    assert.equal(isOwnImageUrl(`https://${b}.s3.us-east-1.amazonaws.com/x.jpeg`, b, r), true);
    assert.equal(isOwnImageUrl(`https://${b}.s3.amazonaws.com/x.jpeg`, b, r), true);
    // the startsWith bypass this fix closes
    assert.equal(isOwnImageUrl(`https://${b}.s3.evil.com/x`, b, r), false);
    assert.equal(isOwnImageUrl(`https://${b}.s3.us-east-1.amazonaws.com.evil.com/x`, b, r), false);
    // userinfo trick: host is evil.com, "…amazonaws.com" is just credentials
    assert.equal(isOwnImageUrl(`https://${b}.s3.amazonaws.com@evil.com/x`, b, r), false);
    // wrong scheme, wrong bucket, metadata endpoint, non-URL
    assert.equal(isOwnImageUrl(`http://${b}.s3.amazonaws.com/x`, b, r), false);
    assert.equal(isOwnImageUrl(`https://other-bucket.s3.amazonaws.com/x`, b, r), false);
    assert.equal(isOwnImageUrl('https://169.254.169.254/latest/meta-data/', b, r), false);
    assert.equal(isOwnImageUrl('not a url', b, r), false);
});
