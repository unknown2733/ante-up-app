import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { ReferenceObservation } from '../../../contracts/reference/observations.ts';
import { validateReferenceObservation } from '../../../contracts/reference/observations.ts';

/** Append-only public evidence. A later capture may revise the same reported point. */
export class ReferenceObservationStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reference_raw (
      raw_sha256 TEXT PRIMARY KEY, raw_bytes BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reference_observations (
      slug TEXT NOT NULL, kind TEXT NOT NULL, aggregation TEXT NOT NULL, observed_at_ms INTEGER NOT NULL,
      captured_at_ms INTEGER NOT NULL, value TEXT NOT NULL, reported_date TEXT,
      provider TEXT NOT NULL, source_url TEXT NOT NULL, raw_sha256 TEXT NOT NULL,
      PRIMARY KEY (slug, observed_at_ms, raw_sha256)
    );
    CREATE INDEX IF NOT EXISTS reference_observations_time
      ON reference_observations(slug, observed_at_ms DESC, captured_at_ms DESC);`);
  }
  close() { this.db.close(); }
  append(value: unknown, rawBytes: Uint8Array, nowMs = Date.now()): boolean {
    const item = validateReferenceObservation(value, nowMs);
    if (rawBytes.byteLength === 0 || rawBytes.byteLength > 2_000_000)
      throw new Error('REFERENCE_RAW_SIZE_INVALID');
    if (createHash('sha256').update(rawBytes).digest('hex') !== item.rawSha256)
      throw new Error('REFERENCE_RAW_HASH_MISMATCH');
    this.db.prepare('INSERT OR IGNORE INTO reference_raw (raw_sha256, raw_bytes) VALUES (?, ?)')
      .run(item.rawSha256, rawBytes);
    const result = this.db.prepare(`INSERT OR IGNORE INTO reference_observations
      (slug, kind, aggregation, observed_at_ms, captured_at_ms, value, reported_date, provider, source_url, raw_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.slug, item.kind, item.aggregation, item.observedAtMs,
        item.capturedAtMs, item.value, item.reportedDate, item.provider, item.sourceUrl, item.rawSha256);
    return result.changes === 1;
  }
  raw(sha256: string): Uint8Array | null {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('INVALID_REFERENCE_QUERY');
    const row = this.db.prepare('SELECT raw_bytes FROM reference_raw WHERE raw_sha256=?').get(sha256) as {raw_bytes: Uint8Array} | undefined;
    return row?.raw_bytes ?? null;
  }
  latest(): ReferenceObservation[] {
    return this.rows(`SELECT slug, kind, aggregation, observed_at_ms, captured_at_ms, value,
      reported_date, provider, source_url, raw_sha256 FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY slug ORDER BY observed_at_ms DESC, captured_at_ms DESC, raw_sha256 DESC) AS rank
      FROM reference_observations) WHERE rank=1 ORDER BY slug`);
  }
  history(slug: string, sinceMs = 0, limit = 5000): ReferenceObservation[] {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(slug) || !Number.isSafeInteger(sinceMs) || sinceMs < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error('INVALID_REFERENCE_QUERY');
    const rows = this.rows(`SELECT * FROM reference_observations WHERE slug=? AND observed_at_ms>=?
      ORDER BY observed_at_ms DESC, captured_at_ms DESC, raw_sha256 DESC LIMIT ?`, slug, sinceMs, limit);
    const seen = new Set<number>();
    return rows.filter(item => { if (seen.has(item.observedAtMs)) return false; seen.add(item.observedAtMs); return true; })
      .sort((a, b) => a.observedAtMs - b.observedAtMs);
  }
  private rows(sql: string, ...args: Array<string | number>): ReferenceObservation[] {
    const result = this.db.prepare(sql).all(...args) as Array<Record<string, string | number | null>>;
    return result.map(row => ({
      slug: String(row.slug), kind: String(row.kind) as ReferenceObservation['kind'],
      aggregation: String(row.aggregation) as ReferenceObservation['aggregation'], value: String(row.value),
      observedAtMs: Number(row.observed_at_ms), capturedAtMs: Number(row.captured_at_ms),
      reportedDate: row.reported_date === null ? null : String(row.reported_date),
      provider: String(row.provider), sourceUrl: String(row.source_url), rawSha256: String(row.raw_sha256),
    }));
  }
}
