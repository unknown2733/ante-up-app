import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { historyReferences } from './platform-history.ts';
import { platformReferences } from './platform-snapshot.ts';

const expected = [
  ['spotify-2ZaL63zLMDr6H18El2EIt9', 'cumulative', 3, '2026-06-28', '2026-10-02'],
  ['spotify-5yVGW2o9LXaiiS4I3HUM3k', 'cumulative', 3, '2026-02-27', '2026-10-09'],
  ['youtube-HyQn-jkug-w', 'daily', 12, '2026-09-30', '2026-10-11'],
  ['youtube-9bZkp7q19f0', 'daily', 12, '2026-09-28', '2026-10-09'],
  ['spotify-0VjIjW4GlUZAMYd2vXMi3b', 'daily', 31, '2026-09-11', '2026-10-11'],
];

test('five exact subjects retain their independently verified coverage and aggregation', () => {
  assert.deepEqual(historyReferences.map(item => [item.slug, item.aggregation, item.points.length, item.points[0].date, item.points.at(-1).date]), expected);
  assert.equal(historyReferences.reduce((sum, item) => sum + item.points.length, 0), 61);
  for (const item of historyReferences) {
    const id = item.slug.slice(item.slug.indexOf('-') + 1);
    const subjectUrl = new URL(item.subjectUrl);
    assert.equal(item.platform === 'YouTube' ? subjectUrl.searchParams.get('v') : subjectUrl.pathname.split('/').at(-1), id);
    assert.equal(item.sourceType, 'THIRD_PARTY');
    assert.equal(item.provider, 'Kworb');
    assert.equal(item.datePrecision, 'day');
    assert.equal(item.chartEligible, item.slug === 'spotify-0VjIjW4GlUZAMYd2vXMi3b');
    assert.equal(item.unit, item.platform === 'YouTube' ? 'views' : 'streams');
    for (const url of [item.subjectUrl, item.imageUrl, item.imageSourceUrl, item.sourceUrl]) assert.equal(new URL(url).protocol, 'https:');
    if (item.aggregation === 'cumulative') {
      const existing = platformReferences.find(subject => subject.slug === item.slug);
      assert.equal(item.subjectUrl, existing.subjectUrl);
      assert.equal(item.title, existing.title);
      assert.equal(item.points.at(-1).value, existing.metric.value);
      assert.equal(item.points.at(-1).date, existing.metric.reportedDate);
    }
  }
  assert.equal(historyReferences.find(x => x.slug === 'youtube-HyQn-jkug-w').creatorLabel, 'Rumi - Topic');
  assert.equal(historyReferences.find(x => x.slug === 'youtube-9bZkp7q19f0').creatorLabel, 'officialpsy');
});

test('every exported point matches its immutable hashed evidence extract exactly', async () => {
  for (const item of historyReferences) {
    const bytes = await readFile(new URL(item.rawFile, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.rawSha256);
    const extract = JSON.parse(bytes);
    assert.equal(extract.subject.slug, item.slug);
    assert.equal(extract.subject.subjectUrl, item.subjectUrl);
    assert.equal(extract.aggregation, item.aggregation);
    assert.equal(extract.scope, item.scope);
    assert.equal(extract.points.length, item.points.length);
    assert.equal(new Set(item.points.map(point => point.date)).size, item.points.length);
    assert.deepEqual(item.points.map(p => p.date), item.points.map(p => p.date).sort());
    for (let i = 0; i < item.points.length; i++) {
      const point = item.points[i], raw = extract.points[i];
      assert.equal(point.rawFile, item.rawFile);
      assert.equal(point.rawSha256, item.rawSha256);
      assert.deepEqual({ date: point.date, value: point.value, sourceUrl: point.sourceUrl }, { date: raw.date, value: raw.value, sourceUrl: raw.sourceUrl });
      assert.match(raw.sourceResponseSha256, /^[a-f0-9]{64}$/);
      assert.match(point.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(point.value, /^\d+$/);
      assert.ok(Number.isFinite(Date.parse(raw.capturedAt)));
      assert.ok(point.date <= raw.capturedAt.slice(0, 10));
    }
  }
});

test('sparse totals remain sparse and chart daily streams never become total plays', () => {
  const rosewood = historyReferences[0];
  assert.deepEqual(rosewood.points.map(p => [p.date, p.value]), [['2026-06-28', '47202777'], ['2026-09-08', '48306333'], ['2026-10-02', '48661771']]);
  const mayNinth = historyReferences[1];
  assert.deepEqual(mayNinth.points.map(p => [p.date, p.value]), [['2026-02-27', '56146919'], ['2026-04-10', '57709051'], ['2026-10-09', '64000726']]);
  const blinding = historyReferences.at(-1);
  assert.match(blinding.scope, /Global chart-eligible/);
  assert.equal(blinding.aggregation, 'daily');
  assert.deepEqual(blinding.points.slice(-2).map(p => [p.date, p.value]), [['2026-10-10', '1487189'], ['2026-10-11', '1306341']]);
  for (const item of historyReferences.filter(x => x.aggregation === 'daily')) {
    assert.ok(item.points.every(p => !p.value.startsWith('~')));
    for (let i = 1; i < item.points.length; i++) assert.equal(Date.parse(item.points[i].date) - Date.parse(item.points[i - 1].date), 86_400_000);
  }
});
