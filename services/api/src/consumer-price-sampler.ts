import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { UNIT, indexPrice } from '../../../contracts/reference.mjs';
import { DataStatus, MarketPhase } from '../../../clients/chain/dist/index.js';
import type { MarketRegistryEntry } from './live-read.ts';
import type { FinalizedFinancialAccounts } from './financial-chain.ts';
import type { FinalizedPriceObservation } from './consumer-history.ts';

export const DEFAULT_PRICE_INTERVAL_MS = 300_000;
export const DEFAULT_PRICE_RETENTION_MS = 90 * 86_400_000;
export const DEFAULT_PRICE_MAX_MARKETS = 8;
export const DEFAULT_PRICE_MAX_ROWS_PER_MARKET = 26_000;
const hex = (value: ArrayLike<number>) => Buffer.from(Uint8Array.from(value)).toString('hex');
const atoms = (value: bigint) => value > 0n && value <= 18_446_744_073_709_551_615n;

export interface PriceCapture {
  marketId: string; kind: 'CURVE_PRICE' | 'REFERENCE_PRICE'; atMs: number; valueAtoms: string;
  snapshotHash: string; snapshotSequence: string; stateVersion: string;
}
export interface PriceSampleResult {
  atMs: number; valid: number; stored: number; skipped: number; noData: number; readErrors: number;
  status: 'OK' | 'PARTIAL' | 'NO_DATA' | 'ERROR'; dryRun: boolean;
}
export interface PriceSamplerConfig {
  programId: string; markets: MarketRegistryEntry[]; intervalMs?: number; maxMarkets?: number;
  timeoutMs?: number; nowMs?: () => number; isStopping?: () => boolean;
}
export interface PriceReader { read(entry: MarketRegistryEntry, atMs: number): Promise<PriceCapture | null> }

