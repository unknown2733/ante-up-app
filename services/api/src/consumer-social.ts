import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ConsumerAction, ConsumerLeaderboard, ConsumerNote, ConsumerProfile, ConsumerSource } from '../../../contracts/consumer.ts';
import { consumerFreeActionId, parseConsumerFreeActionId } from '../../../contracts/consumer-identity.ts';
import type { FreeRecord } from '../../../contracts/types.ts';
import { leaderboard, profile } from './leaderboard.ts';

export interface FreeActionIdentity {
  id: string;
  recordId: string;
  wallet: string;
  atMs: number;
  finality: 'finalized';
  kind: 'CALL_OPEN' | 'CALL_CLOSE';
}
export interface FreeActionLookup {
  getFinalizedFreeAction(actionId: string): Promise<FreeActionIdentity | null>;
}
/** Compatibility export; the shared contract is the sole identity implementation. */
export const freeActionId = consumerFreeActionId;
/** `namespace:recordId:open|close` points at finalized free records, never a paid trade. */
export function createFinalizedFreeActionLookup(records: () => Promise<FreeRecord[]>, namespace: string): FreeActionLookup {
  consumerFreeActionId(namespace, 'ValidationRecord', 'open');
  return { async getFinalizedFreeAction(actionId) {
    const parsed = parseConsumerFreeActionId(namespace, actionId);
    if (!parsed) return null;
    const record = (await records()).find(item => item.id === parsed.recordId && item.finality === 'finalized');
    if (!record) return null;
    const point = parsed.side === 'open' ? record.entry : record.exit;
    if (!point) return null;
    return { id: actionId, recordId: parsed.recordId, wallet: record.wallet, atMs: point.executedAt * 1000,
      finality: 'finalized', kind: parsed.side === 'open' ? 'CALL_OPEN' : 'CALL_CLOSE' };
  } };
}
export interface NoteRevision extends ConsumerNote { revisedAtMs: number }
export interface NotePersistence {
  read(actionId: string): Promise<ConsumerNote | null>;
  revisions(actionId: string): Promise<NoteRevision[]>;
  /** Must atomically reject a stale expectedVersion and preserve every previous revision. */
  write(next: ConsumerNote, expectedVersion: number): Promise<ConsumerNote>;
}
export class NoteError extends Error {
  readonly code: 'INVALID_INPUT' | 'UNAUTHORIZED' | 'ALREADY_EXECUTED' | 'DATA_NOT_READY';
  constructor(code: NoteError['code'], message: string) { super(message); this.code = code; }
}

export const noteCodePoints = (body: string): number => [...body].length;

const displayRatio = (ratio: { numerator: string; denominator: string } | null): number | null => {
  if (!ratio) return null;
  const result = Number(ratio.numerator) / Number(ratio.denominator);
  return Number.isFinite(result) ? result : null;
};
const requiredDisplayRatio = (ratio: { numerator: string; denominator: string }): number => {
  const result = displayRatio(ratio);
  if (result === null) throw new NoteError('DATA_NOT_READY', 'Rank return cannot be displayed.');
  return result;
};
const actorLabel = (wallet: string) => wallet.length > 18 ? wallet.slice(0, 7) + '…' + wallet.slice(-5) : wallet;

