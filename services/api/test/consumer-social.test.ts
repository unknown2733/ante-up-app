import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { consumerFreeActionId, consumerLiveNamespace, parseConsumerFreeActionId } from '../../../contracts/consumer-identity.ts';
import type { FreeRecord } from '../../../contracts/types.ts';
import { ConsumerNoteService, NoteError, SqliteNotePersistence, createConsumerNoteRoutes, createConsumerSocialProjection,
  createFinalizedFreeActionLookup, freeActionId, noteCodePoints } from '../src/consumer-social.ts';

const namespace = consumerLiveNamespace('devnet', 'test-program');
const actionId = (recordId: string, kind: 'open' | 'close') => freeActionId(namespace, recordId, kind);
const record = (finality: FreeRecord['finality'] = 'finalized'): FreeRecord => ({
  id: 'free-1', wallet: 'OwnerWallet', marketId: 'market-1', direction: 'up',
  entry: { executedAt: 1_000, slot: '1', signature: 'entry', h: null, snapshot: null, unavailableReason: null },
  exit: { executedAt: 1_100, slot: '2', signature: 'exit', h: null, snapshot: null, unavailableReason: null },
  status: 'CLOSED_NA', result: { kind: 'na', reason: 'DATA_NOT_READY' }, finality, proofId: null
});

test('finalized free action lookup exposes only open/close, never an unfinalized action', async () => {
  const finalized = createFinalizedFreeActionLookup(async () => [record()], namespace);
  assert.deepEqual(await finalized.getFinalizedFreeAction(actionId('free-1', 'open')), {
    id: actionId('free-1', 'open'), recordId: 'free-1', wallet: 'OwnerWallet', atMs: 1_000_000,
    finality: 'finalized', kind: 'CALL_OPEN'
  });
  assert.equal((await finalized.getFinalizedFreeAction(actionId('free-1', 'close')))?.atMs, 1_100_000);
  assert.equal(await finalized.getFinalizedFreeAction('devnet:test-program:free-1:buy'), null);
  assert.equal(await finalized.getFinalizedFreeAction('localnet:test-program:free-1:open'), null);
  assert.equal(await finalized.getFinalizedFreeAction('devnet:test-program:free-1:open:extra'), null);
  assert.equal(await finalized.getFinalizedFreeAction('devnet:test-program:free-1:open:close'), null);
  assert.equal(await createFinalizedFreeActionLookup(async () => [record('confirmed')], namespace).getFinalizedFreeAction(actionId('free-1', 'open')), null);
});

