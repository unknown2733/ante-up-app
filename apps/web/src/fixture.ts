import { FORMULA_VERSION } from '../../../contracts/types';
import type { Action, Capability, Envelope, FreeRecord, LeaderboardPage, MarketView, ProofStatus, PublicProfile, PublishedSnapshot, RecordPoint } from '../../../contracts/types';
import type { MarketApi, Period } from './model';
import { DEMO_WALLET } from './wallet';

const now = Math.floor(Date.now() / 1000);
const currentTime = () => Math.floor(Date.now() / 1000);
const hash = 'a'.repeat(64);
const snapshot = (marketId: string, sequence: string) => ({ marketId, sequence, payloadHash: hash });
const point = (marketId: string, age: number, sequence: string, h: [string, string] | null, reason: string | null = null): RecordPoint => ({
  executedAt: currentTime() - age, slot: '123456', signature: `fixture-${marketId}-${sequence}`,
  snapshot: h ? snapshot(marketId, sequence) : null,
  h: h ? { numerator: h[0], denominator: h[1] } : null,
  unavailableReason: reason,
});
const cap = (allowed: boolean, reason: Capability['reason'] = null): Capability => ({ allowed, reason });
const published: PublishedSnapshot = {
  payload: {
    schemaVersion: '0.1', formulaVersion: FORMULA_VERSION, configVersion: '1', queryVersion: '1', queryHash: hash,
    admission: { state: 'OPEN', recoveryCount: 2, reason: null },
    marketId: 'm-attention', sequence: '101', dataThrough: now - 60, computedAt: now - 50,
    activityNowQ12: '150000000000000', activity7dQ12: '100000000000000', dataStatus: 'VALID', reason: null, evidenceHash: hash,
  },
  payloadHash: hash, chain: { cluster: 'localnet', programId: 'FIXTURE_NOT_A_PROGRAM', address: 'FIXTURE_NOT_AN_ADDRESS' },
  signature: 'fixture-only-snapshot', slot: '123456', publishedAt: now - 40, finality: 'finalized',
};

const markets: MarketView[] = [
  {
    id: 'm-attention', keyword: 'attention', aliases: ['the attention'], phase: 'INDEXED', dataStatus: 'VALID', epochPhase: 'PRO_OPEN', supported: true,
    chain: null, snapshot: published, anchor: { graduationPriceAtoms: '1200000', graduationNowQ12: '1250000000000000', graduation7dQ12: '1000000000000000', maxPriceAtoms: '4800000' },
    price: { kind: 'indexed', atoms: '1440000', executable: false },
    capabilities: { openFree: cap(true), closeFree: cap(true), spotBuy: cap(false, 'PENDING_CONFIRMATION'), spotSell: cap(false, 'PENDING_CONFIRMATION'), openPro: cap(false, 'PENDING_CONFIRMATION') },
  },
  {
    id: 'm-meme', keyword: 'meme', aliases: [], phase: 'INDEXED', dataStatus: 'LOW_ACTIVITY', epochPhase: 'OPEN_CUTOFF', supported: true,
    chain: null, snapshot: null, anchor: { graduationPriceAtoms: '950000', graduationNowQ12: '1000000000000000', graduation7dQ12: '1000000000000000', maxPriceAtoms: '4750000' },
    price: { kind: 'indexed', atoms: '720000', executable: false },
    capabilities: { openFree: cap(true), closeFree: cap(true), spotBuy: cap(false, 'LOW_ACTIVITY'), spotSell: cap(false, 'PENDING_CONFIRMATION'), openPro: cap(false, 'LOW_ACTIVITY') },
  },
  {
    id: 'm-outage', keyword: 'outage', aliases: [], phase: 'INDEXED', dataStatus: 'OUTAGE', epochPhase: 'SETTLING', supported: true,
    chain: null, snapshot: null, anchor: null, price: null,
    capabilities: { openFree: cap(true), closeFree: cap(true), spotBuy: cap(false, 'DATA_STALE'), openPro: cap(false, 'DATA_STALE') },
  },
  {
    id: 'm-signal', keyword: 'signal', aliases: [], phase: 'CURVE', dataStatus: 'PREPARING', epochPhase: null, supported: false,
    chain: null, snapshot: null, anchor: null, price: { kind: 'curve', atoms: '1080000', executable: false },
    capabilities: { openFree: cap(true), closeFree: cap(true), curveBuy: cap(false, 'DATA_NOT_READY'), openPro: cap(false, 'WRONG_PHASE') },
  },
  {
    id: 'm-wait', keyword: 'moment', aliases: [], phase: 'GRADUATION_WAIT', dataStatus: 'VALID', epochPhase: null, supported: true,
    chain: null, snapshot: null, anchor: null, price: null,
    capabilities: { openFree: cap(true), closeFree: cap(true), curveBuy: cap(false, 'WRONG_PHASE'), spotBuy: cap(false, 'WRONG_PHASE') },
  },
];

