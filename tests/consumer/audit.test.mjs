import test from 'node:test';
import assert from 'node:assert/strict';
import { auditConsumerSnapshot } from '../../apps/web/qa/consumer/audit.mjs';
import { auditEnglish } from '../../apps/web/qa/consumer/english-audit.mjs';

const time = 1_760_000_000_000;
const source = mode => ({ mode, label: mode === 'DEMO' ? 'Synthetic demo' : 'Devnet observations', asOfMs: time + 1000 });
function sample(mode = 'DEMO') {
  const market = { id: `${mode}:m`, title: 'Solana', subtitle: '', subject: 'KEYWORD', phase: 'CURVE', source: source(mode), latestPrice: '1.2', priceUnit: 'tUSD', changeFraction: 0.2 };
  const series = { id: 's', kind: 'CURVE_PRICE', label: 'Curve quote', unit: 'tUSD', source: source(mode), points: [{ atMs: time, value: '1.2', observationId: 'obs-1' }], gaps: [] };
  const action = { id: `${mode}:a`, marketId: market.id, actorId: `${mode}:actor`, actorLabel: 'Actor', kind: 'CALL_CLOSE', atMs: time, seriesId: 's', value: '1.2', recordId: 'r1', returnFraction: -0.1, note: { id: 'n1', actionId: `${mode}:a`, authorId: `${mode}:actor`, body: 'Momentum faded.', createdAtMs: time + 1000, updatedAtMs: time + 1000, version: 1, timing: 'ADDED_LATER', proofCoverage: 'NONE' }, source: source(mode) };
  const profile = { actorId: `${mode}:actor`, actorLabel: 'Actor', source: source(mode), closedCallCount: 1, openCallCount: 0, meanReturnFraction: -0.1, actions: [action] };
  const board = { period: 'ALL', source: source(mode), rows: [{ actorId: profile.actorId, actorLabel: 'Actor', closedCallCount: 1, meanReturnFraction: -0.1, rank: 1 }] };
  return { markets: [market], histories: [{ market, period: 'ALL', series: [series], actions: [action], source: source(mode) }], profiles: [profile], leaderboards: [board] };
}

test('coherent negative outcome and later note are accepted', () => assert.deepEqual(auditConsumerSnapshot(sample()), []));
test('mixed live/demo identities and paid public activity are rejected', () => {
  const data = sample('LIVE');
  data.histories[0].actions[0].source.mode = 'DEMO';
  data.profiles[0].actions[0].kind = 'BUY';
  const issues = auditConsumerSnapshot(data);
  assert.ok(issues.some(x => x.path.endsWith('source.mode')));
  assert.ok(issues.some(x => x.message.includes('paid activity')));
});
test('chart gap and missing value cannot be fabricated as zero', () => {
  const data = sample();
  data.histories[0].series[0].gaps = [{ fromMs: time - 1, toMs: time + 10 }];
  data.histories[0].actions[0].value = 0;
  const issues = auditConsumerSnapshot(data);
  assert.ok(issues.some(x => x.message.includes('gap interior contains')));
  assert.ok(issues.some(x => x.path.endsWith('.value')));
});
test('the same action may recur across periods and social may omit verified chart values', () => {
  const data = sample('LIVE');
  data.histories.push(structuredClone({ ...data.histories[0], period: '1W' }));
  data.histories[0].series[0].gaps = [{ fromMs: time, toMs: time + 10 }];
  data.histories[1].series[0].gaps = [{ fromMs: time, toMs: time + 10 }];
  data.profiles[0].actions[0] = { ...data.profiles[0].actions[0], seriesId: null, value: null };
  assert.deepEqual(auditConsumerSnapshot(data), []);
  data.profiles[0].actions[0].atMs += 1000;
  assert.ok(auditConsumerSnapshot(data).some(issue => issue.message.includes('differs from chart action')));
});
test('demo 1D needs intraday density unless explicit gaps cover missing hours', () => {
  const data = sample();
  data.histories[0].period = '1D';
  assert.ok(auditConsumerSnapshot(data).some(issue => issue.message.includes('intraday points')));
  data.histories[0].series[0].gaps = [{ fromMs: time + 1000 - 86_400_000, toMs: time + 1000 }];
  assert.ok(!auditConsumerSnapshot(data).some(issue => issue.message.includes('intraday points')));
});
test('demo return must follow attention at entry and exit, never price series', () => {
  const data = sample();
  const history = data.histories[0];
  history.series[0].kind = 'ATTENTION_INDEX';
  history.series[0].points = [{ atMs: time - 1000, value: '2' }, { atMs: time, value: '1.8' }];
  const close = history.actions[0];
  close.value = '1.8';
  const open = { ...close, id: 'DEMO:open', kind: 'CALL_OPEN', atMs: time - 1000, value: '2', returnFraction: null, note: null };
  history.actions.unshift(open);
  data.profiles[0].actions = [close, open];
  assert.deepEqual(auditConsumerSnapshot(data), []);
  close.returnFraction = 0.2;
  assert.ok(auditConsumerSnapshot(data).some(issue => issue.message.includes('differs from attention')));
});
test('note provenance, proof boundary and mean return are checked', () => {
  const data = sample();
  data.histories[0].actions[0].note.proofCoverage = 'SAS';
  data.profiles[0].meanReturnFraction = 0.5;
  const issues = auditConsumerSnapshot(data);
  assert.ok(issues.some(x => x.message.includes('proof coverage')));
  assert.ok(issues.some(x => x.message.includes('arithmetic mean')));
});
test('leaderboard tie rank and duplicate actor are checked', () => {
  const data = sample();
  data.leaderboards[0].rows.push({ ...data.leaderboards[0].rows[0], rank: 2 });
  const issues = auditConsumerSnapshot(data);
  assert.ok(issues.some(x => x.message.includes('competition rank')));
  assert.ok(issues.some(x => x.message.includes('twice')));
});
test('English audit checks language, favicon and visible Hangul', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-english-'));
  try {
    await mkdir(join(dir, 'apps/web'), { recursive: true });
    await writeFile(join(dir, 'apps/web/index.html'), '<html lang="ko"><head><title>테스트</title></head></html>');
    const issues = await auditEnglish(['apps/web/index.html'], dir);
    assert.deepEqual(new Set(issues.map(x => x.rule)), new Set(['hangul', 'html-lang-en', 'description', 'favicon-link']));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('English audit ignores a Hangul-detection regex used by an English error mapper', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'ante-up-copy-'));
  try {
    await mkdir(join(dir, 'apps/web/src'), { recursive: true });
    await writeFile(join(dir, 'apps/web/src/copy.ts'), "return /[가-힣]/u.test(reason) ? 'Could not load' : reason;");
    assert.deepEqual(await auditEnglish(['apps/web/src/copy.ts'], dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
