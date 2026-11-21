CREATE TABLE deliveries_next (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source = 'github'),
  delivery_id TEXT NOT NULL,
  event TEXT NOT NULL,
  raw BLOB NOT NULL,
  body_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  prepared INTEGER NOT NULL DEFAULT 0 CHECK (prepared IN (0, 1)),
  lease_until INTEGER,
  lane TEXT NOT NULL DEFAULT 'ordinary' CHECK (lane IN ('ordinary','release-queue','release-operation')),
  UNIQUE (source, delivery_id)
);
