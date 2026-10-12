import { FORMULA_VERSION, type FreeRecord, type MarketView, type ProofStatus, type PublishedSnapshot, type RecordPoint } from '../../../contracts/types.ts';
import { validateMarket, validateRecord } from './validate.ts';

const hash = 'a'.repeat(64);
const wallet = { alice: 'FixtureAlice', bob: 'FixtureBob', carol: 'FixtureCarol', held: 'FixtureHeld' };
const snapshot: PublishedSnapshot = {
  payload: { schemaVersion: '0.1', formulaVersion: FORMULA_VERSION, configVersion: '1', queryVersion: '1', queryHash: hash,
    admission: { state: 'BLOCKED', recoveryCount: 0, reason: 'PENDING_CONFIRMATION' },
    marketId: 'fixture:sol', sequence: '3', dataThrough: 1791763200, computedAt: 1791763260,
    activityNowQ12: '150000000000000', activity7dQ12: '100000000000000', dataStatus: 'VALID', reason: null, evidenceHash: hash },
  payloadHash: hash, chain: { cluster: 'localnet', programId: 'FIXTURE_NOT_A_PROGRAM', address: 'FIXTURE_NOT_AN_ADDRESS' },
  signature: 'fixture-only-snapshot', slot: '3', publishedAt: 1791763260, finality: 'finalized'
};

export const fixtureMarkets: MarketView[] = [
  { id: 'fixture:sol', keyword: 'solana', aliases: [], phase: 'INDEXED', dataStatus: 'VALID', epochPhase: 'PRO_OPEN',
    supported: true, chain: null, snapshot, anchor: { graduationPriceAtoms: '1200000', graduationNowQ12: '125000000000000', graduation7dQ12: '100000000000000', maxPriceAtoms: '4800000' },
    price: { kind: 'indexed', atoms: '1440000', executable: false }, capabilities: { openFree: { allowed: false, reason: 'PENDING_CONFIRMATION' }, closeFree: { allowed: false, reason: 'PENDING_CONFIRMATION' }, openPro: { allowed: false, reason: 'PENDING_CONFIRMATION' } } },
  { id: 'fixture:unready', keyword: 'unready', aliases: [], phase: 'CURVE', dataStatus: 'PREPARING', epochPhase: null,
    supported: false, chain: null, snapshot: null, anchor: null, price: null,
    capabilities: { openFree: { allowed: false, reason: 'PENDING_CONFIRMATION' }, closeFree: { allowed: false, reason: 'PENDING_CONFIRMATION' }, openPro: { allowed: false, reason: 'DATA_NOT_READY' } } }
];

const point = (executedAt: number, h: [string, string] | null, tag: string): RecordPoint => ({
  executedAt, slot: String(executedAt), signature: `fixture-${tag}`,
  snapshot: h ? { marketId: 'fixture:sol', sequence: '3', payloadHash: hash } : null,
  h: h ? { numerator: h[0], denominator: h[1] } : null,
  unavailableReason: h ? null : 'DATA_NOT_READY'
});
const closed = (id: string, owner: string, exitAt: number, result: FreeRecord['result'], entryH: [string,string] | null, exitH: [string,string] | null): FreeRecord => ({
  id, wallet: owner, marketId: 'fixture:sol', direction: 'up', entry: point(exitAt - 86400, entryH, `${id}-entry`),
  exit: point(exitAt, exitH, `${id}-exit`), status: result?.kind === 'return' ? 'CLOSED_RESULT' : 'CLOSED_NA', result, finality: 'finalized',
  proofId: id === 'fixture:alice-win' ? 'fixture:proof-alice-v1' : id === 'fixture:bob-loss' ? 'fixture:proof-bob' : null
});
const open = (id: string, owner: string, at: number, h: [string,string]): FreeRecord => ({
  id, wallet: owner, marketId: 'fixture:sol', direction: 'up', entry: point(at, h, `${id}-entry`), exit: null,
  status: 'OPEN', result: null, finality: 'finalized', proofId: null
});

// Relative timestamps keep the 7-day filter meaningful whenever the fixture server is run.
export function fixtureRecords(asOf: number): FreeRecord[] {
  return [
    closed('fixture:alice-win', wallet.alice, asOf - 3600, { kind: 'return', numerator: '1', denominator: '5' }, ['5','4'], ['3','2']),
    closed('fixture:alice-loss', wallet.alice, asOf - 20 * 86400, { kind: 'return', numerator: '-1', denominator: '2' }, ['1','1'], ['1','2']),
    closed('fixture:bob-loss', wallet.bob, asOf - 7200, { kind: 'return', numerator: '-1', denominator: '4' }, ['1','1'], ['3','4']),
    closed('fixture:bob-na', wallet.bob, asOf - 3000, { kind: 'na', reason: 'DATA_NOT_READY' }, null, null),
    open('fixture:carol-open', wallet.carol, asOf - 300, ['5','4']),
    closed('fixture:held', wallet.held, asOf - 4000, { kind: 'return', numerator: '9', denominator: '1' }, ['1','1'], ['10','1'])
  ].map(validateRecord);
}

for (const market of fixtureMarkets) validateMarket(market);
export const heldCalculationWallets = new Set([wallet.held]);

const queued = (id: string, recordId: string): ProofStatus => ({ id, recordId, payloadHash: null, manifestRef: null,
  state: 'QUEUED', evidence: [], confirmations: null, sasId: null, retryAt: null, error: null, replacementId: null });
export const fixtureProofs: ProofStatus[] = [
  { ...queued('fixture:proof-alice-v1', 'fixture:alice-win'), state: 'REPLACED', error: 'Synthetic replacement example', replacementId: 'fixture:proof-alice-v2' },
  queued('fixture:proof-alice-v2', 'fixture:alice-win'),
  queued('fixture:proof-bob', 'fixture:bob-loss')
];
