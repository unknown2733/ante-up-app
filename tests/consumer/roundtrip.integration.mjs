import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsumerHistoryAdapter } from '../../services/api/src/consumer-history.ts';
import { ConsumerNoteService, createConsumerSocialProjection, createFinalizedFreeActionLookup } from '../../services/api/src/consumer-social.ts';
import { consumerLiveNamespace, consumerFreeActionId } from '../../contracts/consumer-identity.ts';
import { auditConsumerSnapshot } from '../../apps/web/qa/consumer/audit.mjs';

const now = 1_800_000_000_000;
const namespace = consumerLiveNamespace('devnet', 'ProgramQA');
const market = { id: 'market-qa', keyword: 'solana', phase: 'CURVE', price: { kind: 'curve', atoms: '1250000', executable: true } };
const entryAt = now - 3_600_000;
const exitAt = now - 600_000;
const snapshot = (sequence, atMs, numerator) => ({ finality: 'finalized', payloadHash: `hash-${sequence}`,
  payload: { marketId: market.id, sequence, dataThrough: atMs / 1000, dataStatus: 'VALID', activityNowQ12: numerator, activity7dQ12: '1000000000000' } });
const entry = snapshot('1', entryAt, '2000000000000');
const exit = snapshot('2', exitAt, '1800000000000');
const record = { id: 'record-qa', wallet: 'WalletQA', marketId: market.id, direction: 'up', finality: 'finalized', proofId: null,
  entry: { executedAt: entryAt / 1000, slot: '1', signature: 'entry-sig', snapshot: { marketId: market.id, sequence: '1', payloadHash: 'hash-1' }, h: null, unavailableReason: null },
  exit: { executedAt: exitAt / 1000, slot: '2', signature: 'exit-sig', snapshot: { marketId: market.id, sequence: '2', payloadHash: 'hash-2' }, h: null, unavailableReason: null },
  status: 'CLOSED_RESULT', result: { kind: 'return', numerator: '-1', denominator: '10' } };

class MemoryNotes {
  #notes = new Map();
  #versions = new Map();
  async read(id) { return this.#notes.get(id) ?? null; }
  async revisions(id) { return this.#versions.get(id) ?? []; }
  async write(next, expectedVersion) {
    if ((this.#notes.get(next.actionId)?.version ?? 0) !== expectedVersion) throw new Error('stale note');
    this.#notes.set(next.actionId, next);
    this.#versions.set(next.actionId, [...(this.#versions.get(next.actionId) ?? []), { ...next, revisedAtMs: next.updatedAtMs }]);
    return next;
  }
}

test('finalized chart marker → public profile → versioned note → chart roundtrip', async () => {
  const notes = new MemoryNotes();
  const actions = createFinalizedFreeActionLookup(async () => [record], namespace);
  let clock = now - 300_000;
  const noteService = new ConsumerNoteService(actions, notes, () => clock);
  const id = consumerFreeActionId(namespace, record.id, 'open');
  assert.equal((await actions.getFinalizedFreeAction(id))?.wallet, 'WalletQA');
  await assert.rejects(noteService.save({ actionId: id, authenticatedWallet: 'OtherWallet', body: 'Wrong owner', expectedVersion: 0 }));
  const first = await noteService.save({ actionId: id, authenticatedWallet: 'WalletQA', body: 'Attention was rising', expectedVersion: 0 });
  clock += 1000;
  const edited = await noteService.save({ actionId: id, authenticatedWallet: 'WalletQA', body: 'I revised this later', expectedVersion: 1 });
  assert.equal(edited.createdAtMs, first.createdAtMs);
  assert.equal(edited.version, 2);
  assert.equal((await noteService.read(id)).revisions.length, 2);
  assert.equal(edited.proofCoverage, 'NONE');

  const history = createConsumerHistoryAdapter({ namespace, market: async key => key === market.id ? market : null,
    snapshots: async () => [entry, exit], records: async () => [record], priceObservations: async () => [],
    noteForAction: async actionId => (await noteService.read(actionId)).note, nowMs: () => now });
  const social = createConsumerSocialProjection({ namespace, records: async () => [record], heldWallets: async () => new Set(),
    notes, clockMs: () => now });
  const day = await history.getHistory(market.id, '1D');
  const all = await history.getHistory(market.id, 'ALL');
  const profile = await social.getProfile('WalletQA');
  const board = await social.getLeaderboard('ALL');
  const marker = day.actions.find(action => action.id === id);
  assert.ok(marker, JSON.stringify(day.actions.map(action => action.id)));
  const profileAction = profile.actions.find(action => action.id === marker.id);
  assert.equal(marker.seriesId, `${market.id}:attention`);
  assert.equal(marker.value, '2.000000');
  assert.equal(profileAction.seriesId, null);
  assert.equal(profileAction.value, null);
  assert.equal(profileAction.marketId, marker.marketId);
  assert.equal(profileAction.atMs, marker.atMs);
  assert.deepEqual(profileAction.note, marker.note);
  assert.equal((await noteService.read(profileAction.id)).note.body, 'I revised this later');
  assert.equal(profile.meanReturnFraction, -0.1);
  assert.equal(board.rows[0].meanReturnFraction, -0.1);
  assert.deepEqual(auditConsumerSnapshot({ markets: [day.market], histories: [day, all], profiles: [profile], leaderboards: [board] }), []);
});
