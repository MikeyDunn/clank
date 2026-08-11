// ─── Product-name helpers (pure) ─────────────────────────────────
// Deriving a clean t-shirt title from a prompt or a model's raw output.
// No I/O — extracted from tshirt.js so the logic is clear and testable.

const STOP_WORDS = new Set([
    'the',
    'a',
    'an',
    'of',
    'in',
    'on',
    'at',
    'to',
    'and',
    'or',
    'with',
    'for',
    'is',
    'as',
    'by',
    'draw',
    'make',
    'create',
    'show',
    'clank',
]);

// A title ending in one of these reads as cut off mid-phrase (model truncation).
const TRAILING_FILLER = /\b(or|and|the|a|an|with|for|of|to|if|you|like)$/i;

/**
 * Fallback title derived from the prompt: drop stop-words, Title Case, ≤4 words.
 * Never empty — defaults to 'Clank Original'.
 */
function deriveProductName(prompt: string): string {
    const words = (prompt || '')
        .replace(/[^a-z0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter(Boolean);
    const picked = words.filter((w) => !STOP_WORDS.has(w.toLowerCase())).slice(0, 4);
    const title = picked.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    return title || 'Clank Original';
}

/**
 * Strip common LLM wrapping from a raw model title: surrounding quotes/markdown,
 * a leading "Title:"/"Name:" label, and trailing parenthetical/em-dash commentary.
 */
function cleanModelName(raw: string): string {
    return (raw || '')
        .replace(/^["'`#\-*\s]+/, '')
        .replace(/^(title|name|product)\s*:\s*/i, '')
        .split(/[\n\r]/)[0]
        .split(/\s*[(—–\-:]\s/)[0]
        .replace(/["'`*]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Is a cleaned title usable on the storefront (sane length, not truncated)?
 */
function isValidProductName(name: string): boolean {
    if (!name) return false;
    const wordCount = name.split(/\s+/).length;
    return name.length >= 3 && name.length <= 50 && wordCount >= 1 && wordCount <= 7 && !TRAILING_FILLER.test(name);
}

/**
 * Pick the final product name: use the model's title if it cleans up valid,
 * otherwise fall back to one derived from the prompt.
 */
function pickProductName(rawModelName: string, prompt: string): string {
    const cleaned = cleanModelName(rawModelName);
    return isValidProductName(cleaned) ? cleaned : deriveProductName(prompt);
}

export { cleanModelName, deriveProductName, isValidProductName, pickProductName };
