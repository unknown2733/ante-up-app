import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UNIT, indexPrice, curveGross, pro, tradeFee, timeFee, freeCapital, freeReturn } from './reference.mjs';
const vectors = JSON.parse(readFileSync(new URL('./fixtures/golden.json', import.meta.url), 'utf8'));
test('full-width price boundaries retain scaled-ratio equivalence', () => {
  const boundaries = JSON.parse(readFileSync(new URL('./fixtures/price-boundaries.json', import.meta.url), 'utf8'));
  for (const v of boundaries) {
    const out = indexPrice(...v.input.map(BigInt));
    assert.equal(out.price.toString(), v.price, v.id);
    assert.equal(out.maximum.toString(), v.maximum, v.id);
  }
});
test('anchor continuity, rising/falling, cap plateau, genuine zero', () => {
  for (const v of vectors.prices) {
    const out = indexPrice(...v.input.map(BigInt));
    assert.equal(out.price.toString(), v.price, v.id); assert.equal(out.maximum.toString(), v.maximum, v.id);
  }
});
test('long and short maximum collateral survives zero mark', () => {
  for (const v of vectors.pro) {
    const out = pro(...v.input.map(BigInt), v.direction);
    for (const key of ['notional', 'payout', 'reserve']) assert.equal(out[key].toString(), v[key], v.id);
  }
});
test('curve integral, split sale conservation and tiny round trips', () => {
  for (const v of vectors.curve) assert.equal(curveGross(BigInt(v.q0), BigInt(v.q1), v.side).toString(), v.gross);
  for (const q of [0n, 1n, 500n * UNIT, 999n * UNIT]) {
    const buy = curveGross(q, q + 1n, 'buy'), sell = curveGross(q + 1n, q, 'sell');
    assert.ok(buy >= sell, 'rounding must not manufacture proceeds');
  }
});
test('fee, prepayment and refund conserved with fixed elapsed duration', () => {
  const trade = tradeFee(500n * UNIT); assert.deepEqual(trade, { total: 500000n, protocol: 100000n, vault: 400000n });
  const timed = timeFee(1500n * UNIT, 500n * UNIT, 4n * 86400n, 86400n);
  assert.deepEqual(timed, { prepaid: 2200000n, earned: 550000n, refund: 1650000n });
  assert.equal(timed.prepaid, timed.earned + timed.refund);
  assert.equal(timeFee(1500n * UNIT, 500n * UNIT, 4n * 86400n, 6n * 86400n).refund, 0n);
});
test('settle-to-claim never releases unpaid money; claim payment preserves free capital', () => {
  const a = 10000n * UNIT, q = 1000n * UNIT, pmax = 4800000n, rp = 1600n * UNIT, h = 1650000n, buffer = 500n * UNIT;
  const before = freeCapital(a, q, pmax, rp, h, buffer);
  const owed = 200n * UNIT;
  const settled = freeCapital(a, q, pmax, 0n, h + owed, buffer);
  const paid = freeCapital(a - owed, q, pmax, 0n, h, buffer);
  assert.equal(settled - before, rp - owed); assert.equal(paid, settled);
  assert.ok(freeCapital(1n, q, pmax, rp, h, buffer) < 0n);
});
test('free performance follows h and does not treat a null/zero denominator as zero return', () => {
  assert.deepEqual(freeReturn(5n, 4n, 3n, 2n), { numerator: 2n, denominator: 10n });
  assert.throws(() => freeReturn(0n, 1n, 1n, 1n));
  assert.throws(() => indexPrice(1200000n, 5n, 4n, 1n, 0n));
  assert.throws(() => indexPrice(1n, 5n, 4n, 1n, 1000000000n), /PRECISION_UNDERFLOW/);
});
