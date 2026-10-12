import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { allowedUrl, parseDevices, selectDevice, selectTarget, localTargets } from './seeker.mjs';

test('requires explicit authorized target when multiple USB devices are attached', () => {
  const devices = parseDevices('List of devices attached\r\nabc device product:seeker model:Seeker\r\ndef unauthorized\r\n');
  assert.equal(selectDevice(devices, 'abc').state, 'device');
  assert.throws(() => selectDevice(devices));
  assert.throws(() => selectDevice(devices, 'def'));
  assert.throws(() => selectDevice([]));
});
test('only exact HTTPS Ante Up origin, without embedded credentials, is allowed', () => {
  assert.equal(allowedUrl('https://ante-up.fun/faucet'), true);
  for (const url of ['http://ante-up.fun', 'https://ante-up.fun.evil.test', 'https://ante-up.fun@evil.test', 'https://user@ante-up.fun', 'https://ante-up.fun:8443', 'file:///private']) assert.equal(allowedUrl(url), false);
});
test('does not select private tabs and rejects ambiguous or nonlocal debugger targets', () => {
  const a = { type: 'page', id: 'a', url: 'https://ante-up.fun/faucet', webSocketDebuggerUrl: 'ws://localhost:5555/devtools/page/a' };
  const privatePage = { ...a, id: 'private', url: 'https://wallet.example' };
  assert.equal(selectTarget([privatePage, a]).id, 'a');
  assert.throws(() => selectTarget([a, { ...a, id: 'b' }]));
  assert.throws(() => selectTarget([privatePage], 'private'));
  assert.throws(() => selectTarget([{ ...a, webSocketDebuggerUrl: 'ws://evil.test/devtools/page/a' }]));
});

test('loopback target transport accepts only bounded JSON arrays', async () => {
  let body = '[]';
  let status = 200;
  const server = createServer((req, res) => { res.writeHead(status); res.end(body); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.deepEqual(await localTargets(server.address().port), []);
    body = '{}'; await assert.rejects(localTargets(server.address().port), /Invalid Chrome/);
    body = 'x'.repeat(2_000_001); await assert.rejects(localTargets(server.address().port), /exceeds limit/);
    status = 404; await assert.rejects(localTargets(server.address().port), /Open Chrome/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
