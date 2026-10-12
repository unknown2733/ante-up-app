// Read-only inventory: does not read key contents, call providers or start services.
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const modules = ['clients/chain', 'services/data', 'services/evidence', 'services/api', 'services/indexer', 'services/keeper', 'apps/web'];
export const root = fileURLToPath(new URL('../', import.meta.url));

export function inventory(base = root) {
  return modules.map(path => {
    const manifest = join(base, path, 'package.json');
    if (!existsSync(manifest)) return { path, manifest: false, locked: false, installed: false, scripts: [] };
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    const external = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    return { path, manifest: true, locked: external.length === 0 || existsSync(join(base, path, 'package-lock.json')),
      installed: external.every(name => existsSync(join(base, path, 'node_modules', name, 'package.json'))),
      scripts: Object.keys(pkg.scripts ?? {}) };
  });
}

export function inspectTools(run = spawnSync) {
  return ['cargo', 'rustc', 'anchor', 'solana', 'surfpool'].map(name => {
    const result = run(name, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return { name, available: !result.error && result.status === 0 };
  });
}

export function report(base = root, run = spawnSync) {
  const packages = inventory(base);
  return {
    node: process.versions.node,
    supportedNode: Number(process.versions.node.split('.')[0]) >= 24,
    packages,
    tools: inspectTools(run),
    idlPresent: existsSync(join(base, 'clients/chain/idl/ante_up.json')),
    localBuildIdlPresent: existsSync(join(base, 'target/idl/ante_up.json')),
    programBinaryPresent: existsSync(join(base, 'target/deploy/ante_up.so')),
    scope: 'Local dependency inventory only. No wallet, RPC connectivity, deployed program or live-provider readiness is verified.'
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = report();
  console.log(JSON.stringify(result, null, 2));
  if (!result.supportedNode || result.packages.some(p => !p.manifest || !p.locked || !p.installed)) process.exitCode = 1;
  // Native readiness is a separate explicit gate, never a claim derived from JS tests.
  if (process.argv.includes('--require-chain') && (!result.idlPresent || !result.programBinaryPresent || result.tools.filter(t => ['cargo', 'anchor', 'solana'].includes(t.name)).some(t => !t.available))) process.exitCode = 1;
}
