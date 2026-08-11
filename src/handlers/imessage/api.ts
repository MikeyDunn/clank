// ─── iMessage API (Lambda Function URL, not API Gateway) ─────────
// One Lambda, three POST paths: /auth, /generate, /commit. A Function URL
// because /generate runs the full think→generate pipeline SYNCHRONOUSLY
// (30-120s) — API Gateway's hard 29s integration timeout can't carry it, and
// the extension is a patient HTTP client (unlike Slack/Discord's 3s acks).
//
// TWO-PHASE COMMIT (the spec's Gap 2): on iMessage, Clank can't deliver his
// own output — the USER decides whether to insert the rendered bubble. So
// /generate runs the pipeline and returns a signed DRAFT token (the render's
// full evidence, no server-side storage), and only /commit — called after the
// client actually inserts the message — writes tenant memory. Generate-then-
// discard never poisons the shared mind.
//
// Tenancy: chatId is a client-minted-or-server-minted UUID (never derived from
// Apple identifiers); tenant = imessage:<chatId> on the PROD stores via
// memory.forTenant — same seam as Discord guilds.
//
// METERING: deliberately NOT engaged yet (no mind.reserve/charge). The seams
// exist; they switch on when StoreKit transaction verification lands. Until
// then this surface is dev-gated (see auth) rather than metered.

import crypto from 'node:crypto';
import { trunc } from '../../lib/format.js';
import { downloadReferenceImage, runArtPipeline } from '../../lib/imageProcessor/pipeline.js';
import { detectImageMime, uploadImageToS3 } from '../../lib/imageProcessor/upload.js';
import * as memory from '../../lib/memory/index.js';
import { createGlobalMeterStore } from '../../lib/memory/meterStore.js';
import { tenantId } from '../../lib/memory/tenant.js';
import { MODEL_ROLES } from '../../lib/models.js';
import { verifyAppleIdentityToken } from '../../lib/platform/imessage/appleAuth.js';
import { signToken, verifyToken } from '../../lib/platform/imessage/token.js';

const SESSION_TTL_SEC = 30 * 86400; // sessions live on-device in the keychain
const DRAFT_TTL_SEC = 24 * 3600; // long: commit fires at INSERT (client-side, reliable) and
// may be RETRIED on next extension activation if the pane died mid-call — the
// TTL must outlive that retry window. Anti-poisoning no longer rides on the
// TTL: a draft that is never inserted is simply never committed.

const json = (statusCode: number, body: Record<string, any>) => ({
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
});

export const handleImessage = async (event: any, lambdaCtx: any = null) => {
    const path: string = event.rawPath || event.path || '';
    const method: string = event.requestContext?.http?.method || event.httpMethod || '';
    if (method !== 'POST') return json(405, { error: 'POST only' });

    const secret = process.env.IMESSAGE_TOKEN_SECRET;
    if (!secret) {
        console.error('IMESSAGE_TOKEN_SECRET not set');
        return json(500, { error: 'server not configured' });
    }

    let body: any = {};
    try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '{}';
        body = JSON.parse(raw);
    } catch {
        return json(400, { error: 'invalid JSON' });
    }

    try {
        if (path.endsWith('/auth')) return await auth(body, secret);

        // Everything else requires a session.
        const session = verifyToken(String(body.session || ''), secret);
        if (!session?.userId) return json(401, { error: 'invalid session' });

        if (path.endsWith('/generate')) return await generate(body, session, secret, lambdaCtx);
        if (path.endsWith('/commit')) return await commit(body, session, secret);
        if (path.endsWith('/info')) return await info(body);
        return json(404, { error: 'unknown path' });
    } catch (error: any) {
        console.error('imessage api error:', error);
        return json(500, { error: 'internal error' });
    }
};

