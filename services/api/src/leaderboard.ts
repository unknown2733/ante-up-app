import type { FreeRecord, PublicProfile, LeaderboardEntry, LeaderboardPage } from '../../../contracts/types.ts';

type Rational = { numerator: bigint; denominator: bigint };
const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; };
const reduced = (n: bigint, d: bigint): Rational => {
  if (d <= 0n) throw new Error('INVALID_DENOMINATOR');
  const g = gcd(n, d);
  return { numerator: n / g, denominator: d / g };
};
const add = (a: Rational, b: Rational): Rational => reduced(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
const serial = (r: Rational) => ({ numerator: r.numerator.toString(), denominator: r.denominator.toString() });
const score = (r: FreeRecord): Rational => {
  if (r.result?.kind !== 'return') throw new Error('INVALID_INPUT');
  return reduced(BigInt(r.result.numerator), BigInt(r.result.denominator));
};

export function leaderboard(records: FreeRecord[], period: '7d' | 'all', asOf: number, heldWallets: Set<string> = new Set()): LeaderboardPage {
  const floor = period === '7d' ? asOf - 7 * 86400 : -Infinity;
  const wallets = [...new Set(records.map(r => r.wallet))];
  const rows: LeaderboardEntry[] = [];
  for (const wallet of wallets) {
    if (heldWallets.has(wallet)) continue;
    const mine = records.filter(r => r.wallet === wallet && r.finality === 'finalized');
    const closed = mine.filter(r => r.exit && r.exit.executedAt >= floor && r.exit.executedAt <= asOf);
    const valid = closed.filter(r => r.status === 'CLOSED_RESULT');
    if (!valid.length) continue;
    const total = valid.reduce((acc, r) => add(acc, score(r)), { numerator: 0n, denominator: 1n });
    rows.push({ rank: 0, wallet, status: 'ELIGIBLE', averageReturn: serial(reduced(total.numerator, total.denominator * BigInt(valid.length))),
      closedValidCount: String(valid.length), closedNaCount: String(closed.filter(r => r.status === 'CLOSED_NA').length),
      openCount: String(mine.filter(r => r.status === 'OPEN').length), recordIds: valid.map(r => r.id) });
  }
  rows.sort((a, b) => {
    const left = BigInt(a.averageReturn.numerator) * BigInt(b.averageReturn.denominator);
    const right = BigInt(b.averageReturn.numerator) * BigInt(a.averageReturn.denominator);
    return left === right ? a.wallet.localeCompare(b.wallet) : left > right ? -1 : 1;
  });
  for (let i = 0; i < rows.length; i++) {
    const previous = rows[i - 1];
    rows[i].rank = previous && BigInt(rows[i].averageReturn.numerator) * BigInt(previous.averageReturn.denominator) === BigInt(previous.averageReturn.numerator) * BigInt(rows[i].averageReturn.denominator) ? previous.rank : i + 1;
  }
  return { period, rows, heldWallets: [...heldWallets].sort() };
}

export function profile(records: FreeRecord[], wallet: string, heldWallets: Set<string> = new Set()): PublicProfile {
  const mine = records.filter(r => r.wallet === wallet && r.finality === 'finalized');
  const openRecords = mine.filter(r => r.status === 'OPEN');
  const closedRecords = mine.filter(r => r.status !== 'OPEN');
  const valid = closedRecords.filter(r => r.status === 'CLOSED_RESULT');
  const total = valid.reduce((acc, r) => add(acc, score(r)), { numerator: 0n, denominator: 1n });
  return { wallet, openRecords, closedRecords, closedValidCount: String(valid.length),
    closedNaCount: String(closedRecords.filter(r => r.status === 'CLOSED_NA').length),
    averageReturn: valid.length && !heldWallets.has(wallet) ? serial(reduced(total.numerator, total.denominator * BigInt(valid.length))) : null,
    leaderboardStatus: heldWallets.has(wallet) ? 'HELD_CALCULATION_ERROR' : valid.length ? 'ELIGIBLE' : 'NO_RESULT' };
}
