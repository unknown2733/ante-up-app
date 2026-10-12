import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const { artworkSource } = await server.ssrLoadModule('/src/consumer-ui/artwork.ts');

test('a failed cover falls back, then a changed cover URL can render', () => {
  assert.equal(artworkSource('/covers/old.png', null), '/covers/old.png');
  assert.equal(artworkSource('/covers/old.png', '/covers/old.png'), null);
  assert.equal(artworkSource('/covers/new.png', '/covers/old.png'), '/covers/new.png');
  assert.equal(artworkSource(null, '/covers/old.png'), null);
});
