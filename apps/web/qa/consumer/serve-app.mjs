/** Serves a locally built actual App and read-only fixture API on one origin. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleReadonlyMock } from './readonly-mock-api.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const policy = "default-src 'self' data: blob:; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:";

export async function startReadonlyAppServer(directory, port = 4182) {
  const root = path.resolve(directory);
  await readFile(path.join(root, 'index.html'));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status, headers, bytes) => {
      response.writeHead(status, { 'cache-control': 'no-store', 'content-security-policy': policy,
        'x-ante-qa': 'read-only-local', ...headers });
      response.end(bytes);
    };
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      send(405, { 'content-type': 'application/json' }, JSON.stringify({ code: 'UNAUTHORIZED', message: 'QA server is read only.' }));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const result = await handleReadonlyMock(new Request('http://qa.local' + url.pathname.slice(4) + url.search,
        { method: request.method }));
      send(result.status, Object.fromEntries(result.headers), request.method === 'HEAD' ? null : Buffer.from(await result.arrayBuffer()));
      return;
    }
    let relative;
    try { relative = decodeURIComponent(url.pathname); } catch { send(400, {}, 'Invalid path'); return; }
    const target = path.resolve(root, '.' + relative);
    if (target !== root && !target.startsWith(root + path.sep)) { send(403, {}, 'Forbidden'); return; }
    let file = target === root ? path.join(root, 'index.html') : target;
    let data;
    try { data = await readFile(file); }
    catch {
      if (path.extname(file)) { send(404, {}, 'Not found'); return; }
      file = path.join(root, 'index.html'); // SPA deep-link reload.
      data = await readFile(file);
    }
    send(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' }, request.method === 'HEAD' ? null : data);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node serve-app.mjs DIST_DIRECTORY [PORT]');
  const port = Number(process.argv[3] ?? 4182);
  await startReadonlyAppServer(process.argv[2], port);
  console.log(`Read-only actual App QA at http://127.0.0.1:${port}/`);
}
