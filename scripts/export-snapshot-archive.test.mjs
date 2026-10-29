import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { buildArchive } from './export-snapshot-archive.mjs';
import { verifyArchive } from './verify-snapshot-archive.mjs';
import { TrustedSnapshotArchive } from '../services/indexer/src/snapshot-archive.ts';
import { fixtureMarkets } from '../services/api/src/fixture.ts';
import { snapshotViewFromGenerated, verifyPublishedSnapshot } from '../services/indexer/src/snapshot.ts';
import { hash as canonicalHash } from '../services/data/index.mjs';
import { AdmissionReason, AdmissionState, DataStatus, MarketPhase, findSnapshotPda,
  getMarketEncoder, getSnapshotEncoder, getSnapshotDecoder, ANTE_UP_PROGRAM_ADDRESS } from '../clients/chain/dist/index.js';

const kit = createRequire(new URL('../clients/chain/package.json', import.meta.url))('@solana/kit');
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

test('archive preserves only complete finalized, PDA-bound snapshots and never overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-archive-'));
  try {
    const sourceDb = join(dir, 'source.sqlite'), outPath = join(dir, 'archive.sqlite'), rpcFile = join(dir, 'rpc.url');
    await writeFile(rpcFile, 'https://rpc.invalid\n');
    const programId = String(ANTE_UP_PROGRAM_ADDRESS), marketAddress = '11111111111111111111111111111111';
    const candidate = structuredClone(fixtureMarkets[0].snapshot.payload);
    candidate.marketId = marketAddress;
    candidate.sequence = '1';
    const payloadHash = canonicalHash(candidate), sequence = BigInt(candidate.sequence);
    const version = new Uint8Array(16); version.set(new TextEncoder().encode(candidate.formulaVersion));
    const encodedSnapshot = getSnapshotEncoder().encode({ market: kit.address(marketAddress), sequence,
      payloadHash: Uint8Array.from(Buffer.from(payloadHash, 'hex')),
      evidenceHash: Uint8Array.from(Buffer.from(candidate.evidenceHash, 'hex')),
      queryHash: Uint8Array.from(Buffer.from(candidate.queryHash, 'hex')),
      queryVersion: BigInt(candidate.queryVersion), configVersion: BigInt(candidate.configVersion),
      formulaVersion: version, dataThrough: BigInt(candidate.dataThrough),
      publishedAt: BigInt(candidate.computedAt), activityNowQ12: BigInt(candidate.activityNowQ12),
      activity7dQ12: BigInt(candidate.activity7dQ12), dataStatus: DataStatus.Valid,
      admission: { state: AdmissionState.Blocked, recoveryCount: 0, reason: AdmissionReason.PendingConfirmation } });
    const snapshotData = new Uint8Array(264); snapshotData.set(encodedSnapshot);
    const [snapshotAddress] = await findSnapshotPda({ market: kit.address(marketAddress), sequence },
      { programAddress: kit.address(programId) });
    const marketData = getMarketEncoder().encode({ id: new Uint8Array(32), admin: kit.address(programId),
      queryHash: Uint8Array.from(Buffer.from(candidate.queryHash, 'hex')),
      queryVersion: BigInt(candidate.queryVersion), phase: MarketPhase.Curve,
      dataStatus: DataStatus.Valid, admission: { state: AdmissionState.Blocked, recoveryCount: 0,
        reason: AdmissionReason.PendingConfirmation }, latestSequence: sequence,
      latestHash: Uint8Array.from(Buffer.from(payloadHash, 'hex')),
      latestDataThrough: BigInt(candidate.dataThrough), latestNowQ12: BigInt(candidate.activityNowQ12),
      latest7dQ12: BigInt(candidate.activity7dQ12), validityGeneration: 1n });
    const view = snapshotViewFromGenerated(getSnapshotDecoder().decode(snapshotData), String(snapshotAddress), programId);
    const published = verifyPublishedSnapshot({ cluster: 'devnet', programId, signature: 'sig', slot: '1',
      marketAddress, marketId: marketAddress, sequence: candidate.sequence,
      eventPayloadHash: payloadHash, candidate, account: view });
    const db = new DatabaseSync(sourceDb);
    db.exec('CREATE TABLE finalized_events(cluster TEXT,program_id TEXT,kind TEXT,event_json TEXT); CREATE TABLE snapshot_candidates(cluster TEXT,program_id TEXT,market_address TEXT,sequence TEXT,payload_hash TEXT,candidate_json TEXT)');
    db.prepare('INSERT INTO finalized_events VALUES(?,?,?,?)').run('devnet', programId, 'snapshot',
      JSON.stringify({ kind: 'snapshot', finality: 'finalized', signature: 'sig', slot: '1', snapshot: published }));
    db.prepare('INSERT INTO snapshot_candidates VALUES(?,?,?,?,?,?)').run('devnet', programId, marketAddress,
      candidate.sequence, payloadHash, JSON.stringify(candidate));
    db.close();
    const accounts = { async scan() { return { slot: '10', accounts: [
      { address: marketAddress, ownerProgramId: programId, data: marketData },
      { address: String(snapshotAddress), ownerProgramId: programId, data: snapshotData }
    ] }; } };
    const input = { sourceDb, outPath, rpcFile, genesis: GENESIS, accounts };
    const plan = await buildArchive(input);
    assert.equal(plan.snapshots, 1);
    assert.equal((await buildArchive({ ...input, create: true })).digest, plan.digest);
    const archive = new DatabaseSync(outPath, { readOnly: true });
    assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 1);
    assert.equal(Buffer.compare(archive.prepare('SELECT account_data FROM snapshots').get().account_data, Buffer.from(snapshotData)), 0);
    archive.close();
    const trustedSha = createHash('sha256').update(await readFile(outPath)).digest('hex');
    const verifiedArchive = await verifyArchive({ archivePath: outPath, expectedSha256: trustedSha });
    assert.equal(verifiedArchive.snapshots, 1);
    assert.equal(verifiedArchive.integrity, 'ok');
    const trusted = new TrustedSnapshotArchive(outPath, trustedSha, programId);
    assert.equal((await trusted.entries()).length, 1);
    assert.equal(Buffer.compare((await trusted.get(String(snapshotAddress))).data, Buffer.from(snapshotData)), 0);
    await assert.rejects(new TrustedSnapshotArchive(outPath, '0'.repeat(64), programId).entries(), /ARCHIVE_FILE_HASH_MISMATCH/);
    await assert.rejects(verifyArchive({ archivePath: outPath, expectedSha256: '0'.repeat(64) }), /ARCHIVE_FILE_HASH_MISMATCH/);
    await assert.rejects(buildArchive({ ...input, create: true }), /EEXIST/);
    const bad = { async scan() { return { slot: '10', accounts: [
      { address: marketAddress, ownerProgramId: programId, data: marketData } ] }; } };
    await assert.rejects(buildArchive({ ...input, accounts: bad }), /ARCHIVE_EVENT_COUNT_MISMATCH/);
    const wrongPda = { async scan() { return { slot: '10', accounts: [
      { address: marketAddress, ownerProgramId: programId, data: marketData },
      { address: programId, ownerProgramId: programId, data: snapshotData }
    ] }; } };
    await assert.rejects(buildArchive({ ...input, accounts: wrongPda }), /ARCHIVE_PDA_MISMATCH/);
    const tampered = new DatabaseSync(sourceDb);
    tampered.prepare('UPDATE snapshot_candidates SET candidate_json=?').run(JSON.stringify({ ...candidate, dataThrough: candidate.dataThrough + 1 }));
    tampered.close();
    await assert.rejects(buildArchive(input), /ARCHIVE_CANDIDATE_HASH_MISMATCH/);
    const damaged = new DatabaseSync(outPath);
    damaged.prepare('UPDATE snapshots SET account_data=?').run(Buffer.alloc(264));
    damaged.close();
    const damagedSha = createHash('sha256').update(await readFile(outPath)).digest('hex');
    await assert.rejects(verifyArchive({ archivePath: outPath, expectedSha256: damagedSha }), /ARCHIVE_ACCOUNT_HASH_MISMATCH/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