// ── /auth: Apple identity token (real) or dev key (simulator demo) ──
async function auth(body: any, secret: string) {
    // Real path: the identityToken from ASAuthorizationAppleIDCredential.
    if (body.identityToken) {
        const audiences = (process.env.IMESSAGE_BUNDLE_IDS || '').split(',').filter(Boolean);
        const verified = await verifyAppleIdentityToken(String(body.identityToken), audiences);
        if (!verified) return json(401, { error: 'invalid identity token' });
        const userId = `apple:${verified.sub}`;
        await captureName(userId, body);
        console.log(`Auth OK (apple) for ${userId.slice(0, 18)}…`);
        return json(200, { session: signToken({ userId }, secret, SESSION_TTL_SEC), userId });
    }

    // SIMULATOR DEV AUTH — kept for the demo build, safe by construction.
    // SIWA can't run in the iOS Simulator, so the demo authenticates with a
    // shared dev key. This path is:
    //   • OFF by default — requires the explicit IMESSAGE_DEV_AUTH=1 opt-in, so a
    //     real launch just leaves it unset and this branch is dead code;
    //   • unusable without the key VALUE, which lives only in .env (never in the
    //     repo), so no reader of this source can mint a session;
    //   • privilege-free — issues a dev-namespaced identity (apple:dev-*),
    //     rate-limited like any request, with no credit or payment ability.
    if (process.env.IMESSAGE_DEV_AUTH === '1') {
        const devKey = process.env.IMESSAGE_DEV_KEY;
        if (devKey && body.devKey === devKey && typeof body.deviceId === 'string' && body.deviceId) {
            const userId = `apple:dev-${body.deviceId.slice(0, 40)}`;
            await captureName(userId, body);
            console.warn(`Auth OK (DEV AUTH is ENABLED) for ${userId} — must be OFF in any launched deployment`);
            return json(200, { session: signToken({ userId, dev: true }, secret, SESSION_TTL_SEC), userId });
        }
    }

    return json(401, { error: 'no credentials' });
}

/** Silent first-auth name capture (SIWA sends it exactly once; if_not_exists
 *  means a later nil auth can never erase it). Never asked of the user. */
async function captureName(userId: string, body: any) {
    const given = typeof body.givenName === 'string' ? body.givenName.trim().slice(0, 40) : '';
    if (!given) return;
    const familyInitial =
        typeof body.familyName === 'string' && body.familyName.trim() ? body.familyName.trim()[0].toUpperCase() : null;
    const accounts = createGlobalMeterStore(process.env.PROD_DYNAMODB_TABLE_NAME || '');
    await accounts.setNameOnce(userId, given, familyInitial);
}

/** True only for an https URL whose HOST is exactly our images bucket's S3
 *  virtual-host (path- or region-style), with no userinfo. Host-EXACT, never a
 *  prefix — a startsWith check is trivially bypassed by an attacker-owned host
 *  that begins with the bucket name. */
function isOwnImageUrl(raw: string): boolean {
    const bucket = process.env.S3_BUCKET_NAME || '';
    if (!bucket) return false;
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return false;
    }
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    // Virtual-hosted S3, host-exact: <bucket>.s3.amazonaws.com or
    // <bucket>.s3.<region>.amazonaws.com — an allowlisted set, no prefixes.
    const region = process.env.AWS_REGION || 'us-east-1';
    return host === `${bucket}.s3.amazonaws.com` || host === `${bucket}.s3.${region}.amazonaws.com`;
}

// Minimum seconds between a user's renders — a hard cost-DoS floor independent
// of (and beneath) the eventual credit metering. Atomic: one conditional write
// per userId serialises concurrent requests, so N parallel calls can't slip
// past it. Env-tunable.
const GENERATE_COOLDOWN_MS = Number(process.env.IMESSAGE_COOLDOWN_SEC || 8) * 1000;

