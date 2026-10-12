import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const { mergeConsumerMarkets } = await server.ssrLoadModule('/src/consumer-ui/catalog.ts');
const market = (id, title, mode) => ({ id, title, source: { mode, label: mode, asOfMs: 0 } });

test('unified catalog retains samples and Live records and resolves ID collisions to Live', () => {
  const result = mergeConsumerMarkets(
    [market('demo:a', 'B subject', 'DEMO'), market('shared', 'Old sample title', 'DEMO')],
    [market('live:a', 'A subject', 'LIVE'), market('shared', 'Current observed title', 'LIVE')],
  );
  assert.deepEqual(result.map(item => item.id), ['live:a', 'shared', 'demo:a']);
  assert.equal(result.find(item => item.id === 'shared').source.mode, 'LIVE');
  assert.equal(result.find(item => item.id === 'shared').title, 'Current observed title');
});

test('matching titles with different IDs do not merge distinct provenance', () => {
  const result = mergeConsumerMarkets([market('demo:solana', 'solana', 'DEMO')], [market('chain-pda', 'solana', 'LIVE')]);
  assert.deepEqual(result.map(item => item.id), ['chain-pda', 'demo:solana']);
});