/** Additive read projection. Existing rational leaderboard math remains authoritative. */
export function createConsumerSocialProjection(input: {
  records: () => Promise<FreeRecord[]>;
  heldWallets: () => Promise<Set<string>>;
  notes: NotePersistence;
  namespace: string;
  clockMs?: () => number;
  label?: string;
}): Pick<import('../../../contracts/consumer.ts').ConsumerReadApi, 'getProfile' | 'getLeaderboard'> {
  consumerFreeActionId(input.namespace, 'ValidationRecord', 'open');
  const clockMs = input.clockMs ?? Date.now;
  const source = (): ConsumerSource => ({ mode: 'LIVE', label: input.label ?? 'Live Devnet', asOfMs: clockMs() });
  const actionsFor = async (record: FreeRecord, origin: ConsumerSource): Promise<ConsumerAction[]> => {
    const common = { marketId: record.marketId, actorId: record.wallet, actorLabel: actorLabel(record.wallet),
      seriesId: null, value: null, recordId: record.id, source: origin };
    const openedId = freeActionId(input.namespace, record.id, 'open');
    const actions: ConsumerAction[] = [{ ...common, id: openedId, kind: 'CALL_OPEN', atMs: record.entry.executedAt * 1000,
      returnFraction: null, note: await input.notes.read(openedId) }];
    if (record.exit) {
      const closedId = freeActionId(input.namespace, record.id, 'close');
      actions.push({ ...common, id: closedId, kind: 'CALL_CLOSE', atMs: record.exit.executedAt * 1000,
        returnFraction: record.status === 'CLOSED_RESULT' && record.result?.kind === 'return' ? displayRatio(record.result) : null,
        note: await input.notes.read(closedId) });
    }
    return actions;
  };
  return {
    async getProfile(actorId) {
      const records = await input.records();
      const held = await input.heldWallets();
      const raw = profile(records, actorId, held);
      const origin = source();
      const own = records.filter(record => record.wallet === actorId && record.finality === 'finalized');
      const actions = (await Promise.all(own.map(record => actionsFor(record, origin)))).flat()
        .sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id));
      return { actorId, actorLabel: actorLabel(actorId), source: origin,
        closedCallCount: Number(raw.closedValidCount), openCallCount: raw.openRecords.length,
        meanReturnFraction: displayRatio(raw.averageReturn), actions } satisfies ConsumerProfile;
    },
    async getLeaderboard(period) {
      const origin = source();
      const raw = leaderboard(await input.records(), period === '7D' ? '7d' : 'all',
        Math.floor(origin.asOfMs / 1000), await input.heldWallets());
      return { period, source: origin, rows: raw.rows.map(row => ({
        actorId: row.wallet, actorLabel: actorLabel(row.wallet), closedCallCount: Number(row.closedValidCount),
        meanReturnFraction: requiredDisplayRatio(row.averageReturn), rank: row.rank
      })) } satisfies ConsumerLeaderboard;
    }
  };
}
export function validateNoteBody(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || noteCodePoints(value) > 280 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new NoteError('INVALID_INPUT', 'Write 1–280 characters of plain text.');
  }
  return value;
}

/** Only the authenticated wallet may write a finalized free action it owns. */
export class ConsumerNoteService {
  private readonly actions: FreeActionLookup;
  private readonly notes: NotePersistence;
  private readonly clock: () => number;
  constructor(actions: FreeActionLookup, notes: NotePersistence, clock: () => number = Date.now) {
    this.actions = actions; this.notes = notes; this.clock = clock;
  }

  async read(actionId: string): Promise<{ note: ConsumerNote | null; revisions: NoteRevision[] }> {
    const action = await this.actions.getFinalizedFreeAction(actionId);
    if (!action) return { note: null, revisions: [] };
    return { note: await this.notes.read(actionId), revisions: await this.notes.revisions(actionId) };
  }

  async save(input: { actionId: string; authenticatedWallet: string | null; body: unknown; expectedVersion: number }): Promise<ConsumerNote> {
    if (!input.authenticatedWallet) throw new NoteError('UNAUTHORIZED', 'Wallet authentication required.');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new NoteError('INVALID_INPUT', 'Invalid note version.');
    const body = validateNoteBody(input.body);
    const action = await this.actions.getFinalizedFreeAction(input.actionId);
    if (!action) throw new NoteError('DATA_NOT_READY', 'Finalized free action unavailable.');
    if (action.wallet !== input.authenticatedWallet) throw new NoteError('UNAUTHORIZED', 'This action belongs to another wallet.');
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(action.atMs) || action.atMs < 0 || now < action.atMs) throw new NoteError('DATA_NOT_READY', 'Action time unavailable.');
    const previous = await this.notes.read(input.actionId);
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new NoteError('ALREADY_EXECUTED', 'The note changed. Reload before editing.');
    if (previous && (previous.authorId !== action.wallet || previous.actionId !== action.id)) throw new NoteError('DATA_NOT_READY', 'Note ownership mismatch.');
    if (previous && now < previous.updatedAtMs) throw new NoteError('DATA_NOT_READY', 'Server clock moved behind the saved note.');
    const note: ConsumerNote = {
      id: previous?.id ?? randomUUID(), actionId: action.id, authorId: action.wallet, body,
      createdAtMs: previous?.createdAtMs ?? now, updatedAtMs: now, version: input.expectedVersion + 1,
      timing: previous?.timing ?? (now === action.atMs ? 'AT_ACTION' : 'ADDED_LATER'), proofCoverage: 'NONE'
    };
    return this.notes.write(note, input.expectedVersion);
  }
}

