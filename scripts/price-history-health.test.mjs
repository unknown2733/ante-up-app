import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('price worker stays healthy with one sampled market while stale reference markets remain visible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ante-price-health-'));
  const path = join(dir, 'health.json');
  try {
    const check = state => {
      writeFileSync(path, JSON.stringify({ atMs: Date.now(), stored: 1, noData: 2, readErrors: 0, ...state }));
      return spawnSync(process.execPath, ['scripts/price-history.mjs', '--health'], {
        cwd: new URL('..', import.meta.url), encoding: 'utf8',
        env: { ...process.env, ANTE_UP_PRICE_HEALTH_PATH: path },
      });
    };
    const partial = check({ status: 'PARTIAL', valid: 1 });
    assert.equal(partial.status, 0, partial.stderr);
    assert.equal(JSON.parse(partial.stdout).status, 'PARTIAL');
    assert.notEqual(check({ status: 'NO_DATA', valid: 0, stored: 0, noData: 3 }).status, 0);
    assert.notEqual(check({ status: 'ERROR', valid: 1, readErrors: 1 }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