test('wallet ownership, Unicode length, server time, revisions and durable reload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ante-social-'));
  const path = join(directory, 'notes.sqlite');
  let store = new SqliteNotePersistence(path);
  const actions = createFinalizedFreeActionLookup(async () => [record()], namespace);
  let now = 1_200_000;
  const service = new ConsumerNoteService(actions, store, () => now);
  try {
    await assert.rejects(service.save({ actionId: actionId('free-1', 'open'), authenticatedWallet: 'OtherWallet', body: 'No', expectedVersion: 0 }),
      (error: unknown) => error instanceof NoteError && error.code === 'UNAUTHORIZED');
    assert.equal(noteCodePoints('😀'), 1);
    await assert.rejects(service.save({ actionId: actionId('free-1', 'open'), authenticatedWallet: 'OwnerWallet', body: '😀'.repeat(281), expectedVersion: 0 }),
      (error: unknown) => error instanceof NoteError && error.code === 'INVALID_INPUT');
    const first = await service.save({ actionId: actionId('free-1', 'open'), authenticatedWallet: 'OwnerWallet', body: 'Saw rising interest', expectedVersion: 0 });
    assert.equal(first.timing, 'ADDED_LATER');
    assert.equal(first.createdAtMs, 1_200_000);
    assert.equal(first.proofCoverage, 'NONE');
    now += 500;
    const second = await service.save({ actionId: actionId('free-1', 'open'), authenticatedWallet: 'OwnerWallet', body: 'Revised view', expectedVersion: 1 });
    assert.equal(second.version, 2);
    assert.equal(second.createdAtMs, first.createdAtMs);
    assert.equal(second.updatedAtMs, now);
    await assert.rejects(service.save({ actionId: actionId('free-1', 'open'), authenticatedWallet: 'OwnerWallet', body: 'Stale', expectedVersion: 1 }),
      (error: unknown) => error instanceof NoteError && error.code === 'ALREADY_EXECUTED');
    store.close();
    store = new SqliteNotePersistence(path);
    assert.equal((await store.read(actionId('free-1', 'open')))?.body, 'Revised view');
    assert.deepEqual((await store.revisions(actionId('free-1', 'open'))).map(item => item.body), ['Saw rising interest', 'Revised view']);
    const reopenedService = new ConsumerNoteService(actions, store, () => now);
    const concurrent = await Promise.allSettled([
      reopenedService.save({ actionId: actionId('free-1', 'close'), authenticatedWallet: 'OwnerWallet', body: 'First', expectedVersion: 0 }),
      reopenedService.save({ actionId: actionId('free-1', 'close'), authenticatedWallet: 'OwnerWallet', body: 'Second', expectedVersion: 0 })
    ]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = concurrent.find(result => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(rejected.reason instanceof NoteError);
    assert.equal(rejected.reason.code, 'ALREADY_EXECUTED');
    const closeRevisions = await store.revisions(actionId('free-1', 'close'));
    assert.equal(closeRevisions.length, 1);
    assert.equal((await store.read(actionId('free-1', 'close')))?.body, closeRevisions[0].body);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('same record IDs are isolated across programs and profile/chart note IDs roundtrip', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ante-social-identity-'));
  const store = new SqliteNotePersistence(join(directory, 'notes.sqlite'));
  const otherNamespace = consumerLiveNamespace('devnet', 'OtherProgram');
  const first = new ConsumerNoteService(createFinalizedFreeActionLookup(async () => [record()], namespace), store, () => 1_200_000);
  const other = new ConsumerNoteService(createFinalizedFreeActionLookup(async () => [record()], otherNamespace), store, () => 1_300_000);
  try {
    const a = actionId('free-1', 'open');
    const b = consumerFreeActionId(otherNamespace, 'free-1', 'open');
    assert.deepEqual(parseConsumerFreeActionId(namespace, a), { recordId: 'free-1', side: 'open' });
    assert.equal(parseConsumerFreeActionId(namespace, b), null);
    await first.save({ actionId: a, authenticatedWallet: 'OwnerWallet', body: 'Program A', expectedVersion: 0 });
    await other.save({ actionId: b, authenticatedWallet: 'OwnerWallet', body: 'Program B', expectedVersion: 0 });
    assert.equal((await first.read(b)).note, null);
    assert.equal((await first.read(a)).note?.body, 'Program A');
    assert.equal((await other.read(b)).note?.body, 'Program B');
    const projection = createConsumerSocialProjection({ records: async () => [record()], heldWallets: async () => new Set(),
      notes: store, namespace, clockMs: () => 1_400_000 });
    const profile = await projection.getProfile('OwnerWallet');
    assert.ok(profile);
    const profileAction = profile.actions.find(action => action.kind === 'CALL_OPEN');
    assert.ok(profileAction);
    assert.equal(profileAction.id, consumerFreeActionId(namespace, record().id, 'open'));
    // Chart history uses the same shared ID; its noteForAction callback resolves the profile note.
    assert.equal((await first.read(profileAction.id)).note?.body, profileAction.note?.body);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP route requires authenticated owner and keeps public read wallet free', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ante-social-route-'));
  const store = new SqliteNotePersistence(join(directory, 'notes.sqlite'));
  const service = new ConsumerNoteService(createFinalizedFreeActionLookup(async () => [record()], namespace), store, () => 1_200_000);
  const route = createConsumerNoteRoutes(service, async (request, wallet) => request.headers.get('authorization') === 'Bearer ' + wallet);
  try {
    const url = 'https://example.test/v1/consumer/notes/' + encodeURIComponent(actionId('free-1', 'open'));
    const put = (wallet: string, token: string) => new Request(url, { method: 'PUT', headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify({ wallet, body: 'A thought', expectedVersion: 0 }) });
    assert.equal((await route(put('OwnerWallet', 'bad')))?.status, 403);
    assert.equal((await route(put('OtherWallet', 'OtherWallet')))?.status, 403);
    assert.equal((await route(put('OwnerWallet', 'OwnerWallet')))?.status, 200);
    const publicRead = await route(new Request(url));
    assert.equal(publicRead?.status, 200);
    assert.equal((await publicRead?.json()).note.body, 'A thought');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('public projection uses existing seven-day valid-close average and exposes N/A/open history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ante-social-read-'));
  const store = new SqliteNotePersistence(join(directory, 'notes.sqlite'));
  const nowMs = 10 * 86_400_000;
  const valid: FreeRecord = { ...record(), id: 'profit', wallet: 'Alpha', status: 'CLOSED_RESULT',
    entry: { ...record().entry, executedAt: 9 * 86_400 },
    exit: { ...record().exit!, executedAt: 9 * 86_400 + 100 },
    result: { kind: 'return', numerator: '1', denominator: '2' } };
  const loss: FreeRecord = { ...valid, id: 'loss', wallet: 'Beta', result: { kind: 'return', numerator: '-1', denominator: '4' } };
  const na: FreeRecord = { ...valid, id: 'na', wallet: 'Alpha', status: 'CLOSED_NA', result: { kind: 'na', reason: 'DATA_NOT_READY' } };
  const open: FreeRecord = { ...valid, id: 'open', wallet: 'Alpha', status: 'OPEN', exit: null, result: null };
  const old: FreeRecord = { ...valid, id: 'old', wallet: 'Alpha', exit: { ...valid.exit!, executedAt: 1 }, result: { kind: 'return', numerator: '-1', denominator: '1' } };
  const projection = createConsumerSocialProjection({ records: async () => [valid, loss, na, open, old],
    heldWallets: async () => new Set(), notes: store, namespace, clockMs: () => nowMs });
  try {
    const week = await projection.getLeaderboard('7D');
    assert.deepEqual(week.rows.map(row => [row.actorId, row.meanReturnFraction, row.closedCallCount]), [
      ['Alpha', 0.5, 1], ['Beta', -0.25, 1]
    ]);
    const all = await projection.getLeaderboard('ALL');
    assert.equal(all.rows.find(row => row.actorId === 'Alpha')?.meanReturnFraction, -0.25);
    const profile = await projection.getProfile('Alpha');
    assert.ok(profile);
    assert.equal(profile.closedCallCount, 2);
    assert.equal(profile.openCallCount, 1);
    assert.equal(profile.actions.find(action => action.id === actionId('na', 'close'))?.returnFraction, null);
    assert.equal(profile.actions.find(action => action.id === actionId('open', 'open'))?.kind, 'CALL_OPEN');
    assert.equal(profile.actions.every(action => action.kind === 'CALL_OPEN' || action.kind === 'CALL_CLOSE'), true);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