// ── /generate: run the pipeline, return a draft — write NOTHING ──
async function generate(body: any, session: any, secret: string, lambdaCtx: any) {
    const prompt = String(body.prompt || '')
        .trim()
        .slice(0, 1000);
    if (!prompt) return json(400, { error: 'prompt required' });

    // Rate gate FIRST — a throttled request must cost nothing (no pipeline, no
    // tokens). Atomic claim on the global per-user row, so it can't be raced.
    const accounts = createGlobalMeterStore(process.env.PROD_DYNAMODB_TABLE_NAME || '');
    const allowed = await accounts.claimCooldown(session.userId, Date.now(), GENERATE_COOLDOWN_MS);
    if (!allowed) {
        return json(429, { kind: 'error', message: 'One at a time — give Clank a few seconds.' });
    }

    // chatId: adopt the client's (from a tapped payload) or mint. Only ever a
    // UUID — never derived from Apple conversation/participant identifiers.
    const chatId =
        typeof body.chatId === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(body.chatId)
            ? body.chatId.toLowerCase()
            : crypto.randomUUID();
    const tenant = tenantId('imessage', chatId);
    const mind = memory.forTenant({ tenant });

    // Name: resolved SERVER-side from the account record (captured silently at
    // auth) — the client never sends or manages names. Collisions between two
    // two people with the same first name auto-resolve the way a group would ("Alex" → "Alex S." →
    // numbered) via the same TOFU claim that blocks impersonation. Nobody is
    // ever asked anything.
    const displayName = await resolveTenantName(mind, session.userId);

    const deadlineMs = lambdaCtx?.getRemainingTimeInMillis ? Date.now() + lambdaCtx.getRemainingTimeInMillis() : null;

    // ── Single reference slot (Mike's rule: never more than one) ──
    // EITHER a riff on one of our own renders (S3 URL from a tapped bubble's
    // payload) OR a user-supplied photo (data URL). URL wins if both arrive.
    let referenceImageBase64: string | null = null;
    let referenceUrl: string | null = null;
    const refUrl = typeof body.referenceImageUrl === 'string' ? body.referenceImageUrl : null;
    const refData = typeof body.referenceImageBase64 === 'string' ? body.referenceImageBase64 : null;
    if (refUrl) {
        // SSRF guard: riffs may only reference OUR rendered images. Parse the
        // URL and match the HOST EXACTLY — a startsWith() prefix check is
        // bypassable (…images-dev.s3.evil.com passes a prefix, fails a host
        // match). Reject userinfo/non-https too.
        if (!isOwnImageUrl(refUrl)) {
            return json(400, { error: 'invalid reference url' });
        }
        const ref = await downloadReferenceImage({ url: refUrl, isPublic: true, noRedirect: true, name: 'riff' });
        if (!ref.ok || !ref.base64)
            return json(200, { kind: 'error', message: "Couldn't load that render to riff on." });
        referenceImageBase64 = ref.base64;
        referenceUrl = refUrl;
    } else if (refData) {
        if (refData.length > 8_000_000) return json(400, { error: 'reference too large' });
        const match = refData.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
        if (!match) return json(400, { error: 'invalid reference data' });
        const buf = Buffer.from(match[1], 'base64');
        const mime = detectImageMime(buf); // magic bytes, not the client's claim
        if (!mime) return json(400, { error: 'invalid reference image' });
        referenceImageBase64 = `data:${mime};base64,${buf.toString('base64')}`;
    }

    const context = await mind.buildContext(session.userId);
    const pipe = await runArtPipeline({
        prompt,
        context,
        referenceImageBase64,
        requester: displayName,
        vectorScope: mind.vectorScope,
        deadlineMs,
    });
    console.log(`[imessage] ${tenant.slice(0, 30)} kind=${pipe.kind} cost=$${(pipe.cost || 0).toFixed(4)}`);

    // Refusals/errors are NEVER remembered here: nothing was inserted into the
    // chat, so committing them would give the mind memories of moments the
    // group never saw. Generic message, real reason in the logs (platform rule).
    if (pipe.kind === 'refusal') {
        console.log(`[imessage] refusal: ${trunc(pipe.result?.textResponse || '', 200)}`);
        return json(200, {
            kind: 'error',
            message: 'That prompt was declined by the content filter. Rephrasing usually works.',
        });
    }
    if (pipe.kind === 'think_error' || pipe.kind === 'generation_error') {
        console.error(
            `[imessage] ${pipe.kind}:`,
            (pipe as any).genResult?.error?.message || (pipe as any).thinkResult?.error
        );
        return json(200, { kind: 'error', message: 'Something went wrong. Try again.' });
    }

    // Draft: the full evidence of the render, signed. Commit verifies + writes.
    // historyId pre-minted HERE so the inserted bubble's payload can carry it.
    const historyId = crypto.randomUUID();
    const base = {
        v: 1,
        jti: crypto.randomUUID(),
        historyId,
        tenant,
        chatId,
        userId: session.userId,
        displayName,
        prompt,
        thoughts: trunc(pipe.thinkResult.thoughts || '', 600),
        referenceUrl,
        cost: pipe.cost || 0,
    };

    if (pipe.kind === 'text') {
        const response = (pipe.thinkResult.response || '').trim();
        const draft = signToken(
            { ...base, kind: 'text', response: trunc(response, 500), model: MODEL_ROLES.text },
            secret,
            DRAFT_TTL_SEC
        );
        return json(200, { kind: 'text', chatId, historyId, text: response, draft });
    }

    // kind === 'image'
    const publicUrl = await uploadImageToS3(pipe.result.imageUrl, prompt);
    const draft = signToken(
        {
            ...base,
            kind: 'image',
            imageUrl: publicUrl,
            imagePrompt: trunc(pipe.imagePrompt || '', 1800),
            model: MODEL_ROLES.image,
        },
        secret,
        DRAFT_TTL_SEC
    );
    return json(200, { kind: 'image', chatId, historyId, imageUrl: publicUrl, thoughts: base.thoughts, draft });
}

