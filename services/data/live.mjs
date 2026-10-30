import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readStateJson, writeStateJson } from './state-json.mjs';
import { buildQuery, ingestCounts, replay, FileRawResponseRepository, HISTORY_MINUTES } from './index.mjs';
import { markSourceInvalid, markSourceStale, updateOutageTimeline } from './outage.mjs';

const check = (condition, code = 'INVALID_INPUT') => { if (!condition) throw new Error(code); };
export const queryHashFor = query => createHash('sha256').update(query, 'utf8').digest('hex');

// X's documented Counts HTTP endpoint. This constructor does not send traffic.
export class XCountsHttpAdapter {
  constructor({ bearerToken, fetcher = globalThis.fetch, baseUrl = 'https://api.x.com' }) {
    check(typeof bearerToken === 'string' && bearerToken.length > 0, 'MISSING_X_BEARER_TOKEN');
    check(typeof fetcher === 'function');
    this.token = bearerToken; this.fetcher = fetcher; this.baseUrl = baseUrl;
  }
  async count({ query, from, through, historical = false, paginationToken = null }) {
    check(typeof query === 'string' && query.length > 0 && Number.isSafeInteger(from) && Number.isSafeInteger(through) && through > from);
    const endpoint = historical ? '/2/tweets/counts/all' : '/2/tweets/counts/recent';
    const url = new URL(endpoint, this.baseUrl);
    url.searchParams.set('query', query);
    url.searchParams.set('start_time', new Date(from * 1000).toISOString());
    url.searchParams.set('end_time', new Date(through * 1000).toISOString());
    url.searchParams.set('granularity', 'minute');
    if (paginationToken) url.searchParams.set('next_token', paginationToken);
    const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`X_HTTP_${response.status}`);
    // Let the collector archive a parsed but malformed response before
    // classifying it as an invalid source. HTTP and JSON failures have no
    // canonical raw response and remain transport failures.
    return response.json();
  }
}

export class FileCollectionState {
  constructor(path) { this.path = path; }
  async read() { try { return readStateJson(this.path); } catch (e) { if (e.code === 'ENOENT') return { spentByDay:{}, totalSpentMicros:0, batches:{}, markets:{} }; throw e; } }
  async write(value) {
    writeStateJson(this.path, value);
  }
}

