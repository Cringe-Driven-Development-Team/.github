import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store, type OutgoingMessage } from '../src/store';
import { createGithubProjector, runOnce } from '../src/worker';
import { createGithubApi } from '../src/github-api';
import { ReviewGroups } from '../src/review-groups';
import prFixture from './fixtures/github/pr-opened.json';

const directories: string[] = [], stores: Store[] = [];
function open(path?: string) {
  if (!path) { const dir = mkdtempSync(join(tmpdir(), 'reviews-')); directories.push(dir); path = join(dir, 'db.sqlite'); }
  const store = openStore(path); stores.push(store); return { store, path };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function review(store: Store, id: number, now: number, state = 'commented', reviewer = 'reviewer', repo = 'org/repo', number = 7) {
  const payload = { action: 'submitted', repository: { full_name: repo },
    pull_request: { number, title: 'Review aggregation', html_url: `https://github.com/${repo}/pull/${number}`, user: { login: 'author' } },
    review: { id, state, user: { login: reviewer, type: 'User' }, body: `Comment ${id}`,
      submitted_at: new Date(now).toISOString(), html_url: `https://github.com/${repo}/pull/${number}#pullrequestreview-${id}` } };
  store.accept({ source: 'github', event: 'pull_request_review', deliveryId: `review-${id}`, raw: Buffer.from(JSON.stringify(payload)), receivedAt: now });
}
const project = createGithubProjector(createGithubApi({ token: 'test', fetch: async url => new Response(JSON.stringify(url.includes('/comments?') ? [{ pull_request_review_id: 1 }, { pull_request_review_id: 2 }] : [])) }), { userMap: { author: '111' } });
function worker(store: Store, sent: OutgoingMessage[], now: number) {
  return runOnce({ store, project, now, send: async message => { sent.push(message); return { kind: 'sent', telegramMessageId: sent.length }; } });
}
function outbox(path: string) { const db = new Database(path); try { return db.query<Record<string, unknown>, []>('SELECT * FROM outbox ORDER BY id').all(); } finally { db.close(); } }

test('two comments notify once 180 seconds after the last comment and survive restart', async () => {
  const { store, path } = open(); const sent: OutgoingMessage[] = [];
  review(store, 1, 1000); await worker(store, sent, 1000);
  review(store, 2, 121000); await worker(store, sent, 121000);
  store.close(); const reopened = open(path).store;
  await worker(reopened, sent, 300999); expect(sent).toHaveLength(0);
  await worker(reopened, sent, 301000); expect(sent).toHaveLength(1);
  expect(sent[0]!.html).toContain('Комментарии к PR'); expect(sent[0]!.html).toContain('4 комментария');
  expect(sent[0]!.html).toContain('tg://user?id=111'); expect(sent[0]!.button?.url).toEndWith('pullrequestreview-1');
  await worker(reopened, sent, 999000); expect(sent).toHaveLength(1);
  expect(outbox(path)[0]).toMatchObject({ origin_type: 'review_group', ordinal: 0, status: 'sent' });
});

test.each(['approved', 'changes_requested'])('%s immediately consumes pending comments without a delayed duplicate', async state => {
  const { store, path } = open(); const sent: OutgoingMessage[] = [];
  review(store, 1, 1000); await worker(store, sent, 1000);
  review(store, 2, 2000, state); await worker(store, sent, 2000);
  expect(sent).toHaveLength(1); expect(sent[0]!.html).toContain(state === 'approved' ? 'Апрув' : 'Запрошены правки');
  expect(sent[0]!.html).toContain('4 комментария'); expect(sent[0]!.button?.url).toEndWith('pullrequestreview-1');
  store.close(); await worker(open(path).store, sent, 500000); expect(sent).toHaveLength(1);
});

test('a verdict without comments is immediate and a later comment starts a fresh series', async () => {
  const { store } = open(); const sent: OutgoingMessage[] = [];
  review(store, 10, 1000, 'approved'); await worker(store, sent, 1000); expect(sent).toHaveLength(1);
  review(store, 11, 2000); await worker(store, sent, 2000); expect(sent).toHaveLength(1);
  await worker(store, sent, 182000); expect(sent).toHaveLength(2); expect(sent[1]!.html).toContain('1 комментарий');
});

test('repository, PR and reviewer each separate comment groups', async () => {
  const { store } = open(); const sent: OutgoingMessage[] = [];
  review(store, 1, 1000); review(store, 2, 1000, 'commented', 'other');
  review(store, 3, 1000, 'commented', 'reviewer', 'org/other'); review(store, 4, 1000, 'commented', 'reviewer', 'org/repo', 8);
  await worker(store, sent, 1000); await worker(store, sent, 181000); expect(sent).toHaveLength(4);
});

test('PR open creates two independently retryable messages', async () => {
  const { store, path } = open();
  store.accept({ source: 'github', event: 'pull_request', deliveryId: 'opened', receivedAt: 1000,
    raw: Buffer.from(JSON.stringify({ ...prFixture, pull_request: { ...prFixture.pull_request, requested_reviewers: [{ login: 'reviewer' }] } })) });
  const sent: number[] = [];
  const send = async (message: OutgoingMessage) => { sent.push(message.topic); return message.topic === 26
    ? { kind: 'sent' as const, telegramMessageId: 9 } : { kind: 'retry' as const, errorCode: 'network', retryAfterMs: 1000 }; };
  await runOnce({ store, project, send, now: 1000 });
  expect(outbox(path).map(row => [row.ordinal, row.status])).toEqual([[0, 'sent'], [1, 'pending']]);
  await runOnce({ store, project, send, now: 3000 }); expect(sent).toEqual([26, 1513, 1513]);
});

test('a verdict beyond the delivery claim limit consumes the backlog before comments release', async () => {
  const { store } = open(); const sent: OutgoingMessage[] = [];
  for (let id = 1; id <= 10; id++) review(store, id, id * 1000);
  review(store, 11, 11000, 'approved');
  await worker(store, sent, 300000); await worker(store, sent, 301000);
  expect(sent).toHaveLength(1); expect(sent[0]!.html).toContain('Апрув');
});


function record(store: Store, groups: ReviewGroups, id: number, now: number, state = 'commented') {
  review(store, id, now, state);
  const [delivery] = store.claimUnprepared(now, 100);
  groups.record(delivery!, now);
  store.prepare(delivery!.id, []);
  return delivery!;
}

test('record survives a crash before prepare without extending the timer on replay', async () => {
  const { store, path } = open(); const groups = new ReviewGroups(store);
  review(store, 1, 1000); const [delivery] = store.claimUnprepared(1000, 100);
  groups.record(delivery!, 1000); store.close();
  const reopened = open(path).store, after = new ReviewGroups(reopened);
  const [replayed] = reopened.claimUnprepared(10000, 100);
  after.record(replayed!, 10000); reopened.prepare(replayed!.id, []);
  expect(await after.releaseDue(180999, project.reviewGroup!)).toBe(0);
  expect(await after.releaseDue(181000, project.reviewGroup!)).toBe(1);
  expect(await after.releaseDue(181000, project.reviewGroup!)).toBe(0);
  expect(outbox(path)).toHaveLength(1);
});

test('the same GitHub review under a different delivery ID does not create another group', async () => {
  const { store, path } = open(); const groups = new ReviewGroups(store);
  const delivery = record(store, groups, 1, 1000);
  expect(await groups.releaseDue(181000, project.reviewGroup!)).toBe(1);
  store.accept({ ...delivery, deliveryId: 'another-webhook-id', receivedAt: 200000 });
  const [duplicate] = store.claimUnprepared(200000, 100);
  groups.record(duplicate!, 200000); store.prepare(duplicate!.id, []);
  expect(await groups.releaseDue(500000, project.reviewGroup!)).toBe(0); expect(outbox(path)).toHaveLength(1);
});

test('a group extended during asynchronous projection never releases a stale snapshot', async () => {
  const { store, path } = open(); const groups = new ReviewGroups(store);
  record(store, groups, 1, 1000);
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const pending = groups.releaseDue(181000, async deliveries => { await gate; return project.reviewGroup!(deliveries); });
  // A separate connection can commit while the projection is awaiting the API.
  const second = open(path).store;
  record(second, new ReviewGroups(second), 2, 181000);
  resume(); expect(await pending).toBe(0); expect(outbox(path)).toHaveLength(0);
  expect(await groups.releaseDue(360999, project.reviewGroup!)).toBe(0);
  expect(await groups.releaseDue(361000, project.reviewGroup!)).toBe(1);
  expect(outbox(path)[0]!.html).toContain('4 комментария');
});

test('concurrent release attempts commit one stable origin only', async () => {
  const { store, path } = open(); const groups = new ReviewGroups(store);
  record(store, groups, 1, 1000);
  const other = new ReviewGroups(open(path).store);
  const results = await Promise.all([groups.releaseDue(181000, project.reviewGroup!), other.releaseDue(181000, project.reviewGroup!)]);
  expect(results.sort()).toEqual([0, 1]); expect(outbox(path)).toHaveLength(1);
});

test('projection failure and a partial outbox insertion both retain a retryable group', async () => {
  const { store, path } = open(); const groups = new ReviewGroups(store);
  record(store, groups, 1, 1000);
  await expect(groups.releaseDue(181000, async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
  expect(outbox(path)).toHaveLength(0);
  const db = new Database(path);
  const messages = [{ topic: 26, html: 'one' }, { topic: 1513, html: 'two' }];
  try {
    db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON outbox WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    await expect(groups.releaseDue(181000, async () => messages)).rejects.toThrow('test write failure');
    expect(outbox(path)).toHaveLength(0);
    db.exec('DROP TRIGGER reject_second');
    expect(await groups.releaseDue(181000, async () => messages)).toBe(1);
    expect(outbox(path).map(row => [row.origin_type, row.origin_id, row.ordinal])).toEqual([['review_group', 1, 0], ['review_group', 1, 1]]);
  } finally { db.close(); }
});

test('failure to persist a commented group cannot silently prepare its source delivery', async () => {
  const { store, path } = open(); const sent: OutgoingMessage[] = [];
  review(store, 1, 1000);
  const db = new Database(path);
  try {
    db.exec("CREATE TRIGGER reject_group BEFORE INSERT ON review_groups BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    await worker(store, sent, 1000);
    expect(db.query('SELECT prepared FROM deliveries').get()).toEqual({ prepared: 0 });
    db.exec('DROP TRIGGER reject_group');
    await worker(store, sent, 181000); expect(sent).toHaveLength(1);
  } finally { db.close(); }
});

test('API outage retains a basic review card without inventing a count', async () => {
  const { store } = open(); const groups = new ReviewGroups(store);
  record(store, groups, 1, 1000);
  const unavailable = createGithubProjector(createGithubApi(), { warn: () => {} });
  expect(await groups.releaseDue(181000, unavailable.reviewGroup!)).toBe(1);
  const [message] = store.claimDue(181000, 100);
  expect(message!.html).toContain('Комментарии к PR'); expect(message!.html).not.toContain('1 комментарий');
  expect(message!.button?.url).toEndWith('pullrequestreview-1');
});


test('opening a schema-v1 database preserves queued messages and enables review groups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviews-v1-')); directories.push(dir);
  const path = join(dir, 'db.sqlite'), db = new Database(path);
  try {
    db.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
    db.exec("INSERT INTO outbox (origin_type, origin_id, ordinal, topic, html, due_at) VALUES ('delivery', 1, 0, 26, 'queued before upgrade', 1000)");
    db.exec('PRAGMA user_version = 1');
  } finally { db.close(); }
  const { store } = open(path); const groups = new ReviewGroups(store);
  record(store, groups, 1, 1000);
  expect(await groups.releaseDue(181000, project.reviewGroup!)).toBe(1);
  expect(store.claimDue(181000, 100).map(row => [row.originType, row.ordinal])).toEqual([['delivery', 0], ['review_group', 0]]);
  expect(outbox(path)[0]!.html).toBe('queued before upgrade');
});
