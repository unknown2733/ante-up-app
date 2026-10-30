import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyzeCumulativeCoverage,inspectReferenceStore,verifyCumulativeEvidence}
  from './reference-coverage-preflight.mjs';

const minute=60_000,cadence=5*minute,now=20*cadence;
const row=(bucket,value)=>({observedAtMs:bucket*cadence+1000,
  capturedAtMs:bucket*cadence+1000,value:String(value),aggregation:'cumulative'});
const options={nowMs:now+1000,windowMs:3*cadence};

test('continuous cumulative readings provide exact interval totals without invented minute rows',()=>{
  const result=analyzeCumulativeCoverage([row(17,100),row(18,102),row(19,102),row(20,109)],options);
  assert.equal(result.status,'SOURCE_COVERAGE_COMPLETE');
  assert.equal(result.observedBuckets,4);
  assert.equal(result.trailingIntervals,3);
});

test('missing source intervals, stale reads and downward revisions stay ineligible',()=>{
  assert.equal(analyzeCumulativeCoverage([row(17,100),row(19,105),row(20,107)],options).missingBuckets,1);
  assert.equal(analyzeCumulativeCoverage([row(17,100),row(18,102),row(19,102),row(20,99)],options).status,'SOURCE_REVISION_DOWN');
  assert.equal(analyzeCumulativeCoverage([row(17,100),row(18,102),row(19,103)],options).status,'SOURCE_HISTORY_INCOMPLETE');
  assert.equal(analyzeCumulativeCoverage([row(17,100),row(18,102),row(19,103),row(20,104)],
    {...options,nowMs:now+3*cadence}).status,'SOURCE_STALE');
});

test('invalid or noncumulative observations cannot be treated as market activity',()=>{
  assert.throws(()=>analyzeCumulativeCoverage([row(20,'-1')],options),/COVERAGE_OBSERVATION_INVALID/);
  assert.throws(()=>analyzeCumulativeCoverage([{...row(20,1),aggregation:'daily'}],options),/COVERAGE_OBSERVATION_INVALID/);
});

test('YouTube source identity and exact raw bytes are prerequisites for coverage',()=>{
  const rawBytes=Buffer.from('{"items":[{"id":"S0Q4gqBUs7c","statistics":{"viewCount":"100"}}]}');
  const valid={...row(20,100),kind:'YOUTUBE_VIEWS',provider:'YouTube Data API',
    reportedDate:null,sourceUrl:'https://www.youtube.com/watch?v=S0Q4gqBUs7c',
    rawBytes,rawSha256:createHash('sha256').update(rawBytes).digest('hex')};
  const slug='youtube-S0Q4gqBUs7c';
  assert.deepEqual(verifyCumulativeEvidence([valid],slug),{evidenceValid:true,invalidRows:0});
  assert.equal(verifyCumulativeEvidence([{...valid,rawBytes:Buffer.from('changed')}],slug).evidenceValid,false);
  assert.equal(verifyCumulativeEvidence([{...valid,sourceUrl:'https://www.youtube.com/watch?v=different'}],slug).evidenceValid,false);
  assert.equal(verifyCumulativeEvidence([{...valid,value:'101'}],slug).evidenceValid,false);
});

test('X count must match the named post in the original provider response',()=>{
  const rawBytes=Buffer.from('{"data":[{"id":"1557433517579141121","public_metrics":{"like_count":100}}]}');
  const valid={...row(20,100),kind:'X_LIKES',provider:'X API',reportedDate:null,
    sourceUrl:'https://x.com/example/status/1557433517579141121',rawBytes,
    rawSha256:createHash('sha256').update(rawBytes).digest('hex')};
  const slug='x-1557433517579141121';
  assert.equal(verifyCumulativeEvidence([valid],slug).evidenceValid,true);
  assert.equal(verifyCumulativeEvidence([{...valid,value:'101'}],slug).evidenceValid,false);
  assert.equal(verifyCumulativeEvidence([{...valid,sourceUrl:'https://x.com/example/status/1858854362614763615'}],slug).evidenceValid,false);
});

test('read-only store preflight reports bad evidence as unready',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-coverage-'));
  try{
    const file=join(dir,'observations.sqlite'),db=new DatabaseSync(file);
    db.exec(`CREATE TABLE reference_raw(raw_sha256 TEXT PRIMARY KEY,raw_bytes BLOB);
      CREATE TABLE reference_observations(slug TEXT,kind TEXT,aggregation TEXT,
        observed_at_ms INTEGER,captured_at_ms INTEGER,value TEXT,reported_date TEXT,
        provider TEXT,source_url TEXT,raw_sha256 TEXT);`);
    const at=Date.parse('2026-10-30T04:00:00Z');
    const insert=db.prepare('INSERT INTO reference_observations VALUES(?,?,?,?,?,?,?,?,?,?)');
    let latestHash;
    for(const [when,value] of [[at-2*cadence,'100'],[at-cadence,'95'],[at,'98']]){
      const raw=Buffer.from(JSON.stringify({items:[{id:'S0Q4gqBUs7c',statistics:{viewCount:value}}]}));
      const hash=createHash('sha256').update(raw).digest('hex');
      db.prepare('INSERT INTO reference_raw VALUES(?,?)').run(hash,raw);
      insert.run('youtube-S0Q4gqBUs7c','YOUTUBE_VIEWS','cumulative',when,when,value,null,
        'YouTube Data API','https://www.youtube.com/watch?v=S0Q4gqBUs7c',hash);
      latestHash=hash;
    }
    db.close();
    const original=inspectReferenceStore(file,{nowMs:at});
    assert.equal(original[0].evidence.evidenceValid,true);
    assert.equal(original[0].coverage.readyForFiveMinuteDerivation,false);
    assert.deepEqual(original[0].intervalKinds,{OBSERVED_DELTA:0,GAP:0,
      DOWNWARD_REVISION:1,REVISION_RECOVERY:1});
    const damaged=new DatabaseSync(file);
    damaged.prepare('UPDATE reference_raw SET raw_bytes=? WHERE raw_sha256=?').run(Buffer.from('changed'),latestHash);
    damaged.close();
    const result=inspectReferenceStore(file,{nowMs:at});
    assert.equal(result[0].evidence.invalidRows,1);
    assert.equal(result[0].coverage.status,'SOURCE_EVIDENCE_INVALID');
    assert.equal(result[0].coverage.readyForFiveMinuteDerivation,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
