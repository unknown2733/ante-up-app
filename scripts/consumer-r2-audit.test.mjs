import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditR2Catalog, auditR2Source } from './consumer-r2-audit.mjs';

const source = { mode: 'DEMO', label: 'Sample history', asOfMs: Date.parse('2026-10-13T00:00:00Z') };
const scenarios = Array.from({ length: 15 }, (_, i) => ({ slug: `scenario-${i}`,
  subject: ['KEYWORD', 'VIDEO', 'TRACK', 'ALBUM', 'ACCOUNT'][i % 5] }));
const markets = scenarios.map(({ slug, subject }) => ({ id: `demo:market:${slug}`, title: `Real subject ${slug}`,
  subtitle: 'Sample history', subject, source, subjectUrl: `https://example.com/${slug}`,
  creatorLabel: 'Creator', thumbnailUrl: `/media/${slug}.png`, imageAlt: `Artwork for ${slug}`,
  imageSourceUrl: `https://example.com/${slug}/media` }));

test('R2 catalog accepts 15 stable sample identities with media and one separate live market', () => {
  const unified = [...markets, { id: 'real-market', source: { ...source, mode: 'LIVE' } }];
  const result = auditR2Catalog(scenarios, markets, unified);
  assert.deepEqual(Object.values(result).map(item => item.status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  assert.equal(result.unifiedCatalog.detail.liveCount, 1);
});

test('R2 catalog flags missing subject evidence, duplicate IDs and sample/live identity mixing', () => {
  const noMedia = markets.map(item => ({ ...item }));
  delete noMedia[0].imageSourceUrl;
  noMedia[1].liveMarketId = 'real-market';
  const result = auditR2Catalog(scenarios, noMedia, [...noMedia, noMedia[0]]);
  assert.equal(result.realSubjectMedia.status, 'PENDING');
  assert.deepEqual(result.realSubjectMedia.detail.missingIds, [noMedia[0].id]);
  assert.equal(result.sampleProvenance.status, 'FAIL');
  assert.equal(result.unifiedCatalog.status, 'FAIL');
});

test('R2 source scan distinguishes integrated source from visible legacy copy and mode controls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ante-r2-audit-'));
  async function put(name, content) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  try {
    await put('apps/web/src/App.tsx', '<DocsPage slug={slug} /> // /docs');
    await put('apps/web/src/consumer-ui/ConsumerShell.tsx', '<nav>Explore</nav>');
    await put('apps/web/src/docs/index.tsx', 'export function DocsPage() {}');
    await put('apps/web/src/media/SubjectImage.tsx', 'export function SubjectImage(){ onError(); } export function WalletAvatar(){}');
    let result = await auditR2Source(root);
    assert.equal(result.customerCopy.status, 'PASS');
    assert.equal(result.singleNavigation.status, 'PASS');
    assert.equal(result.docsRoute.status, 'PASS');
    assert.equal(result.mediaFallback.status, 'PASS');
    await put('apps/web/src/App.tsx', '<DocsPage /> // /docs onModeChange= old Free Call');
    result = await auditR2Source(root);
    assert.equal(result.customerCopy.status, 'PENDING');
    assert.equal(result.singleNavigation.status, 'PENDING');
    assert.equal(result.executionBoundary.status, 'PENDING');
  } finally { await rm(root, { recursive: true, force: true }); }
});
