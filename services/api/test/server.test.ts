import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { createApiServer } from '../src/server.ts';

function fakeExchange(app: any, headers: Record<string,string> = {}) {
  const request: any = new EventEmitter();
  request.headers = headers; request.method = 'POST'; request.url = '/v1/quotes';
  request.pause = () => {}; request.destroy = () => { request.destroyed = true; };
  const response: any = new EventEmitter();
  response.status = null; response.body = null; response.headersSent = false;
  response.writeHead = (status: number) => { response.status = status; response.headersSent = true; };
  response.end = (body: string | Buffer) => { response.body = String(body); response.emit('finish'); };
  const server = createApiServer(app);
  server.emit('request', request, response);
  return { request, response, server };
}

test('HTTP wrapper caps declared and streaming request bodies', async () => {
  const app: any = { async handle() { throw new Error('must not run'); } };
  const declared = fakeExchange(app, { 'content-length': '32769' });
  assert.equal(declared.response.status, 413);
  assert.equal(declared.request.destroyed, true);
  const streaming = fakeExchange(app);
  streaming.request.emit('data', Buffer.alloc(20_000));
  streaming.request.emit('data', Buffer.alloc(20_000));
  assert.equal(streaming.response.status, 413);
  assert.equal(streaming.request.destroyed, true);
});

test('HTTP wrapper converts handler exceptions to 500 without exposing internals', async () => {
  const exchange = fakeExchange({ async handle() { throw new Error('secret stack detail'); } });
  exchange.request.emit('end');
  await setImmediate();
  assert.equal(exchange.response.status, 500);
  assert.equal(JSON.parse(exchange.response.body).code, 'INTERNAL_ERROR');
  assert.ok(!exchange.response.body.includes('secret stack detail'));
});
