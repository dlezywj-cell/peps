import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter, { yahooPath } from '../worker/international-api.mjs';

test('adapter accepts only the supported public finance routes and normalizes parameters', () => {
    assert.match(yahooPath('/v8/finance/chart/005930.KS?range=max').path, /interval=1d&period1=0/);
    assert.equal(yahooPath('/v8/finance/chart/6488.TWO?range=5d').type, 'chart');
    assert.equal(yahooPath('/ws/fundamentals-timeseries/v1/finance/timeseries/130A.T').type, 'timeseries');
    assert.match(yahooPath('/v1/finance/search?q=Sony&quotesCount=9999').path, /quotesCount=30/);
    for (const input of ['https://example.com', '//example.com', '/v8/finance/chart/AAPL', '/v1/finance/search', '/other', null]) {
        assert.throws(() => yahooPath(input));
    }
});

test('adapter rejects unapproved origins and writes', async () => {
    const denied = await adapter.fetch(new Request('https://service.test', { headers: { Origin: 'https://other.test' } }));
    assert.equal(denied.status, 403);
    const post = await adapter.fetch(new Request('https://service.test', { method: 'POST' }));
    assert.equal(post.status, 405);
    const preflight = await adapter.fetch(new Request('https://service.test', { method: 'OPTIONS', headers: { Origin: 'https://dlezywj-cell.github.io' } }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://dlezywj-cell.github.io');
});

test('adapter retries the second host and never forwards caller credentials', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1 ? new Response('rate limited', { status: 429 }) : Response.json({ chart: { result: [{ meta: { symbol: '2330.TW' } }], error: null } });
    };
    try {
        const request = new Request('https://service.test/?path=' + encodeURIComponent('/v8/finance/chart/2330.TW'), { headers: { Authorization: 'private-test-value' } });
        const result = await adapter.fetch(request);
        assert.equal(result.status, 200);
        assert.equal(calls.length, 2);
        assert.match(calls[1].url, /^https:\/\/query1.finance.yahoo.com/);
        assert.equal(calls[0].options.headers.Authorization, undefined);
        assert.match(result.headers.get('Cache-Control'), /max-age=900/);
    } finally { globalThis.fetch = originalFetch; }
});

test('upstream business errors produce uncached 502 responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ chart: { result: null, error: { code: 'Not Found' } } });
    try {
        const result = await adapter.fetch(new Request('https://service.test/?path=' + encodeURIComponent('/v8/finance/chart/9999.T')));
        assert.equal(result.status, 502);
        assert.equal(result.headers.get('Cache-Control'), null);
    } finally { globalThis.fetch = originalFetch; }
});
