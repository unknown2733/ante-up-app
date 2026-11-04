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

test('revision recovery cannot be promoted to five-minute activity after the downstep leaves the window',()=>{
  const readings=[row(15,100),row(16,90),row(17,91),row(18,92),row(19,93),row(20,94)];
  const result=analyzeCumulativeCoverage(readings,options);
  assert.equal(result.coverageComplete,true);
  assert.equal(result.negativeDeltas,0);
  assert.equal(result.revisionRecoveryIntervals,4);
  assert.equal(result.readyForFiveMinuteDerivation,false);
  assert.equal(result.status,'SOURCE_REVISION_RECOVERY');
});

test('a completed recovery before the evaluated window does not block later deltas',()=>{
  const readings=[row(14,100),row(15,90),row(16,101),
    row(17,102),row(18,103),row(19,104),row(20,105)];
  const result=analyzeCumulativeCoverage(readings,options);
  assert.equal(result.coverageComplete,true);
  assert.equal(result.revisionRecoveryIntervals,0);
  assert.equal(result.readyForFiveMinuteDerivation,true);
});

test('invalid or noncumulative observations cannot be treated as market activity',()=>{
  assert.throws(()=>analyzeCumulativeCoverage([row(20,'-1')],options),/COVERAGE_OBSERVATION_INVALID/);
  assert.throws(()=>analyzeCumulativeCoverage([{...row(20,1),aggregation:'daily'}],options),/COVERAGE_OBSERVATION_INVALID/);
});