const seedRecords: FreeRecord[] = [
  { id: 'fr-open-1', wallet: DEMO_WALLET, marketId: 'm-attention', direction: 'up', entry: point('m-attention', 2 * 86400, '101', ['5', '4']), exit: null, status: 'OPEN', result: null, finality: 'finalized', proofId: null },
  { id: 'fr-win', wallet: DEMO_WALLET, marketId: 'm-meme', direction: 'up', entry: point('m-meme', 6 * 86400, '88', ['5', '4']), exit: point('m-meme', 2 * 86400, '96', ['3', '2']), status: 'CLOSED_RESULT', result: { kind: 'return', numerator: '1', denominator: '5' }, finality: 'finalized', proofId: 'proof-win' },
  { id: 'fr-loss', wallet: DEMO_WALLET, marketId: 'm-signal', direction: 'up', entry: point('m-signal', 12 * 86400, '40', ['4', '5']), exit: point('m-signal', 9 * 86400, '44', ['3', '5']), status: 'CLOSED_RESULT', result: { kind: 'return', numerator: '-1', denominator: '4' }, finality: 'finalized', proofId: 'proof-loss' },
  { id: 'fr-na', wallet: DEMO_WALLET, marketId: 'm-outage', direction: 'up', entry: point('m-outage', 4 * 86400, '77', null, 'No valid metric at entry'), exit: point('m-outage', 3 * 86400, '79', null, 'Closed during a data outage'), status: 'CLOSED_NA', result: { kind: 'na', reason: 'No entry baseline · closed during a data outage' }, finality: 'finalized', proofId: 'proof-na' },
  { id: 'fr-replaced', wallet: 'demo:orbit', marketId: 'm-attention', direction: 'up', entry: point('m-attention', 5 * 86400, '91', ['1', '1']), exit: point('m-attention', 1 * 86400, '99', ['6', '5']), status: 'CLOSED_RESULT', result: { kind: 'return', numerator: '1', denominator: '5' }, finality: 'finalized', proofId: 'proof-replaced' },
  { id: 'fr-error', wallet: 'demo:held', marketId: 'm-attention', direction: 'up', entry: point('m-attention', 4 * 86400, '111', ['1', '1']), exit: point('m-attention', 1 * 86400, '113', ['3', '1']), status: 'CLOSED_RESULT', result: { kind: 'return', numerator: '2', denominator: '1' }, finality: 'finalized', proofId: 'proof-invalid' },
];

