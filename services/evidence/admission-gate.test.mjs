import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {closeAdmissionOnce} from './admission-gate.mjs';

test('close gate journals signed wire before one send and reconciles after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-gate-')),path=join(dir,'gate.json');
 try{
  let open=true,sends=0,signs=0,finalized=false;
  const adapter={path,readGate:async()=>({open}),signClose:async()=>{signs++;return {wire:'signed',signature:'sig'};},
   send:async wire=>{assert.equal(wire,JSON.parse(await readFile(path,'utf8')).wire);sends++;throw Error('unknown response');},
   getSignatureStatus:async()=>finalized?{confirmationStatus:'finalized'}:null};
  assert.equal((await closeAdmissionOnce(adapter)).state,'UNKNOWN');
  assert.equal((await closeAdmissionOnce(adapter)).state,'UNKNOWN');
  assert.equal(sends,1);assert.equal(signs,1);
  finalized=true;open=false;
  assert.equal((await closeAdmissionOnce(adapter)).state,'CLOSED');
  assert.equal(sends,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
