import { readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KitFinalizedAccountReader } from '../services/indexer/src/repositories.ts';
import { FinalizedFinancialAccounts } from '../services/api/src/financial-chain.ts';
import { createFinalizedChainPriceReader, createPriceSampler, DEFAULT_PRICE_INTERVAL_MS,
  SqlitePriceHistoryStore, validatePriceSamplerConfig } from '../services/api/src/consumer-price-sampler.ts';

const required = (name) => { const value = process.env[name]; if (!value) throw new Error(`${name}_REQUIRED`); return value; };
const healthPath = () => resolve(process.env.ANTE_UP_PRICE_HEALTH_PATH ?? '/state/health/price-history.json');
const mode = process.argv[2] ?? '--dry-run';
if (!['--dry-run', '--once', '--follow', '--health'].includes(mode) || process.argv.length > 3) throw new Error('PRICE_MODE_INVALID');
const intervalMs = Number(process.env.ANTE_UP_PRICE_INTERVAL_MS ?? DEFAULT_PRICE_INTERVAL_MS);
let stopping = false;
let wake = () => {};
process.once('SIGTERM', () => { stopping = true; wake(); });
process.once('SIGINT', () => { stopping = true; wake(); });
const heartbeat = async (value) => {
  const path = healthPath(), temp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
};

async function main() {
  if (mode === '--health') {
    const state = JSON.parse(await readFile(healthPath(), 'utf8'));
    if (state.status !== 'OK' || !Number.isSafeInteger(state.atMs) || Date.now() - state.atMs >= intervalMs * 3)
      throw new Error('PRICE_HISTORY_UNHEALTHY');
    console.log(JSON.stringify({ status: 'OK', atMs: state.atMs, valid: state.valid, stored: state.stored }));
    return;
  }
  const programId = required('ANTE_UP_PROGRAM_ID');
  const registryPath = resolve(required('ANTE_UP_MARKETS_PATH'));
  if ((await stat(registryPath)).size > 262_144) throw new Error('PRICE_ALLOWLIST_TOO_LARGE');
  const markets = JSON.parse(await readFile(registryPath, 'utf8'));
  const config = { programId, markets, intervalMs, timeoutMs: Number(process.env.ANTE_UP_PRICE_TIMEOUT_MS ?? 20_000), isStopping: () => stopping };
  validatePriceSamplerConfig(config);
  const rpcUrl = (await readFile(resolve(required('ANTE_UP_RPC_URL_FILE')), 'utf8')).trim();
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error('PRICE_RPC_URL_INVALID');
  const accounts = new KitFinalizedAccountReader(rpcUrl);
  const state = new FinalizedFinancialAccounts({ cluster: 'devnet', programId, accounts });
  const reader = createFinalizedChainPriceReader(state);
  const store = mode === '--dry-run' ? undefined : new SqlitePriceHistoryStore(resolve(required('ANTE_UP_PRICE_DB')), programId, intervalMs);
  const sampler = createPriceSampler(config, reader, store);
  try {
    if (mode !== '--follow') {
      const result = await sampler.runOnce(mode === '--dry-run');
      console.log(JSON.stringify(result));
      if (mode === '--once') await heartbeat(result);
      return;
    }
    while (!stopping) {
      try {
        const result = await sampler.runOnce(false);
        if (!stopping) { await heartbeat(result); console.log(JSON.stringify(result)); }
      } catch {
        await heartbeat({ status: 'ERROR', atMs: Date.now(), valid: 0, stored: 0 });
        console.error('PRICE_HISTORY_CYCLE_FAILED');
      }
      const delay = Math.max(1_000, intervalMs - Date.now() % intervalMs);
      await new Promise(done => { const timer = setTimeout(done, delay); wake = () => { clearTimeout(timer); done(); }; });
      wake = () => {};
    }
  } finally { store?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('PRICE_HISTORY_FAILED'); process.exitCode = 1; });
}
