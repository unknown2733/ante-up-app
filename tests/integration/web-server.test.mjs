import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createWebServer } from '../../scripts/serve-web.mjs';

test('production web server supports SPA routes, fixed API proxy and honest upstream failure', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.proof-integration-web-'));
  let server;
  try {
    await mkdir(join(dir, 'assets')); await writeFile(join(dir, 'index.html'), '<main>Ante Up</main>');
    await writeFile(join(dir, 'assets/app.js'), 'export const mode="test";');
    const requests = [];
    server = await createWebServer({ dist:dir, apiOrigin:'http://127.0.0.1:8787', fetchImpl:async (url, options) => {
      requests.push({url:String(url),headers:options.headers});
      if (url.pathname === '/v1/fail') throw new Error('sensitive provider details');
      return Response.json({mode:'fixture',data:[]});
    }});
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.match(await (await fetch(`${base}/u/some-wallet`)).text(), /Ante Up/);
    assert.equal((await fetch(`${base}/assets/app.js`)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetch(`${base}/missing.js`)).status,404);
    assert.equal((await fetch(`${base}/.env`)).status,404);
    assert.equal((await fetch(`${base}/%ZZ`)).status,400);
    const result = await fetch(`${base}/api/v1/markets?limit=2`,{headers:{'x-ante-wallet':'test','cookie':'not-forwarded','authorization':'Bearer integration-test-only'}});
    assert.equal((await result.json()).mode,'fixture');
    assert.equal(requests[0].url,'http://127.0.0.1:8787/v1/markets?limit=2');
    assert.equal(requests[0].headers.get('cookie'),null);
    assert.equal(requests[0].headers.get('authorization'),'Bearer integration-test-only');
    const failed = await fetch(`${base}/api/v1/fail`); assert.equal(failed.status,502);
    assert.deepEqual(await failed.json(),{error:'API_UNAVAILABLE'});
    assert.equal((await fetch(`${base}/api/v1/test`, {method:'POST',body:'x'.repeat(32769)})).status,413);
  } finally {
    if(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(dir,{recursive:true,force:true});
  }
});
