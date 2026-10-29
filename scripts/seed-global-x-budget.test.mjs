import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GlobalXBudget} from '../services/data/global-budget.mjs';

const script=fileURLToPath(new URL('./seed-global-x-budget.mjs',import.meta.url));
const markets=[
  '7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT',
  'CyYjBcb4LyuyLN1Akaf2eXXJV5GhFUkaPNb7caLCuHN6'
];
test('seed plan is read only and apply includes both existing collector journals once',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ante-up-x-seed-'));
  try{
    const db=join(dir,'budget.sqlite'),states=markets.map((market,index)=>{
      const path=join(dir,`collection-${index}.json`);
      writeFileSync(path,JSON.stringify({markets:{[market]:{}},totalSpentMicros:11_000_000,
        spentByDay:{'2026-10-28':4_000_000,'2026-10-29':3_000_000}}));
      return path;
    });
    const run=mode=>JSON.parse(execFileSync(process.execPath,[script,mode,db,...states],{encoding:'utf8'}));
    assert.equal(run('--plan').state,'READY');
    assert.equal(existsSync(db),false);
    assert.equal(run('--apply').marketCount,2);
    const budget=new GlobalXBudget(db);
    try{assert.deepEqual(budget.totals('2026-10-29'),
      {total:22_000_000,daily:6_000_000,initial:8_000_000});}
    finally{budget.close();}
    assert.throws(()=>run('--apply'));
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('seed refuses historical spending already beyond the shared daily cap',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ante-up-x-over-cap-'));
  try{
    const state=join(dir,'collection.json'),db=join(dir,'budget.sqlite');
    writeFileSync(state,JSON.stringify({markets:{[markets[0]]:{}},totalSpentMicros:11_000_000,
      spentByDay:{'2026-10-29':11_000_000}}));
    assert.throws(()=>execFileSync(process.execPath,[script,'--apply',db,state],{encoding:'utf8'}));
    assert.equal(existsSync(db),false);
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
