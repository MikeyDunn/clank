// ─── Response parsing ────────────────────────────────────────────
// Pure functions for interpreting OpenRouter responses.

import { stripMrkdwn } from '../platform/slack/blocks.js';

/**
 * The result of parsing an OpenRouter image response. Two shapes share this
 * type: a `success` (image present) and a `no_image` (refusal or empty). Fields
 * that only appear on one shape are optional.
 */
export interface ParseResult {
    outcome: 'success' | 'no_image';
    cost: number | null;
    generationId: string | null;
    imageUrl?: string; // Present on success — the generated image URL/data.
    duration?: string; // Present on success — seconds, as a fixed-1 string.
    thoughts?: string | null; // Present on success — any text the model included.
    backend?: string | null; // Present on success — 'wolf' when the self-hosted model rendered it.
    modelName?: string | null; // Present on success — the real model name when a non-OpenRouter backend rendered it.
    errorType?: string; // Present on no_image — 'CONTENT_POLICY' | 'NO_IMAGE_GENERATED'.
    message?: string; // Present on no_image — short human-readable cause.
    textResponse?: string; // Present on no_image — the model's raw text.
}

/**
 * Parse an OpenRouter chat-completion body into a structured result.
 */
function parseResponse(response: any, startTime: number): ParseResult {
    const generationId = response.id || null;
    const message = response.choices?.[0]?.message;
    const images = message?.images;

    const inlineCost = response.usage?.cost;
    const cost = inlineCost !== undefined && inlineCost !== null ? Number(inlineCost) : null;

    if (images?.length > 0 && images[0]?.image_url?.url) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const thoughts = message?.content || null;
        if (thoughts) console.log('Clank says:', `${thoughts.substring(0, 100)}...`);
        const backend = response._backend || null;
        return {
            outcome: 'success',
            imageUrl: images[0].image_url.url,
            duration,
            thoughts,
            generationId,
            cost,
            backend,
            modelName: response._modelLabel || null,
        };
    }

    // No image returned. The image model's safety filter reports itself in the
    // finish reason — `finish_reason: 'content_filter'` / `native_finish_reason:
    // 'IMAGE_SAFETY' | 'IMAGE_PROHIBITED_CONTENT'`. That's a distinct outcome from
    // a genuine empty completion or a think-style policy refusal, and (verified)
    // it's STOCHASTIC: the same prompt often passes on a re-fire. Detecting it
    // lets the pipeline retry and lets us say "filtered" instead of a mystery.
    const choice = response.choices?.[0];
    const nativeFinish = String(choice?.native_finish_reason || '');
    const isSafetyBlock =
        choice?.finish_reason === 'content_filter' || /IMAGE_SAFETY|PROHIBITED_CONTENT|SAFETY/i.test(nativeFinish);
    const textResponse = message?.content || 'No response content';
    const errorType = isSafetyBlock
        ? 'IMAGE_SAFETY'
        : isContentPolicyRefusal(textResponse)
          ? 'CONTENT_POLICY'
          : 'NO_IMAGE_GENERATED';
    return {
        outcome: 'no_image',
        errorType,
        message: 'The model did not generate an image',
        textResponse,
        generationId,
        cost,
    };
}

/**
 * Classify an axios error from OpenRouter into an error type.
 */
function classifyAxiosError(error: any) {
    console.error('OpenRouter API Error:', error.response?.data || error.message);
    const statusCode = error.response?.status;
    const errorData = error.response?.data;
    const errorMessage = errorData?.error?.message || errorData?.message || errorData?.error || error.message;
    return {
        errorType: classifyError(statusCode, errorMessage),
        message: errorMessage,
        statusCode,
        rawError: errorData,
    };
}

// Phrases that only appear in an actual policy refusal.
const POLICY_PHRASES = [
    'content policy',
    'content guidelines',
    'usage policies',
    'against my guidelines',
    'safety guidelines',
    'community guidelines',
    'not allowed',
    'violates',
];
// A refusal verb aimed at the act of creating something, e.g. "I can't create",
// "won't be able to generate", "unable to depict".
const REFUSAL_TO_CREATE =
    /\b(?:can'?t|cannot|won'?t|will not|unable to|not able to|refuse to)\b[\s\w,]{0,30}?\b(create|generate|draw|depict|make|produce|render|illustrate)\b/;

/**
 * Is this no-image response a POLICY refusal (the user's prompt was rejected)
 * rather than a technical failure?
 *
 * This decides whether the user is CHARGED, so it must not fire on ordinary
 * failures. It used to match a bare "sorry", which meant "Sorry, something went
 * wrong" counted as a refusal — now it needs an explicit policy phrase, or a
 * refusal verb attached to the act of creating.
 */
