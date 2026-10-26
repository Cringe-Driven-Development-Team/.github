import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApidogMr } from '../src/apidog-api';
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

  for (const origin of ['delivery', 'review_group'] as const) {
    test(`${origin} preserves both buttons across reopening alongside a one-button card`, () => {
      const path = databasePath();
      const first = open(path);
      first.accept(input());
      const [delivery] = first.claimUnprepared(1000, 100);
      const twoButtons = {
        topic: 26, html: 'Apidog MR',
        button: { text: 'Открыть MR', url: 'https://app.apidog.com/...' },
        secondaryButton: { text: 'Контракт API', url: 'https://vb78fyael1.apidog.io/' },
      };
      if (origin === 'delivery') first.prepare(delivery!.id, [twoButtons, messages[0]!]);
      else {
        first.recordReview(delivery!.id, { repository: 'org/repo', number: 1, reviewer: 'alice', id: 1, state: 'approved' }, 1000);
        const [group] = first.dueReviewGroups(1000);
        expect(first.releaseReviewGroup(group!.id, group!.revision, [twoButtons, messages[0]!], 1000)).toBe(true);
      }
      first.close();
      const reopened = open(path);
      const queued = reopened.claimDue(1100, 100);
      expect(queued).toHaveLength(2);
      expect(queued[0]!.button).toEqual({ text: 'Открыть MR', url: 'https://app.apidog.com/...' });
      expect(queued[0]).toHaveProperty('secondaryButton', { text: 'Контракт API', url: 'https://vb78fyael1.apidog.io/' });
      expect(queued[1]!.button).toEqual({ text: 'Open issue', url: 'https://github.com/org/repo/issues/1' });
      expect(queued[1]).not.toHaveProperty('secondaryButton');
      const inspect = new Database(path);
      try {
        expect(inspect.query<{ button_json: string }, []>('SELECT button_json FROM outbox ORDER BY id DESC LIMIT 1').get()!.button_json)
          .toBe('{"text":"Open issue","url":"https://github.com/org/repo/issues/1"}');
      } finally { inspect.close(); }
    });
  }

  test('a prepared Apidog message retains its source across restart and retry', () => {
    const path = databasePath();
    const first = open(path);
    first.accept({ ...input('apidog-1'), source: 'apidog' });
    const [delivery] = first.claimUnprepared(1000, 100);
    first.prepare(delivery!.id, [{ topic: 26, html: 'Apidog update' }]);
    first.close();

    const reopened = open(path);
    const [queued] = reopened.claimDue(1100, 100);
    expect(queued).toMatchObject({ source: 'apidog', topic: 26, html: 'Apidog update', originType: 'delivery' });
    reopened.markRetry(queued!.id, 1300, 'telegram_429');
    reopened.close();

    const retried = open(path);
    expect(retried.claimDue(1300, 100)[0]).toMatchObject({ id: queued!.id, source: 'apidog', attempts: 2 });
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


describe('Apidog MR monitoring', () => {
  const mr = (overrides: Partial<ApidogMr> = {}): ApidogMr => ({ id: 7, sourceBranchId: 2, targetBranchId: 1, createdById: 3, reviewerIds: [4], description: 'Review me', status: 'OPEN', createdAt: new Date(999).toISOString(), closedAt: null, closedById: null, ...overrides });
  test('first cutoff persists across restart, with equality eligible', () => {
    const path = databasePath(); const first = open(path);
    first.startApidogMrMonitoring(1000);
    expect(first.claimUnprepared(1000, 100)).toEqual([]);
    first.close(); const store = open(path); store.startApidogMrMonitoring(5000);
    expect(store.recordApidogMergeRequests([mr(), mr({ id: 8, createdAt: new Date(1000).toISOString() })])).toBe(1);
    expect(store.claimUnprepared(5000, 100).map(row => [row.deliveryId, row.event, row.receivedAt])).toEqual([['mr-poll:8:OPENED', 'MR_OPENED', 1000]]);
    const inspect = new Database(path);
    try {
      expect(inspect.query('SELECT prepared, received_at FROM deliveries WHERE delivery_id = ?').get('mr-poll:cutoff')).toEqual({ prepared: 1, received_at: 1000 });
      expect(inspect.query('SELECT prepared FROM deliveries WHERE delivery_id = ?').get('mr-poll:7:OPENED')).toEqual({ prepared: 1 });
    } finally { inspect.close(); }
  });
  test('existing OPEN later CLOSED queues only closure, once across restart', () => {
    const path = databasePath(); const store = open(path); store.startApidogMrMonitoring(1000);
    expect(store.recordApidogMergeRequests([mr()])).toBe(0);
    const closed = mr({ status: 'CLOSED', closedAt: new Date(2000).toISOString(), closedById: 4 });
    expect(store.recordApidogMergeRequests([closed])).toBe(1);
    store.close(); const reopened = open(path);
    expect(reopened.recordApidogMergeRequests([closed])).toBe(0);
    const pending = reopened.claimUnprepared(3000, 100);
    expect(pending.map(row => [row.deliveryId, row.event, row.receivedAt])).toEqual([['mr-poll:7:CLOSED', 'MR_CLOSED', 2000]]);
    expect(JSON.parse(new TextDecoder().decode(pending[0]!.raw))).toEqual(closed);
  });
  test('new terminal MR records opened then merged and suppresses historical terminal events', () => {
    const store = open(); store.startApidogMrMonitoring(1000);
    const merged = mr({ status: 'MERGED', createdAt: new Date(1000).toISOString(), closedAt: new Date(2000).toISOString(), closedById: 4 });
    expect(store.recordApidogMergeRequests([merged, mr({ id: 8, status: 'CLOSED', closedAt: new Date(999).toISOString(), closedById: 4 })])).toBe(2);
    expect(store.recordApidogMergeRequests([merged])).toBe(0);
    expect(store.claimUnprepared(3000, 100).map(row => row.event)).toEqual(['MR_OPENED', 'MR_MERGED']);
  });
  test('requires initialization and rejects invalid or partial terminal snapshots atomically', () => {
    const store = open(); expect(() => store.recordApidogMergeRequests([mr()])).toThrow();
    expect(() => store.startApidogMrMonitoring(NaN)).toThrow(); store.startApidogMrMonitoring(1000);
    for (const invalid of [mr({ id: 8, createdAt: 'invalid' }), mr({ id: 8, status: 'CLOSED' }), mr({ id: 8, status: 'MERGED', closedAt: new Date(2000).toISOString() })]) {
      expect(() => store.recordApidogMergeRequests([mr({ createdAt: new Date(1000).toISOString() }), invalid])).toThrow();
      expect(store.claimUnprepared(3000, 100)).toEqual([]);
    }
    expect(store.recordApidogMergeRequests([mr({ createdAt: new Date(1000).toISOString() })])).toBe(1);
  });
  test('database insert failure rolls back the entire snapshot', () => {
    const path = databasePath(); const store = open(path); store.startApidogMrMonitoring(1000); const inspect = new Database(path);
    try {
      inspect.exec("CREATE TRIGGER reject_terminal BEFORE INSERT ON deliveries WHEN NEW.event = 'MR_MERGED' BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
      const merged = mr({ status: 'MERGED', createdAt: new Date(1000).toISOString(), closedAt: new Date(2000).toISOString(), closedById: 4 });
      expect(() => store.recordApidogMergeRequests([merged])).toThrow();
      expect(store.claimUnprepared(3000, 100)).toEqual([]);
      inspect.exec('DROP TRIGGER reject_terminal'); expect(store.recordApidogMergeRequests([merged])).toBe(2);
    } finally { inspect.close(); }
  });
});

test('manual retry cannot reactivate suppressed Apidog messages but still retries other failures', () => {
  const path = databasePath();
  const store = open(path);
  const inspect = new Database(path);
  try {
    inspect.exec(`INSERT INTO outbox (origin_type, origin_id, ordinal, topic, html, status, error_code, due_at) VALUES
      ('delivery', 1, 0, 88, 'suppressed', 'failed', 'APIDOG_RAW_SUPPRESSED', 1),
      ('delivery', 2, 0, 26, 'retryable', 'failed', 'telegram_400', 1),
      ('delivery', 3, 0, 26, 'retryable without code', 'failed', NULL, 1)`);
    expect(store.retryFailed(1, 1000)).toBe(false);
    expect(store.retryFailed(2, 1000)).toBe(true);
    expect(store.retryFailed(3, 1000)).toBe(true);
    expect(inspect.query('SELECT status, error_code FROM outbox ORDER BY id').all()).toEqual([
      { status: 'failed', error_code: 'APIDOG_RAW_SUPPRESSED' },
      { status: 'pending', error_code: null },
      { status: 'pending', error_code: null },
    ]);
  } finally { inspect.close(); }
});
