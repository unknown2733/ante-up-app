import test from 'node:test';
import assert from 'node:assert/strict';
import {fillQuote} from '../../scripts/fill-observed-curve.mjs';

test('observed Devnet fill prices the entire curve and leaves real support capital',()=>{
  const quote=fillQuote(0n,0n,4,30_540_496_804n,17_921_241_984n);
  assert.equal(quote.quantityAtoms,1_000_000_000n);
  assert.equal(quote.grossAtoms,1_100_000_000n);
  assert.equal(quote.feeAtoms,1_100_000n);
  assert.ok(quote.supportBalanceAfterMaxPaymentAtoms>=10_000_000_000n);
});

test('fill refuses partial curves, exhausted slots or unsupported capital',()=>{
  const ready=()=>fillQuote(0n,0n,4,30_540_496_804n,17_921_241_984n);
  assert.doesNotThrow(ready);
  assert.throws(()=>fillQuote(1n,0n,4,0n,20_000_000_000n),/CURVE_NOT_EMPTY/);
  assert.throws(()=>fillQuote(0n,1n,4,0n,20_000_000_000n),/CURVE_RESERVE_NOT_EMPTY/);
  assert.throws(()=>fillQuote(0n,0n,10,0n,20_000_000_000n),/SUPPORT_SLOTS_EXHAUSTED/);
  assert.throws(()=>fillQuote(0n,0n,4,95_000_000_001n,20_000_000_000n),/SUPPORT_BUDGET_INSUFFICIENT/);
  assert.throws(()=>fillQuote(0n,0n,4,0n,11_101_999_999n),/ACTUAL_SUPPORT_BALANCE_INSUFFICIENT/);
});
