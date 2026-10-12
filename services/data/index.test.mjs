import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ALPHA_Q12, Q12, HISTORY_MINUTES, FileRawResponseRepository, buildQuery, ingestCounts, replay, selectObservations, nextEwmaQ12 } from './index.mjs';

const start = 1_700_000_040, marketId = 'fixture:market', queryVersion = '1', queryHash = 'a'.repeat(64);
const base = { marketId, queryVersion, queryHash };
function observations(count = () => 1, length = HISTORY_MINUTES) {
  return Array.from({ length }, (_, i) => ({ ...base, bucketStart: start + i*60, bucketEnd: start + (i+1)*60,
    value: { kind: 'count', count: String(count(i)) }, receivedAt: start + (i+1)*60, validatedAt: start + (i+1)*60,
    revision: '0', rawHash: 'b'.repeat(64) }));
}
const run = (obs, computedAt, extras = {}) => replay({ ...base, observations: obs, start, end: start + HISTORY_MINUTES*60,
  computedAt, sequence: '1', ...extras });

test('restricted query and absent minute differ from a validated zero', () => {
  assert.equal(buildQuery(['Dubai chocolate', '#DubaiChocolate']), '("Dubai chocolate" OR #DubaiChocolate) lang:en -is:retweet');
  assert.throws(() => buildQuery(['cat" OR dog']));
  const from = start, row = i => ({ start: new Date((from+i*60)*1000).toISOString(), end: new Date((from+(i+1)*60)*1000).toISOString(), tweet_count: 0 });
  const parsed = ingestCounts({ data: [row(0), row(2)], meta: { total_tweet_count: 0 } }, { ...base, from, through: from+300, granularity:'minute', receivedAt: from+300, validatedAt: from+300 });
  assert.deepEqual(parsed.map(o => o.value.kind), ['count','missing','count','missing','missing']);
  assert.equal(parsed[0].value.count, '0');
});

