import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReadonlyAppServer } from '../../apps/web/qa/consumer/serve-app.mjs';

test('local app server keeps deep links and API reads while denying every write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-app-qa-'));
  await writeFile(join(dir, 'index.html'), '<html lang="en">QA app</html>');
  const server = await startReadonlyAppServer(dir, 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const deep = await fetch(origin + '/markets/demo%3Amarket%3Asolstice');
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /QA app/);
    assert.match(deep.headers.get('content-security-policy'), /connect-src 'self'/);
    const markets = await (await fetch(origin + '/api/v1/consumer/markets?mode=DEMO')).json();
    assert.equal(markets.mode, 'fixture');
    assert.ok(markets.data.length >= 10);
    const denied = await fetch(origin + '/api/v1/faucet/claims', { method: 'POST' });
    assert.equal(denied.status, 405);
    assert.equal((await denied.json()).code, 'UNAUTHORIZED');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
