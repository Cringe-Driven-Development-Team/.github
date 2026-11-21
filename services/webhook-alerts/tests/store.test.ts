import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/http';
import { loadConfig } from '../src/config';
import { openStore, type Store, type OutgoingMessage } from '../src/store';

const paths: string[] = [];
const stores: Store[] = [];
const raw = new TextEncoder().encode('{ "action": "opened", "text": "Привет 🌍" }\n');
const input = (deliveryId = 'delivery-1', receivedAt = 1000) => ({
  source: 'github' as const, deliveryId, event: 'issues', raw, receivedAt,
});
const messages: OutgoingMessage[] = [
  { topic: 26, html: '<b>Opened</b>', button: { text: 'Open issue', url: 'https://github.com/org/repo/issues/1' }, fallbackHtml: 'Opened' },
  { topic: 1513, html: '<b>Review requested</b>' },
];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'webhook-alerts-store-'));
  paths.push(directory);
  return join(directory, 'queue.sqlite');
}
function open(path = databasePath()) {
  const store = openStore(path);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('durable acceptance', () => {
  test('reopening preserves pending raw bytes, body hash, and completed deliveries', () => {
    const path = databasePath();
    const first = open(path);
    expect(first.accept(input('completed'))).toBe('accepted');
    expect(first.accept(input('pending'))).toBe('accepted');
    const rows = first.claimUnprepared(1000, 100);
    expect(rows).toHaveLength(2);
    first.prepare(rows[0]!.id, []);
    first.close();
    const reopened = open(path);
    const pending = reopened.claimUnprepared(1100, 100);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ deliveryId: 'pending', source: 'github', event: 'issues', receivedAt: 1000 });
    expect(pending[0]!.raw).toEqual(raw);
    // Independently computed with sha256sum from the exact UTF-8 fixture.
    expect(pending[0]!.bodyHash).toBe('94c5be35049d121380268abbc7c1da2fc90a0ba05d9265ba04155322edd89c68');
    expect(reopened.accept(input('completed'))).toBe('duplicate');
  });

  test('exact redelivery is deduplicated without replacing the original delivery', () => {
    const store = open();
    expect(store.accept(input())).toBe('accepted');
    expect(store.accept(input('delivery-1', 2000))).toBe('duplicate');
    const rows = store.claimUnprepared(2000, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.receivedAt).toBe(1000);
  });

  test('same ID with different body conflicts and retains original raw bytes', () => {
    const store = open();
    store.accept(input());
    expect(store.accept({ ...input(), raw: new TextEncoder().encode('{}') })).toBe('conflict');
    expect(store.claimUnprepared(1000, 100)[0]!.raw).toEqual(raw);
  });

  test('GitHub cannot silently fall back to a body hash when its ID is absent', () => {
    const { deliveryId: _, ...withoutId } = input();
    // @ts-expect-error Untyped callers still have to provide a delivery ID.
    expect(() => open().accept(withoutId)).toThrow('delivery ID required');
  });

  test('uses WAL and health detects a closed database', () => {
    const path = databasePath();
    const store = open(path);
    const inspect = new Database(path);
    try { expect(inspect.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' }); }
    finally { inspect.close(); }
    expect(() => store.checkHealth()).not.toThrow();
    store.close();
    expect(() => store.checkHealth()).toThrow();
  });
});

describe('transactional preparation and leases', () => {
  test('preparing zero messages twice permanently completes a delivery', () => {
    const store = open();
    store.accept(input());
    const [delivery] = store.claimUnprepared(1000, 100);
    store.prepare(delivery!.id, []);
    store.prepare(delivery!.id, messages);
    expect(store.claimUnprepared(2000, 100)).toEqual([]);
    expect(store.claimDue(2000, 100)).toEqual([]);
  });

  test('two prepared messages keep stable outbox IDs and content across restart and repeated preparation', () => {
    const path = databasePath();
    const store = open(path);
    store.accept(input());
    const [delivery] = store.claimUnprepared(1000, 100);
    store.prepare(delivery!.id, messages);
    store.prepare(delivery!.id, messages);
    const claimed = store.claimDue(2000, 100);
    expect(claimed).toHaveLength(2);
    expect(claimed.map(({ topic, html, button, fallbackHtml }) => ({ topic, html, ...(button ? { button } : {}), ...(fallbackHtml ? { fallbackHtml } : {}) }))).toEqual(messages);
    expect(claimed.map(row => [row.originType, row.originId, row.ordinal])).toEqual([['delivery', delivery!.id, 0], ['delivery', delivery!.id, 1]]);
    store.close();
    const reopened = open(path);
    reopened.prepare(delivery!.id, messages);
    expect(reopened.claimDue(2099, 100)).toEqual([]);
    expect(reopened.claimDue(2100, 100).map(row => row.id)).toEqual(claimed.map(row => row.id));
    expect(reopened.claimUnprepared(2100, 100)).toEqual([]);
  });

  test('preparation rolls back both outbox insertion and completion if one message cannot be inserted', () => {
    const path = databasePath();
    const store = open(path);
    store.accept(input());
    const [delivery] = store.claimUnprepared(1000, 100);
    const inspect = new Database(path);
    try {
      inspect.exec("CREATE TRIGGER reject_second BEFORE INSERT ON outbox WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
      expect(() => store.prepare(delivery!.id, messages)).toThrow();
      expect(store.claimDue(2000, 100)).toEqual([]);
      expect(store.claimUnprepared(2000, 100)).toHaveLength(1);
      inspect.exec('DROP TRIGGER reject_second');
      store.prepare(delivery!.id, messages);
      expect(store.claimDue(2000, 100)).toHaveLength(2);
    } finally { inspect.close(); }
  });

  test('independent connections cannot claim deliveries until the lease expires', () => {
    const path = databasePath();
    const first = open(path);
    const second = open(path);
    first.accept(input());
    const claimed = first.claimUnprepared(1000, 100);
    expect(claimed).toHaveLength(1);
    expect(second.claimUnprepared(1099, 100)).toEqual([]);
    expect(second.claimUnprepared(1100, 100).map(row => row.id)).toEqual(claimed.map(row => row.id));
    expect(first.claimUnprepared(1100, 100)).toEqual([]);
  });

  test('outbox reserves review-group origin keys independently from delivery origins', () => {
    const path = databasePath();
    const store = open(path);
    store.accept(input());
    const [delivery] = store.claimUnprepared(1000, 100);
    store.prepare(delivery!.id, [messages[0]!]);
    const inspect = new Database(path);
    try {
      inspect.query("INSERT INTO outbox (origin_type, origin_id, ordinal, topic, html, due_at) VALUES ('review_group', ?, 0, 1513, 'Grouped review', 1000)").run(delivery!.id);
      expect(store.claimDue(2000, 100).map(row => row.originType)).toEqual(['delivery', 'review_group']);
    } finally { inspect.close(); }
  });
});

test('real HTTP acceptance survives reopening and returns duplicate or conflict on redelivery', async () => {
  const path = databasePath();
  const store = open(path);
  const secret = 'test-only-secret';
  const config = loadConfig({ GITHUB_WEBHOOK_SECRET: secret });
  const request = (body = raw) => new Request('http://localhost/webhooks/github', {
    method: 'POST', body: new Uint8Array(body), headers: {
      'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': 'http-1',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
  });
  const app = createApp({ config, accept: delivery => store.accept(delivery), checkDb: () => store.checkHealth() });
  expect((await app.fetch(request())).status).toBe(202);
  store.close();
  const reopened = open(path);
  const next = createApp({ config, accept: delivery => reopened.accept(delivery), checkDb: () => reopened.checkHealth() });
  expect((await next.fetch(request())).status).toBe(200);
  expect((await next.fetch(request(new TextEncoder().encode('{}')))).status).toBe(409);
  reopened.close();
  expect((await next.fetch(request())).status).toBe(503);
  expect((await next.request('/health')).status).toBe(503);
});

test('manual retry requeues failed GitHub messages with or without an error code', () => {
  const path = databasePath();
  const store = open(path);
  store.accept(input());
  const [delivery] = store.claimUnprepared(1000, 100);
  store.prepare(delivery!.id, messages);
  const inspect = new Database(path);
  try {
    inspect.exec("UPDATE outbox SET status = 'failed', error_code = 'telegram_400' WHERE id = 1");
    inspect.exec("UPDATE outbox SET status = 'failed' WHERE id = 2");
    expect(store.retryFailed(1, 1000)).toBe(true);
    expect(store.retryFailed(2, 1000)).toBe(true);
    expect(inspect.query('SELECT status, error_code FROM outbox ORDER BY id').all()).toEqual([
      { status: 'pending', error_code: null },
      { status: 'pending', error_code: null },
    ]);
  } finally { inspect.close(); }
});

function openV5(path: string) {
  const db = new Database(path);
  db.exec('PRAGMA foreign_keys = ON');
  for (const schema of ['schema.sql', 'review-groups-schema.sql', 'release-schema.sql']) {
    db.exec(readFileSync(new URL(`../src/${schema}`, import.meta.url), 'utf8'));
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS deliveries_body_window
      ON deliveries (source, body_hash, received_at) WHERE dedupe_kind = 'body_hash';
    CREATE TABLE release_contract (id INTEGER PRIMARY KEY CHECK (id=1), cutoff_ms INTEGER NOT NULL);
    CREATE TABLE backend_release_activation (id INTEGER PRIMARY KEY CHECK (id=1), cutoff_ms INTEGER NOT NULL);
    PRAGMA user_version = 5;
  `);
  return db;
}

test('v6 deletes Apidog deliveries and their outbox while preserving GitHub deliveries and links', () => {
  const path = databasePath();
  const legacy = openV5(path);
  const preservedRows = (db: Database) => ({
    deliveries: db.query("SELECT * FROM deliveries WHERE source = 'github' ORDER BY id").all(),
    outbox: db.query('SELECT * FROM outbox WHERE id IN (5, 6, 7) ORDER BY id').all(),
    groups: db.query('SELECT * FROM review_groups').all(),
    members: db.query('SELECT * FROM review_group_deliveries').all(),
    notices: db.query('SELECT * FROM release_notices').all(),
    recovery: db.query('SELECT * FROM release_recovery').all(),
  });
  const original = (() => {
    try {
      legacy.exec(`
        INSERT INTO deliveries (id, source, delivery_id, dedupe_kind, event, raw, body_hash, received_at, prepared, lane) VALUES
          (1, 'apidog', 'raw-hash:old', 'body_hash', 'API_UPDATED', X'7B7D', 'hash', 1, 1, 'ordinary'),
          (2, 'apidog', 'mr-poll:cutoff', 'id', 'MR_CUTOFF', X'7B7D', 'hash', 1, 1, 'ordinary'),
          (3, 'apidog', 'mr-poll:7:OPENED', 'id', 'MR_OPENED', X'7B7D', 'hash', 1, 1, 'ordinary'),
          (4, 'github', 'release-card', 'id', 'pull_request', X'7B7D', 'hash', 1, 1, 'release-queue'),
          (5, 'github', 'review-delivery', 'id', 'pull_request_review', X'7B7D', 'hash', 1, 1, 'ordinary');
        INSERT INTO deliveries (id, source, delivery_id, dedupe_kind, event, raw, body_hash, received_at)
          VALUES (6, 'apidog', 'delivery-1', 'id', 'BRANCH_CREATED', X'7B7D', 'hash', 1);
        INSERT INTO outbox (id, origin_type, origin_id, ordinal, topic, html, status, due_at, lease_until, error_code, telegram_message_id) VALUES
          (1, 'delivery', 1, 0, 26, 'Old raw', 'sent', 1, NULL, NULL, 123),
          (2, 'delivery', 3, 0, 26, 'Old MR', 'pending', 1, NULL, NULL, NULL),
          (3, 'delivery', 3, 1, 26, 'Old MR', 'leased', 1, 100, NULL, NULL),
          (4, 'delivery', 1, 1, 26, 'Old raw', 'failed', 1, NULL, 'APIDOG_RAW_SUPPRESSED', NULL),
          (5, 'delivery', 4, 0, 88, 'Release', 'sent', 1, NULL, NULL, 124),
          (6, 'review_group', 1, 0, 1513, 'Review', 'pending', 1, NULL, NULL, NULL),
          (7, 'delivery', 7, 0, 26, 'Issue', 'failed', 1, NULL, 'telegram_400', NULL);
        INSERT INTO review_groups (id, repository, pr_number, reviewer, due_at, released, revision)
          VALUES (1, 'org/repo', 1, 'reviewer', 1, 1, 1);
        INSERT INTO review_group_deliveries (delivery_id, group_id, review_id, repository)
          VALUES (5, 1, 1, 'org/repo');
        INSERT INTO release_notices (notice_key, outbox_id, metadata_json)
          VALUES ('queue:entry-1', 5, '{"kind":"queue","key":"queue:entry-1","prNumber":1,"queueEntryId":"entry-1"}');
        INSERT INTO release_activation (id, cutoff_ms) VALUES (1, 11);
        INSERT INTO backend_release_activation (id, cutoff_ms) VALUES (1, 12);
        INSERT INTO release_contract (id, cutoff_ms) VALUES (1, 13);
        INSERT INTO release_recovery (delivery_id) VALUES (4);
      `);
      legacy.query(`INSERT INTO deliveries (id, source, delivery_id, dedupe_kind, event, raw, body_hash, received_at, prepared)
        VALUES (7, 'github', ?, 'id', ?, ?, '94c5be35049d121380268abbc7c1da2fc90a0ba05d9265ba04155322edd89c68', ?, 1)`)
        .run(input().deliveryId, input().event, raw, input().receivedAt);
      return preservedRows(legacy);
    } finally { legacy.close(); }
  })();

  for (let attempt = 0; attempt < 2; attempt++) {
    const store = open(path);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
      expect(db.query("SELECT id FROM deliveries WHERE source = 'apidog'").all()).toEqual([]);
      expect(db.query('SELECT id FROM outbox ORDER BY id').all()).toEqual([{ id: 5 }, { id: 6 }, { id: 7 }]);
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'deliveries_body_window'").all()).toEqual([]);
      expect(preservedRows(db)).toEqual(original);
      expect(store.releaseActivation()).toBe(11);
      expect(store.releaseActivation('Cringe-Driven-Development-Team/backend')).toBe(12);
      expect(store.releaseContract()).toBe(13);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(store.retryFailed(4, 1000)).toBe(false);
      expect(store.accept(input())).toBe('duplicate');
    } finally {
      db.close();
      store.close();
    }
  }
});

test('failed v6 migration rolls back outbox deletion and can be retried', () => {
  const path = databasePath();
  const db = openV5(path);
  try {
    db.exec(`
      INSERT INTO deliveries (id, source, delivery_id, dedupe_kind, event, raw, body_hash, received_at)
        VALUES (1, 'apidog', 'old', 'id', 'API_UPDATED', X'7B7D', 'hash', 1);
      INSERT INTO outbox (id, origin_type, origin_id, ordinal, topic, html, status, due_at)
        VALUES (1, 'delivery', 1, 0, 26, 'Old raw', 'failed', 1);
      CREATE TRIGGER deny_delete BEFORE DELETE ON deliveries
        BEGIN SELECT RAISE(ABORT, 'test migration write failure'); END;
    `);
    const deliveries = db.query('SELECT * FROM deliveries').all();
    const outbox = db.query('SELECT * FROM outbox').all();
    expect(() => open(path)).toThrow('test migration write failure');
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    expect(db.query('SELECT * FROM deliveries').all()).toEqual(deliveries);
    expect(db.query('SELECT * FROM outbox').all()).toEqual(outbox);

    db.exec('DROP TRIGGER deny_delete');
    open(path);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    expect(db.query('SELECT * FROM deliveries').all()).toEqual([]);
    expect(db.query('SELECT * FROM outbox').all()).toEqual([]);
  } finally { db.close(); }
});
