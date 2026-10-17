import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { ReferenceObservationStore } from '../src/reference-observations.ts';
import { ingestReferenceEvidence } from '../src/reference-ingest.ts';

test('verified reference captures persist, reject invalid evidence, and remain read-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-reference-'));
  const dbPath = join(dir, 'reference.sqlite');
  const rawPath = join(dir, 'raw.json');
  const observationPath = join(dir, 'observation.json');
  try {
    const observedAtMs = Date.parse('2026-10-16T11:00:00Z');
    const make = async (value: string, capturedAtMs = observedAtMs) => {
      const raw = Buffer.from(JSON.stringify({ id: 'S0Q4gqBUs7c', viewCount: value }));
      const item = { slug: 'youtube-S0Q4gqBUs7c', kind: 'YOUTUBE_VIEWS', aggregation: 'cumulative',
        value, observedAtMs, capturedAtMs, reportedDate: null, provider: 'YouTube',
        sourceUrl: 'https://www.youtube.com/watch?v=S0Q4gqBUs7c',
        rawSha256: createHash('sha256').update(raw).digest('hex') };
      await writeFile(rawPath, raw); await writeFile(observationPath, JSON.stringify(item));
      return item;
    };
    const first = await make('14200000');
    assert.deepEqual(await ingestReferenceEvidence({ dbPath, observationPath, rawPath }),
      { inserted: true, slug: first.slug, observedAtMs });
    assert.equal((await ingestReferenceEvidence({ dbPath, observationPath, rawPath })).inserted, false);
    const revised = await make('14200001', observedAtMs + 1000);
    // An exact-time platform count cannot be retrospectively relabeled as a later capture.
    await assert.rejects(ingestReferenceEvidence({ dbPath, observationPath, rawPath }), /INVALID_REFERENCE_OBSERVATION/);
    const raw = await readFile(rawPath);
    await writeFile(observationPath, JSON.stringify({ ...first, rawSha256: '0'.repeat(64) }));
    await assert.rejects(ingestReferenceEvidence({ dbPath, observationPath, rawPath }), /REFERENCE_RAW_HASH_MISMATCH/);
    assert.ok(raw.length > 0 && revised.value !== first.value);
    const store = new ReferenceObservationStore(dbPath);
    try {
      assert.equal(store.latest()[0].value, first.value);
      assert.equal(createHash('sha256').update(store.raw(first.rawSha256)!).digest('hex'), first.rawSha256);
      const datedRaw = Buffer.from(JSON.stringify({ track: '2ZaL63zLMDr6H18El2EIt9', streams: '49000000' }));
      const revisedRaw = Buffer.from(JSON.stringify({ track: '2ZaL63zLMDr6H18El2EIt9', streams: '49000001' }));
      const dated = { slug: 'spotify-2ZaL63zLMDr6H18El2EIt9', kind: 'SPOTIFY_STREAMS',
        aggregation: 'cumulative', value: '49000000', reportedDate: '2026-10-16',
        observedAtMs: Date.parse('2026-10-16T00:00:00Z'), capturedAtMs: Date.parse('2026-10-16T10:00:00Z'),
        provider: 'Kworb', sourceUrl: 'https://kworb.net/spotify/artist/example.html',
        rawSha256: createHash('sha256').update(datedRaw).digest('hex') };
      assert.equal(store.append(dated, datedRaw), true);
      assert.equal(store.append({ ...dated, value: '49000001', capturedAtMs: dated.capturedAtMs + 1000,
        rawSha256: createHash('sha256').update(revisedRaw).digest('hex') }, revisedRaw), true);
      assert.equal(store.history(dated.slug)[0].value, '49000001');
      const app = createApp({ referenceObservations: store });
      const response = await app.handle(new Request('http://localhost/v1/reference/history/youtube-S0Q4gqBUs7c'));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data[0].rawSha256, first.rawSha256);
      assert.equal((await app.handle(new Request('http://localhost/v1/reference/latest', { method: 'POST' }))).status, 400);
    } finally { store.close(); }
    const reopened = new ReferenceObservationStore(dbPath);
    try { assert.equal(reopened.history(first.slug).length, 1); }
    finally { reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
