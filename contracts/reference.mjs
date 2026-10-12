// Exact BigInt reference for cross-language vectors, NOT a transaction engine.
export const UNIT = 1_000_000n;
export const Q12 = 1_000_000_000_000n;
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
export function ceilDiv(n, d) { requireValue(n >= 0n && d > 0n, 'INVALID_INPUT'); return (n + d - 1n) / d; }
export function indexPrice(pg, sg, dg, s, d) {
  requireValue(pg > 0n && sg > 0n && dg > 0n && sg < 5n * dg && s >= 0n && d > 0n, 'INVALID_DENOMINATOR');
  const capped = s > 5n * d ? 5n * d : s;
  const price = pg * dg * capped / (sg * d);
  requireValue(s === 0n || price > 0n, 'PRECISION_UNDERFLOW');
  return { price, maximum: ceilDiv(pg * dg * 5n, sg) };
}
export function curveGross(q0, q1, side) {
  requireValue(q0 >= 0n && q1 >= 0n && q0 <= 1000n * UNIT && q1 <= 1000n * UNIT, 'INVALID_INPUT');
  requireValue(side === 'buy' ? q1 > q0 : side === 'sell' && q0 > q1, 'INVALID_INPUT');
  const lo = q0 < q1 ? q0 : q1, hi = q0 > q1 ? q0 : q1;
  const den = 10_000n * UNIT;
  const num = (hi - lo) * den + hi * hi - lo * lo;
  return side === 'buy' ? ceilDiv(num, den) : num / den;
}
export function pro(c, leverageBps, p0, p, maximum, direction) {
  requireValue(c > 0n && leverageBps >= 10_000n && leverageBps <= 50_000n && p0 > 0n && p0 <= maximum && p >= 0n && p <= maximum, 'INVALID_INPUT');
  requireValue(direction === 'long' || direction === 'short', 'INVALID_INPUT');
  const n = c * leverageBps / 10_000n;
  const sign = direction === 'long' ? 1n : -1n;
  const numerator = c * p0 + sign * n * (p - p0);
  const payout = numerator > 0n ? numerator / p0 : 0n;
  const reserve = direction === 'long' ? ceilDiv(c * p0 + n * (maximum - p0), p0) : c + n;
  return { notional: n, payout, reserve, capital: reserve - c };
}
export function tradeFee(gross) {
  const total = ceilDiv(gross * 10n, 10_000n);
  const protocol = total * 20n / 100n;
  return { total, protocol, vault: total - protocol };
}
export function timeFee(capital, notional, duration, elapsed) {
  requireValue(capital >= 0n && notional >= 0n && duration >= 0n && elapsed >= 0n, 'INVALID_INPUT');
  const den = 10_000n * 86_400n;
  const charge = (base, bps) => {
    const prepaid = ceilDiv(base * bps * duration, den);
    const earned = elapsed >= duration ? prepaid : base * bps * elapsed / den;
    return { prepaid, earned, refund: prepaid - earned };
  };
  const a = charge(capital, 2n), b = charge(notional, 5n);
  return { prepaid: a.prepaid + b.prepaid, earned: a.earned + b.earned, refund: a.refund + b.refund };
}
export function freeCapital(a, q, pmax, rp, h, buffer) { return a - ceilDiv(q * pmax, UNIT) - rp - h - buffer; }
export function freeReturn(entryNum, entryDen, exitNum, exitDen) {
  requireValue(entryNum > 0n && entryDen > 0n && exitNum >= 0n && exitDen > 0n, 'INVALID_DENOMINATOR');
  return { numerator: exitNum * entryDen - entryNum * exitDen, denominator: exitDen * entryNum };
}