/** Owns a small additive table in the shared SQLite file; callers close after process shutdown. */
export class SqliteNotePersistence implements NotePersistence {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS consumer_notes(
        action_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, author_id TEXT NOT NULL,
        body TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        version INTEGER NOT NULL, timing TEXT NOT NULL, proof_coverage TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumer_note_revisions(
        action_id TEXT NOT NULL, version INTEGER NOT NULL, note_json TEXT NOT NULL,
        revised_at_ms INTEGER NOT NULL, PRIMARY KEY(action_id, version)
      );`);
  }
  close() { this.db.close(); }
  private readSync(actionId: string): ConsumerNote | null {
    const row = this.db.prepare('SELECT * FROM consumer_notes WHERE action_id=?').get(actionId) as Record<string, string | number> | undefined;
    return row ? { id: String(row.id), actionId: String(row.action_id), authorId: String(row.author_id), body: String(row.body),
      createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms), version: Number(row.version),
      timing: row.timing as ConsumerNote['timing'], proofCoverage: 'NONE' } : null;
  }
  async read(actionId: string): Promise<ConsumerNote | null> { return this.readSync(actionId); }
  async revisions(actionId: string): Promise<NoteRevision[]> {
    const rows = this.db.prepare('SELECT note_json,revised_at_ms FROM consumer_note_revisions WHERE action_id=? ORDER BY version').all(actionId) as Array<{note_json:string;revised_at_ms:number}>;
    return rows.map(row => ({ ...JSON.parse(row.note_json) as ConsumerNote, revisedAtMs: row.revised_at_ms }));
  }
  async write(next: ConsumerNote, expectedVersion: number): Promise<ConsumerNote> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Keep BEGIN, version check, update and revision insert in one synchronous turn.
      const current = this.readSync(next.actionId);
      if ((current?.version ?? 0) !== expectedVersion) throw new NoteError('ALREADY_EXECUTED', 'The note changed. Reload before editing.');
      if (current && (current.id !== next.id || current.authorId !== next.authorId || current.createdAtMs !== next.createdAtMs || current.timing !== next.timing)) {
        throw new NoteError('DATA_NOT_READY', 'Stored note identity changed.');
      }
      if (current) {
        const updated = this.db.prepare(`UPDATE consumer_notes SET body=?,updated_at_ms=?,version=? WHERE action_id=? AND version=?`)
          .run(next.body,next.updatedAtMs,next.version,next.actionId,expectedVersion);
        if (updated.changes !== 1) throw new NoteError('ALREADY_EXECUTED', 'The note changed. Reload before editing.');
      } else {
        this.db.prepare(`INSERT INTO consumer_notes(action_id,id,author_id,body,created_at_ms,updated_at_ms,version,timing,proof_coverage)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(next.actionId,next.id,next.authorId,next.body,next.createdAtMs,next.updatedAtMs,next.version,next.timing,'NONE');
      }
      this.db.prepare('INSERT INTO consumer_note_revisions(action_id,version,note_json,revised_at_ms) VALUES(?,?,?,?)')
        .run(next.actionId,next.version,JSON.stringify(next),next.updatedAtMs);
      this.db.exec('COMMIT');
      return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

/** Route adapter. Authentication must reuse the app's verified wallet session/signature path. */
export function createConsumerNoteRoutes(service: ConsumerNoteService,
  authenticate: (request: Request, claimedWallet: string) => Promise<boolean>) {
  return async (request: Request): Promise<Response | null> => {
    const match = /^\/v1\/consumer\/notes\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (!match) return null;
    let actionId: string;
    try { actionId = decodeURIComponent(match[1]); } catch { return Response.json({ code: 'INVALID_INPUT' }, { status: 400 }); }
    if (!actionId || actionId.length > 256) return Response.json({ code: 'INVALID_INPUT' }, { status: 400 });
    try {
      if (request.method === 'GET') return Response.json(await service.read(actionId), { headers: { 'cache-control': 'no-store' } });
      if (request.method !== 'PUT') return Response.json({ code: 'INVALID_INPUT' }, { status: 405 });
      const raw = await request.text();
      if (raw.length > 4096) throw new NoteError('INVALID_INPUT', 'Note request too large.');
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { throw new NoteError('INVALID_INPUT', 'Invalid JSON.'); }
      if (!payload || typeof payload !== 'object') throw new NoteError('INVALID_INPUT', 'Invalid note request.');
      const { wallet, body, expectedVersion } = payload as Record<string, unknown>;
      if (typeof wallet !== 'string' || !wallet) throw new NoteError('UNAUTHORIZED', 'Wallet authentication required.');
      const verified = await authenticate(request, wallet);
      const note = await service.save({ actionId, authenticatedWallet: verified ? wallet : null, body, expectedVersion: expectedVersion as number });
      return Response.json({ note }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (!(error instanceof NoteError)) throw error;
      const status = { INVALID_INPUT: 400, UNAUTHORIZED: 403, ALREADY_EXECUTED: 409, DATA_NOT_READY: 409 }[error.code];
      return Response.json({ code: error.code, message: error.message }, { status, headers: { 'cache-control': 'no-store' } });
    }
  };
}
