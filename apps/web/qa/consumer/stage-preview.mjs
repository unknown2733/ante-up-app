/** Builds an ignored local preview from committed worker slices. Never edits sibling clones. */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const qaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const parent = path.dirname(qaRoot);
const integrated = path.join(parent, 'ante-up-integrated');
const stageParent = path.join(qaRoot, '.runtime', 'consumer-preview');
await mkdir(stageParent, { recursive: true });
const stage = await mkdtemp(path.join(stageParent, 'run-'));
const chosen = {};
const groups = [
  ['ui', 'ante-up-consumer-ui', ['apps/web/src/consumer-ui', 'apps/web/public/brand',
    'apps/web/src/App.tsx', 'apps/web/src/Financial.tsx', 'apps/web/src/walletSdk.tsx',
    'apps/web/src/walletErrors.ts', 'apps/web/src/liveFree.ts', 'apps/web/src/liveFinancial.ts',
    'apps/web/src/transactionBoundary.ts', 'apps/web/src/fixture.ts', 'apps/web/src/http.ts',
    'apps/web/src/styles.css', 'apps/web/index.html']],
  ['charts', 'ante-up-consumer-charts', ['apps/web/src/charts', 'services/api/src/consumer-history.ts']],
  ['presets', 'ante-up-consumer-presets', ['apps/web/src/demo', 'contracts/fixtures/consumer']],
  ['social', 'ante-up-consumer-social', ['apps/web/src/social', 'services/api/src/consumer-social.ts']],
];
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
async function fromGit(repo, sha, rel) {
  const contents = execFileSync('git', ['-C', repo, 'show', `${sha}:${rel}`], { maxBuffer: 20 * 1024 * 1024 });
  const dest = path.join(stage, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, contents);
}
await cp(path.join(qaRoot, 'apps/web/src'), path.join(stage, 'apps/web/src'), { recursive: true });
for (const [role, directory, prefixes] of groups) {
  const repo = path.join(parent, directory);
  const sha = git(repo, 'rev-parse', 'HEAD');
  chosen[role] = sha;
  const files = git(repo, 'ls-tree', '-r', '--name-only', sha, '--', ...prefixes).split(/\r?\n/).filter(Boolean);
  for (const rel of files) await fromGit(repo, sha, rel);
}
for (const rel of ['contracts/consumer.ts', 'contracts/consumer-identity.ts', 'contracts/types.ts',
  'services/api/src/leaderboard.ts', 'apps/web/qa/consumer/audit.mjs', 'apps/web/qa/consumer/english-audit.mjs',
  'tests/consumer/roundtrip.integration.mjs', 'tests/consumer/demo.integration.mjs']) {
  const dest = path.join(stage, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(path.join(qaRoot, rel), dest);
}
await cp(path.join(qaRoot, 'apps/web/qa/consumer/preview.tsx'), path.join(stage, 'preview.tsx'));
const require = createRequire(path.join(integrated, 'apps/web/package.json'));
const { build } = require('esbuild');
const dist = path.join(stage, 'dist');
await mkdir(dist);
await build({ entryPoints: [path.join(stage, 'preview.tsx')], bundle: true, format: 'esm', platform: 'browser',
  jsx: 'automatic', target: 'es2022', outdir: dist, entryNames: 'bundle',
  nodePaths: [path.join(integrated, 'apps/web/node_modules')], logLevel: 'warning' });
await mkdir(path.join(dist, 'brand'));
for (const rel of ['ante-up-logo-transparent.png', 'ante-up-app-icon-offwhite.png'])
  await cp(path.join(stage, 'apps/web/public/brand', rel), path.join(dist, 'brand', rel));
await writeFile(path.join(dist, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Ante Up isolated Demo QA preview"><link rel="icon" href="/brand/ante-up-app-icon-offwhite.png"><title>Ante Up · QA Demo Preview</title><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
await writeFile(path.join(stage, 'provenance.json'), JSON.stringify({ chosen, createdAt: new Date().toISOString(), purpose: 'QA only; committed worker slices, not deployed app' }, null, 2));
console.log(JSON.stringify({ stage, chosen, test: `node --experimental-strip-types --test ${path.join(stage, 'tests/consumer/roundtrip.integration.mjs')}`,
  serve: `node apps/web/qa/consumer/serve-preview.mjs ${path.join(dist)} 4182` }, null, 2));
