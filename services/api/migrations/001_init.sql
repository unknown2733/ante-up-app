-- SQLite 3, additive initial schema. Apply inside a transaction with PRAGMA foreign_keys=ON.
-- Amounts and versions stay canonical decimal TEXT; timestamps are Unix seconds INTEGER.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_events (
  cluster TEXT NOT NULL CHECK(cluster IN ('localnet','devnet')),
  program_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL CHECK(event_index >= 0),
  transaction_index INTEGER CHECK(transaction_index >= 0),
  slot TEXT NOT NULL,
  finality TEXT NOT NULL CHECK(finality IN ('confirmed','finalized')),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (cluster, program_id, signature, event_index)
);
CREATE INDEX IF NOT EXISTS chain_events_finality ON chain_events(finality, kind);

CREATE TABLE IF NOT EXISTS read_markets (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  market_address TEXT NOT NULL,
  market_id TEXT NOT NULL,
  view_json TEXT NOT NULL,
  finalized_slot TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (cluster, program_id, market_address),
  UNIQUE (market_id)
);
CREATE TABLE IF NOT EXISTS read_free_records (
  record_id TEXT NOT NULL,
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  market_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED_RESULT','CLOSED_NA')),
  exit_at INTEGER,
  finality TEXT NOT NULL CHECK(finality IN ('confirmed','finalized')),
  result_num TEXT,
  result_den TEXT,
  calculation_status TEXT NOT NULL CHECK(calculation_status IN ('VALID','HELD_CALCULATION_ERROR')),
  record_json TEXT NOT NULL,
  finalized_slot TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (cluster, program_id, record_id)
);
CREATE INDEX IF NOT EXISTS read_free_records_wallet_exit ON read_free_records(wallet, exit_at);

CREATE TABLE IF NOT EXISTS operations (
  wallet TEXT NOT NULL,
  action TEXT NOT NULL,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('AWAITING_SIGNATURE','SUBMITTED','CONFIRMED','FINALIZED','FAILED','UNKNOWN')),
  signature TEXT,
  contract_id TEXT,
  error_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (wallet, action, request_id),
  UNIQUE (request_id)
);
CREATE INDEX IF NOT EXISTS operations_signature ON operations(signature);

CREATE TABLE IF NOT EXISTS worker_attempts (
  job_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('READY','LEASED','SUBMITTED','UNKNOWN','FINALIZED','FAILED')),
  signature TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  receipt_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  cluster TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  action TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
  request_id TEXT,
  detail_json TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, strftime('%s','now'));
