import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPriceMarketRegistry } from './price-market-registry.mjs';

test('price sampler sees newly finalized registrations while excluding pending ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ante-price-registry-'));
  const registryPath = join(dir, 'markets.json');
  const dbPath = join(dir, 'index.sqlite');
  const operator = { address: 'operator', seedHex: 'a', keyword: 'operator', aliases: [], dataProvenance: 'SYNTHETIC_QA' };
  writeFileSync(registryPath, JSON.stringify([operator]));
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE financial_registrations (
      market_address TEXT, seed_hex TEXT, keyword TEXT, aliases_json TEXT, state TEXT)`);
    const insert = db.prepare('INSERT INTO financial_registrations VALUES(?,?,?,?,?)');
    insert.run('pending', 'b', 'pending', '[]', 'PENDING');
    assert.deepEqual(await loadPriceMarketRegistry(registryPath, dbPath), [operator]);
    insert.run('new', 'c', 'new', '["#new"]', 'FINALIZED');
    insert.run('operator', 'a', 'wrong label', '[]', 'FINALIZED');
    assert.deepEqual(await loadPriceMarketRegistry(registryPath, dbPath), [
      { address: 'new', seedHex: 'c', keyword: 'new', aliases: ['#new'] }, operator,
    ]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
