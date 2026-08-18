// ─── Shared art pipeline ─────────────────────────────────────────
// The think→generate→classify core, shared by the /clank + Ask Clank flow
// (index.ts `processImage`) and the 🤖-reaction flow (reactPrompt.ts). Both run
// the SAME fiddly middle — reference-image download, think, image generate +
// transient retry, parse, success/refusal/error classification — and diverge
// only in DELIVERY (ephemeral Send/Cancel gate vs. direct root-channel post).
// This module owns the shared middle; each caller keeps its own remember() +
// delivery. Add a third caller (@mentions, DMs) and it reuses this, not a copy.

import { downloadSlackFile } from '../platform/slack/index.js';
import { LEGACY_SCOPE, type VectorScope } from '../vectors.js';
import { generateImage } from './generate.js';
import { classifyAxiosError, parseResponse, RETRYABLE_ERRORS } from './parse.js';
import { type ChannelContext, type MessageContext, type SummonContext, type ThinkImage, think } from './think.js';
import { detectImageMime } from './upload.js';

// ── Reference image → base64 data URI (shared download + magic-byte sniff) ──
export type RefDownload = { ok: true; base64: string | null } | { ok: false; reason: 'invalid' | 'download' };

/**
 * Download a Slack/public reference image and return it as a base64 data URI.
 * `ok:true, base64:null` means "no reference was provided" (nothing to do).
 * `ok:false` distinguishes an unreadable image ('invalid') from a fetch failure
 * ('download') so the caller can word its own message; reactPrompt treats both
 * as "no reference" and carries on, /clank bails.
 */
/** fetch, optionally refusing redirects (a 3xx throws instead of being followed
 *  to a possibly-different host). */
async function fetchNoRedirect(url: string, noRedirect: boolean): Promise<Response> {
    if (!noRedirect) return fetch(url);
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) throw new Error(`refused redirect (${res.status})`);
    return res;
}

export async function downloadReferenceImage(referenceImage: any): Promise<RefDownload> {
    if (!referenceImage?.url) return { ok: true, base64: null };
    try {
        // `noRedirect` (iMessage riff path): the URL host was pinned to our own
        // S3 bucket by the caller, so a 3xx to ANOTHER host would be the exact
        // SSRF the host-pin exists to prevent — refuse to follow it. Slack/
        // Discord paths don't set it (their CDNs legitimately redirect).
        const buf = referenceImage.isPublic
            ? Buffer.from(
                  await (await fetchNoRedirect(referenceImage.url, referenceImage.noRedirect === true)).arrayBuffer()
              )
            : await downloadSlackFile(referenceImage.url);
        const mime = detectImageMime(buf);
        if (!mime) {
            console.error('Invalid reference image. First bytes:', buf.slice(0, 20).toString('hex'));
            return { ok: false, reason: 'invalid' };
        }
        console.log('Reference image downloaded:', referenceImage.name, `${Math.round(buf.length / 1024)}KB`);
        return { ok: true, base64: `data:${mime};base64,${buf.toString('base64')}` };
    } catch (err: any) {
        console.error('Failed to download reference image:', err.message);
        return { ok: false, reason: 'download' };
    }
}

// ── think → generate → classify (shared) ──
// A discriminated result the caller switches on. `cost` is cumulative through
// generation (think + image); the caller adds any delivery-phase cost (e.g. a
// refusal reaction).
export type ArtOutcome =
    | { kind: 'think_error'; thinkResult: any; cost: number }
    | { kind: 'text'; thinkResult: any; cost: number }
    | { kind: 'generation_error'; thinkResult: any; genResult: any; imagePrompt: string; cost: number }
    | { kind: 'image'; thinkResult: any; result: any; imagePrompt: string; cost: number }
    | { kind: 'refusal'; thinkResult: any; result: any; imagePrompt: string; cost: number };

export interface ArtPipelineInput {
    prompt: string;
    context: string;
    referenceImageBase64?: string | null;
    // Images from the surrounding conversation (the summon window) shown to Clank
    // as CONTEXT — he decides if any are integral. Capped below. Never auto-sent
    // to the image model; only ids Clank names in `references` reach his hands.
    contextImages?: { base64: string; note?: string | null }[];
    // Where the request came from (room + space) — ephemeral, never persisted.
    channel?: ChannelContext | null;
    messageContext?: MessageContext | null;
    requester?: string | null;
    tokenMap?: Record<string, string[]>;
    summon?: SummonContext | null;
    // The mind's vector store (bucket/index/tenant) for lore recall. Defaults to
    // the Slack store, so untenanted (Slack) callers are unchanged.
    vectorScope?: VectorScope;
    // Called once before a transient-error retry (e.g. to post a "retrying…"
    // notice). Omit for a silent retry.
    onRetry?: ((errorType: string) => Promise<void> | void) | null;
    /** Absolute epoch-ms deadline (Lambda start + getRemainingTimeInMillis).
     *  Generation attempts budget themselves against it; null = legacy caps. */
    deadlineMs?: number | null;
}

