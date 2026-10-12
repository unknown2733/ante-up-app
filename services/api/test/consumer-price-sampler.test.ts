import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStatus, MarketPhase } from '../../../clients/chain/dist/index.js';
import type { FinalizedFinancialAccounts } from '../src/financial-chain.ts';
import { createFinalizedChainPriceReader, createPriceSampler, openPriceHistoryReadStore, SqlitePriceHistoryStore, validatePriceSamplerConfig } from '../src/consumer-price-sampler.ts';

const programId = 'FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const marketId = '11111111111111111111111111111111';
const entry = { address: marketId, seedHex: 'aa'.repeat(32), keyword: 'solana', aliases: [] };
const hash = 'bb'.repeat(32);
const atMs = 1_800_000_000_000;
const capture = (time = atMs) => ({ marketId, kind: 'CURVE_PRICE' as const, atMs: time, valueAtoms: '1250000',
  snapshotHash: hash, snapshotSequence: '1', stateVersion: '2' });

test('one durable point per bucket across restarts; next bucket accumulates without backfill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au-price-')), path = join(dir, 'prices.sqlite');
  const ids = new Set([marketId]);
  try {
    const first = new SqlitePriceHistoryStore(path, programId);
    assert.equal(first.insert(capture(), ids), true);
    assert.equal(first.insert(capture(atMs + 1000), ids), false);
    first.close();
    const restarted = new SqlitePriceHistoryStore(path, programId);
    assert.equal(restarted.insert(capture(atMs + 2000), ids), false);
    assert.equal(restarted.insert(capture(atMs + 300_000), ids), true);
    assert.equal((await restarted.priceObservations(marketId)).length, 2);
    assert.equal(restarted.health(atMs + 300_000, ids).markets[0].fresh, true);
    restarted.close();
    const readOnly = openPriceHistoryReadStore(path, programId);
    assert.equal((await readOnly.priceObservations(marketId)).length, 2);
    readOnly.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dry-run makes no writes and scope/timeout bounds are enforced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au-price-')), path = join(dir, 'prices.sqlite');
  const store = new SqlitePriceHistoryStore(path, programId);
  try {
    const sampler = createPriceSampler({ programId, markets: [entry], nowMs: () => atMs }, { read: async () => capture() }, store);
    assert.deepEqual(await sampler.runOnce(true), { atMs, valid: 1, stored: 0, skipped: 0, noData: 0, readErrors: 0, status: 'OK', dryRun: true });
    assert.equal((await store.priceObservations(marketId)).length, 0);
    assert.equal((await sampler.runOnce(false)).stored, 1);
    const unavailable = createPriceSampler({ programId, markets: [entry], nowMs: () => atMs }, { read: async () => null }, store);
    assert.equal((await unavailable.runOnce(true)).status, 'NO_DATA');
    const wrong = createPriceSampler({ programId, markets: [entry], nowMs: () => atMs }, { read: async () => ({ ...capture(), marketId: programId }) }, store);
    await assert.rejects(wrong.runOnce(), /PRICE_CAPTURE_SCOPE_MISMATCH/);
    assert.throws(() => validatePriceSamplerConfig({ programId, markets: [...Array(9)].map((_, i) => ({ ...entry, address: `${i}` })) }), /MARKET_ALLOWLIST_INVALID/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('one reader failure does not block the next allowlisted market; storage errors still fail', async () => {
  const secondId = '22222222222222222222222222222222';
  const second = { ...entry, address: secondId, seedHex: 'cc'.repeat(32) };
  const dir = mkdtempSync(join(tmpdir(), 'au-price-')), path = join(dir, 'prices.sqlite');
  const store = new SqlitePriceHistoryStore(path, programId);
  try {
    const config = { programId, markets: [entry, second], nowMs: () => atMs };
    const sampler = createPriceSampler(config, { read: async item => {
      if (item.address === marketId) throw new Error('RPC_UNAVAILABLE');
      return { ...capture(), marketId: secondId };
    } }, store);
    assert.deepEqual(await sampler.runOnce(), { atMs, valid: 1, stored: 1, skipped: 1, noData: 0, readErrors: 1, status: 'ERROR', dryRun: false });
    assert.equal((await store.priceObservations(secondId)).length, 1);
    const broken = createPriceSampler(config, { read: async item => item.address === marketId ? null :
      { ...capture(atMs + 300_000), marketId: secondId, atMs, snapshotHash: 'invalid' } }, store);
    await assert.rejects(broken.runOnce(), /PRICE_CAPTURE_INVALID/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('retention removes old samples and missing cycles remain absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au-price-')), path = join(dir, 'prices.sqlite');
  const store = new SqlitePriceHistoryStore(path, programId);
  const ids = new Set([marketId]);
  try {
    store.insert(capture(atMs), ids);
    store.insert(capture(atMs + 3_600_000), ids);
    assert.deepEqual((await store.priceObservations(marketId)).map(point => point.atMs), [atMs, atMs + 3_600_000]);
    store.prune(atMs + 91 * 86_400_000, ids);
    assert.deepEqual(await store.priceObservations(marketId), []);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('finalized chain reader enforces snapshot match, freshness and data status', async () => {
  const option = (value: bigint) => ({ __option: 'Some' as const, value });
  const chainMarket = { id: Uint8Array.from(Buffer.from(entry.seedHex, 'hex')), latestSequence: 1n,
    latestHash: Uint8Array.from(Buffer.from(hash, 'hex')), latestDataThrough: BigInt(atMs / 1000 - 60),
    dataStatus: DataStatus.Valid, phase: MarketPhase.Curve, latestNowQ12: option(2n), latest7dQ12: option(1n) };
  const snapshot = { payloadHash: chainMarket.latestHash, sequence: 1n, dataThrough: chainMarket.latestDataThrough,
    dataStatus: DataStatus.Valid, activityNowQ12: option(2n), activity7dQ12: option(1n) };
  const finance = { curveSold: 1250n * 5000n, stateVersion: 2n };
  const state = { options: { cluster: 'devnet' }, market: async () => chainMarket,
    financeMarket: async () => finance, snapshot: async () => snapshot } as unknown as FinalizedFinancialAccounts;
  const reader = createFinalizedChainPriceReader(state);
  assert.equal((await reader.read(entry, atMs))?.kind, 'CURVE_PRICE');
  chainMarket.dataStatus = DataStatus.Outage;
  assert.equal(await reader.read(entry, atMs), null);
  chainMarket.dataStatus = DataStatus.Valid;
  chainMarket.latestDataThrough = BigInt(atMs / 1000 - 601);
  assert.equal(await reader.read(entry, atMs), null);
  chainMarket.latestDataThrough = snapshot.dataThrough;
  snapshot.payloadHash = Uint8Array.from(Buffer.alloc(32));
  assert.equal(await reader.read(entry, atMs), null);
  snapshot.payloadHash = chainMarket.latestHash;
  chainMarket.phase = MarketPhase.Indexed;
  Object.assign(finance, { anchorPg: 1_000_000n, anchorSg: 1n, anchorDg: 1n, pmax: 5_000_000n });
  const indexed = await reader.read(entry, atMs);
  assert.equal(indexed?.kind, 'REFERENCE_PRICE');
  assert.equal(indexed?.valueAtoms, '2000000');
});
