// Cloudflare Workers and the local Node server share this read-only adapter.
// No API keys, user financial records, or GitHub credentials pass through it.
export function yahooPath(input) {
    if (!input || !input.startsWith('/') || input.startsWith('//')) throw new Error('Invalid path');
    const url = new URL(input, 'https://query2.finance.yahoo.com');
    const chart = url.pathname.match(/^\/v8\/finance\/chart\/(\d[0-9A-Z]{3,5}\.(?:T|KS|KQ|TW|TWO))$/);
    const financials = url.pathname.match(/^\/ws\/fundamentals-timeseries\/v1\/finance\/timeseries\/(\d[0-9A-Z]{3,5}\.(?:T|KS|KQ|TW|TWO))$/);
    const today = Math.floor(Date.now() / 86400000) * 86400;
    if (chart) {
        const period = url.searchParams.get('range') === '5d' ? 'range=5d' : `period1=0&period2=${today + 86400}`;
        return { path: `${url.pathname}?interval=1d&${period}&events=splits`, ttl: 900, type: 'chart' };
    }
    if (financials) {
        const types = 'annualTotalRevenue,annualNetIncome,annualOrdinarySharesNumber,quarterlyOrdinarySharesNumber';
        return { path: `${url.pathname}?type=${types}&period1=0&period2=${today + 86400}`, ttl: 21600, type: 'timeseries' };
    }
    if (url.pathname === '/v1/finance/search') {
        const query = url.searchParams.get('q')?.trim();
        if (!query || query.length > 100) throw new Error('Invalid search');
        return { path: `${url.pathname}?q=${encodeURIComponent(query)}&quotesCount=30&newsCount=0`, ttl: 900, type: 'search' };
    }
    throw new Error('Unsupported endpoint');
}

export default {
    async fetch(request, env = {}, ctx = {}) {
        const origin = request.headers.get('Origin');
        const allowed = (env.ALLOWED_ORIGINS || 'https://dlezywj-cell.github.io').split(',').map(value => value.trim());
        if (origin && !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
        const cors = {
            'Access-Control-Allow-Origin': origin || allowed[0],
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Vary': 'Origin',
            'Content-Type': 'application/json; charset=utf-8'
        };
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (request.method !== 'GET') return Response.json({ error: 'GET only' }, { status: 405, headers: cors });
        let target;
        try { target = yahooPath(new URL(request.url).searchParams.get('path')); }
        catch (error) { return Response.json({ error: error.message }, { status: 400, headers: cors }); }

        const key = new URL(request.url);
        key.search = new URLSearchParams({ path: target.path, origin: origin || allowed[0] }).toString();
        const cache = typeof caches !== 'undefined' ? caches.default : null;
        const cached = cache && await cache.match(key.toString());
        if (cached) return cached;

        for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
            try {
                const response = await fetch(`https://${host}${target.path}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(6000), redirect: 'error'
                });
                if (!response.ok) continue;
                const json = await response.json();
                const valid = target.type === 'search' ? Array.isArray(json.quotes) :
                    !json[target.type]?.error && Array.isArray(json[target.type]?.result) && json[target.type].result.length > 0;
                if (!valid) continue;
                const result = Response.json(json, { headers: { ...cors, 'Cache-Control': `public, max-age=${target.ttl}` } });
                if (cache && ctx.waitUntil) ctx.waitUntil(cache.put(key.toString(), result.clone()));
                return result;
            } catch { /* Retry the other Yahoo host; never cache failures. */ }
        }
        return Response.json({ error: 'Upstream unavailable or symbol not found; retry later' }, { status: 502, headers: cors });
    }
};
