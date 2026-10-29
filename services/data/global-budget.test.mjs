import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GlobalXBudget} from './global-budget.mjs';

const market='7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT';
test('two collector processes share atomic daily and total X spending limits',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ante-up-x-budget-'));
  let a,b;
  try{
    const path=join(dir,'budget.sqlite');a=new GlobalXBudget(path);b=new GlobalXBudget(path);
    const row={marketId:market,day:'2026-10-29',kind:'regular',at:1};
    assert.equal(a.reserve({...row,id:'a',costMicros:6_000_000}),'RESERVED');
    assert.equal(b.reserve({...row,id:'a',costMicros:6_000_000}),'ALREADY_RESERVED');
    assert.throws(()=>b.reserve({...row,id:'b',costMicros:5_000_000}),/BUDGET_EXHAUSTED/);
    assert.equal(b.reserve({...row,id:'c',costMicros:4_000_000}),'RESERVED');
    assert.deepEqual(a.totals('2026-10-29'),{total:10_000_000,daily:10_000_000,initial:0});
    assert.throws(()=>a.reserve({...row,id:'d',day:'2026-10-30',costMicros:141_000_000}),/BUDGET_EXHAUSTED/);
  }finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});

test('initial archive reservations share the $100 initial budget and never refund failures',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ante-up-x-initial-'));
  let budget;
  try{
    budget=new GlobalXBudget(join(dir,'budget.sqlite'),{dailyLimitMicros:110_000_000});
    const row={marketId:market,day:'2026-10-29',kind:'initial',at:1};
    budget.reserve({...row,id:'page-1',costMicros:60_000_000});
    assert.throws(()=>budget.reserve({...row,id:'page-2',costMicros:41_000_000}),/BUDGET_EXHAUSTED/);
    assert.equal(budget.totals('2026-10-29').total,60_000_000);
  }finally{budget?.close();rmSync(dir,{recursive:true,force:true});}
});
