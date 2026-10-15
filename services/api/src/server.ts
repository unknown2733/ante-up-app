import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.ts';
import { createLiveApp } from './live.ts';
import type { MarketRegistryEntry } from './live-read.ts';
import { createVisitorSolRuntime } from './visitor-sol-runtime.ts';

const MAX_BODY_BYTES = 32_768;
type App = ReturnType<typeof createApp>;
const sendJson = (res: ServerResponse, status: number, data: unknown) => {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

export function createApiServer(app: App = createApp()) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let bytes = 0, rejected = false;
    const rejectLarge = () => {
      if (rejected) return;
      rejected = true;
      res.once('finish', () => req.destroy());
      sendJson(res, 413, { code: 'INVALID_INPUT', message: 'body too large', retryable: false, requestId: null });
      req.pause();
    };
    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) { rejectLarge(); return; }
    req.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { rejectLarge(); return; }
      chunks.push(Buffer.from(chunk));
    });
    req.on('error', () => { if (!rejected) sendJson(res, 400, { code: 'INVALID_INPUT', message: 'request stream failed', retryable: false, requestId: null }); });
    req.on('end', async () => {
      if (rejected) return;
      try {
        const request = new Request(`http://localhost${req.url ?? '/'}`, {
          method: req.method, headers: req.headers as HeadersInit,
          body: ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : Buffer.concat(chunks)
        });
        const response = await app.handle(request);
        const responseBody = Buffer.from(await response.arrayBuffer());
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(responseBody);
      } catch {
        sendJson(res, 500, { code: 'INTERNAL_ERROR', message: 'server request failed', retryable: true, requestId: null });
      }
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? '8787');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT invalid');
  const mode=process.env.ANTE_UP_MODE??'fixture';
  if (mode==='fixture') createApiServer().listen(port,'127.0.0.1',()=>console.log(`Ante Up fixture API on http://127.0.0.1:${port}`));
  else {
    if (mode!=='localnet' && mode!=='devnet') throw new Error('ANTE_UP_MODE invalid');
    const programId=process.env.ANTE_UP_PROGRAM_ID,rpcUrl=process.env.ANTE_UP_RPC_URL,
      dbPath=process.env.ANTE_UP_INDEX_DB,registryPath=process.env.ANTE_UP_MARKETS_PATH;
    if (!programId||!rpcUrl||!dbPath||!registryPath) throw new Error('Live mode requires program, RPC, database and market registry paths');
    const markets=JSON.parse(await readFile(resolve(registryPath),'utf8')) as MarketRegistryEntry[];
    if (!Array.isArray(markets)) throw new Error('INVALID_MARKET_REGISTRY');
    const priceDbPath=process.env.ANTE_UP_PRICE_DB;
    const visitorSol = mode === 'devnet' ? await createVisitorSolRuntime({endpoint:rpcUrl,
      dbPath:resolve(`${dbPath}.visitor-sol.sqlite`),env:process.env}) : null;
    const live=createLiveApp({mode,programId,rpcUrl,dbPath:resolve(dbPath),markets,
      priceDbPath:priceDbPath ? resolve(priceDbPath) : undefined,
      visitorSol:visitorSol?.faucet});
    const server=createApiServer(live.app);
    server.on('close',()=>{live.close();visitorSol?.close();});
    const host=process.env.HOST??'127.0.0.1';
    server.listen(port,host,()=>console.log(`Ante Up ${mode} API listening on port ${port}`));
    const close=()=>{server.close();server.closeIdleConnections();};
    process.once('SIGTERM',close);process.once('SIGINT',close);
  }
}