const boundedInt = (value: number, min: number, max: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}_OUT_OF_RANGE`);
  return value;
};
export function validatePriceSamplerConfig(config: PriceSamplerConfig) {
  const intervalMs = boundedInt(config.intervalMs ?? DEFAULT_PRICE_INTERVAL_MS, 60_000, 3_600_000, 'INTERVAL');
  const timeoutMs = boundedInt(config.timeoutMs ?? 20_000, 1_000, Math.min(intervalMs, 60_000), 'TIMEOUT');
  const maxMarkets = boundedInt(config.maxMarkets ?? DEFAULT_PRICE_MAX_MARKETS, 1, 64, 'MAX_MARKETS');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.programId)) throw new Error('PROGRAM_ID_INVALID');
  if (!Array.isArray(config.markets) || config.markets.length < 1 || config.markets.length > maxMarkets) throw new Error('MARKET_ALLOWLIST_INVALID');
  const ids = new Set<string>();
  for (const entry of config.markets) {
    if (!entry || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(entry.address) || !/^[0-9a-f]{64}$/.test(entry.seedHex) || ids.has(entry.address))
      throw new Error('MARKET_ALLOWLIST_INVALID');
    ids.add(entry.address);
  }
  if (timeoutMs * config.markets.length > intervalMs) throw new Error('PRICE_CYCLE_BUDGET_EXCEEDED');
  return { intervalMs, timeoutMs, maxMarkets, ids };
}

/** Uses finalized account readers and the same marginal/index formulas as live-read. */
export function createFinalizedChainPriceReader(state: FinalizedFinancialAccounts): PriceReader {
  if (state.options.cluster !== 'devnet') throw new Error('PRICE_READER_DEVNET_ONLY');
  return { async read(entry, atMs) {
    const market = await state.market(entry.address);
    if (hex(market.id) !== entry.seedHex) throw new Error('PRICE_MARKET_SEED_MISMATCH');
    const fm = await state.financeMarket(entry.address);
    const nowSeconds = Math.floor(atMs / 1000);
    if (market.latestSequence <= 0n || market.latestDataThrough > BigInt(nowSeconds) ||
      BigInt(nowSeconds) - market.latestDataThrough >= 600n ||
      (market.dataStatus !== DataStatus.Valid && market.dataStatus !== DataStatus.LowActivity)) return null;
    const snapshot = await state.snapshot(entry.address, market.latestSequence);
    const payloadHash = hex(market.latestHash);
    if (!snapshot || hex(snapshot.payloadHash) !== payloadHash || snapshot.sequence !== market.latestSequence ||
      snapshot.dataThrough !== market.latestDataThrough || snapshot.dataStatus !== market.dataStatus ||
      snapshot.activityNowQ12.__option !== market.latestNowQ12.__option ||
      snapshot.activity7dQ12.__option !== market.latest7dQ12.__option ||
      snapshot.activityNowQ12.__option === 'Some' && market.latestNowQ12.__option === 'Some' && snapshot.activityNowQ12.value !== market.latestNowQ12.value ||
      snapshot.activity7dQ12.__option === 'Some' && market.latest7dQ12.__option === 'Some' && snapshot.activity7dQ12.value !== market.latest7dQ12.value) return null;
    let price: bigint, kind: PriceCapture['kind'];
    if (market.phase === MarketPhase.Curve) {
      price = UNIT + fm.curveSold / 5000n; kind = 'CURVE_PRICE';
    } else if (market.phase === MarketPhase.Indexed && market.latestNowQ12.__option === 'Some' &&
      market.latest7dQ12.__option === 'Some' && market.latest7dQ12.value > 0n) {
      try {
        const calculated = indexPrice(fm.anchorPg, fm.anchorSg, fm.anchorDg, market.latestNowQ12.value, market.latest7dQ12.value);
        if (BigInt(calculated.maximum) !== fm.pmax) return null;
        price = BigInt(calculated.price); kind = 'REFERENCE_PRICE';
      } catch { return null; }
    } else return null;
    if (!atoms(price)) return null;
    return { marketId: entry.address, kind, atMs, valueAtoms: price.toString(), snapshotHash: payloadHash,
      snapshotSequence: market.latestSequence.toString(), stateVersion: fm.stateVersion.toString() };
  } };
}

/** Dedicated durable history DB; never edits the indexer or financial state database. */
export class SqlitePriceHistoryStore {
  private readonly db: DatabaseSync;
  private readonly programId: string;
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private readonly maxRowsPerMarket: number;
  private readonly maxMarkets: number;
  constructor(path: string, programId: string, intervalMs = DEFAULT_PRICE_INTERVAL_MS,
    retentionMs = DEFAULT_PRICE_RETENTION_MS, maxRowsPerMarket = DEFAULT_PRICE_MAX_ROWS_PER_MARKET,
    readOnly = false, maxMarkets = DEFAULT_PRICE_MAX_MARKETS) {
    boundedInt(intervalMs, 60_000, 3_600_000, 'INTERVAL');
    boundedInt(retentionMs, 86_400_000, 365 * 86_400_000, 'RETENTION');
    boundedInt(maxRowsPerMarket, 1, 105_120, 'MAX_ROWS');
    boundedInt(maxMarkets, 1, 64, 'MAX_MARKETS');
    this.programId = programId; this.intervalMs = intervalMs; this.retentionMs = retentionMs;
    this.maxRowsPerMarket = maxRowsPerMarket; this.maxMarkets = maxMarkets;
    this.db = new DatabaseSync(path, { readOnly });
    if (!readOnly) this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS consumer_price_history (
        cluster TEXT NOT NULL CHECK(cluster='devnet'), program_id TEXT NOT NULL, market_id TEXT NOT NULL,
        bucket_ms INTEGER NOT NULL, observed_at_ms INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('CURVE_PRICE','REFERENCE_PRICE')),
        value_atoms TEXT NOT NULL, snapshot_hash TEXT NOT NULL, snapshot_sequence TEXT NOT NULL, state_version TEXT NOT NULL,
        PRIMARY KEY(cluster,program_id,market_id,bucket_ms));
      CREATE INDEX IF NOT EXISTS consumer_price_history_time ON consumer_price_history(cluster,program_id,market_id,observed_at_ms);`);
  }
  close() { this.db.close(); }
  insert(capture: PriceCapture, allowedMarkets: Set<string>): boolean {
    if (!allowedMarkets.has(capture.marketId) || !Number.isSafeInteger(capture.atMs) || capture.atMs <= 0 ||
      !/^(0|[1-9][0-9]*)$/.test(capture.valueAtoms) || BigInt(capture.valueAtoms) <= 0n ||
      !/^[0-9a-f]{64}$/.test(capture.snapshotHash) || !/^(0|[1-9][0-9]*)$/.test(capture.snapshotSequence) ||
      !/^(0|[1-9][0-9]*)$/.test(capture.stateVersion)) throw new Error('PRICE_CAPTURE_INVALID');
    const bucket = Math.floor(capture.atMs / this.intervalMs) * this.intervalMs;
    const result = this.db.prepare(`INSERT OR IGNORE INTO consumer_price_history
      (cluster,program_id,market_id,bucket_ms,observed_at_ms,kind,value_atoms,snapshot_hash,snapshot_sequence,state_version)
      VALUES('devnet',?,?,?,?,?,?,?,?,?)`).run(this.programId,capture.marketId,bucket,capture.atMs,capture.kind,capture.valueAtoms,
        capture.snapshotHash,capture.snapshotSequence,capture.stateVersion);
    return result.changes === 1;
  }
  prune(nowMs: number, allowedMarkets: Set<string>) {
    const cutoff = nowMs - this.retentionMs;
    this.db.prepare('DELETE FROM consumer_price_history WHERE cluster=? AND program_id=? AND observed_at_ms<?').run('devnet',this.programId,cutoff);
    const trim = this.db.prepare(`DELETE FROM consumer_price_history WHERE rowid IN (
      SELECT rowid FROM consumer_price_history WHERE cluster='devnet' AND program_id=? AND market_id=?
      ORDER BY observed_at_ms DESC LIMIT -1 OFFSET ?)`);
    for (const marketId of allowedMarkets) trim.run(this.programId,marketId,this.maxRowsPerMarket);
    this.db.prepare(`DELETE FROM consumer_price_history WHERE rowid IN (
      SELECT rowid FROM consumer_price_history WHERE cluster='devnet' AND program_id=?
      ORDER BY observed_at_ms DESC LIMIT -1 OFFSET ?)`).run(this.programId,this.maxRowsPerMarket*this.maxMarkets);
  }
  async priceObservations(marketId: string): Promise<FinalizedPriceObservation[]> {
    const rows = this.db.prepare(`SELECT bucket_ms,observed_at_ms,kind,value_atoms,snapshot_hash FROM consumer_price_history
      WHERE cluster='devnet' AND program_id=? AND market_id=? ORDER BY observed_at_ms`).all(this.programId,marketId) as Array<{
      bucket_ms:number;observed_at_ms:number;kind:'CURVE_PRICE'|'REFERENCE_PRICE';value_atoms:string;snapshot_hash:string}>;
    return rows.map(row => ({ id: `sample:${createHash('sha256').update(`${this.programId}:${marketId}:${row.bucket_ms}:${row.snapshot_hash}`).digest('hex')}`,
      marketId, kind: row.kind, atMs: row.observed_at_ms, valueAtoms: row.value_atoms, finality: 'finalized' as const,
      maxContinuityMs: this.intervalMs * 2 + 60_000 }));
  }
  health(nowMs: number, allowedMarkets: Set<string>) {
    const rows = [...allowedMarkets].map(marketId => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count, MAX(observed_at_ms) AS latest FROM consumer_price_history
        WHERE cluster='devnet' AND program_id=? AND market_id=?`).get(this.programId,marketId) as {count:number;latest:number|null};
      return { marketId, points: row.count, latestAtMs: row.latest, fresh: row.latest !== null && nowMs - row.latest < this.intervalMs * 3 };
    });
    return { mode: 'LIVE', cluster: 'devnet', programId: this.programId, checkedAtMs: nowMs, markets: rows };
  }
}

export function openPriceHistoryReadStore(path: string, programId: string, intervalMs = DEFAULT_PRICE_INTERVAL_MS) {
  return new SqlitePriceHistoryStore(path, programId, intervalMs, DEFAULT_PRICE_RETENTION_MS,
    DEFAULT_PRICE_MAX_ROWS_PER_MARKET, true);
}

export function createPriceSampler(config: PriceSamplerConfig, reader: PriceReader, store?: SqlitePriceHistoryStore) {
  const limits = validatePriceSamplerConfig(config);
  const nowMs = config.nowMs ?? Date.now;
  return { async runOnce(dryRun = false): Promise<PriceSampleResult> {
    const atMs = nowMs();
    if (!Number.isSafeInteger(atMs) || atMs <= 0) throw new Error('PRICE_CLOCK_INVALID');
    let valid = 0, stored = 0, noData = 0, readErrors = 0;
    for (const entry of config.markets) {
      if (config.isStopping?.()) break;
      const observedAtMs = nowMs();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) throw new Error('PRICE_CLOCK_INVALID');
      let capture: PriceCapture | null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        capture = await Promise.race([reader.read(entry, observedAtMs), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PRICE_READ_TIMEOUT')), limits.timeoutMs);
        })]);
      } catch { readErrors++; continue; }
      finally { clearTimeout(timer); }
      if (!capture) { noData++; continue; }
      if (capture.marketId !== entry.address || capture.atMs !== observedAtMs) throw new Error('PRICE_CAPTURE_SCOPE_MISMATCH');
      valid++;
      if (!dryRun) {
        if (!store) throw new Error('PRICE_STORE_REQUIRED');
        if (store.insert(capture, limits.ids)) stored++;
      }
    }
    if (!dryRun) store?.prune(atMs, limits.ids);
    return { atMs, valid, stored, skipped: config.markets.length - valid, noData, readErrors,
      status: readErrors ? 'ERROR' : valid === 0 ? 'NO_DATA' : noData ? 'PARTIAL' : 'OK', dryRun };
  }, limits };
}