// A retry only makes sense with enough runway for a real attempt: the 10s
// generation floor + the 20s delivery reserve + margin. Below this, skip
// straight to the error path so the user gets a message instead of a dead Lambda.
const RETRY_MIN_BUDGET_MS = 45_000;

// Cap on context images shown to think (a summon window can hold many; each is
// re-read per tool-loop turn, so this is the real cost lever). The primary
// reference is separate and always shown.
const MAX_CONTEXT_IMAGES = 3;
// Cap on images actually forwarded to the image model, in case Clank names many.
const MAX_GEN_REFS = 3;

/** Map Clank's chosen image ids back to data URIs for the generator. Field
 *  omitted (not an array) → the primary image if one exists (legacy default).
 *  Explicit empty array → no reference (pure imagination). Unknown ids are
 *  dropped; the result is capped. */
export function resolveReferences(images: ThinkImage[], references: unknown): string[] {
    const byId = new Map(images.map((i) => [i.id, i.base64]));
    if (Array.isArray(references)) {
        return references
            .filter((r): r is string => typeof r === 'string')
            .map((id) => byId.get(id))
            .filter((b): b is string => !!b)
            .slice(0, MAX_GEN_REFS);
    }
    const primary = images.find((i) => i.role === 'primary');
    return primary ? [primary.base64] : [];
}

export async function runArtPipeline({
    prompt,
    context,
    referenceImageBase64 = null,
    contextImages = [],
    channel = null,
    messageContext = null,
    requester = null,
    tokenMap = {},
    summon = null,
    vectorScope = LEGACY_SCOPE,
    onRetry = null,
    deadlineMs = null,
}: ArtPipelineInput): Promise<ArtOutcome> {
    // The labeled image set Clank sees: the primary reference (the subject —
    // always shown) plus a capped set of context images from the surrounding
    // conversation. Cost lives here (each is re-read per tool turn), so the
    // context set is bounded; which of them reach his hands is nearly free and
    // is Clank's call (`references`).
    const images: ThinkImage[] = [];
    if (referenceImageBase64) images.push({ id: 'primary', base64: referenceImageBase64, role: 'primary' });
    for (const [i, c] of contextImages.slice(0, MAX_CONTEXT_IMAGES).entries()) {
        images.push({ id: `ctx${i + 1}`, base64: c.base64, role: 'context', note: c.note ?? null });
    }

    const thinkResult = await think(
        prompt,
        context,
        images,
        messageContext,
        requester,
        tokenMap,
        summon,
        null,
        vectorScope,
        channel
    );
    let cost = thinkResult.cost || 0;

    if (thinkResult.error || (!thinkResult.response && !thinkResult.imagePrompt))
        return { kind: 'think_error', thinkResult, cost };
    if (thinkResult.type === 'text') return { kind: 'text', thinkResult, cost };

    // ── IMAGE: generate, retry once on a transient error, then classify. ──
    const imagePrompt = thinkResult.imagePrompt || prompt;
    console.log('Image prompt:', imagePrompt.substring(0, 200));

    // Which images reach Clank's hands: the ids HE chose (`references`), mapped
    // back to data. Omitted → the primary reference (legacy default); [] → none.
    const genRefs = resolveReferences(images, thinkResult.references);
    if (genRefs.length) console.log(`Generate refs: ${genRefs.length}`);

    let genResult = await generateImage(imagePrompt, genRefs, null, deadlineMs);
    if (genResult.error) {
        const { errorType } = classifyAxiosError(genResult.error);
        const budgetLeft = deadlineMs ? deadlineMs - Date.now() : Number.POSITIVE_INFINITY;
        if (RETRYABLE_ERRORS.has(errorType) && budgetLeft > RETRY_MIN_BUDGET_MS) {
            console.log(`Retrying after transient error: ${errorType} (${Math.round(budgetLeft / 1000)}s left)`);
            if (onRetry) await onRetry(errorType);
            genResult = await generateImage(imagePrompt, genRefs, null, deadlineMs);
        } else if (RETRYABLE_ERRORS.has(errorType)) {
            console.log(`Skipping retry for ${errorType}: only ${Math.round(budgetLeft / 1000)}s of budget left`);
        }
    }
    if (genResult.error) return { kind: 'generation_error', thinkResult, genResult, imagePrompt, cost };

    const result = parseResponse(genResult.response, genResult.startTime);
    const genCost = result.cost || 0;
    cost += genCost;
    console.log(`Generation cost: $${genCost.toFixed(4)}, total: $${cost.toFixed(4)}`);

    return result.outcome === 'success'
        ? { kind: 'image', thinkResult, result, imagePrompt, cost }
        : { kind: 'refusal', thinkResult, result, imagePrompt, cost };
}
