import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectXReferenceLikes } from './reference-x-posts.ts';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Reserves a paid request before sending it; even failed or uncertain calls consume the local cap. */
export class ReferenceXRequestBudget {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(resolve(path));
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reference_x_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, attempted_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('STARTED','SUCCESS','FAILED')), error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS reference_x_requests_time ON reference_x_requests(attempted_at_ms);`);
  }
  close() { this.db.close(); }
  reserve(nowMs: number): { id: number | null; reason: string | null } {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('INVALID_COLLECTION_TIME');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const last = this.db.prepare('SELECT MAX(attempted_at_ms) AS at_ms FROM reference_x_requests')
        .get() as { at_ms: number | null };
      const dayStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
      const today = this.db.prepare('SELECT COUNT(*) AS n FROM reference_x_requests WHERE attempted_at_ms >= ? AND attempted_at_ms <= ?')
        .get(dayStartMs, nowMs) as { n: number };
      const rolling = this.db.prepare('SELECT COUNT(*) AS n FROM reference_x_requests WHERE attempted_at_ms > ? AND attempted_at_ms <= ?')
        .get(nowMs - THIRTY_DAYS_MS, nowMs) as { n: number };
      let reason: string | null = null;
      if (last.at_ms !== null && nowMs - last.at_ms < SIX_HOURS_MS) reason = 'MIN_INTERVAL';
      else if (today.n >= 4) reason = 'DAILY_CAP';
      else if (rolling.n >= 120) reason = 'ROLLING_30_DAY_CAP';
      if (reason) { this.db.exec('COMMIT'); return { id: null, reason }; }
      const result = this.db.prepare("INSERT INTO reference_x_requests(attempted_at_ms,status) VALUES (?,'STARTED')")
        .run(nowMs);
      this.db.exec('COMMIT');
      return { id: Number(result.lastInsertRowid), reason: null };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(id: number, status: 'SUCCESS' | 'FAILED', errorCode: string | null = null) {
    if (!Number.isSafeInteger(id) || id < 1 || (errorCode !== null && !/^[A-Z0-9_]{1,60}$/.test(errorCode)))
      throw new Error('INVALID_COLLECTION_RESULT');
    const result = this.db.prepare("UPDATE reference_x_requests SET status=?, error_code=? WHERE id=? AND status='STARTED'")
      .run(status, errorCode, id);
    if (result.changes !== 1) throw new Error('COLLECTION_ATTEMPT_NOT_PENDING');
  }
}

export async function runBoundedXReferenceLikes(input: {
  dbPath: string; bearerToken: string; fetcher?: typeof fetch; nowMs?: () => number;
}) {
  const nowMs = (input.nowMs ?? Date.now)();
  const budget = new ReferenceXRequestBudget(input.dbPath);
  let reservation: ReturnType<ReferenceXRequestBudget['reserve']>;
  try { reservation = budget.reserve(nowMs); }
  finally { budget.close(); }
  if (reservation.id === null) return { status: 'SKIPPED' as const, reason: reservation.reason };
  try {
    const result = await collectXReferenceLikes({ ...input, nowMs: () => nowMs });
    const journal = new ReferenceXRequestBudget(input.dbPath);
    try { journal.finish(reservation.id, 'SUCCESS'); }
    finally { journal.close(); }
    return { status: 'SUCCESS' as const, ...result };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,60}$/.test(error.message)
      ? error.message : 'X_REQUEST_FAILED';
    const journal = new ReferenceXRequestBudget(input.dbPath);
    try { journal.finish(reservation.id, 'FAILED', code); }
    finally { journal.close(); }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.argv[2];
  const keyPath = process.env.ANTE_UP_X_BEARER_TOKEN_FILE;
  if (!dbPath || !keyPath || process.env.ANTE_UP_X_POST_LOOKUP_ALLOW_PAID !== '1')
    throw new Error('Usage: ANTE_UP_X_BEARER_TOKEN_FILE=<secret-file> ANTE_UP_X_POST_LOOKUP_ALLOW_PAID=1 node reference-x-schedule.ts <persistent-api-db.sqlite>');
  const bearerToken = (await readFile(resolve(keyPath), 'utf8')).trim();
  console.log(JSON.stringify(await runBoundedXReferenceLikes({ dbPath, bearerToken })));
}
