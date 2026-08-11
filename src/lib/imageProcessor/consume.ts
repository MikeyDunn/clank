// ─── Outcome consumer ────────────────────────────────────────────
// The shared BACK half of a request. runArtPipeline produces an ArtOutcome;
// this owns the remember → maybeReflect → outcome-classification
// bookkeeping that was triplicated across /clank (index.ts), the 🤖-reaction
// (reactPrompt.ts) and Discord (discord/processor.ts). The actual "show it to
// the user" step is the only thing that differs per platform, so it's delegated
// to a small DeliveryAdapter whose 3 methods each close over the caller's
// request context (channel, credit line, response sink…).

import { elapsed, fmtCost, trunc } from '../format.js';
import { legacyMind, type Mind } from '../memory/index.js';
import { getModelInfo, MODEL_ROLES } from '../models.js';
import { classifyAxiosError, getUserFriendlyError } from './parse.js';
import type { ArtOutcome } from './pipeline.js';
import { uploadImageToS3 } from './upload.js';

export interface DeliveryAdapter {
    /** A finished image (already uploaded to S3). The adapter builds its own
     *  stats/credit line + reference display from its closed-over context. */
    image(a: {
        publicUrl: string;
        thoughts: string;
        modelName: string;
        duration: string;
        cost: string;
        fromWolf: boolean;
    }): Promise<void>;
    /** A line of Clank's text — a text response, a refusal, an in-character note. */
    text(a: { text: string; modelName: string; cost: string }): Promise<void>;
    /** A technical failure (ephemeral to the requester on Slack, edited reply on Discord). */
    error(message: string): Promise<void>;
}

/**
 * Reflection is a full LLM call (~$0.14, tens of seconds) that fires every 50th
 * interaction. It has NO bearing on the response already being delivered, so it
 * runs AFTER delivery — otherwise every 50th user sits watching "thinking…" for
 * a reflection they'll never see, and it eats into the Lambda's timeout budget.
 * Failures are swallowed: a reflection must never break a delivered response.
 */
async function reflectAfterDelivery(mind: Mind): Promise<void> {
    try {
        await mind.maybeReflect();
    } catch (err: any) {
        console.error('Reflection failed (response already delivered):', err.message);
    }
}

/**
 * A POLICY refusal is charged; a technical failure is not.
 *
 * The reasoning: if the prompt was rejected, we did the work and the cause was
 * the request, so it costs a credit. If our upstream timed out or 500'd, that's
 * ours to eat. This also closes a real hole: charge() previously ran only on
 * success, so a user could send failing prompts indefinitely, burning think
 * cost on every one while never spending a credit.
 */
const isChargeableFailure = (errorType?: string) => errorType === 'CONTENT_POLICY';

export interface RequestCtx {
    prompt: string;
    userId: string;
    userInfo: any;
    requestStartTime: number;
    /** Discord guild, so charge() can draw on the server's shared free pool.
     *  Slack omits it (unmetered). */
    guildId?: string | null;
    referenceUrl: string | null; // stored on the history entry for image successes
    // The tenant mind to record into. Omitted by Slack callers → the default
    // (Slack) mind; Discord passes its forTenant() mind so it records to the
    // Discord table + vector store, never Slack's.
    mind?: Mind;
}

/**
 * Consume an ArtOutcome: all the remember/charge/reflect/classify bookkeeping
 * here, the platform-specific delivery via `adapter`.
 */
export async function consumeOutcome(pipe: ArtOutcome, ctx: RequestCtx, adapter: DeliveryAdapter): Promise<void> {
    const { prompt, userId, userInfo, requestStartTime, referenceUrl, guildId } = ctx;
    const mind = ctx.mind ?? legacyMind;
    const cost = pipe.cost;

    if (pipe.kind === 'think_error') {
        await adapter.error('⚠️ Something went wrong. Try again.');
        return;
    }

    if (pipe.kind === 'text') {
        const response = (pipe.thinkResult.response || '').trim();
        await mind.remember(prompt, trunc(pipe.thinkResult.thoughts, 500), 'text_only', userId, userInfo, {
            model: MODEL_ROLES.text,
            cost,
            publicResponse: trunc(response, 500),
        });
        await adapter.text({ text: response, modelName: getModelInfo(MODEL_ROLES.text).name, cost: fmtCost(cost) });
        await reflectAfterDelivery(mind);
        return;
    }

    if (pipe.kind === 'generation_error') {
        const { errorType, message } = classifyAxiosError(pipe.genResult.error);
        const thoughts = pipe.thinkResult.thoughts || "wanted to make something but couldn't";
        await mind.remember(prompt, trunc(thoughts, 500), 'error', userId, userInfo, {
            model: MODEL_ROLES.image,
            cost,
            imagePrompt: pipe.imagePrompt,
            preThoughts: trunc(pipe.thinkResult.thoughts, 500),
            errorMessage: `[${errorType}] ${trunc(message, 500)}`,
        });
        await adapter.error(getUserFriendlyError(errorType, message));
        if (isChargeableFailure(errorType)) await mind.charge(userId, guildId);
        await reflectAfterDelivery(mind);
        return;
    }

    if (pipe.kind === 'image') {
        const publicUrl = await uploadImageToS3(pipe.result.imageUrl, prompt);
        const thoughts = pipe.thinkResult.thoughts || 'made something, no particular feelings';
        await mind.remember(prompt, trunc(thoughts, 600), 'success', userId, userInfo, {
            model: MODEL_ROLES.image,
            cost,
            imageUrl: publicUrl,
            referenceUrl,
            imagePrompt: pipe.imagePrompt,
        });
        // Name Wolf's self-hosted model when it rendered, else the OpenRouter one.
        const fromWolf = pipe.result.backend === 'wolf';
        const modelName =
            fromWolf && pipe.result.modelName ? pipe.result.modelName : getModelInfo(MODEL_ROLES.image).name;
        await adapter.image({
            publicUrl,
            thoughts,
            modelName,
            duration: elapsed(requestStartTime),
            cost: fmtCost(cost, 'unknown'),
            fromWolf,
        });
        // Charge only AFTER the image is actually in front of them (Slack's mind
        // = no-op; Discord decrements free-daily, then credits). Only images
        // cost — text/refusals don't. If delivery threw, we never get here, which
        // is the right side to err on: a free render beats charging for nothing.
        await mind.charge(userId, guildId);
        await reflectAfterDelivery(mind);
        return;
    }

    // Nothing left but a refusal / no-image outcome.
    if (pipe.kind !== 'refusal') return;

    // ── refusal / no image → a plain generic error, never Clank's voice. ──
    // Still recorded (his memory + the logs keep the real reason); only the
    // user-facing line is generic, so a failure is never a peek at his insides.
    const outcome = pipe.result.errorType === 'CONTENT_POLICY' ? 'refused' : 'error';
    await mind.remember(
        prompt,
        trunc(pipe.thinkResult.thoughts || "couldn't render this one", 500),
        outcome,
        userId,
        userInfo,
        {
            model: MODEL_ROLES.image,
            cost,
            imagePrompt: pipe.imagePrompt,
            preThoughts: trunc(pipe.thinkResult.thoughts, 500),
            errorMessage: `[${pipe.result.errorType || 'NO_IMAGE'}] ${trunc(pipe.result.textResponse || pipe.result.message, 500)}`,
        }
    );
    await adapter.error(getUserFriendlyError(pipe.result.errorType || 'NO_IMAGE_GENERATED'));
    if (isChargeableFailure(pipe.result.errorType)) await mind.charge(userId, guildId);
    await reflectAfterDelivery(mind);
}
