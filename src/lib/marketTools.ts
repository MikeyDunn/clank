// ─── Market tool ─────────────────────────────────────────────────
// getMarketData: a live quote + a downsampled price curve for one instrument
// (stock, ETF, index, crypto), via Yahoo Finance's keyless chart/search API.
// Unofficial and may rate-limit Lambda IPs — every failure returns an
// {error} payload so Clank improvises instead of the request breaking. The
// curve is the point: it lets him draw the actual SHAPE of the move.

const YF = 'https://query1.finance.yahoo.com';
const TIMEOUT_MS = 8000;
const SERIES_POINTS = 24;
// Yahoo serves an empty/blocked response to bare fetch() user agents.
const UA = 'Mozilla/5.0 (compatible; ClankBot/1.0)';

// range → bar interval. Fine-grained for short ranges so the curve has a shape.
const INTERVALS: Record<string, string> = {
    '1d': '5m',
    '5d': '30m',
    '1mo': '1d',
    '6mo': '1d',
    '1y': '1wk',
    '5y': '1mo',
};
// Search hits we accept as "the thing they meant" (skip futures/options noise).
const ACCEPTED_TYPES = new Set(['EQUITY', 'ETF', 'INDEX', 'CRYPTOCURRENCY', 'MUTUALFUND', 'CURRENCY']);

const MARKET_TOOL = {
    type: 'function',
    function: {
        name: 'getMarketData',
        description:
            'Look up a REAL stock, ETF, index, or cryptocurrency right now: price, change over the range, highs/lows, and a price curve (oldest → newest) you can use as the shape of the drawing. Use when a request touches a real company, ticker, or "the market". Pass a ticker or a company/asset name.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Ticker or name, e.g. "NVDA", "nvidia", "bitcoin", "S&P 500".' },
                range: {
                    type: 'string',
                    enum: Object.keys(INTERVALS),
                    description: 'Time window for the curve. Default "1d" (today).',
                },
            },
            required: ['query'],
        },
    },
};

async function getJson(url: string): Promise<any> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
        if (!res.ok) throw new Error(`Yahoo ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/** First search hit that's a real tradable instrument, or null. Pure. */
function pickSymbol(quotes: any[]): string | null {
    const hit = (quotes || []).find((q) => q?.symbol && ACCEPTED_TYPES.has(q.quoteType));
    return hit ? hit.symbol : null;
}

/** Evenly sample `n` points from a series (keeping first + last), nulls dropped,
 *  rounded to a sensible precision. Pure. */
function downsample(values: (number | null)[], n = SERIES_POINTS): number[] {
    const clean = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const pick =
        clean.length <= n
            ? clean
            : Array.from({ length: n }, (_, i) => clean[Math.round((i * (clean.length - 1)) / (n - 1))]);
    return pick.map(roundPrice);
}

function roundPrice(v: number): number {
    const abs = Math.abs(v);
    const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 6;
    return Number(v.toFixed(digits));
}

/** Shape the chart API result into Clank's compact payload. Pure. */
function summarizeChart(result: any, range: string) {
    const m = result?.meta || {};
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
    const series = downsample(closes);
    const price = m.regularMarketPrice ?? series[series.length - 1];
    // Change is measured against the start of the window: the prior close for
    // "today", the first bar otherwise.
    const base = range === '1d' ? (m.chartPreviousClose ?? m.previousClose) : series[0];
    const changePct = price != null && base ? Number((((price - base) / base) * 100).toFixed(2)) : null;
    return {
        symbol: m.symbol,
        name: m.longName || m.shortName || m.symbol,
        currency: m.currency,
        range,
        price: price != null ? roundPrice(price) : null,
        changePct,
        dayHigh: m.regularMarketDayHigh ?? null,
        dayLow: m.regularMarketDayLow ?? null,
        high52w: m.fiftyTwoWeekHigh ?? null,
        low52w: m.fiftyTwoWeekLow ?? null,
        asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
        series,
    };
}

/** Execute a getMarketData call. Never throws. */
async function executeMarketTool(args: any) {
    const query = String(args?.query || '').trim();
    const range = INTERVALS[args?.range] ? args.range : '1d';
    if (!query) return { error: 'no query' };
    try {
        const search = await getJson(
            `${YF}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`
        );
        const symbol = pickSymbol(search?.quotes) || query.toUpperCase();
        const chart = await getJson(
            `${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${INTERVALS[range]}`
        );
        const result = chart?.chart?.result?.[0];
        if (!result) return { error: `no market data for "${query}"` };
        return summarizeChart(result, range);
    } catch (err) {
        console.error('Market tool failed:', query, err.message);
        return { error: `market data unavailable for "${query}"` };
    }
}

export { downsample, executeMarketTool, MARKET_TOOL, pickSymbol, summarizeChart };
