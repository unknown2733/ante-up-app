import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectXReferenceLikes } from '../src/reference-x-posts.ts';
import { ReferenceObservationStore } from '../src/reference-observations.ts';

const ids = ['1557433517579141121', '1858854362614763615', '2043769559614656588'];
const mockData = ids.map((id, index) => ({ id, public_metrics: { like_count: 4000 + index } }));

test('approved X posts become durable observations in one bounded lookup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-x-posts-'));
  const dbPath = join(dir, 'api.sqlite');
  try {
    let calls = 0;
    const fetcher = async (url: string, options?: RequestInit) => {
      calls++;
      const request = new URL(url);
      assert.equal(request.hostname, 'api.x.com');
      assert.deepEqual(request.searchParams.get('ids')?.split(','), ids);
      assert.equal(request.searchParams.get('tweet.fields'), 'public_metrics');
      assert.equal(options?.headers && (options.headers as Record<string, string>).Authorization, 'Bearer test-token');
      return new Response(JSON.stringify({ data: mockData }), { status: 200 });
    };
    const result = await collectXReferenceLikes({ dbPath, bearerToken: 'test-token',
      fetcher: fetcher as typeof fetch, nowMs: () => Date.parse('2026-10-17T03:00:00Z') });
    assert.equal(calls, 1);
    assert.equal(result.inserted.length, 3);
    assert.deepEqual(result.missing, []);
    const store = new ReferenceObservationStore(dbPath);
    try {
      assert.equal(store.latest().length, 3);
      assert.equal(store.history(`x-${ids[0]}`)[0].value, '4000');
      assert.equal(JSON.parse(Buffer.from(store.raw(store.latest()[0].rawSha256)!).toString('utf8')).data.length, 3);
    } finally { store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing or malformed provider metrics never become fabricated zeroes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-x-posts-'));
  const dbPath = join(dir, 'api.sqlite');
  try {
    const fetcher = async () => new Response(JSON.stringify({ data: mockData.slice(0, 2) }));
    const result = await collectXReferenceLikes({ dbPath, bearerToken: 'test-token', fetcher: fetcher as typeof fetch });
    assert.deepEqual(result.missing, [`x-${ids[2]}`]);
    const invalidFetcher = async () => new Response(JSON.stringify({ data: [
      { id: ids[2], public_metrics: { like_count: -1 } },
    ] }));
    await assert.rejects(collectXReferenceLikes({ dbPath, bearerToken: 'test-token',
      fetcher: invalidFetcher as typeof fetch }), /X_RESPONSE_INVALID/);
    const store = new ReferenceObservationStore(dbPath);
    try { assert.equal(store.latest().length, 2); }
    finally { store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
