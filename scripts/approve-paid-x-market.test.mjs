import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('operator plans, applies and idempotently reads back one bounded paid X approval',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ante-up-paid-x-'));
  try{
    const registryPath=join(dir,'approved.json'),configPath=join(dir,'collection.json');
    writeFileSync(registryPath,JSON.stringify({schemaVersion:1,maxMarkets:5,markets:[]}));
    writeFileSync(configPath,JSON.stringify({
      marketId:'CyYjBcb4LyuyLN1Akaf2eXXJV5GhFUkaPNb7caLCuHN6',
      directory:'/state/tariff',
      seedHex:'c9ab2789eb8c5b6c54611086d77164f07b81f1e4ebb448db15787f9a3915ed32',
      queryVersion:'1',expressions:['tariff'],estimatedCostMicros:5000,
      initialEstimatedCostMicros:10000,initialLimitMicros:1000000,
      dailyLimitMicros:1500000,totalLimitMicros:47000000
    }));
    const run=mode=>spawnSync(process.execPath,[fileURLToPath(new URL('./approve-paid-x-market.mjs',import.meta.url)),mode,registryPath,configPath],{encoding:'utf8'});
    let result=run('--plan');
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).state,'READY');
    assert.equal(JSON.parse(readFileSync(registryPath,'utf8')).markets.length,0);
    result=run('--apply');
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).state,'APPROVED');
    result=run('--apply');
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).state,'ALREADY_APPROVED');
    const saved=JSON.parse(readFileSync(registryPath,'utf8'));
    assert.equal(saved.markets.length,1);
    assert.equal(saved.markets[0].candidatePath,'/state/tariff/candidates.json');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
