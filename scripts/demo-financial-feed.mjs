// Finite synthetic feed for an explicitly labelled Devnet demo market.
// Each child persists candidate + signature before submission and never retries
// an unknown transaction. Any child failure stops the feed for operator review.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {safeError} from './qa-finance-devnet.mjs';

async function main(){
  const passes=Number(process.env.ANTE_UP_DEMO_FEED_PASSES??'15');
  assert.ok(Number.isInteger(passes)&&passes>=1&&passes<=15,'one hour maximum; 1..15 passes');
  assert.equal(process.env.ANTE_UP_QA_PROFILE,'demo');
  assert.equal(process.env.ANTE_UP_QA_CANDIDATE_IMPORT_READY,'yes');
  const abort=new AbortController();
  const stop=()=>abort.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
  for(let i=0;i<passes&&!abort.signal.aborted;i++){
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('./qa-finance-devnet.mjs',import.meta.url)),'refresh'],{stdio:'inherit',env:process.env});
      // Let the current atomic publication finish even when shutdown is requested.
      child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('DEMO_FEED_CHILD_FAILED')));
    });
    if(i+1<passes&&!abort.signal.aborted)await delay(240000,undefined,{signal:abort.signal}).catch(e=>{if(e.name!=='AbortError')throw e;});
  }
  console.log(JSON.stringify({feedStopped:true,synthetic:true,at:new Date().toISOString()}));
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
