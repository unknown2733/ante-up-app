import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createHttpApi } from '../src/http.ts';

const appPath = process.env.ANTE_UP_D_APP_PATH;

test('web adapter consumes D actual HTTP fixture envelopes and proof IDs', { skip: !appPath }, async () => {
  const { createApp } = await import(pathToFileURL(appPath).href);
  const app = createApp();
  const server = createServer(async (request, response) => {
    try {
      const body = [];
      for await (const chunk of request) body.push(chunk);
      const input = new Request(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers: request.headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(body),
      });
      const output = await app.handle(input);
      response.writeHead(output.status, Object.fromEntries(output.headers));
      response.end(Buffer.from(await output.arrayBuffer()));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const strict = createHttpApi(origin, { allowFixture: false });
    await assert.rejects(strict.listMarkets(), /VITE_ALLOW_FIXTURE_API=true/);

    const seenModes = [];
    const client = createHttpApi(origin, { allowFixture: true, onMode: (mode) => seenModes.push(mode) });
    const markets = await client.listMarkets();
    assert.equal(markets.mode, 'fixture');
    assert.equal(markets.data[0].snapshot.payload.formulaVersion, 'h3-d7-q12-v1');
    assert.equal(markets.data[0].snapshot.payload.queryHash.length, 64);
    assert.equal(markets.data[0].snapshot.payload.admission.state, 'BLOCKED');
    assert.equal(markets.data[0].price.executable, false);

    const market = await client.getMarket('fixture:sol');
    assert.equal(market.data.id, 'fixture:sol');
    const profile = await client.getProfile('FixtureCarol');
    assert.equal(profile.data.openRecords.length, 1);
    assert.equal(profile.data.openPreviews[0].recordId, profile.data.openRecords[0].id);
    assert.equal(profile.data.openPreviews[0].status, 'REFERENCE');

    const board = await client.getLeaderboard('7d');
    assert.equal(board.data.period, '7d');
    assert.ok(Array.isArray(board.data.rows));
    assert.ok(board.data.rows.every((row) => row.status === 'ELIGIBLE'));
    assert.deepEqual(board.data.heldWallets, ['FixtureHeld']);

    const record = await client.getRecord('fixture:alice-win');
    assert.equal(record.data.id, 'fixture:alice-win');
    assert.notEqual(record.data.proofId, record.data.id);
    const proof = await client.getProof(record.data.proofId);
    assert.equal(proof.data.id, record.data.proofId);
    assert.equal(proof.data.state, 'REPLACED');
    const replacement = await client.getProof(proof.data.replacementId);
    assert.equal(replacement.data.id, proof.data.replacementId);
    assert.equal(replacement.data.payloadHash, null);
    assert.equal(replacement.data.manifestRef, null);
    assert.equal((await client.getProof('fixture:missing')).data, null);
    assert.ok(seenModes.length >= 7 && seenModes.every((mode) => mode === 'fixture'));

    const blockedWrite = await client.openFree('FixtureCarol', 'fixture:sol');
    assert.equal(blockedWrite.kind, 'notExecutable');

    process.env.VITE_API_PROXY_TARGET = origin;
    const vite = await createViteServer({ optimizeDeps: { noDiscovery: true }, server: { host: '127.0.0.1', port: 0 } });
    try {
      await vite.listen();
      const webOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
      const proxied = await fetch(`${webOrigin}/api/v1/markets`);
      assert.equal(proxied.status, 200);
      const body = await proxied.json();
      assert.equal(body.mode, 'fixture');
      assert.equal(body.data[0].id, 'fixture:sol');
    } finally {
      await vite.close();
      delete process.env.VITE_API_PROXY_TARGET;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
