import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectYouTubeReferenceViews } from './reference-youtube.ts';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export type YouTubeCadence = 'reference' | 'oracle-prep';
const POLICIES = {
  reference: { table: 'reference_youtube_requests', minIntervalMs: SIX_HOURS_MS,
    slotMs: null, dailyCap: 4, rollingCap: 120 },
  // One request per UTC five-minute slot. Container startup can vary by over
  // 30 seconds, so an elapsed-time gate can skip the next scheduled slot.
  // The daily cap still bounds this feed to 288 statistics batch calls.
  'oracle-prep': { table: 'reference_youtube_oracle_prep_requests', minIntervalMs: null,
    slotMs: FIVE_MINUTES_MS,
    dailyCap: 288, rollingCap: 8_640 },
} as const;

/** Reserve quota before a call. An uncertain response never triggers an immediate retry. */
export class ReferenceYouTubeRequestBudget {
  private db: DatabaseSync;
  private policy: typeof POLICIES[YouTubeCadence];
  constructor(path: string, cadence: YouTubeCadence = 'reference') {
    if (!(cadence in POLICIES)) throw new Error('YOUTUBE_CADENCE_INVALID');
    this.policy = POLICIES[cadence];
    this.db = new DatabaseSync(resolve(path));
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS ${this.policy.table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT, attempted_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('STARTED','SUCCESS','FAILED')), error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS ${this.policy.table}_time
        ON ${this.policy.table}(attempted_at_ms);`);
  }
  close() { this.db.close(); }
  reserve(nowMs: number): { id: number | null; reason: string | null } {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('INVALID_COLLECTION_TIME');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const last = this.db.prepare(`SELECT MAX(attempted_at_ms) AS at_ms FROM ${this.policy.table}`)
        .get() as { at_ms: number | null };
      const dayStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
      const today = this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.policy.table} WHERE attempted_at_ms >= ? AND attempted_at_ms <= ?`)
        .get(dayStartMs, nowMs) as { n: number };
      const rolling = this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.policy.table} WHERE attempted_at_ms > ? AND attempted_at_ms <= ?`)
        .get(nowMs - THIRTY_DAYS_MS, nowMs) as { n: number };
      let reason: string | null = null;
      if (last.at_ms !== null && (last.at_ms > nowMs ||
        (this.policy.slotMs === null
          ? nowMs - last.at_ms < (this.policy.minIntervalMs ?? 0)
          : Math.floor(nowMs / this.policy.slotMs) === Math.floor(last.at_ms / this.policy.slotMs))))
        reason = 'MIN_INTERVAL';
      else if (today.n >= this.policy.dailyCap) reason = 'DAILY_CAP';
      else if (rolling.n >= this.policy.rollingCap) reason = 'ROLLING_30_DAY_CAP';
      if (reason) { this.db.exec('COMMIT'); return { id: null, reason }; }
      const result = this.db.prepare(`INSERT INTO ${this.policy.table}(attempted_at_ms,status) VALUES (?,'STARTED')`)
        .run(nowMs);
      this.db.exec('COMMIT');
      return { id: Number(result.lastInsertRowid), reason: null };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(id: number, status: 'SUCCESS' | 'FAILED', errorCode: string | null = null) {
    if (!Number.isSafeInteger(id) || id < 1 || (errorCode !== null && !/^[A-Z0-9_]{1,60}$/.test(errorCode)))
      throw new Error('INVALID_COLLECTION_RESULT');
    const result = this.db.prepare(`UPDATE ${this.policy.table} SET status=?, error_code=? WHERE id=? AND status='STARTED'`)
      .run(status, errorCode, id);
    if (result.changes !== 1) throw new Error('COLLECTION_ATTEMPT_NOT_PENDING');
  }
}

export async function runBoundedYouTubeReferenceViews(input: {
  dbPath: string; apiKey: string; fetcher?: typeof fetch; nowMs?: () => number;
  cadence?: YouTubeCadence;
}) {
  if (!input.apiKey || input.apiKey.length > 512) throw new Error('YOUTUBE_KEY_REQUIRED');
  const nowMs = (input.nowMs ?? Date.now)();
  const budget = new ReferenceYouTubeRequestBudget(input.dbPath, input.cadence);
  let reservation: ReturnType<ReferenceYouTubeRequestBudget['reserve']>;
  try { reservation = budget.reserve(nowMs); }
  finally { budget.close(); }
  if (reservation.id === null) return { status: 'SKIPPED' as const, reason: reservation.reason };
  try {
    const result = await collectYouTubeReferenceViews({ ...input, nowMs: () => nowMs });
    const journal = new ReferenceYouTubeRequestBudget(input.dbPath, input.cadence);
    try { journal.finish(reservation.id, 'SUCCESS'); }
    finally { journal.close(); }
    return { status: 'SUCCESS' as const, ...result };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,60}$/.test(error.message)
      ? error.message : 'YOUTUBE_REQUEST_FAILED';
    const journal = new ReferenceYouTubeRequestBudget(input.dbPath, input.cadence);
    try { journal.finish(reservation.id, 'FAILED', code); }
    finally { journal.close(); }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.argv[2];
  const keyPath = process.env.ANTE_UP_YOUTUBE_API_KEY_FILE;
  if (!dbPath || !keyPath || process.env.ANTE_UP_YOUTUBE_ALLOW_QUOTA !== '1')
    throw new Error('Usage: ANTE_UP_YOUTUBE_API_KEY_FILE=<secret-file> ANTE_UP_YOUTUBE_ALLOW_QUOTA=1 node reference-youtube-schedule.ts <persistent-api-db.sqlite>');
  const cadence = process.env.ANTE_UP_YOUTUBE_CADENCE ?? 'reference';
  if (cadence !== 'reference' && cadence !== 'oracle-prep') throw new Error('YOUTUBE_CADENCE_INVALID');
  const apiKey = (await readFile(resolve(keyPath), 'utf8')).trim();
  console.log(JSON.stringify(await runBoundedYouTubeReferenceViews({ dbPath, apiKey, cadence })));
}