function isContentPolicyRefusal(text) {
    if (typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    return POLICY_PHRASES.some((p) => lower.includes(p)) || REFUSAL_TO_CREATE.test(lower);
}

function classifyError(statusCode, message) {
    const m = (message || '').toLowerCase();
    // OpenRouter returns 403 when the INPUT trips moderation — that's a content
    // block, not a mystery failure, so the user gets "rephrase" rather than
    // "try again later" (which would never work).
    if (statusCode === 403 || m.includes('moderation') || m.includes('flagged')) return 'CONTENT_POLICY';
    if (statusCode === 401 || m.includes('unauthorized')) return 'AUTH_ERROR';
    if (statusCode === 402 || m.includes('insufficient credits')) return 'INSUFFICIENT_CREDITS';
    if (statusCode === 429 || m.includes('rate limit')) return 'RATE_LIMIT';
    if (statusCode === 400 || m.includes('invalid request')) return 'INVALID_REQUEST';
    if (statusCode === 503 || m.includes('service unavailable')) return 'SERVICE_UNAVAILABLE';
    if (m.includes('timeout') || m.includes('timed out') || m.includes('aborted')) return 'TIMEOUT';
    if (statusCode === 404 || m.includes('model not found')) return 'MODEL_NOT_FOUND';
    if (m.includes('econnreset') || m.includes('econnrefused') || m.includes('socket hang up'))
        return 'CONNECTION_ERROR';
    if (statusCode === 500 || m.includes('internal server error')) return 'UPSTREAM_ERROR';
    return 'UNKNOWN_ERROR';
}

const RETRYABLE_ERRORS = new Set(['TIMEOUT', 'UPSTREAM_ERROR', 'CONNECTION_ERROR', 'SERVICE_UNAVAILABLE']);

const ERROR_MESSAGES = {
    AUTH_ERROR:
        "🔐 Authentication Error\nThere's an issue with the OpenRouter API key. Please contact an administrator.",
    INSUFFICIENT_CREDITS:
        '💳 Insufficient Credits\nThe OpenRouter account is out of credits. Please contact an administrator to add more credits.',
    RATE_LIMIT: '⏱️ Rate Limit Exceeded\nToo many requests have been made. Please wait a moment and try again.',
    INVALID_REQUEST: "❌ Invalid Request\nYour prompt couldn't be processed. Try rephrasing it or making it shorter.",
    SERVICE_UNAVAILABLE:
        '🔧 Service Unavailable\nOpenRouter is temporarily unavailable. Please try again in a few minutes.',
    TIMEOUT:
        '⏰ Request Timeout\nOpenRouter timed out generating the image. Try again — this is an upstream issue, not a problem with your prompt.',
    UPSTREAM_ERROR:
        '⚠️ Upstream Error\nOpenRouter returned a 500 Internal Server Error. This is on their end — try again in a moment.',
    CONNECTION_ERROR:
        '⚠️ Connection Error\nOpenRouter dropped the connection mid-request (ECONNRESET). This is a network issue on their end — try again.',
    MODEL_NOT_FOUND:
        '🤖 Model Not Available\nThe image generation model is not available. Please contact an administrator.',
    NO_IMAGE_GENERATED:
        "🎨 No Image Generated\nThe model responded but didn't generate an image. Try a different prompt.",
    // The image model's content filter blocked it. It's stochastic (we already
    // re-fired once), so "try again" is genuine advice, not a brush-off. NOT
    // charged (isChargeableFailure is CONTENT_POLICY-only) — the block was free.
    IMAGE_SAFETY:
        "🎨 The image filter blocked that one. It's inconsistent — trying again or rephrasing usually gets it through.",
    // Charged (see consumeOutcome): the prompt was rejected, not our failure, and
    // the work was done. Say so plainly so a missing credit isn't a mystery.
    CONTENT_POLICY: '🚫 That prompt was declined by the content filter, so it used a credit. Rephrasing usually works.',
    UNKNOWN_ERROR: '⚠️ Something Went Wrong\nAn unexpected error occurred. Please try again later.',
};

function getUserFriendlyError(errorType: string, _originalMessage?: string | null, textResponse: string | null = null) {
    let msg = ERROR_MESSAGES[errorType] || ERROR_MESSAGES.UNKNOWN_ERROR;

    if (
        textResponse &&
        textResponse !== 'No response content' &&
        (errorType === 'CONTENT_POLICY' || errorType === 'NO_IMAGE_GENERATED')
    ) {
        const cleaned = stripMrkdwn(textResponse).trim().substring(0, 400);
        msg += `\n\nModel says: ${cleaned}`;
    }

    return msg;
}

export {
    classifyAxiosError,
    classifyError,
    ERROR_MESSAGES,
    getUserFriendlyError,
    isContentPolicyRefusal,
    parseResponse,
    RETRYABLE_ERRORS,
};