const proofs: Record<string, ProofStatus> = {
  'proof-win': { id: 'proof-win', recordId: 'fr-win', payloadHash: hash, manifestRef: { contentHash: hash, arweaveItemId: 'fixture-manifest-1', parentTransactionId: 'fixture-parent-1' }, state: 'ISSUED', evidence: [{ contentHash: hash, arweaveItemId: 'fixture-item-1', parentTransactionId: 'fixture-parent-1' }], confirmations: 20, sasId: 'fixture-sas-1', retryAt: null, error: null, replacementId: null },
  'proof-loss': { id: 'proof-loss', recordId: 'fr-loss', payloadHash: hash, manifestRef: { contentHash: hash, arweaveItemId: 'fixture-manifest-2', parentTransactionId: 'fixture-parent-2' }, state: 'CONFIRMING', evidence: [{ contentHash: hash, arweaveItemId: 'fixture-item-2', parentTransactionId: 'fixture-parent-2' }], confirmations: 8, sasId: null, retryAt: null, error: null, replacementId: null },
  'proof-na': { id: 'proof-na', recordId: 'fr-na', payloadHash: null, manifestRef: null, state: 'QUEUED', evidence: [], confirmations: null, sasId: null, retryAt: now + 300, error: 'Waiting in archive queue', replacementId: null },
  'proof-replaced': { id: 'proof-replaced', recordId: 'fr-replaced', payloadHash: hash, manifestRef: { contentHash: hash, arweaveItemId: 'fixture-old-manifest', parentTransactionId: 'fixture-parent-old' }, state: 'REPLACED', evidence: [], confirmations: 20, sasId: 'fixture-sas-old', retryAt: null, error: 'Display error corrected', replacementId: 'proof-new' },
  'proof-new': { id: 'proof-new', recordId: 'fr-replaced', payloadHash: 'b'.repeat(64), manifestRef: { contentHash: 'b'.repeat(64), arweaveItemId: 'fixture-new-manifest', parentTransactionId: 'fixture-parent-new' }, state: 'ISSUED', evidence: [], confirmations: 20, sasId: 'fixture-sas-new', retryAt: null, error: null, replacementId: null },
  'proof-invalid': { id: 'proof-invalid', recordId: 'fr-error', payloadHash: 'c'.repeat(64), manifestRef: { contentHash: 'c'.repeat(64), arweaveItemId: 'fixture-invalid-manifest', parentTransactionId: 'fixture-parent-invalid' }, state: 'INVALID', evidence: [], confirmations: 20, sasId: 'fixture-sas-invalid', retryAt: null, error: 'Performance calculation under review · ranking held', replacementId: null },
};

const storageKey = 'ante-up-web-fixture-records-v1';
function localRecords(): FreeRecord[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(parsed) ? parsed as FreeRecord[] : [];
  } catch { return []; }
}
function save(records: FreeRecord[]) { localStorage.setItem(storageKey, JSON.stringify(records)); }
function allRecords() {
  const local = localRecords();
  return [...local, ...seedRecords.filter((record) => !local.some((override) => override.id === record.id))];
}
function envelope<T>(data: T): Envelope<T> { return { schemaVersion: '0.1', mode: 'fixture', asOf: now, data, nextCursor: null }; }

const sampleLeaderboard: Record<Period, LeaderboardPage> = {
  '7d': { period: '7d', rows: [
    { rank: 1, wallet: 'demo:orbit', averageReturn: { numerator: '1', denominator: '5' }, closedValidCount: '1', closedNaCount: '0', openCount: '0', status: 'ELIGIBLE', recordIds: ['fr-replaced'] },
    { rank: 1, wallet: DEMO_WALLET, averageReturn: { numerator: '1', denominator: '5' }, closedValidCount: '1', closedNaCount: '1', openCount: '1', status: 'ELIGIBLE', recordIds: ['fr-win'] },
  ], heldWallets: ['demo:held'] },
  all: { period: 'all', rows: [
    { rank: 1, wallet: 'demo:orbit', averageReturn: { numerator: '1', denominator: '5' }, closedValidCount: '1', closedNaCount: '0', openCount: '0', status: 'ELIGIBLE', recordIds: ['fr-replaced'] },
    { rank: 2, wallet: DEMO_WALLET, averageReturn: { numerator: '-1', denominator: '40' }, closedValidCount: '2', closedNaCount: '1', openCount: '1', status: 'ELIGIBLE', recordIds: ['fr-win', 'fr-loss'] },
  ], heldWallets: ['demo:held'] },
};

function profile(wallet: string): PublicProfile {
  const records = allRecords().filter((record) => record.wallet === wallet);
  const hasLocalChanges = wallet === DEMO_WALLET && localRecords().some((record) => record.status !== 'OPEN');
  return {
    wallet,
    openRecords: records.filter((record) => record.status === 'OPEN'),
    closedRecords: records.filter((record) => record.status !== 'OPEN'),
    closedValidCount: String(records.filter((record) => record.status === 'CLOSED_RESULT').length),
    closedNaCount: String(records.filter((record) => record.status === 'CLOSED_NA').length),
    averageReturn: hasLocalChanges ? null : wallet === DEMO_WALLET ? { numerator: '-1', denominator: '40' } : wallet === 'demo:orbit' ? { numerator: '1', denominator: '5' } : null,
    leaderboardStatus: wallet === 'demo:held' ? 'HELD_CALCULATION_ERROR' : records.some((record) => record.status === 'CLOSED_RESULT') ? 'ELIGIBLE' : 'NO_RESULT',
    openPreviews: records.filter((record) => record.status === 'OPEN').map((record) => ({
      recordId: record.id,
      referenceReturn: record.id === 'fr-open-1' ? { numerator: '1', denominator: '5' } : null,
      status: record.id === 'fr-open-1' ? 'REFERENCE' : 'UNAVAILABLE',
      observedAt: record.id === 'fr-open-1' ? published.payload.dataThrough : null,
    })),
  };
}

