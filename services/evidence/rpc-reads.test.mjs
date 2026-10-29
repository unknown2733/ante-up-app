import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEvidenceChain } from './rpc-reads.mjs';

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

async function serve(handler) {
  for (let attempt = 0; attempt < 20; attempt++) {
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
    // Windows may assign a browser-blocked low port for listen(0).
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return { endpoint: `http://127.0.0.1:${port}`,
        close: () => new Promise(resolve => server.close(resolve)) };
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw Error('TEST_RPC_PORT_UNAVAILABLE');
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

test('proof reads can start from the backup when primary genesis is rate limited', async () => {
  let primaryGenesisCalls = 0, primarySends = 0, backupSends = 0;
  const primary = await serve(method => {
    if (method === 'getGenesisHash')
      return ++primaryGenesisCalls === 1 ? { status: 429 } : DEVNET;
    if (method === 'sendTransaction') { primarySends++; return 'primary-signature'; }
    return { status: 429 };
  });
  const backup = await serve(method => {
    if (method === 'getGenesisHash') return DEVNET;
    if (method === 'sendTransaction') { backupSends++; return 'backup-signature'; }
    return 43;
  });
  try {
    const { rpc, transport } = await createEvidenceChain(primary.endpoint, backup.endpoint);
    assert.equal(await rpc.getBlockHeight().send(), 43n);
    assert.equal(await transport.getBlockHeight(), 43n);
    assert.equal(await transport.sendTransaction('wire'), 'primary-signature');
    assert.equal(primaryGenesisCalls, 2);
    assert.equal(primarySends, 1);
    assert.equal(backupSends, 0);
  } finally { await Promise.all([primary.close(), backup.close()]); }
});

test('a read-only backup cannot submit while the primary cluster remains unverified', async () => {
  let backupSends = 0;
  const primary = await serve(() => ({ status: 429 }));
  const backup = await serve(method => {
    if (method === 'getGenesisHash') return DEVNET;
    if (method === 'sendTransaction') backupSends++;
    return 47;
  });
  try {
    const { rpc, transport } = await createEvidenceChain(primary.endpoint, backup.endpoint);
    assert.equal(await rpc.getBlockHeight().send(), 47n);
    await assert.rejects(() => transport.sendTransaction('wire'), /429/);
    assert.equal(backupSends, 0);
  } finally { await Promise.all([primary.close(), backup.close()]); }
});

test('a wrong-cluster primary is rejected even if the backup is Devnet', async () => {
  const primary = await serve(method => method === 'getGenesisHash' ? 'wrong-cluster' : 1);
  const backup = await serve(method => method === 'getGenesisHash' ? DEVNET : 2);
  try {
    await assert.rejects(() => createEvidenceChain(primary.endpoint, backup.endpoint), /DEVNET_REQUIRED/);
  } finally { await Promise.all([primary.close(), backup.close()]); }
});
