// Portable production web entry point. The API remains a separate process.
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.json':'application/json', '.woff2':'font/woff2' };
const within = (base, path) => { const tail = relative(base, path); return tail !== '..' && !tail.startsWith('../') && !tail.startsWith('..\\') && !isAbsolute(tail); };

export async function createWebServer({ dist = resolve(root, 'apps/web/dist'), apiOrigin = 'http://127.0.0.1:8787', fetchImpl = fetch } = {}) {
  const base = await realpath(dist);
  const api = new URL(apiOrigin);
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash || api.pathname !== '/') throw new Error('API_ORIGIN must be an HTTP(S) origin without credentials or path');
  return createServer(async (request, response) => {
    const fail = (status, message) => { response.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store' }); response.end(JSON.stringify({ error: message })); };
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 32768) { fail(413, 'REQUEST_TOO_LARGE'); return; } chunks.push(chunk); }
        const headers = new Headers();
        for (const name of ['accept', 'content-type', 'authorization', 'x-ante-wallet', 'x-ante-nonce', 'x-ante-signature']) {
          const value = request.headers[name]; if (typeof value === 'string') headers.set(name, value);
        }
        const target = new URL(api.origin);
        target.pathname = url.pathname.slice(4); target.search = url.search;
        let result;
        try { result = await fetchImpl(target, { method: request.method, headers,
          body: ['GET','HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks), signal: AbortSignal.timeout(15000), redirect: 'error' }); }
        catch { fail(502, 'API_UNAVAILABLE'); return; }
        response.writeHead(result.status, { 'content-type': result.headers.get('content-type') ?? 'application/json', 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
        response.end(request.method === 'HEAD' ? undefined : Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (!['GET','HEAD'].includes(request.method)) { fail(405, 'METHOD_NOT_ALLOWED'); return; }
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { fail(400, 'INVALID_PATH'); return; }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(p => p.startsWith('.'))) { fail(404, 'NOT_FOUND'); return; }
      let path = resolve(base, `.${pathname}`);
      if (!within(base, path)) { fail(404, 'NOT_FOUND'); return; }
      try { if (!(await stat(path)).isFile()) path = resolve(base, 'index.html'); }
      catch { if (extname(pathname)) { fail(404, 'NOT_FOUND'); return; } path = resolve(base, 'index.html'); }
      const actual = await realpath(path);
      if (!within(base, actual)) { fail(404, 'NOT_FOUND'); return; }
      const bytes = await readFile(actual);
      response.writeHead(200, { 'content-type':types[extname(actual)] ?? 'application/octet-stream',
        'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options':'nosniff', 'referrer-policy':'same-origin', 'content-length':bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { if (!response.headersSent) fail(500, 'WEB_SERVER_ERROR'); else response.destroy(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WEB_PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WEB_PORT');
  const server = await createWebServer({ dist: process.env.WEB_DIST, apiOrigin: process.env.API_ORIGIN });
  server.listen(port, process.env.WEB_HOST ?? '127.0.0.1', () => console.log(`Ante Up web listening on port ${port}; upstream/API mode is displayed by the app`));
  const close = () => { server.close(); server.closeIdleConnections(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
