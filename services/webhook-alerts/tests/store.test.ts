import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
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

  test('source namespaces keep supplied Apidog IDs independent with permanent deduplication', () => {
    const store = open();
    store.accept(input());
    const apidog = { ...input(), source: 'apidog' as const };
    expect(store.accept(apidog)).toBe('accepted');
    expect(store.accept({ ...apidog, receivedAt: 900000 })).toBe('duplicate');
    expect(store.accept({ ...apidog, raw: new Uint8Array([123, 125]) })).toBe('conflict');
    expect(store.claimUnprepared(900000, 100)).toHaveLength(2);
  });

  test('Apidog hash fallback uses a rolling five-minute window across clock bucket boundaries and restarts', () => {
    const path = databasePath();
    const first = open(path);
    const apidog = { source: 'apidog' as const, event: 'changed', raw, receivedAt: 299999 };
    expect(first.accept(apidog)).toBe('accepted');
    first.close();
    const reopened = open(path);
    expect(reopened.accept({ ...apidog, receivedAt: 300001 })).toBe('duplicate');
    expect(reopened.accept({ ...apidog, receivedAt: 599998 })).toBe('duplicate');
    expect(reopened.accept({ ...apidog, receivedAt: 599999 })).toBe('accepted');
    expect(reopened.claimUnprepared(599999, 100)).toHaveLength(2);
  });

  test('GitHub cannot silently fall back to a body hash when its ID is absent', () => {
    expect(() => open().accept({ source: 'github', event: 'issues', raw })).toThrow();
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
  const config = loadConfig({ GITHUB_WEBHOOK_SECRET: secret, APIDOG_SIGNATURE_KEY: 'test-apidog', APIDOG_SIGNATURE_HEADER: 'X-Test-Signature' });
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
