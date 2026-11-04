import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformReferences } from '../../../contracts/reference/platform-snapshot.ts';
import { ReferenceObservationStore } from '../src/reference-observations.ts';
import { collectKworbReferenceStreams } from '../src/reference-kworb.ts';
import { ReferenceKworbRequestBudget, runBoundedKworbReferenceStreams } from '../src/reference-kworb-schedule.ts';

const tracks=platformReferences.filter(item=>item.platform==='Spotify');
const nowMs=Date.parse('2026-10-29T12:00:00Z');
function report(value:string,date='2026/10/28'){
  const fetcher:typeof fetch=async url=>{
    const subject=tracks.find(item=>item.metric.sourceUrl===String(url));
    assert.ok(subject);
    const id=new URL(subject.subjectUrl).pathname.split('/').at(-1);
    return new Response(`Last updated: ${date}<table><tr><td><a href="https://open.spotify.com/track/${id}">Song</a></td><td>${value}</td><td>1</td></tr></table>`);
  };
  return fetcher;
}

test('stores exact dated raw evidence and skips an unchanged daily report',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-kworb-'));
  try{
    const dbPath=join(dir,'index.sqlite');
    const first=await collectKworbReferenceStreams({dbPath,fetcher:report('999,999,999'),nowMs:()=>nowMs});
    assert.equal(first.inserted.length,tracks.length);
    const second=await collectKworbReferenceStreams({dbPath,fetcher:report('999,999,999'),nowMs:()=>nowMs+1000});
    assert.equal(second.inserted.length,0);
    assert.equal(second.unchanged.length,tracks.length);
    const store=new ReferenceObservationStore(dbPath);
    try{
      for(const subject of tracks){
        const row=store.history(subject.slug).at(-1);
        assert.equal(row?.value,'999999999');
        assert.ok(row&&store.raw(row.rawSha256)?.byteLength);
      }
    }finally{store.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('rejects a later decrease before appending any of the three tracks',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-kworb-'));
  try{
    const dbPath=join(dir,'index.sqlite');
    await collectKworbReferenceStreams({dbPath,fetcher:report('999,999,999','2026/10/27'),nowMs:()=>nowMs});
    await assert.rejects(collectKworbReferenceStreams({dbPath,fetcher:report('999,999,998','2026/10/28'),nowMs:()=>nowMs}),
      /KWORB_STREAM_COUNT_DECREASED/);
    const store=new ReferenceObservationStore(dbPath);
    try{assert.equal(store.history(tracks[0].slug).length,1);}finally{store.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('one daily reservation prevents repeat public fetches',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-kworb-'));
  try{
    const dbPath=join(dir,'index.sqlite');
    const first=await runBoundedKworbReferenceStreams({dbPath,fetcher:report('999,999,999'),nowMs:()=>nowMs});
    assert.equal(first.status,'SUCCESS');
    const second=await runBoundedKworbReferenceStreams({dbPath,fetcher:async()=>{throw Error('FETCHED_TWICE');},nowMs:()=>nowMs+60_000});
    assert.equal(second.status,'SKIPPED');
    assert.equal(second.reason,'MIN_INTERVAL');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('same-date correction is preserved and a later daily report advances only its source date',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-kworb-correction-'));
  try{
    const dbPath=join(dir,'index.sqlite');
    await collectKworbReferenceStreams({dbPath,fetcher:report('100,000','2026/10/27'),nowMs:()=>nowMs});
    await collectKworbReferenceStreams({dbPath,fetcher:report('99,999','2026/10/27'),nowMs:()=>nowMs+1000});
    await collectKworbReferenceStreams({dbPath,fetcher:report('100,010','2026/10/28'),nowMs:()=>nowMs+2000});
    const store=new ReferenceObservationStore(dbPath);
    try{
      for(const subject of tracks){const rows=store.history(subject.slug);assert.deepEqual(rows.map(r=>[r.reportedDate,r.value]),[['2026-10-27','99999'],['2026-10-28','100010']]);assert.equal(rows[1].observedAtMs,Date.parse('2026-10-28T00:00:00Z'));}
    }finally{store.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('20-hour minimum and UTC daily cap leave the next day eligible',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-kworb-cadence-'));
  try{
    const dbPath=join(dir,'index.sqlite'),start=Date.parse('2026-11-03T02:40:00Z'),budget=new ReferenceKworbRequestBudget(dbPath);
    try{
      assert.ok(budget.reserve(start).id);
      assert.equal(budget.reserve(start+16*3600000).reason,'MIN_INTERVAL');
      assert.equal(budget.reserve(start+20*3600000).reason,'DAILY_CAP');
      assert.ok(budget.reserve(start+24*3600000).id);
    }finally{budget.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});
