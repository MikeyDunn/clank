// ─── Image generation ────────────────────────────────────────────
// Mini generates images from detailed prompts. No context needed —
// Sonnet (think.ts) already resolved all lore/appearance references.
//
// Backend selection: when VLLM_IMAGE_URL is set (a self-hosted model on the
// OpenAI images API, e.g. behind an ngrok/Cloudflare tunnel), we try it FIRST
// for plain text-to-image and fall back to OpenRouter on any failure.
// Reference-image and model-override requests skip vLLM (the images/generations
// endpoint takes neither). When the env is unset, this is a no-op: OpenRouter only.

import { MODEL_ROLES } from '../models.js';
import * as openrouter from '../openrouter.js';

// vLLM gets a SHORT fail-fast timeout, not the full request budget. A *down*
// host already errors in seconds, but a *hung* one (GPU wedged/OOM) would
// otherwise stall the whole Lambda (300s cap) and starve the OpenRouter
// fallback. Healthy gens run ~7-17s, so 45s bails a hung box while leaving
// ~240s of runway for the fallback to still produce an image.
const VLLM_TIMEOUT_MS = 45000;

// ── Deadline-aware generation budget ─────────────────────────────
// Timeouts on sequential steps don't compose: think routinely takes 20-45s, so
// a fixed 280s generation timeout could only fire at T+325s on a 300s Lambda —
// i.e. NEVER. A hung upstream then killed the Lambda mid-flight: no error
// handler, no message to the user, no history entry (seen live 2026-08-06).
// Callers now thread an absolute `deadlineMs` (from getRemainingTimeInMillis)
// and each generation attempt takes what's actually left, minus a reserve for
// upload + delivery + remember. Floor of 10s: with almost no budget we still
// attempt briefly so a timeout becomes a HANDLED error, never a hard kill.
const DELIVERY_RESERVE_MS = 20_000;
const MIN_GEN_MS = 10_000;
const MAX_GEN_MS = 280_000;

/** Generation timeout for this attempt: remaining budget minus the delivery
 *  reserve, clamped to [MIN_GEN_MS, MAX_GEN_MS]. No deadline → legacy cap. */
function genTimeoutMs(deadlineMs: number | null, now: number = Date.now()): number {
    if (!deadlineMs) return MAX_GEN_MS;
    return Math.max(MIN_GEN_MS, Math.min(MAX_GEN_MS, deadlineMs - now - DELIVERY_RESERVE_MS));
}

// Appended to the imagePrompt ONLY on the OpenRouter path — gpt-5-image-mini
// frames tightly and crops subjects at the edges without this nudge. Kept OFF
// the vLLM/Wolf path on purpose: FLUX's 512-token text encoder can't spare the
// budget, which is why this was pulled when Wolf was primary. Now that the
// OpenRouter fallback carries the load, it earns its place there.
const FRAMING_FOOTER =
    '\n\nFRAMING: Compose for a 1024×1024 square canvas. The entire subject must fit inside the frame with visible margin on all four sides. No cut-off heads, hands, feet, or limbs at the canvas edges. If the scene is wide, zoom out. If the subject is tall, fit head-to-toe with breathing room above and below.';

const VLLM_HEADERS = () => ({
    Authorization: `Bearer ${process.env.VLLM_API_KEY}`,
    // Free ngrok serves a browser interstitial unless this header is present.
    'ngrok-skip-browser-warning': '1',
});

// The model the vLLM server is actually serving (e.g. "FLUX.2-klein-9B"), so the
// stats line names the real model instead of the OpenRouter one. The generations
// response doesn't echo it, so we read /v1/models — cached per warm container, so
// it's one cheap lookup, not a per-request call. Falls back to a generic label.
let vllmModelLabel: string | null = null;
async function getVllmModelLabel(): Promise<string> {
    if (vllmModelLabel) return vllmModelLabel;
    try {
        const res = await fetch(`${process.env.VLLM_IMAGE_URL}/v1/models`, {
            headers: VLLM_HEADERS(),
            signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
            const body: any = await res.json();
            const id: string | undefined = body?.data?.[0]?.id;
            if (id) vllmModelLabel = id.split('/').pop() || id; // drop the "org/" prefix
        }
    } catch (err) {
        console.warn('vLLM model-name lookup failed:', err.message);
    }
    return vllmModelLabel || "Wolf's model";
}

/**
 * Generate via a self-hosted OpenAI-images-API backend (vLLM). Returns the image
 * shaped EXACTLY like an OpenRouter chat-completion image body, so parseResponse
 * handles it unchanged. Throws on any failure so the caller can fall back.
 */
async function generateViaVllm(prompt: string, timeoutMs: number): Promise<any> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        // Kick off the model-name lookup concurrently — it resolves (cached) well
        // before the generation does, so it adds no wall-clock latency.
        const modelLabelPromise = getVllmModelLabel();
        const res = await fetch(`${process.env.VLLM_IMAGE_URL}/v1/images/generations`, {
            method: 'POST',
            headers: { ...VLLM_HEADERS(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, size: '1024x1024' }),
            signal: ac.signal,
        });
        if (!res.ok) throw new Error(`vLLM ${res.status}`);
        const body: any = await res.json();
        const b64 = body?.data?.[0]?.b64_json;
        if (!b64) throw new Error('vLLM returned no image');
        // Self-hosted = no metered cost. Shape to the OpenRouter image contract,
        // tagging the backend (❤️ wolf) and the real model name for the stats line.
        return {
            choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${b64}` } }] } }],
            usage: { cost: 0 },
            _backend: 'wolf',
            _modelLabel: await modelLabelPromise,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function generateImage(
    imagePrompt: string,
    referenceImageBase64: string | null = null,
    modelOverride: string | null = null,
    deadlineMs: number | null = null
) {
    const startTime = Date.now();

    // Self-hosted backend first (text-to-image only). References + model
    // overrides bypass it and go straight to OpenRouter below.
    if (process.env.VLLM_IMAGE_URL && !referenceImageBase64 && !modelOverride) {
        try {
            const response = await generateViaVllm(imagePrompt, Math.min(VLLM_TIMEOUT_MS, genTimeoutMs(deadlineMs)));
            console.log('Generated via vLLM (self-hosted)');
            return { response, startTime };
        } catch (error) {
            console.warn('vLLM failed, falling back to OpenRouter:', error.message);
        }
    }

    try {
        // Anti-crop framing rides only on the OpenRouter path (see FRAMING_FOOTER).
        const framedPrompt = imagePrompt + FRAMING_FOOTER;
        const response = await openrouter.chat(
            {
                model: modelOverride || MODEL_ROLES.image,
                messages: [
                    {
                        role: 'user',
                        content: referenceImageBase64
                            ? [
                                  { type: 'image_url', image_url: { url: referenceImageBase64 } },
                                  { type: 'text', text: framedPrompt },
                              ]
                            : framedPrompt,
                    },
                ],
                modalities: ['image'],
                size: '1024x1024',
            },
            // Recomputed at THIS moment, so a slow think or a spent vLLM attempt
            // shrinks what this call may take instead of overrunning the Lambda.
            genTimeoutMs(deadlineMs)
        );

        return { response, startTime };
    } catch (error) {
        return { error, startTime };
    }
}

export { generateImage, genTimeoutMs };
