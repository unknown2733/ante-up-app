import test from 'node:test';
import assert from 'node:assert/strict';
import { isRpcRateLimited, retryRpcRead } from '../src/rpc-retry.ts';

test('read-only RPC retries a transient 429 and returns the successful read', async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await retryRpcRead(async () => {
    attempts++;
    if (attempts < 3) throw new Error('HTTP error (429): Too Many Requests');
    return 'finalized';
  }, async ms => { waits.push(ms); });
  assert.equal(result, 'finalized');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [500, 1000]);
});

test('RPC retry leaves other errors intact and stops after the bounded 429 attempts', async () => {
  assert.equal(isRpcRateLimited(new Error('HTTP error (429): Too Many Requests')), true);
  assert.equal(isRpcRateLimited(new Error('FINANCIAL_ACCOUNT_UNAVAILABLE')), false);
  let attempts = 0;
  await assert.rejects(() => retryRpcRead(async () => {
    attempts++;
    throw new Error('HTTP error (429): Too Many Requests');
  }, async () => {}), /429/);
  assert.equal(attempts, 3);
  await assert.rejects(() => retryRpcRead(async () => { throw new Error('INVALID_ACCOUNT_DATA'); }, async () => {
    throw new Error('unexpected retry');
  }), /INVALID_ACCOUNT_DATA/);
});
