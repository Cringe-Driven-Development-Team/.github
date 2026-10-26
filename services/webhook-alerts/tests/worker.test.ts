import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store, type OutgoingMessage } from '../src/store';
import { sendMessage, type SendResult } from '../src/telegram';
import { runOnce, startWorker } from '../src/worker';

const config = { botToken: 'test-secret-token', chatId: '-100123' };
const card: OutgoingMessage = { topic: 26, html: '<b>Issue</b><blockquote>Quote</blockquote>', fallbackHtml: '<b>Issue</b>', button: { text: 'Open', url: 'https://github.com/org/repo/issues/1' } };
const resources: { directory: string; store: Store }[] = [];
function queue() {
  const directory = mkdtempSync(join(tmpdir(), 'webhook-worker-'));
  const path = join(directory, 'queue.sqlite');
  const store = openStore(path);
  resources.push({ directory, store });
  store.accept({ source: 'github', deliveryId: 'event-1', event: 'issues', raw: new TextEncoder().encode('{"private":"payload"}'), receivedAt: 1000 });
  return { store, path };
}
function rows(path: string) {
  const db = new Database(path);
  try { return db.query<Record<string, unknown>, []>('SELECT * FROM outbox ORDER BY id').all(); }
  finally { db.close(); }
}
function fetchResponse(status: number, body: unknown): typeof fetch {
  return (async () => Response.json(body, { status })) as unknown as typeof fetch;
}
function deps(store: Store, fetcher: typeof fetch) {
  return { store, project: async () => [card], send: (message: OutgoingMessage) => sendMessage(message, config, fetcher), now: 1000 };
}
afterEach(() => {
  for (const { directory, store } of resources.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('success sends HTML to the configured topic and persists message_id across reopening', async () => {
  const { store, path } = queue();
  let request: { url: string; body: unknown; signal: AbortSignal | null | undefined } | undefined;
  const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    request = { url: String(url), body: JSON.parse(String(init!.body)), signal: init!.signal };
    return Response.json({ ok: true, result: { message_id: 321, date: 1, chat: { id: -100123, type: 'supergroup' }, text: 'Issue' } });
  }) as unknown as typeof fetch;
  expect(await runOnce(deps(store, fetcher))).toBe(1);
  expect(request!.url).toBe('https://api.telegram.org/bottest-secret-token/sendMessage');
  expect(request!.body).toEqual({ chat_id: '-100123', message_thread_id: 26, text: card.html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[card.button]] } });
  expect(request!.signal).toBeInstanceOf(AbortSignal);
  store.close();
  const reopened = openStore(path);
  resources[resources.length - 1]!.store = reopened;
  expect(rows(path)[0]).toMatchObject({ status: 'sent', telegram_message_id: 321, lease_until: null, error_code: null });
  expect(await runOnce(deps(reopened, fetcher))).toBe(0);
});

test('worker sends the MR and API contract buttons in one ordered row', async () => {
  const { store } = queue();
  const twoButtons = {
    topic: 26, html: 'Apidog MR',
    button: { text: 'Открыть MR', url: 'https://app.apidog.com/...' },
    secondaryButton: { text: 'Контракт API', url: 'https://vb78fyael1.apidog.io/' },
  };
  const requests: unknown[] = [];
  const fetcher = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(JSON.parse(String(init!.body)));
    return Response.json({ ok: true, result: { message_id: 322 } });
  }) as unknown as typeof fetch;
  expect(await runOnce({ ...deps(store, fetcher), project: async () => [twoButtons] })).toBe(1);
  expect(requests).toEqual([{
    chat_id: '-100123', message_thread_id: 26, text: 'Apidog MR', parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[
      { text: 'Открыть MR', url: 'https://app.apidog.com/...' },
      { text: 'Контракт API', url: 'https://vb78fyael1.apidog.io/' },
    ]] },
  }]);
});

for (const proxyUrl of [undefined, 'http://proxy.internal:2080', 'https://proxy.internal:2080']) {
  test(`worker sends with ${proxyUrl === undefined ? 'no explicit proxy' : 'configured Telegram proxy'}`, async () => {
    const { store, path } = queue();
    const requests: RequestInit[] = [];
    const fetcher = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(init!);
      return Response.json({ ok: true, result: { message_id: 321 } });
    }) as unknown as typeof fetch;
    await runOnce({ ...deps(store, fetcher), send: message => sendMessage(message, { ...config, proxyUrl }, fetcher) });
    expect(requests).toHaveLength(1);
    if (proxyUrl === undefined) expect(requests[0]).not.toHaveProperty('proxy');
    else expect(requests[0]).toHaveProperty('proxy', { url: proxyUrl, respectNoProxy: false });
    expect(rows(path)[0]).toMatchObject({ status: 'sent', telegram_message_id: 321 });
  });
}

