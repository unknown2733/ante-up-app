import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, inspectTools } from '../../scripts/doctor.mjs';

test('readiness distinguishes declared, locked and installed SDK dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ante-doctor-'));
  try {
    const module = join(dir, 'clients/chain'); mkdirSync(module, { recursive: true });
    writeFileSync(join(module, 'package.json'), JSON.stringify({ dependencies: { '@solana/kit': '8.4.0' }, scripts: { test: 'node --test' } }));
    assert.equal(inventory(dir)[0].installed, false);
    writeFileSync(join(module, 'package-lock.json'), '{}');
    assert.equal(inventory(dir)[0].locked, true);
    mkdirSync(join(module, 'node_modules/@solana/kit'), { recursive: true });
    writeFileSync(join(module, 'node_modules/@solana/kit/package.json'), '{}');
    assert.equal(inventory(dir)[0].installed, true);
    assert.equal(inventory(dir)[1].manifest, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing or failing native tools do not appear available', () => {
  const results = inspectTools(name => name === 'cargo' ? { status: 0 } : name === 'rustc' ? { status: 1 } : { error: new Error('ENOENT') });
  assert.deepEqual(results.filter(r => r.available).map(r => r.name), ['cargo']);
});
