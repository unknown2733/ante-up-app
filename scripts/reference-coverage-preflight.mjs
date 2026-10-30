import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const FIVE_MINUTES=300_000;
const TWENTY_EIGHT_DAYS=28*86_400_000;
const integer=value=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value);

/** Source identity and stored raw response must agree before coverage is useful. */
export function verifyCumulativeEvidence(rows,slug){
  if(!Array.isArray(rows)||typeof slug!=='string')throw Error('COVERAGE_EVIDENCE_ARGS_INVALID');
  let invalidRows=0;
  for(const row of rows){
    const rawValid=row.rawBytes instanceof Uint8Array&&
      /^[a-f0-9]{64}$/.test(row.rawSha256??'')&&
      createHash('sha256').update(row.rawBytes).digest('hex')===row.rawSha256;
    let sourceValid=true;
    if(slug.startsWith('youtube-')){
      try{
        const url=new URL(row.sourceUrl);
        sourceValid=row.kind==='YOUTUBE_VIEWS'&&row.provider==='YouTube Data API'&&
          row.reportedDate===null&&row.observedAtMs===row.capturedAtMs&&
          url.protocol==='https:'&&url.hostname==='www.youtube.com'&&url.pathname==='/watch'&&
          url.searchParams.get('v')===slug.slice('youtube-'.length);
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
    negativeDeltas:0,latestAgeMs:null,trailingIntervals:0};
  const byBucket=new Map();
  for(const row of rows){
    const bucket=Math.floor(row.observedAtMs/cadenceMs)*cadenceMs;
    const previous=byBucket.get(bucket);
    if(!previous||row.observedAtMs>previous.observedAtMs||
        row.observedAtMs===previous.observedAtMs&&row.capturedAtMs>previous.capturedAtMs)
      byBucket.set(bucket,row);
  }
  const latest=Math.max(...byBucket.keys()),first=latest-windowMs;
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
  const latestAgeMs=nowMs-rows.reduce((max,row)=>Math.max(max,row.observedAtMs),0);
  const coverageComplete=observedBuckets===requiredBuckets;
  const fresh=latestAgeMs>=0&&latestAgeMs<2*cadenceMs;
  const readyForFiveMinuteDerivation=coverageComplete&&fresh&&negativeDeltas===0;
  return {status:readyForFiveMinuteDerivation?'SOURCE_COVERAGE_COMPLETE':
    !fresh?'SOURCE_STALE':negativeDeltas?'SOURCE_REVISION_DOWN':
    'SOURCE_HISTORY_INCOMPLETE',coverageComplete,readyForFiveMinuteDerivation,
    observedBuckets,requiredBuckets,missingBuckets:requiredBuckets-observedBuckets,
    negativeDeltas,latestAgeMs,trailingIntervals};
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
    const latest=db.prepare('SELECT MAX(observed_at_ms) AS atMs FROM reference_observations WHERE slug=?');
    return slugs.map(({slug})=>{
      const atMs=latest.get(slug).atMs;
      const rows=history.all(slug,atMs-TWENTY_EIGHT_DAYS-FIVE_MINUTES);
      const kind=rows.at(-1)?.kind??null;
      const cadenceSource=kind==='YOUTUBE_VIEWS'||kind==='X_LIKES';
      const coverage=cadenceSource?analyzeCumulativeCoverage(rows,{nowMs}):null;
      const evidence=cadenceSource?verifyCumulativeEvidence(rows,slug):null;
      const checked=coverage&&evidence&&!evidence.evidenceValid
        ?{...coverage,status:'SOURCE_EVIDENCE_INVALID',readyForFiveMinuteDerivation:false}:coverage;
      return {slug,kind,requiredCadence:'5m',evidence,coverage:checked??{
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
