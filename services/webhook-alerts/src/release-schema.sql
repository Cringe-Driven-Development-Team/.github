CREATE TABLE release_notices (
  notice_key TEXT PRIMARY KEY,
  operation_key TEXT UNIQUE,
  outbox_id INTEGER NOT NULL UNIQUE REFERENCES outbox(id),
  metadata_json TEXT NOT NULL,
  sending_at INTEGER,
  skip_reason TEXT
);
CREATE TABLE release_activation (id INTEGER PRIMARY KEY CHECK (id=1), cutoff_ms INTEGER NOT NULL);
CREATE TABLE release_recovery (delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id));
