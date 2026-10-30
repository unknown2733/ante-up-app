import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deriveCumulativeIntervals} from '../services/data/cumulative-intervals.mjs';

const FIVE_MINUTES=300_000;
const TWENTY_EIGHT_DAYS=28*86_400_000;
const integer=value=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value);

function reportedCount(rawBytes,kind,id){
  try{
    const response=JSON.parse(Buffer.from(rawBytes).toString('utf8'));
    const items=kind==='YOUTUBE_VIEWS'?response?.items:response?.data;
    if(!Array.isArray(items))return null;
    const matches=items.filter(item=>item?.id===id);
    if(matches.length!==1)return null;
    const value=kind==='YOUTUBE_VIEWS'
      ?matches[0]?.statistics?.viewCount:matches[0]?.public_metrics?.like_count;
    if(kind==='YOUTUBE_VIEWS')return integer(value)?value:null;
    return Number.isSafeInteger(value)&&value>=0?String(value):null;
  }catch{return null;}
}

/** Source identity and stored raw response must agree before coverage is useful. */
export function verifyCumulativeEvidence(rows,slug){
  if(!Array.isArray(rows)||typeof slug!=='string')throw Error('COVERAGE_EVIDENCE_ARGS_INVALID');
  let invalidRows=0;
  for(const row of rows){
    const rawValid=row.rawBytes instanceof Uint8Array&&
      /^[a-f0-9]{64}$/.test(row.rawSha256??'')&&
      createHash('sha256').update(row.rawBytes).digest('hex')===row.rawSha256;
    let sourceValid=false;
    if(slug.startsWith('youtube-')){
      try{
        const url=new URL(row.sourceUrl);
        sourceValid=row.kind==='YOUTUBE_VIEWS'&&row.provider==='YouTube Data API'&&
          row.reportedDate===null&&row.observedAtMs===row.capturedAtMs&&
          url.protocol==='https:'&&url.hostname==='www.youtube.com'&&url.pathname==='/watch'&&
          !url.username&&!url.password&&!url.hash&&
          url.searchParams.get('v')===slug.slice('youtube-'.length)&&
          reportedCount(row.rawBytes,row.kind,slug.slice('youtube-'.length))===row.value;
      }catch{sourceValid=false;}
    }else if(slug.startsWith('x-')){
      try{
        const url=new URL(row.sourceUrl);
        sourceValid=row.kind==='X_LIKES'&&row.provider==='X API'&&
          row.reportedDate===null&&row.observedAtMs===row.capturedAtMs&&
          url.protocol==='https:'&&url.hostname==='x.com'&&
          !url.username&&!url.password&&!url.hash&&!url.search&&
          url.pathname.endsWith('/status/'+slug.slice('x-'.length))&&
          reportedCount(row.rawBytes,row.kind,slug.slice('x-'.length))===row.value;
      }catch{sourceValid=false;}
    }
    if(!rawValid||!sourceValid)invalidRows++;
  }
  return {evidenceValid:invalidRows===0,invalidRows};
}

/** Readiness of cumulative source observations only; this does not authorize a market. */
export function analyzeCumulativeCoverage(rows,{nowMs=Date.now(),cadenceMs=FIVE_MINUTES,
  windowMs=TWENTY_EIGHT_DAYS}={}){
  if(!Number.isSafeInteger(nowMs)||!Number.isSafeInteger(cadenceMs)||cadenceMs<=0||
      !Number.isSafeInteger(windowMs)||windowMs<=0||windowMs%cadenceMs!==0)
    throw Error('COVERAGE_ARGS_INVALID');
  if(!Array.isArray(rows)||rows.some(row=>!row||!Number.isSafeInteger(row.observedAtMs)||
      !Number.isSafeInteger(row.capturedAtMs)||row.capturedAtMs<row.observedAtMs||
      !integer(row.value)||row.aggregation!=='cumulative'))throw Error('COVERAGE_OBSERVATION_INVALID');
  if(!rows.length)return {status:'NO_OBSERVATIONS',coverageComplete:false,readyForFiveMinuteDerivation:false,
    observedBuckets:0,requiredBuckets:windowMs/cadenceMs+1,missingBuckets:windowMs/cadenceMs+1,
    negativeDeltas:0,revisionRecoveryIntervals:0,latestAgeMs:null,trailingIntervals:0};
  const byBucket=new Map();
  for(const row of rows){
    const bucket=Math.floor(row.observedAtMs/cadenceMs)*cadenceMs;
    const previous=byBucket.get(bucket);
    if(!previous||row.observedAtMs>previous.observedAtMs||
        row.observedAtMs===previous.observedAtMs&&row.capturedAtMs>previous.capturedAtMs)
      byBucket.set(bucket,row);
  }
  let latest=-1;
  for(const bucket of byBucket.keys())if(bucket>latest)latest=bucket;
  const first=latest-windowMs;
  const requiredBuckets=windowMs/cadenceMs+1;
  let observedBuckets=0,negativeDeltas=0,trailingIntervals=0,previous=null;
  for(let bucket=first;bucket<=latest;bucket+=cadenceMs){
    const row=byBucket.get(bucket);
    if(!row){previous=null;continue;}
    observedBuckets++;
    if(previous&&BigInt(row.value)<BigInt(previous.value))negativeDeltas++;
    previous=row;
  }
  for(let bucket=latest;byBucket.has(bucket-cadenceMs);bucket-=cadenceMs)
    trailingIntervals++;
  // An increase after a downward provider correction can restore previously
  // counted activity. Continuous buckets alone do not make it a new delta.
  const revisionRecoveryIntervals=deriveCumulativeIntervals(rows,{bucketMs:cadenceMs}).intervals
    .filter(interval=>interval.kind==='REVISION_RECOVERY'&&
      Math.floor(interval.toAtMs/cadenceMs)*cadenceMs>=first&&
      Math.floor(interval.toAtMs/cadenceMs)*cadenceMs<=latest).length;
  const latestAgeMs=nowMs-rows.reduce((max,row)=>Math.max(max,row.observedAtMs),0);
  const coverageComplete=observedBuckets===requiredBuckets;
  const fresh=latestAgeMs>=0&&latestAgeMs<2*cadenceMs;
  const readyForFiveMinuteDerivation=coverageComplete&&fresh&&negativeDeltas===0&&revisionRecoveryIntervals===0;
  return {status:readyForFiveMinuteDerivation?'SOURCE_COVERAGE_COMPLETE':
    !fresh?'SOURCE_STALE':negativeDeltas?'SOURCE_REVISION_DOWN':
    revisionRecoveryIntervals?'SOURCE_REVISION_RECOVERY':
    'SOURCE_HISTORY_INCOMPLETE',coverageComplete,readyForFiveMinuteDerivation,
    observedBuckets,requiredBuckets,missingBuckets:requiredBuckets-observedBuckets,
    negativeDeltas,revisionRecoveryIntervals,latestAgeMs,trailingIntervals};
}

