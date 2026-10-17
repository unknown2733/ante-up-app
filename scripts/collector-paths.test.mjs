import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { collectorProjectionDbPath } from './collector-paths.mjs';

test('an extra market reconciles against the shared finalized index', () => {
  const env = { ANTE_UP_EXTERNAL_INDEXER: 'yes', ANTE_UP_INDEX_DB: '/state/live-smoke/index.sqlite' };
  assert.equal(collectorProjectionDbPath('/state/tariff', env), resolve('/state/live-smoke/index.sqlite'));
  assert.throws(() => collectorProjectionDbPath('/state/tariff',
    { ANTE_UP_EXTERNAL_INDEXER: 'yes' }), /MISSING_ANTE_UP_INDEX_DB/);
  assert.equal(collectorProjectionDbPath('/state/solana', {}), join('/state/solana','index.sqlite'));
});
