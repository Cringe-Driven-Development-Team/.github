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
  keyboard_json TEXT,
  UNIQUE (origin_type, origin_id, ordinal)
);
CREATE INDEX outbox_due ON outbox (status, due_at, lease_until, id);
