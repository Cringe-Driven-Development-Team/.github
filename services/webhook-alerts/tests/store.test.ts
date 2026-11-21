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

function openLegacyQueue(path: string, version: 6 | 7) {
  const db = new Database(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE deliveries (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('github', 'former-source')),
      delivery_id TEXT NOT NULL,
      dedupe_kind TEXT NOT NULL CHECK (dedupe_kind IN ('id', 'body_hash')),
      event TEXT NOT NULL,
      raw BLOB NOT NULL,
      body_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      prepared INTEGER NOT NULL DEFAULT 0 CHECK (prepared IN (0, 1)),
      lease_until INTEGER,
      lane TEXT NOT NULL DEFAULT 'ordinary' CHECK (lane IN ('ordinary','release-queue','release-operation')),
      UNIQUE (source, delivery_id)
    );
    CREATE INDEX deliveries_unprepared ON deliveries (prepared, lease_until, id);
    CREATE TABLE release_contract (id INTEGER PRIMARY KEY CHECK (id=1), cutoff_ms INTEGER NOT NULL);
    CREATE TABLE backend_release_activation (id INTEGER PRIMARY KEY CHECK (id=1), cutoff_ms INTEGER NOT NULL);
    PRAGMA user_version = ${version};
  `);
  db.exec(readFileSync(new URL('../src/review-groups-schema.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../src/release-schema.sql', import.meta.url), 'utf8'));
  if (version === 7) {
    db.exec('CREATE TABLE infra_release_activation (id INTEGER PRIMARY KEY CHECK (id=1), cutoff_ms INTEGER NOT NULL)');
  }
  return db;
}

function queueRows(db: Database) {
  return {
    deliveries: db.query(`SELECT id, source, delivery_id, event, raw, body_hash, received_at, prepared,
      lease_until, lane FROM deliveries ORDER BY id`).all(),
    outbox: db.query('SELECT * FROM outbox ORDER BY id').all(),
    groups: db.query('SELECT * FROM review_groups').all(),
    members: db.query('SELECT * FROM review_group_deliveries').all(),
    notices: db.query('SELECT * FROM release_notices').all(),
    recovery: db.query('SELECT * FROM release_recovery').all(),
  };
}

for (const version of [6, 7] as const) {
  test(`v${version} upgrades to the same v8 schema as a fresh database and preserves the queue`, () => {
    const path = databasePath();
    const legacy = openLegacyQueue(path, version);
    const original = (() => {
      try {
        legacy.exec(`
          INSERT INTO deliveries (id, source, delivery_id, dedupe_kind, event, raw, body_hash, received_at, prepared, lease_until, lane) VALUES
            (4, 'github', 'release-card', 'id', 'pull_request', X'7B7D', 'hash', 1, 1, NULL, 'release-queue'),
            (5, 'github', 'review-delivery', 'id', 'pull_request_review', X'7B7D', 'hash', 1, 1, NULL, 'ordinary'),
            (8, 'github', 'pending', 'id', 'issues', X'7B7D', 'hash', 1, 0, 500, 'ordinary');
          INSERT INTO outbox (id, origin_type, origin_id, ordinal, topic, html, status, due_at, error_code, telegram_message_id) VALUES
            (5, 'delivery', 4, 0, 88, 'Release', 'sent', 1, NULL, 124),
            (6, 'review_group', 1, 0, 1513, 'Review', 'pending', 1, NULL, NULL),
            (7, 'delivery', 7, 0, 26, 'Result', 'failed', 1, 'release_uncertain', NULL);
          INSERT INTO review_groups (id, repository, pr_number, reviewer, due_at, released, revision)
            VALUES (1, 'org/repo', 1, 'reviewer', 1, 1, 1);
          INSERT INTO review_group_deliveries (delivery_id, group_id, review_id, repository)
            VALUES (5, 1, 1, 'org/repo');
          INSERT INTO release_notices (notice_key, outbox_id, metadata_json)
            VALUES ('queue:entry-1', 5, '{"kind":"queue","key":"queue:entry-1","prNumber":1,"queueEntryId":"entry-1"}');
          INSERT INTO release_notices (notice_key, outbox_id, metadata_json, sending_at)
            VALUES ('result:entry-1', 7, '{"kind":"result","key":"result:entry-1","deploymentId":1,"runId":1}', 50);
          INSERT INTO release_activation (id, cutoff_ms) VALUES (1, 11);
          INSERT INTO backend_release_activation (id, cutoff_ms) VALUES (1, 12);
          INSERT INTO release_contract (id, cutoff_ms) VALUES (1, 13);
          INSERT INTO release_recovery (delivery_id) VALUES (4);
        `);
        if (version === 7) legacy.exec('INSERT INTO infra_release_activation VALUES (1, 14)');
        legacy.query(`INSERT INTO deliveries (id, source, delivery_id, dedupe_kind, event, raw, body_hash, received_at, prepared)
          VALUES (7, 'github', ?, 'id', ?, ?, '94c5be35049d121380268abbc7c1da2fc90a0ba05d9265ba04155322edd89c68', ?, 1)`)
          .run(input().deliveryId, input().event, raw, input().receivedAt);
        return queueRows(legacy);
      } finally { legacy.close(); }
    })();

    const freshPath = databasePath();
    openStore(freshPath).close();
    const fresh = new Database(freshPath, { readonly: true });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const store = openStore(path);
        const db = new Database(path, { readonly: true });
        try {
          expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
          expect(queueRows(db)).toEqual(original);
          expect(db.query('PRAGMA table_info(deliveries)').all()).toEqual(fresh.query('PRAGMA table_info(deliveries)').all());
          expect(db.query('PRAGMA index_list(deliveries)').all()).toEqual(fresh.query('PRAGMA index_list(deliveries)').all());
          expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
          expect(store.releaseActivation()).toBe(11);
          expect(store.releaseActivation('Cringe-Driven-Development-Team/backend')).toBe(12);
          expect(store.releaseActivation('Cringe-Driven-Development-Team/infra')).toBe(version === 7 ? 14 : null);
          expect(store.releaseContract()).toBe(13);
          expect(store.accept(input())).toBe('duplicate');
        } finally { db.close(); store.close(); }
      }
    } finally { fresh.close(); }
  });
}

test('v8 migration rolls back the rebuilt schema when a foreign key is broken', () => {
  const path = databasePath();
  const legacy = openLegacyQueue(path, 7);
  const schema = 'SELECT name, sql FROM sqlite_schema ORDER BY name';
  try {
    legacy.exec('PRAGMA foreign_keys = OFF');
    legacy.exec('INSERT INTO release_recovery VALUES (999)');
    const original = legacy.query(schema).all();
    expect(() => openStore(path)).toThrow();
    expect(legacy.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    expect(legacy.query(schema).all()).toEqual(original);
    expect(legacy.query('SELECT * FROM release_recovery').all()).toEqual([{ delivery_id: 999 }]);
    legacy.exec('DELETE FROM release_recovery');
    openStore(path).close();
    expect(legacy.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
  } finally { legacy.close(); }
});

test('a fresh v8 database accepts only GitHub deliveries and deduplicates by ID and body', () => {
  const path = databasePath();
  const store = openStore(path);
  const db = new Database(path);
  try {
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    expect(db.query<{ name: string }, []>('PRAGMA table_info(deliveries)').all().map(column => column.name))
      .not.toContain('dedupe_kind');
    expect(() => db.exec(`INSERT INTO deliveries (source, delivery_id, event, raw, body_hash, received_at)
      VALUES ('unknown', 'external', 'event', X'7B7D', 'hash', 1)`)).toThrow(/CHECK constraint failed/);
    expect(store.accept(input())).toBe('accepted');
    expect(store.accept(input())).toBe('duplicate');
    expect(store.accept({ ...input(), raw: new Uint8Array([1]) })).toBe('conflict');
  } finally { db.close(); store.close(); }
});

for (const version of [5, 9]) {
  test(`rejects unsupported database version ${version}`, () => {
    const path = databasePath();
    const db = openLegacyQueue(path, 6);
    try {
      db.exec(`PRAGMA user_version = ${version}`);
      expect(() => openStore(path)).toThrow('unsupported database schema');
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: version });
    } finally { db.close(); }
  });
}