for (const [label, fetcher, code] of [
  ['500', fetchResponse(500, { ok: false, error_code: 500, description: 'private server response' }), 'telegram_500'],
  ['network', (async () => { throw new Error('URL with test-secret-token'); }) as unknown as typeof fetch, 'network'],
] as const) {
  test(`${label} failure persists backoff and does not retry before due time`, async () => {
    const { store, path } = queue();
    await runOnce(deps(store, fetcher));
    const row = rows(path)[0]!;
    expect(row).toMatchObject({ status: 'pending', attempts: 1, error_code: code, lease_until: null });
    expect(Number(row.due_at)).toBeGreaterThan(1000);
    expect(Number(row.due_at)).toBeLessThanOrEqual(61100);
    expect(await runOnce({ ...deps(store, fetcher), now: Number(row.due_at) - 1 })).toBe(0);
    expect(await runOnce({ ...deps(store, fetchResponse(200, { ok: true, result: { message_id: 7 } })), now: Number(row.due_at) })).toBe(1);
    expect(rows(path)[0]).toMatchObject({ status: 'sent', attempts: 2, telegram_message_id: 7 });
  });
}

test('429 respects retry_after plus a safety margin', async () => {
  const { store, path } = queue();
  await runOnce(deps(store, fetchResponse(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 120 } })));
  expect(rows(path)[0]).toMatchObject({ status: 'pending', error_code: 'telegram_429' });
  expect(Number(rows(path)[0]!.due_at)).toBeGreaterThan(121000);
  expect(Number(rows(path)[0]!.due_at)).toBeLessThanOrEqual(123000);
});

for (const retryAfter of [undefined, null, '12', 0, -10, 1.5, 1e300]) {
  test(`invalid retry_after ${String(retryAfter)} uses bounded positive backoff even after many attempts`, async () => {
    const { store, path } = queue();
    const fetcher = fetchResponse(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: retryAfter } });
    let now = 1000;
    for (let i = 0; i < 15; i++) {
      await runOnce({ ...deps(store, fetcher), now });
      const dueAt = Number(rows(path)[0]!.due_at);
      expect(dueAt).toBeGreaterThanOrEqual(now + [1000, 2000, 4000, 8000, 16000, 30000][Math.min(i, 5)]!);
      expect(dueAt).toBeLessThanOrEqual(now + 60100);
      now = dueAt;
    }
  });
}