test('complete endpoint coverage does not hide a provider correction inside one bucket',()=>{
  const readings=[row(17,100),row(18,110),
    {...row(18,90),observedAtMs:18*cadence+2000,capturedAtMs:18*cadence+2000},
    {...row(18,115),observedAtMs:18*cadence+3000,capturedAtMs:18*cadence+3000},
    row(19,120),row(20,125)];
  const result=analyzeCumulativeCoverage(readings,options);
  assert.equal(result.coverageComplete,true);
  assert.equal(result.negativeDeltas,1);
  assert.equal(result.status,'SOURCE_REVISION_DOWN');
  assert.equal(result.readyForFiveMinuteDerivation,false);
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

test('store preflight retains a correction baseline older than the 28-day evidence window',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-coverage-boundary-'));
  try{
    const file=join(dir,'observations.sqlite'),db=new DatabaseSync(file);
    db.exec(`CREATE TABLE reference_raw(raw_sha256 TEXT PRIMARY KEY,raw_bytes BLOB);
      CREATE TABLE reference_observations(slug TEXT,kind TEXT,aggregation TEXT,
        observed_at_ms INTEGER,captured_at_ms INTEGER,value TEXT,reported_date TEXT,
        provider TEXT,source_url TEXT,raw_sha256 TEXT);`);
    const at=Date.parse('2026-10-30T04:00:00Z'),first=at-28*86_400_000;
    const insert=db.prepare('INSERT INTO reference_observations VALUES(?,?,?,?,?,?,?,?,?,?)');
    for(const [when,value] of [[first-2*cadence,'100'],[first-cadence,'90'],
      [first,'91'],[first+cadence,'92'],[at,'93']]){
      const raw=Buffer.from(JSON.stringify({items:[{id:'S0Q4gqBUs7c',statistics:{viewCount:value}}]}));
      const hash=createHash('sha256').update(raw).digest('hex');
      db.prepare('INSERT INTO reference_raw VALUES(?,?)').run(hash,raw);
      insert.run('youtube-S0Q4gqBUs7c','YOUTUBE_VIEWS','cumulative',when,when,value,null,
        'YouTube Data API','https://www.youtube.com/watch?v=S0Q4gqBUs7c',hash);
    }
    db.close();
    const result=inspectReferenceStore(file,{nowMs:at});
    assert.equal(result[0].coverage.negativeDeltas,0);
    assert.equal(result[0].coverage.revisionRecoveryIntervals,2);
    assert.equal(result[0].intervalKinds.REVISION_RECOVERY,2);
    assert.equal(result[0].coverage.status,'SOURCE_REVISION_RECOVERY');
    assert.equal(result[0].coverage.readyForFiveMinuteDerivation,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

for(const source of [
  {kind:'YOUTUBE_VIEWS',slug:'youtube-S0Q4gqBUs7c',id:'S0Q4gqBUs7c',
    provider:'YouTube Data API',url:'https://www.youtube.com/watch?v=S0Q4gqBUs7c',
    response:(id,value)=>({items:[{id,statistics:{viewCount:String(value)}}]})},
  {kind:'X_LIKES',slug:'x-1557433517579141121',id:'1557433517579141121',
    provider:'X API',url:'https://x.com/example/status/1557433517579141121',
    response:(id,value)=>({data:[{id,public_metrics:{like_count:value}}]})},
])test(`${source.kind} readiness verifies old baseline evidence beyond the coverage window`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-coverage-old-evidence-'));
  let db;
  try{
    const file=join(dir,'observations.sqlite');
    db=new DatabaseSync(file);
    db.exec(`CREATE TABLE reference_raw(raw_sha256 TEXT PRIMARY KEY,raw_bytes BLOB);
      CREATE TABLE reference_observations(slug TEXT,kind TEXT,aggregation TEXT,
        observed_at_ms INTEGER,captured_at_ms INTEGER,value TEXT,reported_date TEXT,
        provider TEXT,source_url TEXT,raw_sha256 TEXT); BEGIN;`);
    const at=Date.parse('2026-11-04T12:00:00Z'),first=at-28*86_400_000,oldAt=first-2*cadence;
    const insert=db.prepare('INSERT INTO reference_observations VALUES(?,?,?,?,?,?,?,?,?,?)');
    const insertRaw=db.prepare('INSERT INTO reference_raw VALUES(?,?)');
    const rawFor=value=>Buffer.from(JSON.stringify(source.response(source.id,value)));
    const hashFor=raw=>createHash('sha256').update(raw).digest('hex');
    const append=(when,value)=>{
      const raw=rawFor(value),hash=hashFor(raw);
      insertRaw.run(hash,raw);
      insert.run(source.slug,source.kind,'cumulative',when,when,String(value),null,
        source.provider,source.url,hash);
      return {raw,hash};
    };
    const old=append(oldAt,90);
    append(first-cadence,95);
    for(let bucket=0;bucket<=8064;bucket++)append(first+bucket*cadence,96+bucket);
    db.exec('COMMIT');
    const inspect=()=>inspectReferenceStore(file,{nowMs:at})[0];
    const assertInvalid=()=>{
      const result=inspect();
      assert.equal(result.coverage.coverageComplete,true);
      assert.deepEqual(result.evidence,{evidenceValid:false,invalidRows:1});
      assert.equal(result.coverage.status,'SOURCE_EVIDENCE_INVALID');
      assert.equal(result.coverage.readyForFiveMinuteDerivation,false);
    };
    assert.equal(inspect().coverage.readyForFiveMinuteDerivation,true);

    // The raw hash still matches, but the old stored count conceals a downstep.
    const correctedRaw=rawFor(100),correctedHash=hashFor(correctedRaw);
    db.prepare('INSERT OR IGNORE INTO reference_raw VALUES(?,?)').run(correctedHash,correctedRaw);
    db.prepare('UPDATE reference_observations SET raw_sha256=? WHERE observed_at_ms=?')
      .run(correctedHash,oldAt);
    assertInvalid();
    db.prepare('UPDATE reference_observations SET value=? WHERE observed_at_ms=?').run('100',oldAt);
    const corrected=inspect();
    assert.equal(corrected.evidence.evidenceValid,true);
    assert.equal(corrected.coverage.status,'SOURCE_REVISION_RECOVERY');
    assert.equal(corrected.coverage.revisionRecoveryIntervals,6);
    assert.equal(corrected.coverage.readyForFiveMinuteDerivation,false);

    db.prepare('UPDATE reference_observations SET value=?,raw_sha256=? WHERE observed_at_ms=?')
      .run('90',old.hash,oldAt);
    db.prepare('DELETE FROM reference_raw WHERE raw_sha256=?').run(old.hash);
    assertInvalid();
    insertRaw.run(old.hash,Buffer.from('changed'));
    assertInvalid();
    db.prepare('UPDATE reference_raw SET raw_bytes=? WHERE raw_sha256=?').run(old.raw,old.hash);
    db.prepare('UPDATE reference_observations SET source_url=? WHERE observed_at_ms=?')
      .run('https://example.com/wrong-source',oldAt);
    assertInvalid();
    db.prepare('UPDATE reference_observations SET source_url=? WHERE observed_at_ms=?')
      .run(source.url,oldAt);
    assert.equal(inspect().coverage.readyForFiveMinuteDerivation,true);
  }finally{
    db?.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('store preflight keeps one read snapshot while another connection appends a correction',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-coverage-snapshot-'));
  let writer;
  try{
    const file=join(dir,'observations.sqlite');
    writer=new DatabaseSync(file);
    writer.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE reference_raw(raw_sha256 TEXT PRIMARY KEY,raw_bytes BLOB);
      CREATE TABLE reference_observations(slug TEXT,kind TEXT,aggregation TEXT,
        observed_at_ms INTEGER,captured_at_ms INTEGER,value TEXT,reported_date TEXT,
        provider TEXT,source_url TEXT,raw_sha256 TEXT);`);
    const at=Date.parse('2026-11-04T12:00:00Z'),slug='youtube-S0Q4gqBUs7c';
    const insertRaw=writer.prepare('INSERT INTO reference_raw VALUES(?,?)');
    const insert=writer.prepare('INSERT INTO reference_observations VALUES(?,?,?,?,?,?,?,?,?,?)');
    const append=(when,value)=>{
      const raw=Buffer.from(JSON.stringify({items:[{id:'S0Q4gqBUs7c',statistics:{viewCount:String(value)}}]}));
      const hash=createHash('sha256').update(raw).digest('hex');
      insertRaw.run(hash,raw);
      insert.run(slug,'YOUTUBE_VIEWS','cumulative',when,when,String(value),null,
        'YouTube Data API','https://www.youtube.com/watch?v=S0Q4gqBUs7c',hash);
    };
    append(at-cadence,100);
    append(at,101);
    const prepare=DatabaseSync.prototype.prepare;
    let injected=false;
    t.mock.method(DatabaseSync.prototype,'prepare',function(sql){
      const statement=prepare.call(this,sql);
      if(this!==writer&&!injected&&sql.startsWith('SELECT')){
        const all=statement.all;
        t.mock.method(statement,'all',function(...args){
          const rows=all.apply(this,args);
          injected=true;
          // Commit after the reader establishes its snapshot, before it loads history.
          append(at+1000,90);
          return rows;
        });
      }
      return statement;
    });
    const during=inspectReferenceStore(file,{nowMs:at+1000})[0];
    assert.equal(injected,true);
    assert.equal(during.evidence.evidenceValid,true);
    assert.equal(during.coverage.latestAgeMs,1000);
    assert.equal(during.coverage.negativeDeltas,0);
    const after=inspectReferenceStore(file,{nowMs:at+1000})[0];
    assert.equal(after.evidence.evidenceValid,true);
    assert.equal(after.coverage.latestAgeMs,0);
    assert.equal(after.coverage.negativeDeltas,1);
    assert.equal(after.coverage.readyForFiveMinuteDerivation,false);
  }finally{
    t.mock.restoreAll();
    writer?.close();
    await rm(dir,{recursive:true,force:true});
  }
});
