// ─── Model registry ──────────────────────────────────────────────
// Single source of truth for model roles, metadata, and availability.

const MODEL_ROLES = {
    // Nano Banana 2 Lite: cheapest + fastest in the bake-off (~$0.034/img, ~3s,
    // vs gpt-5-image-mini's ~$0.047 / 54-74s), no refusals, and it takes
    // reference images (in:[image,text]) so Ask Clank + 🤖-on-image still work.
    // Trialing as Clank's hand — fall back to 'google/gemini-2.5-flash-image'
    // (full Nano Banana) or 'openai/gpt-5-image-mini' if the line loses character
    // or botches image-to-image edits.
    image: 'google/gemini-3.1-flash-lite-image',
    // Sonnet 5: newer generation AND ~33% cheaper than 4.6 ($2/$10 vs $3/$15),
    // same vision + tools + caching + 1M ctx. Same-family upgrade → minimal voice
    // drift risk. Revert to 'anthropic/claude-sonnet-4.6' if he stops sounding
    // like himself. Drives both the think step and reflection.
    text: 'anthropic/claude-sonnet-5',
    reflection: 'anthropic/claude-sonnet-5',
};

const MODEL_REGISTRY = {
    'openai/gpt-5-image': { name: 'GPT-5 Image' },
    'openai/gpt-5-image-mini': { name: 'GPT-5 Image Mini' },
    'anthropic/claude-sonnet-5': { name: 'Claude Sonnet 5' },
    'anthropic/claude-sonnet-4.6': { name: 'Claude Sonnet 4.6' },
    'anthropic/claude-opus-5': { name: 'Claude Opus 5' },
    'anthropic/claude-haiku-4.5': { name: 'Claude Haiku 4.5' },
    'google/gemini-2.5-flash-image': { name: 'Gemini 2.5 Flash' },
    'google/gemini-2.5-flash-image-preview': { name: 'Gemini 2.5 Flash Preview' },
    'google/gemini-3.1-flash-lite-image': { name: 'Gemini 3.1 Flash Lite' },
    'google/gemini-3.1-flash-image': { name: 'Gemini 3.1 Flash' },
    'google/gemini-3-pro-image-preview': { name: 'Gemini 3 Pro' },
};

function getModelInfo(modelId) {
    return MODEL_REGISTRY[modelId] || { name: modelId };
}

export { getModelInfo, MODEL_REGISTRY, MODEL_ROLES };
