import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type OutgoingMessage, type Store } from '../src/store';
import { deliverOnce, runOnce } from '../src/worker';
import { sendMessage } from '../src/telegram';
const dirs: string[] = [],
  stores: Store[] = [];
function path() {
  const dir = mkdtempSync(join(tmpdir(), 'release-store-'));
  dirs.push(dir);
  return join(dir, 'queue.sqlite');
}
function open(file = path()) {
  const store = openStore(file);
  stores.push(store);
  return store;
}
function accept(store: Store, id = 'first') {
  store.accept({
    source: 'github',
    event: 'pull_request',
    deliveryId: id,
    receivedAt: 1000,
    raw: new TextEncoder().encode(
      JSON.stringify({
        action: 'enqueued',
        repository: { full_name: 'Cringe-Driven-Development-Team/frontend' },
        pull_request: { number: 1, base: { ref: 'main' } },
      }),
    ),
  });
}
const card: OutgoingMessage = {
  topic: 88,
  html: 'Queue',
  release: { kind: 'queue', key: 'queue:entry-1', prNumber: 1, queueEntryId: 'entry-1' },
  keyboard: [
    [{ text: 'PR', url: 'https://github.com/org/repo/pull/1' }],
    [{ text: 'Logs', url: 'https://github.com/org/repo/actions' }],
  ],
};
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
test('v2_database_keeps_existing_outbox_and_review_groups', () => {
  const file = path(),
    db = new Database(file);
  db.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../src/review-groups-schema.sql', import.meta.url), 'utf8'));
  db.exec(
    "PRAGMA user_version=2; INSERT INTO deliveries (id,source,delivery_id,dedupe_kind,event,raw,body_hash,received_at,prepared) VALUES (1,'github','old','id','issues',X'7B7D','hash',1,1); INSERT INTO outbox (origin_type,origin_id,ordinal,topic,html,button_json,due_at) VALUES ('delivery',1,0,26,'Old','{\"text\":\"Open\",\"url\":\"https://github.com/org/repo\"}',1); INSERT INTO review_groups (repository,pr_number,reviewer,due_at) VALUES ('org/repo',1,'mentor',1000);",
  );
  db.close();
  const s = open(file);
  expect(s.releaseActivation()).toBeNull();
  expect(s.claimDue(1000, 100)[0]).toMatchObject({
    html: 'Old',
    button: { text: 'Open', url: 'https://github.com/org/repo' },
  });
  const inspect = new Database(file);
  expect(inspect.query('SELECT count(*) AS n FROM review_groups').get()).toEqual({ n: 1 });
  expect(inspect.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
  inspect.close();
});
test('activation_is_persistent_and_immutable', () => {
  const file = path(),
    s = open(file);
  s.activateReleases(500);
  s.activateReleases(500);
  expect(() => s.activateReleases(501)).toThrow();
  s.close();
  expect(open(file).releaseActivation()).toBe(500);
});
test('semantic_key_is_unique_across_distinct_deliveries', () => {
  const s = open();
  s.activateReleases(500);
  accept(s);
  accept(s, 'second');
  for (const d of s.claimUnprepared(1000, 100, 'release-queue')) s.prepare(d.id, [card]);
  expect(s.claimDue(1000, 100)).toHaveLength(1);
});
test('confirmed_429_retries_current_release_and_persists_success', async () => {
  const s = open();
  s.activateReleases(500);
  accept(s);
  s.prepare(s.claimUnprepared(1000, 100, 'release-queue')[0]!.id, [card]);
  let sends = 0;
  const send = async () =>
    ++sends === 1
      ? { kind: 'retry' as const, errorCode: 'telegram_429', retryAfterMs: 1000 }
      : { kind: 'sent' as const, telegramMessageId: 42 };
  await deliverOnce({ store: s, now: 1000, send, beforeReleaseSend: async () => 'send' });
  await deliverOnce({ store: s, now: 3000, send, beforeReleaseSend: async () => 'send' });
  expect(sends).toBe(2);
  expect(s.claimDue(125000, 1000)).toHaveLength(0);
  expect(s.retryFailed(1, 126000)).toBe(false);
});
test('keyboard_round_trips_ordered_rows', async () => {
  const s = open();
  s.activateReleases(500);
  accept(s);
  s.prepare(s.claimUnprepared(1000, 100, 'release-queue')[0]!.id, [card]);
  const message = s.claimDue(1000, 100)[0]!;
  expect(message.keyboard).toEqual(card.keyboard);
  let body: Record<string, unknown> = {};
  await sendMessage(message, { botToken: 'test', chatId: '-1' }, (async (
    _url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: { message_id: 9 } });
  }) as unknown as typeof fetch);
  expect(body.reply_markup).toEqual({ inline_keyboard: card.keyboard });
});
test('accepted_message_without_saved_message_id_never_auto_resends', () => {
  const file = path(),
    s = open(file);
  s.activateReleases(500);
  accept(s);
  s.prepare(s.claimUnprepared(1000, 100, 'release-queue')[0]!.id, [card]);
  const message = s.claimDue(1000, 100)[0]!;
  expect(s.beginReleaseSend(message.id, 1000)).toBe(true);
  s.close();
  const recovered = open(file);
  expect(recovered.claimDue(1200, 100)).toEqual([]);
  const db = new Database(file);
  expect(db.query('SELECT status,error_code FROM outbox').get()).toEqual({
    status: 'failed',
    error_code: 'release_uncertain',
  });
  db.close();
  expect(recovered.retryFailed(message.id, 1300)).toBe(true);
  const next = recovered.claimDue(1300, 100)[0]!;
  expect(recovered.beginReleaseSend(next.id, 1300)).toBe(true);
});
test('release_delivery_is_isolated_and_recovery_is_addressed', () => {
  const s = open();
  accept(s);
  expect(s.claimUnprepared(1000, 100)).toEqual([]);
  s.activateReleases(1100);
  expect(s.claimUnprepared(1200, 100, 'release-queue')).toEqual([]);
  expect(s.recoverReleaseDelivery(1)).toBe(true);
  expect(s.claimUnprepared(1200, 100, 'release-queue')).toHaveLength(1);
});
test('release_network_failure_requires_review', async () => {
  const file = path(),
    s = open(file);
  s.activateReleases(500);
  s.accept({
    source: 'github',
    event: 'issues',
    deliveryId: 'normal',
    receivedAt: 1000,
    raw: new TextEncoder().encode('{}'),
  });
  const send = (m: OutgoingMessage) =>
    sendMessage(m, { botToken: 'test', chatId: '-1' }, (async () => {
      throw new Error('secret URL');
    }) as unknown as typeof fetch);
  await runOnce({ store: s, now: 1000, project: async () => [card], send });
  const db = new Database(file);
  expect(db.query('SELECT status,error_code FROM outbox').get()).toEqual({
    status: 'failed',
    error_code: 'release_uncertain',
  });
  db.close();
});
test('ordinary_network_failure_still_retries', async () => {
  const file = path(),
    s = open(file);
  s.accept({
    source: 'github',
    event: 'issues',
    deliveryId: 'ordinary',
    receivedAt: 1000,
    raw: new TextEncoder().encode('{}'),
  });
  await runOnce({
    store: s,
    now: 1000,
    project: async () => [{ topic: 26, html: 'Ordinary' }],
    send: (m) =>
      sendMessage(m, { botToken: 'test', chatId: '-1' }, (async () => {
        throw new Error('network');
      }) as unknown as typeof fetch),
  });
  const db = new Database(file);
  expect(db.query('SELECT status FROM outbox').get()).toEqual({ status: 'pending' });
  db.close();
});
test('activation_and_recovery_cli_validate_and_persist', () => {
  const file = path(),
    s = open(file);
  accept(s);
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const env = {
    ...process.env,
    DATABASE_PATH: file,
    TELEGRAM_RELEASES_TOPIC_ID: '88',
    GITHUB_API_TOKEN: 'test',
  };
  const activated = Bun.spawnSync(['bun', cli, 'release-activate', '1970-01-01T00:00:01.100Z'], {
    env,
  });
  expect(activated.exitCode).toBe(0);
  expect(s.releaseActivation()).toBe(1100);
  const recovered = Bun.spawnSync(['bun', cli, 'release-recover', '1'], { env });
  expect(recovered.exitCode).toBe(0);
  expect(s.claimUnprepared(1200, 100, 'release-queue')).toHaveLength(1);
  expect(Bun.spawnSync(['bun', cli, 'release-activate', 'yesterday'], { env }).exitCode).toBe(1);
});
test('http_acceptance_then_database_failure_does_not_send_twice', async () => {
  const file = path(),
    s = open(file);
  s.activateReleases(500);
  s.accept({
    source: 'github',
    event: 'issues',
    deliveryId: 'crash',
    receivedAt: 1000,
    raw: new TextEncoder().encode('{}'),
  });
  let calls = 0;
  const send = (m: OutgoingMessage) =>
    sendMessage(m, { botToken: 'test', chatId: '-1' }, (async () => {
      calls++;
      return Response.json({ ok: true, result: { message_id: 91 } });
    }) as unknown as typeof fetch);
  const save = s.markSent.bind(s);
  s.markSent = () => {
    throw new Error('storage unavailable');
  };
  await expect(runOnce({ store: s, now: 1000, project: async () => [card], send })).rejects.toThrow(
    'storage unavailable',
  );
  s.markSent = save;
  await runOnce({ store: s, now: 122000, project: async () => [card], send });
  expect(calls).toBe(1);
});
test('ordinary_preparation_time_does_not_shorten_telegram_retry_after', async () => {
  const file = path(),
    s = open(file);
  s.accept({
    source: 'github',
    event: 'issues',
    deliveryId: 'slow',
    receivedAt: 1000,
    raw: new TextEncoder().encode('{}'),
  });
  await runOnce({
    store: s,
    now: 1000,
    project: async () => {
      await Bun.sleep(35);
      return [{ topic: 26, html: 'Ordinary' }];
    },
    send: (m) =>
      sendMessage(m, { botToken: 'test', chatId: '-1' }, (async () =>
        Response.json(
          { ok: false, parameters: { retry_after: 1 } },
          { status: 429 },
        )) as unknown as typeof fetch),
  });
  const db = new Database(file);
  const row = db.query<{ due_at: number }, []>('SELECT due_at FROM outbox').get()!;
  expect(row.due_at).toBeGreaterThanOrEqual(3030);
  db.close();
});
test('skipped_release_keeps_reason_and_cannot_be_manually_retried', () => {
  const file = path(),
    s = open(file);
  s.activateReleases(500);
  accept(s);
  s.prepare(s.claimUnprepared(1000, 100, 'release-queue')[0]!.id, [card]);
  const message = s.claimDue(1000, 100)[0]!;
  s.skipRelease(message.id, 'stale');
  const db = new Database(file);
  expect(db.query('SELECT skip_reason FROM release_notices').get()).toEqual({
    skip_reason: 'stale',
  });
  db.close();
  expect(s.retryFailed(message.id, 1100)).toBe(false);
});
test('invalid_activation_dates_do_not_create_a_cutoff', () => {
  for (const value of ['2026-02-31T00:00:00Z', '2099-01-01T00:00:00Z']) {
    const file = path();
    const result = Bun.spawnSync(
      ['bun', new URL('../src/cli.ts', import.meta.url).pathname, 'release-activate', value],
      {
        env: {
          ...process.env,
          DATABASE_PATH: file,
          TELEGRAM_RELEASES_TOPIC_ID: '88',
          GITHUB_API_TOKEN: 'test',
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(open(file).releaseActivation()).toBeNull();
  }
});