export function inspectReferenceStore(dbPath,{nowMs=Date.now()}={}){
  const db=new DatabaseSync(resolve(dbPath),{readOnly:true});
  try{
    const slugs=db.prepare('SELECT DISTINCT slug FROM reference_observations ORDER BY slug').all();
    const history=db.prepare(`SELECT o.kind, o.aggregation, o.observed_at_ms AS observedAtMs,
      o.captured_at_ms AS capturedAtMs, o.value, o.provider, o.source_url AS sourceUrl,
      o.reported_date AS reportedDate, o.raw_sha256 AS rawSha256, r.raw_bytes AS rawBytes
      FROM reference_observations o LEFT JOIN reference_raw r ON r.raw_sha256=o.raw_sha256
      WHERE o.slug=? AND o.observed_at_ms>=? ORDER BY o.observed_at_ms, o.captured_at_ms`);
    // Keep the correction baseline across the 28-day boundary without loading
    // older raw provider responses into the evidence verification window.
    const countHistory=db.prepare(`SELECT aggregation, observed_at_ms AS observedAtMs,
      captured_at_ms AS capturedAtMs, value FROM reference_observations
      WHERE slug=? ORDER BY observed_at_ms, captured_at_ms`);
    const latest=db.prepare('SELECT MAX(observed_at_ms) AS atMs FROM reference_observations WHERE slug=?');
    return slugs.map(({slug})=>{
      const atMs=latest.get(slug).atMs;
      const rows=history.all(slug,atMs-TWENTY_EIGHT_DAYS-FIVE_MINUTES);
      const kind=rows.at(-1)?.kind??null;
      const cadenceSource=kind==='YOUTUBE_VIEWS'||kind==='X_LIKES';
      const counts=cadenceSource?countHistory.all(slug):null;
      const coverage=counts?analyzeCumulativeCoverage(counts,{nowMs}):null;
      const evidence=cadenceSource?verifyCumulativeEvidence(rows,slug):null;
      const firstBucket=Math.floor((atMs-TWENTY_EIGHT_DAYS)/FIVE_MINUTES)*FIVE_MINUTES;
      const lastBucket=Math.floor(atMs/FIVE_MINUTES)*FIVE_MINUTES;
      const intervalKinds=counts
        ?deriveCumulativeIntervals(counts).intervals.filter(interval=>{
          const bucket=Math.floor(interval.toAtMs/FIVE_MINUTES)*FIVE_MINUTES;
          return bucket>=firstBucket&&bucket<=lastBucket;
        }).reduce((totals,interval)=>{
          totals[interval.kind]++;return totals;
        },{OBSERVED_DELTA:0,GAP:0,DOWNWARD_REVISION:0,REVISION_RECOVERY:0})
        :null;
      const checked=coverage&&evidence&&!evidence.evidenceValid
        ?{...coverage,status:'SOURCE_EVIDENCE_INVALID',readyForFiveMinuteDerivation:false}:coverage;
      return {slug,kind,requiredCadence:'5m',evidence,intervalKinds,coverage:checked??{
        status:'UNSUPPORTED_SOURCE_CADENCE',
        coverageComplete:false,readyForFiveMinuteDerivation:false}};
    });
  }finally{db.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3)throw Error('Usage: node scripts/reference-coverage-preflight.mjs <reference-db.sqlite>');
  console.log(JSON.stringify({readOnly:true,marketAuthorization:false,
    subjects:inspectReferenceStore(process.argv[2])}));
}
