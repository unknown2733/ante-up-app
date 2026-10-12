/** Same-origin read-only R2 App QA server. Fixture Live market has no observations or actions. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleReadonlyMock } from '../apps/web/qa/consumer/readonly-mock-api.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const policy = imageOrigins => "default-src 'self' data: blob:; connect-src 'self'; img-src 'self' data: blob: " +
  imageOrigins.join(' ') + "; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-ante-r2-qa': 'read-only' } });
const envelope = (data, asOf) => ({ schemaVersion: '0.1', mode: 'devnet', asOf, data, nextCursor: null });
const liveMarket = () => ({ id: 'fixture:sol', title: 'solana', subtitle: 'QA read-only Devnet shell · no observations',
  subject: 'KEYWORD', phase: 'CURVE', source: { mode: 'LIVE', label: 'QA Live shell · no observations',
    asOfMs: Date.now() }, latestPrice: null, priceUnit: 'tUSD', changeFraction: null, liveMarketId: 'fixture:sol' });

export async function handleR2Mock(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return json({ code: 'UNAUTHORIZED', message: 'Read-only QA server.' }, 405);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'v1' || parts[1] !== 'consumer') return handleReadonlyMock(request);
  const asOf = Math.floor(Date.now() / 1000);
  const market = liveMarket();
  if (parts[2] === 'markets' && parts.length === 3) return json(envelope([market], asOf));
  if (parts[2] === 'markets' && parts[4] === 'history') {
    const id = decodeURIComponent(parts[3]);
    const period = url.searchParams.get('period') ?? 'ALL';
    if (!['1D', '1W', '1M', 'ALL'].includes(period)) return json({ code: 'INVALID_INPUT', message: 'Invalid period.' }, 400);
    return json(envelope(id === market.id ? { market, period, series: [], actions: [], source: market.source } : null, asOf));
  }
  if (parts[2] === 'profiles' && parts[3]) {
    const actorId = decodeURIComponent(parts[3]);
    return json(envelope({ actorId, actorLabel: 'QA public wallet', source: market.source,
      closedCallCount: 0, openCallCount: 0, meanReturnFraction: null, actions: [] }, asOf));
  }
  if (parts[2] === 'leaderboard') {
    const period = url.searchParams.get('period') ?? '7D';
    return json(envelope({ period, source: market.source, rows: [] }, asOf));
  }
  if (parts[2] === 'notes') return json(envelope({ note: null, revisions: [] }, asOf));
  return json({ code: 'INVALID_INPUT', message: 'Unknown QA consumer route.' }, 404);
}

export async function startR2ReadonlyServer(directory, port = 4188, allowedImageOrigins = []) {
  const root = path.resolve(directory);
  await readFile(path.join(root, 'index.html'));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status, headers, body) => {
      response.writeHead(status, { 'cache-control': 'no-store', 'content-security-policy': policy(allowedImageOrigins),
        'x-ante-r2-qa': 'read-only', ...headers });
      response.end(request.method === 'HEAD' ? null : body);
    };
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      send(405, { 'content-type': 'application/json' }, JSON.stringify({ code: 'UNAUTHORIZED', message: 'Read-only QA server.' }));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const result = await handleR2Mock(new Request('http://qa.local' + url.pathname.slice(4) + url.search, { method: request.method }));
      send(result.status, Object.fromEntries(result.headers), Buffer.from(await result.arrayBuffer()));
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
      file = path.join(root, 'index.html');
      data = await readFile(file);
    }
    send(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' }, data);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/consumer-r2-serve.mjs DIST [PORT]');
  const port = Number(process.argv[3] ?? 4188);
  await startR2ReadonlyServer(process.argv[2], port);
  console.log(`R2 read-only App QA server at http://127.0.0.1:${port}/`);
}
