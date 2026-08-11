// ─── OpenRouter client ───────────────────────────────────────────
// One place for the OpenRouter HTTP contract: base URL, auth + attribution
// headers, fetch with a per-call timeout. On a non-2xx response it throws an
// axios-shaped error (`err.response = { status, data }`) so the existing
// classifyAxiosError() keeps working unchanged.

const BASE = 'https://openrouter.ai/api/v1';

function authHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/MikeyDunn/clank',
        'X-Title': 'Clank Image Generator',
    };
}

async function request(path: string, method: string, body: any, timeoutMs: number): Promise<any> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(`${BASE}${path}`, {
            method,
            headers: authHeaders(),
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ac.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw Object.assign(new Error(`OpenRouter ${res.status}`), { response: { status: res.status, data } });
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

/** POST /chat/completions — returns the parsed response body. */
export async function chat(body: any, timeoutMs = 60000): Promise<any> {
    return request('/chat/completions', 'POST', body, timeoutMs);
}

/** POST /embeddings — returns the parsed response body. */
export async function embed(body: any, timeoutMs = 30000): Promise<any> {
    return request('/embeddings', 'POST', body, timeoutMs);
}

/** GET /credits — returns the parsed response body. */
export async function credits(timeoutMs = 5000): Promise<any> {
    return request('/credits', 'GET', undefined, timeoutMs);
}