export async function runInitialArchive({store,rawDirectory,transport,marketId,expressions,queryVersion,start,through,now,
  estimatedCostMicros,initialLimitMicros=100_000_000,totalLimitMicros=100_000_000,configVersion='1',
  beforeSourceRequest}) {
  check(Number.isSafeInteger(start) && start % 60 === 0 && through === start + HISTORY_MINUTES*60 && now >= through);
  check(Number.isSafeInteger(estimatedCostMicros) && estimatedCostMicros > 0);
  const query = buildQuery(expressions), queryHash = queryHashFor(query), key = `initial:${marketId}:${queryVersion}`;
  const state = await store.read();
  const prior=state.batches[key];
  if (prior && !['FAILED','PAGING'].includes(prior.state)) return prior;
  if (prior?.retryAt && now<prior.retryAt) return prior;
  check(!state.markets[marketId],'VERSION_MISMATCH');
  const rawRepo=new FileRawResponseRepository(rawDirectory);
  const pages=prior?.pages ?? [];
  let nextToken=prior?.nextToken ?? null;
  try {
    const seen=new Set(pages.map(p=>p.token).filter(Boolean));
    while (true) {
      check(pages.length<500,'X_PAGE_LIMIT');
      check(state.totalSpentMicros+estimatedCostMicros<=Math.min(initialLimitMicros,totalLimitMicros),'BUDGET_EXHAUSTED');
      await beforeSourceRequest?.({marketId,kind:'initial',costMicros:estimatedCostMicros,now});
      state.totalSpentMicros+=estimatedCostMicros;
      state.batches[key]={id:key,state:'REQUESTING',chargedMicros:(pages.length+1)*estimatedCostMicros,
        requestedAt:now,pages,nextToken};
      await store.write(state);
      const page=await transport.count({query,from:start,through,historical:true,paginationToken:nextToken});
      const pageHash=await rawRepo.put(page);
      check(page && Array.isArray(page.data) &&
        (!page.meta?.next_token || typeof page.meta.next_token==='string'),'INVALID_X_PAGE');
      pages.push({token:nextToken,rawHash:pageHash});
      nextToken=page.meta?.next_token ?? null;
      check(!nextToken || !seen.has(nextToken),'X_PAGE_CYCLE');
      if (nextToken) seen.add(nextToken);
      state.batches[key]={id:key,state:'PAGING',pages,nextToken,requestedAt:now};
      await store.write(state);
      if (!nextToken) break;
    }
    const fetched=await Promise.all(pages.map(p=>rawRepo.get(p.rawHash)));
    const raw={data:fetched.flatMap(p=>p.data),meta:{pageCount:fetched.length},pages:fetched};
    const rawHash=await rawRepo.put(raw);
    const observations = ingestCounts(raw,{marketId,queryVersion,queryHash,from:start,through,historical:true,granularity:'minute',receivedAt:now,validatedAt:now});
    const replayInput={observations,marketId,queryVersion,queryHash,start,end:through,computedAt:now,configVersion,
      pollBatch:{id:key,kind:'bootstrap',observedAt:now,dataThrough:through}};
    const result = replay(replayInput);
    const market={queryHash,queryVersion,observations,recoveryState:result.state,
      outageTimeline:[],sequence:'0',lastPollAt:now};
    updateOutageTimeline(market,marketId,result,{at:now,replayEnd:through,historyStart:start,batchId:key});
    state.markets[marketId] = market;
    // The collector has no authority to assign a chain sequence. A publisher
    // must replay with the next chain sequence and recompute the payload hash.
    const {sequence: _unassigned, ...calculation} = result.candidate;
    state.batches[key] = {id:key,state:'VALIDATED',rawHash,pageHashes:pages.map(p=>p.rawHash),observationCount:observations.length,
      calculation,replayInput,requiresChainSequence:true};
    await store.write(state);
    return state.batches[key];
  } catch (e) {
    const attempts=(prior?.attempts??0)+1;
    state.batches[key] = {id:key,state:'FAILED',pages,nextToken,attempts,
      retryAt:now+[300,900,3600][Math.min(attempts-1,2)],error:String(e.message??e)};
    await store.write(state); return state.batches[key];
  }
}

