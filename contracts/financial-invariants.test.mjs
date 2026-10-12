import test from 'node:test';
import assert from 'node:assert/strict';
import { UNIT, ceilDiv, indexPrice, curveGross, pro, tradeFee, timeFee, freeCapital } from './reference.mjs';

// Independent acceptance oracle. These are not evidence of token CPI/SBF execution.
const u = n => BigInt(n) * UNIT;
test('graduation cash, debt, fee and locked shares match accepted example', () => {
  const sale = curveGross(0n, u(1000), 'buy');
  const fee = tradeFee(sale);
  const { price, maximum } = indexPrice(1200000n, 125n, 100n, 125n, 100n);
  const reserve = ceilDiv(u(1000) * maximum, UNIT);
  const contribution = reserve + u(500) + u(3000) - sale - fee.vault;
  assert.equal(sale, u(1100));
  assert.equal(fee.protocol, 220000n);
  assert.equal(contribution, 7199120000n);
  const assets = sale + fee.vault + contribution;
  assert.equal(assets, u(8300));
  assert.equal(freeCapital(assets, u(1000), maximum, 0n, 0n, u(500)), u(3000));
  assert.equal(assets - u(1000) * price / UNIT, u(7100));
});

test('split purchase rounding can leave curve cash above the exact graduation integral', () => {
  const first = curveGross(0n, 1n, 'buy');
  const rest = curveGross(1n, u(1000), 'buy');
  assert.equal(first + rest, u(1100) + 1n);
  // Graduation checks q==cap AND backing>=R(cap); equality would strand this market.
  assert.ok(first + rest >= curveGross(0n, u(1000), 'buy'));
});

test('long and short claim cash conserve assets, fees and NAV without releasing unpaid claims', () => {
  for (const [direction, exit, expectedPayout, expectedNav] of [
    ['long', 2400000n, u(600), 5400950000n],
    ['short', 600000n, u(350), 7450750000n],
  ]) {
    const p = pro(u(100), 50000n, 1200000n, exit, 4800000n, direction);
    const fee = tradeFee(p.notional);
    const time = timeFee(p.capital, p.notional, 4n * 86400n, 86400n);
    const a = u(8300) + u(100) + fee.total + time.prepaid;
    const claim = p.payout + time.refund;
    const outstanding = fee.protocol + claim;
    assert.equal(p.payout, expectedPayout);
    const beforePay = freeCapital(a, u(1000), 4800000n, 0n, outstanding, u(500));
    const afterPay = freeCapital(a - claim, u(1000), 4800000n, 0n, fee.protocol, u(500));
    assert.equal(beforePay, afterPay);
    assert.equal(a - claim - fee.protocol - u(1000) * exit / UNIT, expectedNav);
    assert.equal(a - claim - fee.protocol - u(8300), u(100) - p.payout + fee.vault + time.earned);
  }
});

test('alternating endpoints and repeated protected trades consume finite capital; fees do not replace reservation', () => {
  let a = u(8300), rounds = 0, totalTraderProfit = 0n, earned = 0n;
  for (; rounds < 100; rounds++) {
    const direction = rounds % 2 ? 'short' : 'long';
    const entry = direction === 'long' ? 1200000n : 2400000n;
    const exit = direction === 'long' ? 2400000n : 1200000n;
    const p = pro(u(100), 50000n, entry, exit, 4800000n, direction);
    const fee = tradeFee(p.notional), time = timeFee(p.capital, p.notional, 86400n, 60n);
    const nextAssets = a + u(100) + fee.total + time.prepaid;
    const held = fee.protocol + time.prepaid;
    if (freeCapital(nextAssets, u(1000), 4800000n, p.reserve, held, u(500)) < 0n) break;
    // Pay both claimant and protocol. Maximum reservations must survive until settlement.
    a = nextAssets - p.payout - time.refund - fee.protocol;
    totalTraderProfit += p.payout - u(100);
    earned += fee.vault + time.earned;
    assert.ok(freeCapital(a, u(1000), 4800000n, 0n, 0n, u(500)) >= 0n);
    assert.equal(a, u(8300) - totalTraderProfit + earned);
  }
  assert.ok(rounds > 0 && rounds < 100, 'finite reserve must eventually reject profitable repeating entry');
});

test('LP NAV does not subtract reserve twice and pro zero mark retains the recovery reserve', () => {
  const assets = u(8300), q = u(1000), price = 1200000n, maximum = 4800000n;
  const nav = assets - q * price / UNIT;
  const shares = nav, deposit = u(1000), minted = deposit * shares / nav;
  assert.equal(minted, deposit);
  assert.equal(minted * (nav + deposit) / (shares + minted), deposit);
  assert.equal(freeCapital(assets + deposit, q, maximum, 0n, 0n, u(500)), u(4000));
  const zero = pro(u(100), 50000n, price, 0n, maximum, 'long');
  const recovered = pro(u(100), 50000n, price, maximum, maximum, 'long');
  assert.equal(zero.payout, 0n);
  assert.equal(zero.reserve, recovered.reserve);
  assert.equal(recovered.payout, u(1600));
});
