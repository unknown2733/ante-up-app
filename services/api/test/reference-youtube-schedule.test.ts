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

test('oracle preparation uses a separate five-minute budget and never exceeds 288 calls per UTC day', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-youtube-budget-'));
  const dbPath = join(dir, 'api.sqlite');
  try {
    const fast = new ReferenceYouTubeRequestBudget(dbPath, 'oracle-prep');
    try {
      assert.notEqual(fast.reserve(t0).id, null);
      assert.deepEqual(fast.reserve(t0 + 60_000), { id: null, reason: 'MIN_INTERVAL' });
      for (let i = 1; i < 288; i++)
        assert.notEqual(fast.reserve(t0 + i * 300_000).id, null);
      assert.deepEqual(fast.reserve(t0 + 287 * 300_000 + 59_000),
        { id: null, reason: 'MIN_INTERVAL' });
      assert.notEqual(fast.reserve(t0 + 288 * 300_000).id, null);
    } finally { fast.close(); }
    const reference = new ReferenceYouTubeRequestBudget(dbPath);
    try {
      assert.notEqual(reference.reserve(t0 + 60_000).id, null);
      assert.deepEqual(reference.reserve(t0 + 6 * 60 * 60 * 1000).reason, 'MIN_INTERVAL');
    } finally { reference.close(); }
    assert.throws(() => new ReferenceYouTubeRequestBudget(dbPath, 'unknown' as 'reference'),
      /YOUTUBE_CADENCE_INVALID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('oracle preparation accepts the next calendar slot despite container startup jitter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-youtube-budget-'));
  try {
    const budget = new ReferenceYouTubeRequestBudget(join(dir, 'api.sqlite'), 'oracle-prep');
    try {
      assert.notEqual(budget.reserve(t0 + 55_000).id, null);
      assert.deepEqual(budget.reserve(t0 + 299_000), { id: null, reason: 'MIN_INTERVAL' });
      // The next systemd timer may start only 250 seconds after a late capture.
      assert.notEqual(budget.reserve(t0 + 305_000).id, null);
    } finally { budget.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('oracle preparation appends real captured snapshots only when its five-minute slot is due', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-youtube-budget-'));
  const dbPath = join(dir, 'api.sqlite');
  let calls = 0;
  const fetcher = (async () => new Response(JSON.stringify({ items: [
    { id: 'S0Q4gqBUs7c', statistics: { viewCount: String(14_200_000 + ++calls) } },
    { id: 'sTcHbELHYCk', statistics: { viewCount: '2790000' } },
    { id: 'jrDv0OdMt5s', statistics: { viewCount: '420001' } },
  ] }), { status: 200 })) as typeof fetch;
  try {
    const input = { dbPath, apiKey: 'fixture', cadence: 'oracle-prep' as const, fetcher };
    assert.equal((await runBoundedYouTubeReferenceViews({ ...input, nowMs: () => t0 })).status, 'SUCCESS');
    assert.deepEqual(await runBoundedYouTubeReferenceViews({ ...input, nowMs: () => t0 + 60_000 }),
      { status: 'SKIPPED', reason: 'MIN_INTERVAL' });
    assert.equal((await runBoundedYouTubeReferenceViews({ ...input, nowMs: () => t0 + 300_000 })).status, 'SUCCESS');
    assert.equal(calls, 2);
    const store = new ReferenceObservationStore(dbPath);
    try { assert.equal(store.history('youtube-S0Q4gqBUs7c').length, 2); }
    finally { store.close(); }
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