function getMarket(id: string) { return markets.find((market) => market.id === id) || null; }
function allowed(market: MarketView, action: Action) { return market.capabilities[action]?.allowed === true; }

export const fixtureApi: MarketApi = {
  async listMarkets() { return envelope(markets); },
  async getMarket(id) { return envelope(getMarket(id)); },
  async getProfile(wallet) { return envelope(profile(wallet)); },
  async getRecord(id) { return envelope(allRecords().find((record) => record.id === id) || null); },
  async getProof(id) { return envelope(proofs[id] || null); },
  async getLeaderboard(period) { return envelope(sampleLeaderboard[period]); },
  async openFree(wallet, marketId) {
    const market = getMarket(marketId);
    if (!market || !allowed(market, 'openFree')) return { kind: 'notExecutable', reason: 'Free participation is currently unavailable for this market.' };
    const records = allRecords().filter((record) => record.wallet === wallet);
    const open = records.filter((record) => record.status === 'OPEN');
    if (open.length >= 3) return { kind: 'notExecutable', reason: 'You can have up to three open free chips at once.' };
    if (open.some((record) => record.marketId === marketId)) return { kind: 'notExecutable', reason: 'You can have only one open chip in the same market.' };
    if (localRecords().filter((record) => record.wallet === wallet && record.entry.executedAt > currentTime() - 86400).length >= 6) return { kind: 'notExecutable', reason: 'The demo session limit of six new chips in a rolling 24-hour period has been reached.' };
    const record: FreeRecord = {
      id: `fixture-${crypto.randomUUID()}`, wallet, marketId, direction: 'up',
      entry: point(marketId, 0, 'fixture', market.dataStatus === 'VALID' ? ['6', '5'] : market.dataStatus === 'LOW_ACTIVITY' ? ['4', '5'] : null, market.dataStatus === 'OUTAGE' ? 'Data outage' : market.dataStatus === 'PREPARING' ? 'Metric preparing' : null),
      exit: null, status: 'OPEN', result: null, finality: 'finalized', proofId: null,
    };
    save([record, ...localRecords()]);
    return { kind: 'fixture', record };
  },
  async closeFree(wallet, recordId) {
    const records = localRecords();
    const seed = seedRecords.find((record) => record.id === recordId);
    const current = records.find((record) => record.id === recordId) || seed;
    if (!current || current.wallet !== wallet || current.status !== 'OPEN') return { kind: 'notExecutable', reason: 'You can close only your own open record.' };
    const market = getMarket(current.marketId);
    if (!market || !allowed(market, 'closeFree')) return { kind: 'notExecutable', reason: 'This record cannot be closed right now.' };
    // A fixture outcome, not a client-side implementation of the h performance formula.
    const valid = current.entry.h !== null && market.dataStatus !== 'OUTAGE' && market.dataStatus !== 'PREPARING';
    const exitH: [string, string] = current.id === 'fr-open-1' ? ['3', '2'] : market.dataStatus === 'LOW_ACTIVITY' ? ['24', '25'] : ['36', '25'];
    const closed: FreeRecord = {
      ...current, exit: point(current.marketId, 0, 'fixture-exit', valid ? exitH : null, valid ? null : 'No valid exit metric'),
      status: valid ? 'CLOSED_RESULT' : 'CLOSED_NA',
      result: valid ? { kind: 'return', numerator: '1', denominator: '5' } : { kind: 'na', reason: market.dataStatus === 'OUTAGE' ? 'Closed during a data outage' : 'No valid entry or exit baseline' },
      proofId: null,
    };
    save([closed, ...records.filter((record) => record.id !== recordId)]);
    return { kind: 'fixture', record: closed };
  },
};
