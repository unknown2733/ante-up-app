import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReferenceXRequestBudget, runBoundedXReferenceLikes } from '../src/reference-x-schedule.ts';

const day = 24 * 60 * 60 * 1000;

test('paid X requests are reserved durably and spaced six hours apart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-x-budget-'));
  const dbPath = join(dir, 'api.sqlite');
  try {
    const base = Date.parse('2026-10-17T00:00:00Z');
    const budget = new ReferenceXRequestBudget(dbPath);
    try {
      assert.ok(budget.reserve(base).id);
      assert.equal(budget.reserve(base + 1000).reason, 'MIN_INTERVAL');
      assert.ok(budget.reserve(base + 6 * 60 * 60 * 1000).id);
      assert.ok(budget.reserve(base + 12 * 60 * 60 * 1000).id);
      assert.ok(budget.reserve(base + 18 * 60 * 60 * 1000).id);
      assert.ok(budget.reserve(base + day).id);
    } finally { budget.close(); }
    const reopened = new ReferenceXRequestBudget(dbPath);
    try { assert.equal(reopened.reserve(base + day + 1000).reason, 'MIN_INTERVAL'); }
    finally { reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('failed or uncertain X provider call consumes its slot and is not retried automatically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-x-budget-'));
  const dbPath = join(dir, 'api.sqlite');
  try {
    let calls = 0;
    const fetcher = async () => { calls++; return new Response('{}', { status: 429 }); };
    const nowMs = () => Date.parse('2026-10-17T00:00:00Z');
    await assert.rejects(runBoundedXReferenceLikes({ dbPath, bearerToken: 'test-token',
      fetcher: fetcher as typeof fetch, nowMs }), /X_PROVIDER_HTTP_429/);
    assert.deepEqual(await runBoundedXReferenceLikes({ dbPath, bearerToken: 'test-token',
      fetcher: fetcher as typeof fetch, nowMs }), { status: 'SKIPPED', reason: 'MIN_INTERVAL' });
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
