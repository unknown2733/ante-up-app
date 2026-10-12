CREATE TABLE IF NOT EXISTS index_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS finalized_events (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  slot TEXT NOT NULL,
  transaction_index INTEGER,
  kind TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY(cluster, program_id, signature, event_index)
);
CREATE TABLE IF NOT EXISTS current_free_records (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(cluster, program_id, record_id)
);
CREATE TABLE IF NOT EXISTS current_snapshots (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  sequence TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY(cluster, program_id, market_id, sequence)
);
CREATE TABLE IF NOT EXISTS rpc_cursors (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  address TEXT NOT NULL,
  head_signature TEXT,
  scan_head TEXT,
  scan_before TEXT,
  PRIMARY KEY(cluster, program_id, address)
);
CREATE TABLE IF NOT EXISTS pending_signatures (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  address TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot TEXT NOT NULL,
  failed INTEGER NOT NULL CHECK(failed IN (0,1)),
  PRIMARY KEY(cluster, program_id, address, signature)
);
INSERT OR IGNORE INTO index_schema_migrations(version, applied_at) VALUES (1, strftime('%s','now'));
