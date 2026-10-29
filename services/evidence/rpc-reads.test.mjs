import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEvidenceChain } from './rpc-reads.mjs';

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

async function serve(handler) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const query = JSON.parse(body);
    const result = handler(query.method);
    if (result.status) {
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limit exceeded' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: query.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}

test('proof reads may use a Devnet backup while submission stays on the primary', async () => {
  const primaryCalls = [], backupCalls = [];
  const primary = await serve(method => {
    primaryCalls.push(method);
    return method === 'getGenesisHash' ? DEVNET : { status: 429 };
  });
  const backup = await serve(method => {
    backupCalls.push(method);
    return method === 'getGenesisHash' ? DEVNET : 41;
  });
  try {
    const { rpc, transport } = await createEvidenceChain(primary.endpoint, backup.endpoint);
    assert.equal(await rpc.getBlockHeight().send(), 41n);
    assert.equal(await transport.getBlockHeight(), 41n);
    await assert.rejects(() => transport.sendTransaction('wire'), /429/);
    assert.equal(primaryCalls.filter(method => method === 'sendTransaction').length, 1);
    assert.equal(backupCalls.filter(method => method === 'sendTransaction').length, 0);
  } finally { await Promise.all([primary.close(), backup.close()]); }
});

test('a backup on another cluster cannot provide proof reads', async () => {
  const primary = await serve(method => method === 'getGenesisHash' ? DEVNET : { status: 429 });
  const backup = await serve(method => method === 'getGenesisHash' ? 'wrong-cluster' : 41);
  try {
    const { rpc } = await createEvidenceChain(primary.endpoint, backup.endpoint);
    await assert.rejects(() => rpc.getBlockHeight().send(), /RPC_FAILOVER_GENESIS_MISMATCH/);
  } finally { await Promise.all([primary.close(), backup.close()]); }
});
