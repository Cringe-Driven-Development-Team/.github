import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { loadConfig } from '../src/config';
import { openStore } from '../src/store';
import * as main from '../src/main';
import review from './fixtures/github/review-submitted.json';
const env = { GITHUB_WEBHOOK_SECRET: 'local-github', APIDOG_SIGNATURE_KEY: 'local-apidog', APIDOG_SIGNATURE_HEADER: 'X-Test-Signature' };

test('startup requires Apidog signature settings and enabled mode requires Telegram config/topic', () => {
  expect(() => loadConfig({ GITHUB_WEBHOOK_SECRET: 'local' })).toThrow('APIDOG_SIGNATURE_KEY');
  expect(() => loadConfig({ ...env, APIDOG_SIGNATURE_HEADER: '' })).toThrow('APIDOG_SIGNATURE_HEADER');
  expect(() => loadConfig({ ...env, APIDOG_SIGNATURE_HEADER: 'invalid header' })).toThrow('APIDOG_SIGNATURE_HEADER');
  expect(() => loadConfig({ ...env, WEBHOOK_ALERTS_SEND_ENABLED: 'true' })).toThrow('TELEGRAM_BOT_TOKEN');
  expect(() => loadConfig({ ...env, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local' })).toThrow('TELEGRAM_CHAT_ID');
  expect(() => loadConfig({ ...env, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local', TELEGRAM_CHAT_ID: '-1001' })).toThrow('TELEGRAM_APIDOG_TOPIC_ID');
});

test('disabled entrypoint accepts durably without preparation or network calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hooks-disabled-'));
  const path = join(directory, 'queue.sqlite');
  const existing = openStore(path);
  existing.accept({ source: 'apidog', event: 'endpoint.updated', raw: new TextEncoder().encode('{}') });
  existing.close();
  let calls = 0;
  const service = main.startService(loadConfig({ ...env, DATABASE_PATH: path }), { fetch: (async () => { calls++; throw new Error('no network'); }) as unknown as typeof fetch });
  try {
    const raw = new TextEncoder().encode('{"event":"schema.updated"}');
    const response = await service.app.request('/webhooks/apidog', { method: 'POST', body: raw, headers: {
      'content-type': 'application/json', 'x-test-signature': `sha1=${createHmac('sha1', env.APIDOG_SIGNATURE_KEY).update(raw).digest('hex')}`,
    } });
    expect(response.status).toBe(202);
    expect(calls).toBe(0);
  } finally { await service.stop(); }
  const reopened = openStore(path);
  try { expect(reopened.claimUnprepared(Date.now(), 1000)).toHaveLength(2); }
  finally { reopened.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('enabled entrypoint sends Apidog and grouped GitHub review through real worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hooks-enabled-'));
  const path = join(directory, 'queue.sqlite');
  const store = openStore(path);
  store.accept({ source: 'apidog', event: 'test.completed', raw: new TextEncoder().encode('{"event":"test.completed"}'), receivedAt: 1 });
  store.accept({ source: 'github', event: 'pull_request_review', deliveryId: 'review', raw: new TextEncoder().encode(JSON.stringify({ ...review, review: { ...review.review, user: { ...review.review.user, login: 'IndependentReviewer' } } })), receivedAt: 2 });
  store.close();
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(url)).toBe('https://api.telegram.org/botlocal-token/sendMessage');
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: bodies.length } });
  }) as unknown as typeof fetch;
  const service = main.startService(loadConfig({ ...env, DATABASE_PATH: path, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local-token', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_APIDOG_TOPIC_ID: '88', TELEGRAM_REVIEW_TOPIC_ID: '77' }), { fetch: fetcher });
  try {
    const deadline = Date.now() + 3000;
    while (bodies.length < 2 && Date.now() < deadline) await Bun.sleep(5);
  } finally { await service.stop(); }
  try {
    expect(bodies).toHaveLength(2);
    expect(bodies.map(body => body.message_thread_id).sort()).toEqual([77, 88]);
    expect(bodies.every(body => body.chat_id === '-1001')).toBe(true);
    const db = new Database(path);
    try { expect(db.query<{ status: string }, []>('SELECT status FROM outbox').all()).toEqual([{ status: 'sent' }, { status: 'sent' }]); }
    finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const [name, value] of [
  ['TELEGRAM_TOPIC_ID', '0'], ['TELEGRAM_REVIEW_TOPIC_ID', '12junk'],
  ['TELEGRAM_APIDOG_TOPIC_ID', '-1'], ['TELEGRAM_CHAT_ID', 'private-chat-name'],
  ['TELEGRAM_USER_MAP', '{bad'], ['TELEGRAM_USER_MAP', '[]'], ['TELEGRAM_USER_MAP', '{"user":"oops"}'],
] as const) {
  test(`rejects malformed ${name} without exposing value`, () => {
    expect(() => loadConfig({ ...env, [name]: value })).toThrow(name);
  });
}
