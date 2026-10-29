import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { address, createSolanaRpc } from '@solana/kit';
import { createRpcReadFailover, withRpcReadFailover } from '../src/rpc-failover.ts';
import { isRpcRateLimited } from '../src/rpc-retry.ts';

type Rpc = ReturnType<typeof createSolanaRpc>;

test('rate-limited read switches provider and pauses the limited provider', async () => {
  let time = 1000, primaryCalls = 0, backupCalls = 0, notices = 0;
  const primary = {getBalance: () => ({send: async () => {
    primaryCalls++;
    if (primaryCalls === 1) throw new Error('max usage reached');
    return {value: 1n};
  }})} as unknown as Rpc;
  const backup = {getBalance: () => ({send: async () => {backupCalls++; return {value: 2n};}})} as unknown as Rpc;
  const rpc = withRpcReadFailover(primary, backup, {now: () => time, cooldownMs: 60_000, onFailover: () => {notices++;}});
  assert.equal(isRpcRateLimited(new Error('max usage reached')), true);
  assert.deepEqual(await rpc.getBalance('11111111111111111111111111111111' as Parameters<typeof rpc.getBalance>[0]).send(), {value: 2n});
  assert.deepEqual(await rpc.getBalance('11111111111111111111111111111111' as Parameters<typeof rpc.getBalance>[0]).send(), {value: 2n});
  assert.deepEqual([primaryCalls, backupCalls, notices], [1, 2, 1]);
  time += 60_000;
  assert.deepEqual(await rpc.getBalance('11111111111111111111111111111111' as Parameters<typeof rpc.getBalance>[0]).send(), {value: 1n});
});

test('other read failures are preserved and transaction submission is never switched', async () => {
  let backupCalls = 0;
  const primary = {
    getBalance: () => ({send: async () => {throw new Error('INVALID_ACCOUNT_DATA');}}),
    sendTransaction: () => ({send: async () => {throw new Error('HTTP 429');}}),
  } as unknown as Rpc;
  const backup = {
    getBalance: () => ({send: async () => {backupCalls++; return {value: 2n};}}),
    sendTransaction: () => ({send: async () => {backupCalls++; return 'signature';}}),
  } as unknown as Rpc;
  const rpc = withRpcReadFailover(primary, backup);
  await assert.rejects(() => rpc.getBalance('11111111111111111111111111111111' as Parameters<typeof rpc.getBalance>[0]).send(), /INVALID_ACCOUNT_DATA/);
  await assert.rejects(() => rpc.sendTransaction('wire' as Parameters<typeof rpc.sendTransaction>[0]).send(), /429/);
  assert.equal(backupCalls, 0);
});

test('Solana Kit reads through a real HTTP 429 to the backup transport', async () => {
  let firstCalls = 0, secondCalls = 0;
  const primary = createServer((_req, res) => {
    firstCalls++;
    res.writeHead(429, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: 'rate limit exceeded'}));
  });
  const backup = createServer(async (req, res) => {
    secondCalls++;
    let body = '';
    for await (const part of req) body += part;
    const request = JSON.parse(body) as {id: string | number; method: string};
    assert(['getBalance', 'getGenesisHash'].includes(request.method));
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({jsonrpc: '2.0', id: request.id,
      result: request.method === 'getGenesisHash' ? 'verified-devnet' : {context: {slot: 7}, value: 123}}));
  });
  try {
    await Promise.all([new Promise<void>(resolve => primary.listen(0, '127.0.0.1', resolve)),
      new Promise<void>(resolve => backup.listen(0, '127.0.0.1', resolve))]);
    const first = primary.address(), second = backup.address();
    assert(first && typeof first !== 'string' && second && typeof second !== 'string');
    const rpc = createRpcReadFailover(`http://127.0.0.1:${first.port}`, `http://127.0.0.1:${second.port}`,
      {expectedGenesisHash: 'verified-devnet'});
    const result = await rpc.getBalance(address('11111111111111111111111111111111')).send();
    assert.equal(result.value, 123n);
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 2);
  } finally {
    await Promise.all([new Promise<void>(resolve => primary.close(() => resolve())),
      new Promise<void>(resolve => backup.close(() => resolve()))]);
  }
});

test('a backup on another cluster cannot supply a read result', async () => {
  let backupReads = 0;
  const primary = {getBalance: () => ({send: async () => {throw new Error('HTTP 429');}})} as unknown as Rpc;
  const backup = {
    getGenesisHash: () => ({send: async () => 'other-cluster'}),
    getBalance: () => ({send: async () => {backupReads++; return {value: 1n};}}),
  } as unknown as Rpc;
  const rpc = withRpcReadFailover(primary, backup, {expectedGenesisHash: 'devnet'});
  await assert.rejects(() => rpc.getBalance(address('11111111111111111111111111111111')).send(),
    /RPC_FAILOVER_GENESIS_MISMATCH/);
  assert.equal(backupReads, 0);
});
