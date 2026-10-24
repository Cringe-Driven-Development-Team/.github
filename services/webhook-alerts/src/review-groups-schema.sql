CREATE TABLE review_groups (
  id INTEGER PRIMARY KEY,
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0,
  released INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX review_groups_due ON review_groups (released, due_at);
CREATE INDEX review_groups_key ON review_groups (repository, pr_number, reviewer, released, sealed);
CREATE TABLE review_group_deliveries (
  delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id),
  group_id INTEGER NOT NULL REFERENCES review_groups(id),
  review_id INTEGER NOT NULL,
  repository TEXT NOT NULL,
  UNIQUE (repository, review_id)
);
CREATE INDEX review_group_members ON review_group_deliveries (group_id, delivery_id);
