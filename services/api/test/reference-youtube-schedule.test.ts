import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReferenceObservationStore } from '../src/reference-observations.ts';
import { ReferenceYouTubeRequestBudget, runBoundedYouTubeReferenceViews } from '../src/reference-youtube-schedule.ts';

const t0 = Date.parse('2026-10-17T00:00:00Z');

test('YouTube request reservation survives restart and prevents early repeat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-youtube-budget-'));
  const dbPath = join(dir, 'api.sqlite');
  try {
    const first = new ReferenceYouTubeRequestBudget(dbPath);
    const slot = first.reserve(t0);
    assert.equal(slot.reason, null);
    first.close();
    const resumed = new ReferenceYouTubeRequestBudget(dbPath);
    assert.deepEqual(resumed.reserve(t0 + 60_000), { id: null, reason: 'MIN_INTERVAL' });
    resumed.finish(slot.id!, 'FAILED', 'YOUTUBE_PROVIDER_HTTP_429');
    assert.notEqual(resumed.reserve(t0 + 6 * 60 * 60 * 1000).id, null);
    resumed.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('YouTube scheduler accepts only one approved batch per interval and keeps failed calls charged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-youtube-budget-'));
  const dbPath = join(dir, 'api.sqlite');
  let calls = 0;
  try {
    const fetcher = async () => {
      calls++;
      return new Response(JSON.stringify({ items: [
        { id: 'S0Q4gqBUs7c', statistics: { viewCount: '14200001' } },
        { id: 'sTcHbELHYCk', statistics: { viewCount: '2790000' } },
        { id: 'jrDv0OdMt5s', statistics: { viewCount: '420001' } },
      ] }), { status: 200 });
    };
    const first = await runBoundedYouTubeReferenceViews({ dbPath, apiKey: 'fixture',
      fetcher: fetcher as typeof fetch, nowMs: () => t0 });
    assert.equal(first.status, 'SUCCESS');
    assert.equal(calls, 1);
    assert.deepEqual(await runBoundedYouTubeReferenceViews({ dbPath, apiKey: 'fixture',
      fetcher: fetcher as typeof fetch, nowMs: () => t0 + 60_000 }),
      { status: 'SKIPPED', reason: 'MIN_INTERVAL' });
    assert.equal(calls, 1);
    await assert.rejects(runBoundedYouTubeReferenceViews({ dbPath, apiKey: 'fixture',
      fetcher: (async () => new Response('{}', { status: 429 })) as typeof fetch,
      nowMs: () => t0 + 6 * 60 * 60 * 1000 }), /YOUTUBE_PROVIDER_HTTP_429/);
    assert.deepEqual(await runBoundedYouTubeReferenceViews({ dbPath, apiKey: 'fixture',
      fetcher: fetcher as typeof fetch, nowMs: () => t0 + 6 * 60 * 60 * 1000 + 60_000 }),
      { status: 'SKIPPED', reason: 'MIN_INTERVAL' });
    assert.equal(calls, 1);
    const store = new ReferenceObservationStore(dbPath);
    try { assert.equal(store.latest().length, 3); }
    finally { store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
