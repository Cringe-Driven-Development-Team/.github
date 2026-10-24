CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('github', 'apidog')),
  delivery_id TEXT NOT NULL,
  dedupe_kind TEXT NOT NULL CHECK (dedupe_kind IN ('id', 'body_hash')),
  event TEXT NOT NULL,
  raw BLOB NOT NULL,
  body_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  prepared INTEGER NOT NULL DEFAULT 0 CHECK (prepared IN (0, 1)),
  lease_until INTEGER,
  UNIQUE (source, delivery_id)
);
CREATE INDEX deliveries_unprepared ON deliveries (prepared, lease_until, id);
CREATE INDEX deliveries_body_window ON deliveries (source, body_hash, received_at) WHERE dedupe_kind = 'body_hash';

-- A review group may create messages independently from an individual delivery.
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  origin_type TEXT NOT NULL CHECK (origin_type IN ('delivery', 'review_group')),
  origin_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  topic INTEGER NOT NULL,
  html TEXT NOT NULL,
  button_json TEXT,
  fallback_html TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  lease_until INTEGER,
  error_code TEXT,
  telegram_message_id INTEGER,
  UNIQUE (origin_type, origin_id, ordinal)
);
CREATE INDEX outbox_due ON outbox (status, due_at, lease_until, id);