test('raw X-shaped response persists by content hash and reopens unchanged', async () => {
  const dir = await mkdtemp(join(process.cwd(), 'ante-raw-'));
  try {
    const repo = new FileRawResponseRepository(dir), raw = {meta:{total_tweet_count:0},data:[]};
    const id = await repo.put(raw);
    assert.equal(await repo.put({data:[],meta:{total_tweet_count:0}}), id);
    assert.deepEqual(await repo.get(id), raw);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('H3 Q12 recurrence, first-day seed, D7 lookup, and identical replay hash', () => {
  assert.equal(ALPHA_Q12, 160437865n);
  assert.equal(nextEwmaQ12(1440n*Q12, 1n), 1440n*Q12);
  const obs = observations(); const time = start + HISTORY_MINUTES*60;
  const a = run(obs, time), b = run(obs, time);
  assert.equal(a.candidate.dataStatus, 'VALID');
  assert.equal(a.candidate.activityNowQ12, '1440000000000000');
  assert.equal(a.candidate.activity7dQ12, a.candidate.activityNowQ12);
  assert.equal(a.candidateHash, b.candidateHash);
  assert.equal(a.candidate.evidenceHash, b.candidate.evidenceHash);
  assert.equal(run(obs.toReversed(), time).candidateHash, a.candidateHash);
});

test('missing minute stops dataThrough; stale incident stays anchored to observed time', () => {
  const obs = observations(() => 1, HISTORY_MINUTES+10); const gap = start + (HISTORY_MINUTES+7)*60;
  obs.splice(HISTORY_MINUTES+7, 1);
  const a = run(obs, gap+600, { end: start + (HISTORY_MINUTES+10)*60 });
  assert.equal(a.candidate.dataThrough, gap);
  assert.equal(a.candidate.dataStatus, 'OUTAGE');
  assert.equal(a.state.outageStartAt, gap+600);
  assert.equal(a.state.emergencyAt, gap+600+86400);
  const later = run(obs, gap+720, { end: start + (HISTORY_MINUTES+10)*60, prior: a.state });
  assert.equal(later.state.emergencyAt, a.state.emergencyAt);
});

test('in-deadline revision replays affected state, late revision audits only', () => {
  const obs = observations(); const time = start + HISTORY_MINUTES*60;
  const target = obs.at(-1);
  const correction = { ...target, value: { kind: 'count', count: '100' }, revision: '1', validatedAt: target.bucketEnd+100 };
  const corrected = run([...obs, correction], time+120);
  const original = run(obs, time+120);
  assert(BigInt(corrected.candidate.activityNowQ12) > BigInt(original.candidate.activityNowQ12));
  const late = run([...obs, { ...correction, receivedAt:target.bucketEnd+86400, validatedAt: target.bucketEnd+86400 }], target.bucketEnd+86400);
  assert.equal(late.candidate.activityNowQ12, original.candidate.activityNowQ12);
  assert.equal(late.audit[0].reason, 'CORRECTION_CLOSED');
});

test('real zero, low activity, and D7 zero are distinct', () => {
  const time = start + HISTORY_MINUTES*60;
  assert.equal(run(observations(i => i%20===0 ? 1 : 0), time).candidate.dataStatus, 'LOW_ACTIVITY');
  const zero = run(observations(() => 0), time);
  assert.equal(zero.candidate.dataStatus, 'PREPARING');
  assert.equal(zero.candidate.reason, 'INVALID_DENOMINATOR');
  assert.equal(zero.candidate.activityNowQ12, '0');
});

test('unknown formula and Q12 activity outside chain u64 are rejected', () => {
  const time = start+HISTORY_MINUTES*60;
  assert.throws(() => run(observations(),time,{formulaVersion:'unknown'}),/INVALID_INPUT/);
  assert.throws(() => run(observations(()=>20_000_000),time),/INVALID_INPUT/);
});

test('missing first-day minute keeps its exact dataThrough', () => {
  const obs = observations(); const missingAt = start+100*60;
  obs.splice(100, 1);
  const result = run(obs, start+HISTORY_MINUTES*60);
  assert.equal(result.candidate.dataThrough, missingAt);
  assert.equal(result.candidate.dataStatus, 'PREPARING');
});

test('late gap fill is recovery, while future validation cannot rewrite an as-of replay', () => {
  const obs = observations(); const end = start+HISTORY_MINUTES*60;
  const missing = {...obs.at(-1),value:{kind:'missing',reason:'SOURCE_GAP'}};
  const filled = {...missing,value:{kind:'count',count:'3'},revision:'1',receivedAt:end+86401,validatedAt:end+86401};
  const selected = selectObservations([...obs.slice(0,-1),missing,filled],base,end+86401);
  assert.equal(selected.selected.get(missing.bucketStart).value.count,'3');
  assert.equal(selected.usage.at(-1).kind,'gapFill');
  const future = {...obs.at(-1),value:{kind:'count',count:'1000'},revision:'1',receivedAt:end+3600,validatedAt:end+3600};
  assert.equal(run([...obs,future],end).candidateHash,run(obs,end).candidateHash);
  assert(BigInt(run([...obs,future],end+3600).candidate.activityNowQ12) > BigInt(run(obs,end+3600).candidate.activityNowQ12));
});

test('one regular recovery batch stays closed; distinct second 5-minute poll opens', () => {
  const end = start+HISTORY_MINUTES*60, stable = observations();
  const stale = run(stable,end+600);
  assert.equal(stale.candidate.dataStatus,'OUTAGE');
  const firstData = observations(()=>1,HISTORY_MINUTES+15);
  const first = run(firstData,end+900,{end:end+900,prior:stale.state,
    pollBatch:{id:'poll-1',kind:'regular',observedAt:end+900,dataThrough:end+900}});
  assert.equal(first.candidate.dataStatus,'VALID');
  assert.deepEqual(first.candidate.admission,{state:'RECOVERING',recoveryCount:1,reason:'DATA_NOT_READY'});
  const secondData = observations(()=>1,HISTORY_MINUTES+20);
  const replayed = run(secondData,end+1200,{end:end+1200,prior:JSON.parse(JSON.stringify(first.state)),
    pollBatch:{id:'poll-1',kind:'regular',observedAt:end+1200,dataThrough:end+1200}});
  assert.equal(replayed.candidate.admission.state,'RECOVERING');
  const second = run(secondData,end+1200,{end:end+1200,prior:JSON.parse(JSON.stringify(first.state)),
    pollBatch:{id:'poll-2',kind:'regular',observedAt:end+1200,dataThrough:end+1200}});
  assert.equal(second.candidate.admission.state,'OPEN');
  assert.equal(second.state.lastPollId,'poll-2');
});

test('low-activity block uses the same two regular-poll admission gate', () => {
  const end = start+HISTORY_MINUTES*60;
  const initial = run(observations(),end);
  const blocked = {...initial.state,admission:{state:'BLOCKED',recoveryCount:0,reason:'LOW_ACTIVITY'}};
  const first = run(observations(()=>1,HISTORY_MINUTES+5),end+300,{end:end+300,prior:blocked,
    pollBatch:{id:'low-1',kind:'regular',observedAt:end+300,dataThrough:end+300}});
  assert.equal(first.candidate.dataStatus,'VALID');
  assert.equal(first.candidate.admission.state,'RECOVERING');
  const second = run(observations(()=>1,HISTORY_MINUTES+10),end+600,{end:end+600,prior:first.state,
    pollBatch:{id:'low-2',kind:'regular',observedAt:end+600,dataThrough:end+600}});
  assert.equal(second.candidate.admission.state,'OPEN');
});
