// Install only package-lock-pinned dependencies in the seven known modules.
// No workspace rewrite and no global install. Run explicitly; never on app startup.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { root, modules } from './doctor.mjs';

export function installPlan(base = root) {
  return modules.flatMap(module => {
    const manifest = join(base, module, 'package.json');
    if (!existsSync(manifest)) throw new Error(`Missing module manifest: ${module}`);
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) return [];
    if (!existsSync(join(base, module, 'package-lock.json'))) throw new Error(`Missing dependency lock: ${module}`);
    return [{ module, cwd: join(base, module) }];
  });
}

export function npmCli() {
  const paths = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const found = paths.find(p => p && existsSync(p));
  if (!found) throw new Error('npm CLI not found. Run npm ci in each module listed by node scripts/install-dependencies.mjs --plan.');
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = installPlan();
  if (process.argv.includes('--plan')) console.log(JSON.stringify(plan.map(p => ({ module: p.module, command: 'npm ci' })), null, 2));
  else for (const item of plan) {
    console.log(`Installing locked dependencies: ${item.module}`);
    const result = spawnSync(process.execPath, [npmCli(), 'ci', '--no-audit', '--no-fund'],
      { cwd: item.cwd, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
