import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { address } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS, AdmissionReason, AdmissionState, DataStatus, MarketPhase,
  findAdmissionPda, findMarketPda, getAdmissionEncoder, getMarketEncoder } from '../../../clients/chain/dist/index.js';
import { SqlitePriceHistoryStore } from '../src/consumer-price-sampler.ts';
import { createLiveApp } from '../src/live.ts';

test('createLiveApp boots with no sampler DB, then reads persisted price only after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au-consumer-live-'));
  const dbPath = join(dir, 'index.sqlite'), priceDbPath = join(dir, 'late-price.sqlite');
  const programId = String(ANTE_UP_PROGRAM_ADDRESS), seed = new Uint8Array(32).fill(9);
  const [marketAddress] = await findMarketPda({ marketId: seed }, { programAddress: address(programId) });
  const [admissionAddress] = await findAdmissionPda({ programAddress: address(programId) });
  const marketId = String(marketAddress), now = 1_800_000_000;
  const accounts = { async get(id: string) {
    if (id === String(admissionAddress)) return { ownerProgramId: programId,
      data: getAdmissionEncoder().encode({ admin: address(programId), open: true, outstanding: 0, recent: Array(100).fill(0n), fundedOpenCap: 1n, fundedOpenCount: 0n }) };
    if (id === marketId) return { ownerProgramId: programId, data: getMarketEncoder().encode({
      id: seed, admin: address(programId), queryHash: new Uint8Array(32), queryVersion: 0n,
      phase: MarketPhase.Curve, dataStatus: DataStatus.Preparing,
      admission: { state: AdmissionState.Blocked, recoveryCount: 0, reason: AdmissionReason.DataNotReady },
      latestSequence: 0n, latestHash: new Uint8Array(32), latestDataThrough: 0n,
      latestNowQ12: null, latest7dQ12: null, validityGeneration: 0n,
    }) };
    return null;
  } };
  const config = { mode: 'devnet' as const, programId, rpcUrl: 'http://unused.invalid', dbPath, priceDbPath,
    markets: [{ address: marketId, seedHex: Buffer.from(seed).toString('hex'), keyword: 'solana', aliases: [] }],
    accounts, now: () => now,
    blockhashes: { async latest() { return { blockhash: marketId, lastValidBlockHeight: 100n }; } },
    chain: { async get() { return null; }, async discover() { return []; } },
  };
  const path = '/v1/consumer/markets/' + marketId + '/history?period=1W';
  const read = async (live: ReturnType<typeof createLiveApp>) => {
    const result = await live.app.handle(new Request('http://local.test' + path));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    return await result.json() as any;
  };
  let live: ReturnType<typeof createLiveApp> | null = null;
  try {
    assert.equal(existsSync(priceDbPath), false);
    live = createLiveApp(config);
    const empty = await read(live);
    assert.equal(empty.mode, 'devnet');
    assert.equal(empty.data.market.id, marketId);
    assert.deepEqual(empty.data.series, []);
    assert.equal(existsSync(priceDbPath), false, 'API must not create the sampler database');
    const writer = new SqlitePriceHistoryStore(priceDbPath, programId);
    try {
      assert.equal(writer.insert({ marketId, kind: 'CURVE_PRICE', atMs: (now - 300) * 1000,
        valueAtoms: '1250000', snapshotHash: 'a'.repeat(64), snapshotSequence: '1', stateVersion: '1' },
        new Set([marketId])), true);
    } finally { writer.close(); }
    assert.deepEqual((await read(live)).data.series, [], 'a missing DB at boot stays disconnected until restart');
    live.close(); live = null;
    const indexDb = new DatabaseSync(dbPath);
    try {
      const quote = { id: 'quote-1', intent: { marketId, action: 'curveBuy' },
        chain: { cluster: 'devnet', programId, address: marketId }, phase: 'CURVE',
        executable: true, priceAtoms: '1100000', quotedAt: now - 600 };
      indexDb.prepare('INSERT INTO live_financial_quotes(id,request_id,wallet,cluster,program_id,quote_json,expires_at) VALUES(?,?,?,?,?,?,?)')
        .run('quote-1', 'request-1', programId, 'devnet', programId, JSON.stringify(quote), now + 100);
    } finally { indexDb.close(); }
    live = createLiveApp(config);
    const populated = await read(live);
    assert.deepEqual(populated.data.series.map((series: any) => series.kind), ['CURVE_PRICE']);
    assert.deepEqual(populated.data.series[0].points.map((point: any) => point.value), ['1.100000', '1.250000']);
    assert.equal(populated.data.series[0].points[1].atMs, (now - 300) * 1000);
    assert.equal(populated.data.market.latestPrice, null, 'historical sampler point is not a current executable quote');
  } finally { live?.close(); rmSync(dir, { recursive: true, force: true }); }
});
