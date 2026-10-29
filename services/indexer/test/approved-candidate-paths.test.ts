import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {approvedCandidatePaths} from '../src/approved-candidate-paths.ts';

test('new operator approvals supply candidate paths while old entries remain readable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-up-candidate-paths-'));
  try{
    const path=join(dir,'approved.json');
    await writeFile(path,JSON.stringify({schemaVersion:1,maxMarkets:5,markets:[
      {marketId:'7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT',seedHex:'a'.repeat(64),queryHash:'b'.repeat(64),queryVersion:'1'},
      {marketId:'CyYjBcb4LyuyLN1Akaf2eXXJV5GhFUkaPNb7caLCuHN6',seedHex:'c'.repeat(64),queryHash:'d'.repeat(64),queryVersion:'1',candidatePath:'/state/tariff/candidates.json'}
    ]}));
    assert.deepEqual(await approvedCandidatePaths(path),['/state/tariff/candidates.json']);
    await writeFile(path,JSON.stringify({schemaVersion:1,maxMarkets:5,markets:[
      {marketId:'CyYjBcb4LyuyLN1Akaf2eXXJV5GhFUkaPNb7caLCuHN6',seedHex:'c'.repeat(64),queryHash:'d'.repeat(64),queryVersion:'1',candidatePath:'/state/../secrets/candidates.json'}
    ]}));
    await assert.rejects(approvedCandidatePaths(path),/PAID_X_APPROVAL_INVALID/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
