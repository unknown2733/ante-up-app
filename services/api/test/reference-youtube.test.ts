import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectYouTubeReferenceViews } from '../src/reference-youtube.ts';
import { ReferenceObservationStore } from '../src/reference-observations.ts';

test('one approved YouTube statistics batch becomes three durable public observations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-youtube-'));
  const dbPath = join(dir, 'api.sqlite');
  try {
    let calls = 0;
    const fetcher = async (url: string, init?: RequestInit) => {
      calls++;
      const request = new URL(url);
      assert.equal(request.hostname, 'www.googleapis.com');
      assert.equal(request.pathname, '/youtube/v3/videos:batchGetStats');
      assert.equal(request.searchParams.get('part'), 'statistics');
      assert.equal(request.searchParams.get('id')?.split(',').length, 3);
      assert.equal(request.searchParams.has('key'), false);
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'test-secret');
      return new Response(JSON.stringify({ items: [
        { id: 'S0Q4gqBUs7c', statistics: { viewCount: '14200001' } },
        { id: 'sTcHbELHYCk', statistics: { viewCount: '2790000' } },
        { id: 'jrDv0OdMt5s', statistics: { viewCount: '420001' } },
      ] }), { status: 200 });
    };
    const result = await collectYouTubeReferenceViews({ dbPath, apiKey: 'test-secret',
      fetcher: fetcher as typeof fetch, nowMs: () => Date.parse('2026-10-17T03:00:00Z') });
    assert.equal(calls, 1);
    assert.equal(result.inserted.length, 3);
    assert.deepEqual(result.missing, []);
    const store = new ReferenceObservationStore(dbPath);
    try {
      assert.equal(store.latest().length, 3);
      assert.equal(store.history('youtube-S0Q4gqBUs7c')[0].value, '14200001');
      const raw = store.raw(store.latest()[0].rawSha256);
      assert.equal(JSON.parse(Buffer.from(raw!).toString('utf8')).items.length, 3);
    } finally { store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('malformed or failed provider response does not write fabricated observations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-youtube-'));
  const dbPath = join(dir, 'api.sqlite');
  try {
    const invalidFetcher = async () => new Response(JSON.stringify({ items: [
      { id: 'S0Q4gqBUs7c', statistics: { viewCount: 'NaN' } },
    ] }));
    await assert.rejects(collectYouTubeReferenceViews({ dbPath, apiKey: 'test-secret',
      fetcher: invalidFetcher as typeof fetch }), /YOUTUBE_RESPONSE_INVALID/);
    const store = new ReferenceObservationStore(dbPath);
    try { assert.deepEqual(store.latest(), []); }
    finally { store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
