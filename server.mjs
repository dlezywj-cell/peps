import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import adapter from './worker/international-api.mjs';

const port = Number(process.env.PORT || 8766);
const host = process.env.HOST || '127.0.0.1';
const origins = process.env.ALLOWED_ORIGINS || `http://127.0.0.1:${port},http://localhost:${port}`;
const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname === '/api/international') {
            const result = await adapter.fetch(new Request(url, { method: req.method, headers: req.headers }), { ALLOWED_ORIGINS: origins });
            res.writeHead(result.status, Object.fromEntries(result.headers));
            res.end(Buffer.from(await result.arrayBuffer()));
        } else if (req.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(await readFile(new URL('./index.html', import.meta.url)));
        } else { res.writeHead(404); res.end('Not found'); }
    } catch { res.writeHead(500); res.end('Server error'); }
});
server.listen(port, host, () => console.log(`PEPS: http://${host}:${port}`));