/** The requester's name IN THIS CHAT: account givenName, auto-disambiguated on
 *  collision. Deterministic — the claim loop lands on the same name every time
 *  (owned claims return true for their owner). Null if the account has no name
 *  (then the requester is simply anonymous in the roster). */
async function resolveTenantName(mind: memory.Mind, userId: string): Promise<string | null> {
    const accounts = createGlobalMeterStore(process.env.PROD_DYNAMODB_TABLE_NAME || '');
    const acct = await accounts.getUserMeter(userId);
    const given = acct.givenName;
    if (!given) return null;
    const candidates = [given];
    if (acct.familyInitial) candidates.push(`${given} ${acct.familyInitial}.`);
    for (let n = 2; n <= 5; n++) candidates.push(`${given} ${acct.familyInitial || ''}${n}`.trim());
    for (const candidate of candidates) {
        if (await mind.claimName(userId, candidate)) return candidate;
    }
    return null; // 5+ same-named people in one chat — anonymous beats wrong
}

// ── /info: the mind indicator — how much of a HISTORY does this chat's Clank
// have? A relationship, not a counter: renders, how long he's been here, and
// how many of the room he knows. All from existing Mind reads (roster profiles
// carry firstSeen, written on each person's first render).
async function info(body: any) {
    const chatId = String(body.chatId || '');
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(chatId)) return json(400, { error: 'chatId required' });
    const mind = memory.forTenant({ tenant: tenantId('imessage', chatId.toLowerCase()) });
    const [memories, profiles] = await Promise.all([mind.historyCount(), mind.scanUserProfiles()]);
    const firstSeen = profiles
        .map((p: any) => p.firstSeen)
        .filter(Boolean)
        .sort()[0];
    return json(200, {
        memories,
        people: profiles.length,
        // ISO of the oldest render; client turns it into "3 months".
        since: firstSeen || null,
    });
}

// ── /commit: the client inserted the bubble — NOW it becomes memory ──
async function commit(body: any, session: any, secret: string) {
    const draft = verifyToken(String(body.draft || ''), secret);
    if (!draft?.tenant || !draft.kind) return json(401, { error: 'invalid draft' });
    // A draft is only committable by the session that generated it.
    if (draft.userId !== session.userId) return json(401, { error: 'not your draft' });

    // NOTE: replay of the same draft within its 15min TTL would duplicate the
    // memory row. Accepted for the demo (client calls commit once); a
    // conditional-write claim on jti (REACTED#-style) closes it later.
    const mind = memory.forTenant({ tenant: draft.tenant });
    const { historyId } = await mind.remember(
        draft.prompt,
        draft.thoughts || '',
        draft.kind === 'text' ? 'text_only' : 'success',
        session.userId,
        { handle: draft.displayName || null, displayName: draft.displayName || null, source: 'imessage' },
        {
            historyId: draft.historyId || null,
            referenceUrl: draft.referenceUrl || null,
            model: draft.model || null,
            cost: draft.cost || 0,
            imageUrl: draft.imageUrl || null,
            imagePrompt: draft.imagePrompt || null,
            publicResponse: draft.kind === 'text' ? draft.response || null : null,
        }
    );
    // Reflection AFTER the write, failures swallowed inside — never breaks commit.
    await mind.maybeReflect();
    console.log(`[imessage] committed ${draft.kind} ${historyId} to ${String(draft.tenant).slice(0, 30)}`);
    return json(200, { ok: true, historyId, chatId: draft.chatId });
}
