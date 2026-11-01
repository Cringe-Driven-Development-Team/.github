ALTER TABLE deliveries ADD COLUMN lane TEXT NOT NULL DEFAULT 'ordinary' CHECK (lane IN ('ordinary','release-queue','release-operation'));
ALTER TABLE outbox ADD COLUMN keyboard_json TEXT;
CREATE TABLE release_notices (
  notice_key TEXT PRIMARY KEY,
  outbox_id INTEGER NOT NULL UNIQUE REFERENCES outbox(id),
  metadata_json TEXT NOT NULL,
  sending_at INTEGER,
  skip_reason TEXT
);
CREATE TABLE release_activation (id INTEGER PRIMARY KEY CHECK (id=1), cutoff_ms INTEGER NOT NULL);
CREATE TABLE release_recovery (delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id));