test('permanent 400 is failed and actual retry CLI requeues the same row without a new delivery', async () => {
  const { store, path } = queue();
  await runOnce(deps(store, fetchResponse(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found private data' })));
  const before = rows(path)[0]!;
  expect(before).toMatchObject({ status: 'failed', error_code: 'telegram_400', lease_until: null });
  expect(await runOnce({ ...deps(store, fetchResponse(200, { ok: true, result: { message_id: 1 } })), now: 999999 })).toBe(0);
  const child = Bun.spawn([process.execPath, 'run', 'src/cli.ts', 'retry', String(before.id)], { cwd: join(import.meta.dir, '..'), env: { ...Bun.env, DATABASE_PATH: path }, stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
  const after = rows(path);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ id: before.id, origin_id: before.origin_id, status: 'pending', error_code: null, attempts: 1 });
  expect(store.accept({ source: 'github', deliveryId: 'event-1', event: 'issues', raw: new TextEncoder().encode('{"private":"payload"}') })).toBe('duplicate');
});

test('lease expiry after a crash resumes the same outbox message', async () => {
  const { store, path } = queue();
  const [delivery] = store.claimUnprepared(1000, 100);
  store.prepare(delivery!.id, [card]);
  const [leased] = store.claimDue(1000, 100);
  store.close();
  const reopened = openStore(path);
  resources[resources.length - 1]!.store = reopened;
  const next = deps(reopened, fetchResponse(200, { ok: true, result: { message_id: 99 } }));
  expect(await runOnce({ ...next, now: 1099 })).toBe(0);
  expect(await runOnce({ ...next, now: 1100 })).toBe(1);
  expect(rows(path)[0]).toMatchObject({ id: leased!.id, status: 'sent', attempts: 2, telegram_message_id: 99 });
});

test('entity parse rejection retries once without quote and persists fallback for network retries', async () => {
  const { store, path } = queue();
  let calls = 0;
  const texts: string[] = [];
  const fetcher = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    texts.push(JSON.parse(String(init!.body)).text);
    if (++calls === 1) return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unsupported start tag" }, { status: 400 });
    throw new Error('network unavailable');
  }) as unknown as typeof fetch;
  await runOnce(deps(store, fetcher));
  expect(texts).toEqual([card.html, card.fallbackHtml!]);
  expect(rows(path)[0]).toMatchObject({ status: 'pending', html: card.fallbackHtml, fallback_html: null });
  await runOnce({ ...deps(store, fetchResponse(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" })), now: Number(rows(path)[0]!.due_at) });
  expect(rows(path)[0]).toMatchObject({ status: 'failed', error_code: 'telegram_entities' });
});

test('poller stops after abort and does not overlap work', async () => {
  const { store, path } = queue();
  const controller = new AbortController();
  await startWorker({ store, project: async () => [card], send: async (): Promise<SendResult> => {
    controller.abort();
    return { kind: 'sent', telegramMessageId: 42 };
  }, signal: controller.signal });
  expect(rows(path)[0]).toMatchObject({ status: 'sent', telegram_message_id: 42, attempts: 1 });
});

test('logs include HTTP status but never Telegram body, payload, card or bot token', async () => {
  const { store } = queue();
  const logs: string[] = [];
  const info = spyOn(console, 'info').mockImplementation(value => { logs.push(String(value)); });
  const error = spyOn(console, 'error').mockImplementation(value => { logs.push(String(value)); });
  try {
    await runOnce(deps(store, fetchResponse(200, { ok: true, result: { message_id: 8 }, private: 'private-body-marker' })));
    expect(JSON.parse(logs[0]!)).toMatchObject({ outboxId: 1, attempt: 1, httpStatus: 200, result: 'sent' });
    const output = logs.join('');
    for (const sensitive of ['test-secret-token', 'private-body-marker', 'payload', '<blockquote>', 'https://github.com']) expect(output).not.toContain(sensitive);
  } finally { info.mockRestore(); error.mockRestore(); }
});

test('invalid success JSON retries and non-JSON permanent 403 remains failed', async () => {
  const { store, path } = queue();
  await runOnce(deps(store, fetchResponse(200, { ok: true, result: {} })));
  expect(rows(path)[0]).toMatchObject({ status: 'pending', error_code: 'telegram_invalid_response' });
  const fetcher = (async () => new Response('private proxy response', { status: 403 })) as unknown as typeof fetch;
  await runOnce({ ...deps(store, fetcher), now: Number(rows(path)[0]!.due_at) });
  expect(rows(path)[0]).toMatchObject({ status: 'failed', error_code: 'telegram_403' });
});

test('retry CLI refuses a sent message and malformed IDs', async () => {
  const { store, path } = queue();
  await runOnce(deps(store, fetchResponse(200, { ok: true, result: { message_id: 8 } })));
  for (const id of ['1', '0', '1x']) {
    const child = Bun.spawn([process.execPath, 'run', 'src/cli.ts', 'retry', id], { cwd: join(import.meta.dir, '..'), env: { ...Bun.env, DATABASE_PATH: path }, stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(1);
  }
  expect(rows(path)[0]).toMatchObject({ status: 'sent', telegram_message_id: 8, attempts: 1 });
});

test('retry_after starts after the Telegram response rather than at the beginning of a slow batch', async () => {
  const { store, path } = queue();
  await runOnce({ store, project: async () => [card], now: 1000, send: async () => {
    await Bun.sleep(40);
    return { kind: 'retry', errorCode: 'telegram_429', httpStatus: 429, retryAfterMs: 1000 };
  } });
  expect(Number(rows(path)[0]!.due_at)).toBeGreaterThanOrEqual(2040);
});

test('projector prepares only polled MR deliveries while raw Apidog webhooks remain silent', async () => {
  const { createProjector } = await import('../src/worker');
  const { store, path } = queue();
  // Complete the helper's GitHub row before exercising the Apidog queue.
  for (const delivery of store.claimUnprepared(1000, 1000)) store.prepare(delivery.id, []);
  const mr = { id: 39834, sourceBranchId: 5, targetBranchId: 1388508, createdById: 1, reviewerIds: [], status: 'OPEN', description: 'Contract change', createdAt: '2026-10-26T10:00:00Z', closedAt: null, closedById: null };
  for (const [deliveryId, event] of [['raw-api', 'API_UPDATED'], ['raw-branch', 'BRANCH_CREATED'], ['mr-poll:39834:OPENED', 'MR_OPENED']]) {
    store.accept({ source: 'apidog', deliveryId: deliveryId!, event: event!, raw: new TextEncoder().encode(JSON.stringify(mr)), receivedAt: 1000 });
  }
  const githubApi = { getIssue: async () => undefined } as unknown as import('../src/github-api').GithubApi;
  const project = createProjector(githubApi, { apidogTopic: 88 }, { api: {} as import('../src/apidog-api').ApidogApi,
    config: { projectId: 1382426, targetBranchId: 1388508, projectName: 'Example', contractUrl: 'https://vb78fyael1.apidog.io/', peopleMap: {} } });
  const sent: OutgoingMessage[] = [];
  expect(await runOnce({ store, project, now: 1000, send: async message => { sent.push(message); return { kind: 'sent', telegramMessageId: 321 }; } })).toBe(1);
  expect(sent[0]!.html).toContain('Открыт MR #39834');
  expect(sent[0]!.secondaryButton?.url).toBe('https://vb78fyael1.apidog.io/');
  expect(rows(path)).toHaveLength(1);
});
