import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { FreeRecord, PublishedSnapshot } from '../../../contracts/types.ts';
import { EventIndex, type ChainEvent } from './index.ts';

export interface StreamKey { cluster: 'localnet' | 'devnet'; programId: string; address: string }
export interface RpcCursor { headSignature: string | null; scanHead: string | null; scanBefore: string | null }
export interface PendingSignature { signature: string; slot: string; failed: boolean }
const version1 = readFileSync(new URL('../migrations/001_rpc_index.sql', import.meta.url), 'utf8');
const streamArgs = (key: StreamKey) => [key.cluster, key.programId, key.address] as const;

/** Local SQLite WAL adapter; one process owns writes, and every projection/cursor advance is atomic. */
export class SqliteProjectionStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    this.db.exec(version1);
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  cursor(key: StreamKey): RpcCursor {
    const row = this.db.prepare('SELECT head_signature, scan_head, scan_before FROM rpc_cursors WHERE cluster=? AND program_id=? AND address=?').get(...streamArgs(key)) as Record<string, string | null> | undefined;
    return { headSignature: row?.head_signature ?? null, scanHead: row?.scan_head ?? null, scanBefore: row?.scan_before ?? null };
  }
  pending(key: StreamKey): PendingSignature[] {
    const rows = this.db.prepare('SELECT signature, slot, failed FROM pending_signatures WHERE cluster=? AND program_id=? AND address=?').all(...streamArgs(key)) as Array<{signature:string;slot:string;failed:number}>;
    return rows.map(row => ({ signature: row.signature, slot: row.slot, failed: row.failed === 1 }));
  }
  savePage(key: StreamKey, signatures: PendingSignature[], scanHead: string, scanBefore: string | null): void {
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO rpc_cursors(cluster,program_id,address) VALUES(?,?,?)').run(...streamArgs(key));
      const cursor = this.cursor(key);
      if (cursor.scanHead && cursor.scanHead !== scanHead) throw new Error('SCAN_HEAD_CHANGED');
      const insert = this.db.prepare('INSERT OR IGNORE INTO pending_signatures(cluster,program_id,address,signature,slot,failed) VALUES(?,?,?,?,?,?)');
      for (const item of signatures) {
        if (!/^(0|[1-9][0-9]*)$/.test(item.slot)) throw new Error('INVALID_SLOT');
        insert.run(...streamArgs(key), item.signature, item.slot, item.failed ? 1 : 0);
        const stored = this.db.prepare('SELECT slot,failed FROM pending_signatures WHERE cluster=? AND program_id=? AND address=? AND signature=?').get(...streamArgs(key), item.signature) as {slot:string;failed:number};
        if (stored.slot !== item.slot || stored.failed !== (item.failed ? 1 : 0)) throw new Error('SIGNATURE_CONFLICT');
      }
      this.db.prepare('UPDATE rpc_cursors SET scan_head=?, scan_before=? WHERE cluster=? AND program_id=? AND address=?').run(scanHead, scanBefore, ...streamArgs(key));
    });
  }
  /** Finality evidence and decoder output are validated by the poller before this transaction. */
  commitScan(key: StreamKey, events: ChainEvent[], newHead: string): void {
    this.transaction(() => {
      const cursor = this.cursor(key);
      if (cursor.scanHead !== newHead || cursor.scanBefore !== null) throw new Error('SCAN_NOT_COMPLETE');
      const insert = this.db.prepare('INSERT OR IGNORE INTO finalized_events(cluster,program_id,signature,event_index,slot,transaction_index,kind,event_json) VALUES(?,?,?,?,?,?,?,?)');
      for (const event of events) {
        if (event.finality !== 'finalized' || event.cluster !== key.cluster || event.programId !== key.programId) throw new Error('EVENT_SCOPE_MISMATCH');
        const serialized = JSON.stringify(event);
        insert.run(event.cluster, event.programId, event.signature, event.eventIndex, event.slot, event.transactionIndex ?? null, event.kind, serialized);
        const existing = this.db.prepare('SELECT event_json FROM finalized_events WHERE cluster=? AND program_id=? AND signature=? AND event_index=?').get(event.cluster, event.programId, event.signature, event.eventIndex) as {event_json:string};
        if (existing.event_json !== serialized) throw new Error('EVENT_CONTENT_CONFLICT');
      }
      this.rebuildProjection();
      this.db.prepare('UPDATE rpc_cursors SET head_signature=?,scan_head=NULL,scan_before=NULL WHERE cluster=? AND program_id=? AND address=?').run(newHead, ...streamArgs(key));
      this.db.prepare('DELETE FROM pending_signatures WHERE cluster=? AND program_id=? AND address=?').run(...streamArgs(key));
    });
  }
  private rebuildProjection(): void {
    const rows = this.db.prepare('SELECT cluster,program_id,event_json FROM finalized_events').all() as Array<{cluster:string;program_id:string;event_json:string}>;
    const scopes = new Map<string, {cluster:string;programId:string;events:ChainEvent[]}>();
    for (const row of rows) {
      const scopeKey = JSON.stringify([row.cluster, row.program_id]);
      const group = scopes.get(scopeKey) ?? { cluster: row.cluster, programId: row.program_id, events: [] };
      group.events.push(JSON.parse(row.event_json) as ChainEvent);
      scopes.set(scopeKey, group);
    }
    this.db.exec('DELETE FROM current_free_records; DELETE FROM current_snapshots;');
    const insertRecord = this.db.prepare('INSERT INTO current_free_records(cluster,program_id,record_id,record_json) VALUES(?,?,?,?)');
    const insertSnapshot = this.db.prepare('INSERT INTO current_snapshots(cluster,program_id,market_id,sequence,snapshot_json) VALUES(?,?,?,?,?)');
    for (const group of scopes.values()) {
      const index = new EventIndex();
      for (const event of group.events) index.ingest(event);
      for (const record of index.finalizedRecords()) insertRecord.run(group.cluster, group.programId, record.id, JSON.stringify(record));
      for (const snapshot of index.finalizedSnapshots()) insertSnapshot.run(group.cluster, group.programId, snapshot.payload.marketId, snapshot.payload.sequence, JSON.stringify(snapshot));
    }
  }
  records(cluster: StreamKey['cluster'], programId: string): FreeRecord[] {
    return (this.db.prepare('SELECT record_json FROM current_free_records WHERE cluster=? AND program_id=? ORDER BY record_id').all(cluster, programId) as Array<{record_json:string}>).map(row => JSON.parse(row.record_json) as FreeRecord);
  }
  snapshots(cluster: StreamKey['cluster'], programId: string): PublishedSnapshot[] {
    return (this.db.prepare('SELECT snapshot_json FROM current_snapshots WHERE cluster=? AND program_id=?').all(cluster, programId) as Array<{snapshot_json:string}>).map(row => JSON.parse(row.snapshot_json) as PublishedSnapshot);
  }
  eventCount(): number { return Number((this.db.prepare('SELECT COUNT(*) AS count FROM finalized_events').get() as {count:number}).count); }
}
