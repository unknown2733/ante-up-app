// Read-only release checks; this verifies delivery, not browser interaction or signing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = process.argv[2] ?? 'https://ante-up.fun';
const dist = resolve(process.argv[3] ?? 'apps/web/dist');
const html = await readFile(resolve(dist, 'index.html'), 'utf8');
const digest = data => createHash('sha256').update(data).digest('hex');
assert.match(html, /lang="en"/);
const routes = ['/', '/markets', '/leaderboard', '/faucet', '/me',
  '/docs', '/docs/chips', '/docs/records-proofs', '/docs/unknown-article',
  '/markets/reference%3Amarket%3Aaurora',
  '/markets/7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT'];
for (const route of routes) {
  const response = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  assert.equal(response.status, 200, route);
  assert.equal(digest(await response.text()), digest(html), `Release HTML mismatch: ${route}`);
}
const icon = html.match(/<link[^>]*rel="icon"[^>]*href="(\/[^"?]+)"/)?.[1];
assert.ok(icon, 'Release has no local favicon');
const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map(match => match[1]).concat(icon))];
assert.ok(assets.some(asset => asset.endsWith('.js')));
const results = [];
for (const asset of assets) {
  const response = await fetch(new URL(asset, origin), { signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  assert.equal(response.status, 200, asset);
  const actual = Buffer.from(await response.arrayBuffer());
  const expected = await readFile(resolve(dist, '.' + asset));
  assert.equal(digest(actual), digest(expected), `Release asset mismatch: ${asset}`);
  results.push({ asset, bytes: actual.length, sha256: digest(actual) });
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), origin, routes, assets: results,
  htmlSha256: digest(html), browserInteraction: false, walletTransactions: 0 }, null, 2));