// One local worker. Charge reservations conservatively on every HTTP attempt;
// failed/429 requests are not refunded because provider billing is unverified.
export async function runRegularPoll({ store, rawDirectory, transport, marketId, expressions, queryVersion,
  historyStart, from, through, now, estimatedCostMicros, dailyLimitMicros = 10_000_000,
  totalLimitMicros = 100_000_000, configVersion = '1', kind = 'regular', revision = '0',
  beforeSourceRequest }) {
  check(Number.isSafeInteger(now) && Number.isSafeInteger(from) && Number.isSafeInteger(through) &&
    from % 300 === 0 && through % 300 === 0 && through >= from + 300 &&
    through <= from + 7*86400 && through <= now && Number.isSafeInteger(historyStart));
  check(['regular','backfill'].includes(kind) && /^(0|[1-9][0-9]*)$/.test(revision));
  check(Number.isSafeInteger(estimatedCostMicros) && estimatedCostMicros > 0 &&
    Number.isSafeInteger(dailyLimitMicros) && Number.isSafeInteger(totalLimitMicros));
  const query = buildQuery(expressions), queryHash = queryHashFor(query);
  const day = new Date(now * 1000).toISOString().slice(0,10), key = kind==='regular' ? `${marketId}:${queryVersion}:${from}` :
    `backfill:${marketId}:${queryVersion}:${from}:${revision}`;
  const state = await store.read(), priorBatch = state.batches[key];
  if (priorBatch && priorBatch.state !== 'FAILED') return priorBatch; // uncertain REQUESTING never auto-repeats
  if (priorBatch?.retryAt && now < priorBatch.retryAt) return priorBatch;
  check((state.spentByDay[day] ?? 0) + estimatedCostMicros <= dailyLimitMicros &&
    state.totalSpentMicros + estimatedCostMicros <= totalLimitMicros, 'BUDGET_EXHAUSTED');
  const market = state.markets[marketId] ?? { queryHash, queryVersion, observations:[], recoveryState:null, sequence:'0' };
  const knownMarket=Boolean(state.markets[marketId]);
  check(market.queryHash === queryHash && market.queryVersion === queryVersion, 'VERSION_MISMATCH');
  if (kind==='regular') check(market.lastPollAt === undefined || now >= market.lastPollAt + 300, 'POLL_NOT_DUE');
  await beforeSourceRequest?.({marketId,kind:'regular',costMicros:estimatedCostMicros,now});
  state.spentByDay[day] = (state.spentByDay[day] ?? 0) + estimatedCostMicros;
  state.totalSpentMicros += estimatedCostMicros;
  const attempts=(priorBatch?.attempts??0)+1;
  state.batches[key] = { id:key, state:'REQUESTING', chargedMicros:estimatedCostMicros, requestedAt:now, attempts };
  await store.write(state);
  let stage='transport',validationRawHash=null,originalObservationCount=market.observations.length;
  const originalLastPollAt=market.lastPollAt;
  try {
    const raw = await transport.count({query,from,through});
    const rawRepo = new FileRawResponseRepository(rawDirectory);
    const rawHash = await rawRepo.put(raw);
    validationRawHash=rawHash;
    stage='parse-source';
    check(!raw?.meta?.next_token || typeof raw.meta.next_token==='string','INVALID_X_PAGE');
    const parsed = ingestCounts(raw,{marketId,queryVersion,queryHash,from,through,granularity:'minute',receivedAt:now,validatedAt:now,revision});
    stage='replay';
    market.observations.push(...parsed);
    if (kind==='regular') market.lastPollAt = now;
    // Incomplete 28-day history remains PREPARING; the worker must run the
    // separately budgeted, authorized initial archive collection first.
    let result = null, replayInput=null;
    const replayEnd=kind==='backfill' ? market.observations.reduce((max,o)=>Math.max(max,o.bucketEnd),through) : through;
    if (replayEnd >= historyStart + HISTORY_MINUTES*60) {
      const input = {observations:market.observations,marketId,queryVersion,queryHash,start:historyStart,end:replayEnd,
        computedAt:now,sequence:market.sequence,configVersion,prior:market.recoveryState};
      const preliminary = replay(input);
      replayInput={...input,pollBatch:{id:key,kind,observedAt:now,dataThrough:preliminary.state.dataThrough}};
      result = replay(replayInput);
      updateOutageTimeline(market,marketId,result,{at:now,replayEnd,historyStart,batchId:key});
    }
    state.markets[marketId] = market;
    const calculation=result ? (({sequence: _unassigned, ...rest})=>rest)(result.candidate) : null;
    state.batches[key] = {id:key,state:result ? 'VALIDATED' : 'PREPARING',rawHash,observationCount:parsed.length,
      calculation,replayInput,requiresChainSequence:true};
    await store.write(state);
    return state.batches[key];
  } catch (e) {
    market.observations.length=originalObservationCount;
    market.lastPollAt=originalLastPollAt;
    if(stage==='parse-source' && knownMarket){
      markSourceInvalid(market,marketId,now,{rawHash:validationRawHash,batchId:key});
      state.markets[marketId]=market;
    } else if(stage==='transport' && knownMarket){
      markSourceStale(market,marketId,now);
      state.markets[marketId]=market;
    }
    state.batches[key] = {id:key,state:'FAILED',rawHash:validationRawHash,chargedMicros:estimatedCostMicros,attempts,
      retryAt:now+[300,900,3600][Math.min(attempts-1,2)],error:String(e.message ?? e)};
    await store.write(state);
    return state.batches[key];
  }
}

export async function runGapFill(options) {
  const state=await options.store.read(), market=state.markets[options.marketId];
  check(market && market.queryVersion===options.queryVersion,'VERSION_MISMATCH');
  const gap=market.recoveryState?.dataThrough;
  check(Number.isSafeInteger(gap) && gap<market.observations.reduce((max,o)=>Math.max(max,o.bucketEnd),0),'NO_GAP');
  const from=Math.floor(gap/300)*300;
  const maxRevision=market.observations.filter(o=>o.bucketStart>=from && o.bucketStart<from+300)
    .reduce((n,o)=>Math.max(n,Number(o.revision)),0);
  return runRegularPoll({...options,from,through:from+300,kind:'backfill',revision:String(maxRevision+1)});
}
