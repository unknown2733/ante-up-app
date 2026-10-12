import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MINUTE = 60;
export const DAY = 86400;
export const HISTORY_MINUTES = 28 * 1440;
export const Q12 = 1_000_000_000_000n;
export const MAX_U64 = 18_446_744_073_709_551_615n;
// round((1 - 2 ** (-1 / 4320)) * 1e12); half-life is three 1440-minute days.
export const ALPHA_Q12 = 160_437_865n;

export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('INVALID_INPUT');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const hash = value => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

export class FileRawResponseRepository {
  constructor(directory) { this.directory = directory; }
  async put(raw) {
    const rawHash = hash(raw), file = join(this.directory, `${rawHash}.json`);
    await mkdir(this.directory, { recursive: true });
    try { await writeFile(file, canonical(raw), { encoding: 'utf8', flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    assert(hash(JSON.parse(await readFile(file, 'utf8'))) === rawHash, 'VERSION_MISMATCH');
    return rawHash;
  }
  async get(rawHash) {
    assert(/^[a-f0-9]{64}$/.test(rawHash));
    const raw = JSON.parse(await readFile(join(this.directory, `${rawHash}.json`), 'utf8'));
    assert(hash(raw) === rawHash, 'VERSION_MISMATCH'); return raw;
  }
}
const assert = (condition, reason = 'INVALID_INPUT') => { if (!condition) throw new Error(reason); };
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const second = value => Number.isSafeInteger(value) && value >= 0;
const parseTime = iso => { const ms = Date.parse(iso); assert(Number.isFinite(ms) && ms % 60_000 === 0); return ms / 1000; };

// Restricted query builder. Matching semantics still require live X sample validation.
export function buildQuery(expressions) {
  assert(Array.isArray(expressions) && expressions.length > 0 && expressions.length <= 8);
  const terms = expressions.map(term => {
    assert(typeof term === 'string' && /^(?:#[A-Za-z][A-Za-z0-9_]*|[A-Za-z][A-Za-z0-9]*(?: [A-Za-z][A-Za-z0-9]*)*)$/.test(term));
    return term.startsWith('#') ? term : `"${term}"`;
  });
  const query = `(${terms.join(' OR ')}) lang:en -is:retweet`;
  assert(query.length <= 512);
  return query;
}

// One normal five-minute request or a bounded delayed-worker catch-up request.
// Absent minute != zero; extra history is still only one recovery observation.
export function ingestCounts(raw, { marketId, queryVersion, queryHash, from, through, granularity, historical = false, receivedAt, validatedAt, revision = '0' }) {
  assert(typeof marketId === 'string' && marketId.length > 0 && uint(queryVersion) && /^[a-f0-9]{64}$/.test(queryHash));
  assert(second(from) && second(through) && from % 60 === 0 && through % 60 === 0 &&
    (historical ? through > from && through-from <= HISTORY_MINUTES*60 :
      through-from >= 300 && through-from <= 7*DAY && (through-from)%300 === 0));
  assert(second(receivedAt) && second(validatedAt) && validatedAt >= receivedAt && uint(revision));
  // X documents granularity as a request parameter; its sample response meta
  // has total_tweet_count, not granularity. The caller must bind the request.
  assert(granularity === 'minute' && raw && Array.isArray(raw.data));
  const responseHash = hash(raw), found = new Map();
  for (const row of raw.data) {
    const start = parseTime(row.start), end = parseTime(row.end);
    assert(end === start + 60 && start >= from && end <= through && Number.isSafeInteger(row.tweet_count) && row.tweet_count >= 0);
    assert(!found.has(start));
    found.set(start, row.tweet_count);
  }
  return Array.from({ length: (through-from)/60 }, (_, i) => {
    const bucketStart = from + i * 60;
    return { marketId, queryVersion, queryHash, bucketStart, bucketEnd: bucketStart + 60,
      value: found.has(bucketStart) ? { kind: 'count', count: String(found.get(bucketStart)) } : { kind: 'missing', reason: 'ABSENT_FROM_RESPONSE' },
      receivedAt, validatedAt, revision, rawHash: responseHash };
  });
}

export function validateObservation(o, expected) {
  assert(o.marketId === expected.marketId && o.queryVersion === expected.queryVersion && o.queryHash === expected.queryHash, 'VERSION_MISMATCH');
  assert(second(o.bucketStart) && o.bucketStart % 60 === 0 && o.bucketEnd === o.bucketStart + 60);
  assert(second(o.receivedAt) && (o.validatedAt === null || second(o.validatedAt) && o.validatedAt >= o.receivedAt) && uint(o.revision) && /^[a-f0-9]{64}$/.test(o.rawHash));
  assert(o.value?.kind === 'count' ? uint(o.value.count) : o.value?.kind === 'missing' && typeof o.value.reason === 'string');
}

// Select the first validated version and only accepted pre-deadline corrections.
export function selectObservations(observations, expected, asOf = Number.MAX_SAFE_INTEGER) {
  assert(second(asOf));
  const selected = new Map(), audit = [], usage = [];
  observations.forEach(o => validateObservation(o, expected));
  const ordered = observations.filter(o => o.validatedAt !== null && o.receivedAt <= asOf && o.validatedAt <= asOf).sort((a,b) =>
    a.bucketStart-b.bucketStart || a.validatedAt-b.validatedAt || (BigInt(a.revision) < BigInt(b.revision) ? -1 : BigInt(a.revision) > BigInt(b.revision) ? 1 : 0));
  for (const o of ordered) {
    const prior = selected.get(o.bucketStart);
    if (!prior) { selected.set(o.bucketStart, o); usage.push({bucketStart:o.bucketStart,revision:o.revision,kind:'first'}); continue; }
    if (BigInt(o.revision) === BigInt(prior.revision)) {
      assert(canonical(o.value) === canonical(prior.value) && o.rawHash === prior.rawHash, 'VERSION_MISMATCH');
      continue;
    }
    if (BigInt(o.revision) < BigInt(prior.revision)) { audit.push({ bucketStart: o.bucketStart, revision: o.revision, reason: 'OLDER_REVISION' }); continue; }
    const kind = prior.value.kind === 'missing' && o.value.kind === 'count' ? 'gapFill' : 'correction';
    if (kind === 'correction' && o.validatedAt >= o.bucketEnd + DAY) { audit.push({ bucketStart: o.bucketStart, revision: o.revision, reason: 'CORRECTION_CLOSED' }); continue; }
    selected.set(o.bucketStart, o);
    usage.push({bucketStart:o.bucketStart,revision:o.revision,kind});
  }
  return { selected, audit, usage };
}

export function nextEwmaQ12(previous, count) {
  assert(typeof previous === 'bigint' && previous >= 0n && typeof count === 'bigint' && count >= 0n);
  const target = count * 1440n * Q12;
  const next = (previous * (Q12 - ALPHA_Q12) + target * ALPHA_Q12 + Q12 / 2n) / Q12;
  assert(next <= MAX_U64, 'INVALID_INPUT');
  return next;
}

export function replay({ observations, marketId, queryVersion, queryHash, start, end, computedAt, sequence = '0', configVersion = '1', formulaVersion = 'h3-d7-q12-v1', prior = null, pollBatch = null }) {
  assert(second(start) && second(end) && second(computedAt) && start % 60 === 0 && end % 60 === 0 && end >= start + HISTORY_MINUTES * 60);
  assert(uint(sequence) && uint(configVersion) && formulaVersion === 'h3-d7-q12-v1');
  const { selected, audit, usage } = selectObservations(observations, { marketId, queryVersion, queryHash }, computedAt);
  let total = 0n, firstEnd = start + DAY;
  for (let t = start; t < firstEnd; t += 60) {
    const o = selected.get(t);
    if (!o || o.value.kind !== 'count') return incomplete('PREPARING', 'DATA_NOT_READY', t, selected, audit, usage);
    total += BigInt(o.value.count);
  }
  let s = total * Q12, dataThrough = firstEnd;
  assert(s <= MAX_U64, 'INVALID_INPUT');
  const states = new Map([[firstEnd, s]]);
  for (let t = firstEnd; t < end; t += 60) {
    const o = selected.get(t);
    if (!o || o.value.kind !== 'count') break;
    s = nextEwmaQ12(s, BigInt(o.value.count));
    dataThrough = t + 60;
    states.set(dataThrough, s);
  }
  const historical = dataThrough >= start + HISTORY_MINUTES * 60;
  assert(computedAt >= dataThrough);
  const d7 = states.get(dataThrough - 7 * DAY);
  const stale = computedAt >= dataThrough + 600;
  let status = !historical || !d7 ? 'PREPARING' : stale ? 'OUTAGE' : s < 100n * Q12 || d7 < 100n * Q12 ? 'LOW_ACTIVITY' : 'VALID';
  let reason = status === 'PREPARING' ? 'DATA_NOT_READY' : status === 'OUTAGE' ? 'DATA_STALE' : status === 'LOW_ACTIVITY' ? 'LOW_ACTIVITY' : null;
  if (historical && d7 === 0n && !stale) { status = 'PREPARING'; reason = 'INVALID_DENOMINATOR'; }
  // Data validity and new-trade admission are separate. A regular poll counts
  // once regardless of how many minute buckets/backfilled rows it contains.
  let outageStartAt = prior?.outageStartAt ?? null;
  if (stale && historical) outageStartAt ??= dataThrough + 600;
  if (outageStartAt !== null && dataThrough < end) { status = 'OUTAGE'; reason = 'DATA_STALE'; }
  if (outageStartAt !== null && !stale && dataThrough === end && historical) outageStartAt = null;
  const admissionState = nextAdmission(prior, pollBatch, status, dataThrough, computedAt);
  const evidenceHash = hash({ marketId, queryVersion, queryHash, start, dataThrough, observations: [...selected.values()].filter(o => o.bucketStart < dataThrough).sort((a,b) => a.bucketStart-b.bucketStart) });
  const candidate = { schemaVersion: '0.1', formulaVersion, configVersion, queryVersion, queryHash, admission: admissionState.admission, marketId, sequence,
    dataThrough, computedAt, activityNowQ12: historical ? s.toString() : null, activity7dQ12: historical && d7 !== undefined ? d7.toString() : null,
    dataStatus: status, reason, evidenceHash };
  return { candidate, candidateHash: hash(candidate), audit, usage: usage.map(u => ({...u,kind:u.kind === 'first' && u.bucketStart < start + HISTORY_MINUTES*60 ? 'initialHistory' : u.kind})),
    usedVersions: [...selected.values()].filter(o => o.bucketStart < dataThrough).sort((a,b) => a.bucketStart-b.bucketStart)
      .map(o => ({bucketStart:o.bucketStart,revision:o.revision,rawHash:o.rawHash})),
    state: { ...admissionState, dataThrough, outageStartAt, emergencyAt: outageStartAt === null ? null : outageStartAt + DAY } };

  function incomplete(dataStatus, error, at, selected, audit, usage) {
    const admission = {state:'BLOCKED',recoveryCount:0,reason:error};
    const candidate = { schemaVersion: '0.1', formulaVersion, configVersion, queryVersion, queryHash, admission, marketId, sequence,
      dataThrough: at, computedAt, activityNowQ12: null, activity7dQ12: null, dataStatus, reason: error,
      evidenceHash: hash({ marketId, queryVersion, queryHash, start, dataThrough: at,
        observations: [...selected.values()].filter(o => o.bucketStart < at).sort((a,b) => a.bucketStart-b.bucketStart) }) };
    return { candidate, candidateHash: hash(candidate), audit, usage,
      usedVersions:[...selected.values()].filter(o => o.bucketStart < at).sort((a,b) => a.bucketStart-b.bucketStart)
        .map(o => ({bucketStart:o.bucketStart,revision:o.revision,rawHash:o.rawHash})),
      state: { lastPollId:prior?.lastPollId??null,lastPollAt:prior?.lastPollAt??null,dataThrough:at,admission,outageStartAt:prior?.outageStartAt??null,emergencyAt:prior?.emergencyAt??null } };
  }
}

function nextAdmission(prior, poll, dataStatus, dataThrough, computedAt) {
  if (poll !== null) {
    assert(typeof poll.id === 'string' && poll.id.length > 0 && ['regular','bootstrap','backfill'].includes(poll.kind));
    assert(second(poll.observedAt) && poll.observedAt <= computedAt && poll.dataThrough === dataThrough);
    assert(prior?.lastPollAt === null || prior?.lastPollAt === undefined || poll.observedAt >= prior.lastPollAt);
  }
  const prev = prior?.admission ?? { state:'OPEN', recoveryCount:2, reason:null };
  const regularNew = poll?.kind === 'regular' && poll.id !== prior?.lastPollId &&
    (prior?.lastPollAt === null || prior?.lastPollAt === undefined || poll.observedAt >= prior.lastPollAt + 300) &&
    dataThrough > (prior?.dataThrough ?? 0);
  let admission;
  if (dataStatus !== 'VALID') admission = { state:'BLOCKED', recoveryCount:0, reason: dataStatus === 'LOW_ACTIVITY' ? 'LOW_ACTIVITY' : dataStatus === 'OUTAGE' ? 'DATA_STALE' : 'DATA_NOT_READY' };
  else if (!prior || prev.state === 'OPEN') admission = { state:'OPEN', recoveryCount:2, reason:null };
  else {
    const count = Math.min(2, prev.recoveryCount + (regularNew ? 1 : 0));
    admission = count === 2 ? { state:'OPEN',recoveryCount:2,reason:null } : count === 1 ?
      { state:'RECOVERING',recoveryCount:1,reason:'DATA_NOT_READY' } : { state:'BLOCKED',recoveryCount:0,reason:'DATA_NOT_READY' };
  }
  return { lastPollId: poll?.kind === 'regular' ? poll.id : prior?.lastPollId ?? null,
    lastPollAt: poll?.kind === 'regular' ? poll.observedAt : prior?.lastPollAt ?? null,
    admission };
}

// Historical replay is always as-of computedAt. This separate entry point
// signals an intentional latest analytical recomputation, never a trade rewrite.
export const replayLatest = input => replay(input);
