import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = dirname(fileURLToPath(import.meta.url));
const articles = readdirSync(directory).filter(name => name.endsWith('.md') && name !== 'README.md');
const slugs = new Set(articles.map(name => name.slice(0, -3)));
const renderer = readFileSync(join(directory, '../../apps/web/src/docs/index.tsx'), 'utf8');

test('every Docs article has a unique heading and resolvable local links', () => {
  assert.equal(slugs.size, 10);
  const imports = new Set([...renderer.matchAll(/from '\.\.\/\.\.\/\.\.\/\.\.\/docs\/product\/([^']+)\.md\?raw'/g)].map(match => match[1]));
  assert.deepEqual(imports, slugs, 'the app must render every canonical Markdown article');
  assert.doesNotMatch(renderer, /dangerouslySetInnerHTML|innerHTML\s*=/, 'the renderer must not inject Markdown as HTML');
  for (const name of articles) {
    const source = readFileSync(join(directory, name), 'utf8');
    assert.match(source, /^# [^\n]+/);
    const ids = [...source.matchAll(/^## (.+)$/gm)].map(match => match[1].toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-'));
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate anchor`);
    for (const [, , href] of source.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      assert.match(href, /^\/(?:docs|markets|me|faucet|leaderboard|u|records|proofs)(?:\/[^\s]*)?$|^https:\/\/[^\s]+$/, `${name}: unsafe or unsupported link ${href}`);
      if (href.startsWith('/docs/')) assert.ok(slugs.has(href.slice(6)), `${name}: broken Docs link ${href}`);
    }
    assert.doesNotMatch(source, /\bFree Calls?\b/i, `${name}: internal name in public article`);
  }
});
