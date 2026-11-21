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
const env = { GITHUB_WEBHOOK_SECRET: 'local-github' };
const enabled = {
  ...env, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local-token', TELEGRAM_CHAT_ID: '-1001',
};

test('enabled startup requires the Telegram bot token and chat', () => {
  expect(() => loadConfig({ ...enabled, TELEGRAM_BOT_TOKEN: undefined })).toThrow('TELEGRAM_BOT_TOKEN');
  expect(() => loadConfig({ ...enabled, TELEGRAM_CHAT_ID: undefined })).toThrow('TELEGRAM_CHAT_ID');
});

for (const proxyUrl of ['http://proxy.internal:2080', 'https://proxy.internal:2080']) {
  test('enabled config retains an HTTP or HTTPS Telegram proxy', () => {
    const config = loadConfig({ ...enabled, TELEGRAM_PROXY_URL: proxyUrl });
    expect(config.telegram).toMatchObject({ proxyUrl });
  });
}

for (const proxyUrl of ['socks5h://proxy.internal:2080', 'not-a-url', '', '   ', 'http://', 'http://user:private-password@']) {
  test('rejects an invalid Telegram proxy without exposing its value', () => {
    let error: unknown;
    try { loadConfig({ ...env, TELEGRAM_PROXY_URL: proxyUrl }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('TELEGRAM_PROXY_URL');
    if (proxyUrl) expect((error as Error).message).not.toContain(proxyUrl);
    expect((error as Error).message).not.toContain('private-password');
  });
}

test('disabled entrypoint accepts durably without preparation or network calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hooks-disabled-'));
  const path = join(directory, 'queue.sqlite');
  let calls = 0;
  try {
    const service = main.startService(loadConfig({ ...env, DATABASE_PATH: path }), {
      fetch: (() => { calls++; throw new Error('unexpected network request'); }) as unknown as typeof fetch,
    });
    try {
      const raw = new TextEncoder().encode('{"action":"opened"}');
      const response = await service.app.request('/webhooks/github', { method: 'POST', body: raw, headers: {
        'content-type': 'application/json', 'x-github-delivery': 'issue-1', 'x-github-event': 'issues',
        'x-hub-signature-256': `sha256=${createHmac('sha256', env.GITHUB_WEBHOOK_SECRET).update(raw).digest('hex')}`,
      } });
      expect(response.status).toBe(202);
    } finally { await service.stop(); }
    expect(calls).toBe(0);
    const reopened = openStore(path);
    try {
      expect(reopened.claimUnprepared(Date.now(), 1000).map(delivery => delivery.deliveryId)).toEqual(['issue-1']);
      expect(reopened.claimDue(Date.now(), 1000)).toEqual([]);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('enabled entrypoint rejects Apidog webhooks without writing a delivery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hooks-rejected-'));
  const path = join(directory, 'queue.sqlite');
  try {
    const service = main.startService(loadConfig({ ...enabled, DATABASE_PATH: path }), {
      fetch: (() => { throw new Error('unexpected network request'); }) as unknown as typeof fetch,
    });
    try {
      const response = await service.app.request('/webhooks/apidog', {
        method: 'POST', body: '{"event":"API_UPDATED"}', headers: { 'content-type': 'application/json' },
      });
      expect(response.status).toBe(404);
    } finally { await service.stop(); }
    const db = new Database(path);
    try { expect(db.query('SELECT id FROM deliveries').all()).toEqual([]); }
    finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const proxyUrl of [undefined, 'http://proxy.internal:2080']) {
  test(`enabled entrypoint sends a GitHub review ${proxyUrl === undefined ? 'without explicit proxy' : 'with Telegram-only proxy'}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hooks-enabled-'));
    const path = join(directory, 'queue.sqlite');
    try {
      const store = openStore(path);
      try {
        const payload = { ...review, review: { ...review.review, user: { ...review.review.user, login: 'IndependentReviewer' } } };
        store.accept({ source: 'github', event: 'pull_request_review', deliveryId: 'review', raw: new TextEncoder().encode(JSON.stringify(payload)), receivedAt: 2 });
      } finally { store.close(); }

      const bodies: Record<string, unknown>[] = [];
      const requests: { url: string; init: RequestInit | undefined }[] = [];
      const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).startsWith('https://api.github.com/')) return Response.json([]);
        if (String(url) === 'https://api.telegram.org/botlocal-token/sendMessage') {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({ ok: true, result: { message_id: bodies.length } });
        }
        throw new Error('unexpected network request');
      }) as unknown as typeof fetch;
      const service = main.startService(loadConfig({
        ...enabled, DATABASE_PATH: path, TELEGRAM_REVIEW_TOPIC_ID: '88', TELEGRAM_PROXY_URL: proxyUrl, GITHUB_API_TOKEN: 'local-github-token',
      }), { fetch: fetcher });
      try {
        const deadline = Date.now() + 3000;
        while (bodies.length === 0 && Date.now() < deadline) await Bun.sleep(5);
      } finally { await service.stop(); }

      const githubRequests = requests.filter(request => request.url.startsWith('https://api.github.com/'));
      const telegramRequests = requests.filter(request => request.url === 'https://api.telegram.org/botlocal-token/sendMessage');
      expect(githubRequests.length).toBeGreaterThan(0);
      expect(telegramRequests).toHaveLength(1);
      expect(requests).toHaveLength(githubRequests.length + telegramRequests.length);
      for (const request of githubRequests) expect(request.init).not.toHaveProperty('proxy');
      if (proxyUrl === undefined) expect(telegramRequests[0]?.init).not.toHaveProperty('proxy');
      else expect(telegramRequests[0]?.init).toHaveProperty('proxy', { url: proxyUrl, respectNoProxy: false });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ message_thread_id: 88, chat_id: '-1001' });
      expect(String(bodies[0]?.text)).toContain('IndependentReviewer');
      const db = new Database(path);
      try { expect(db.query('SELECT origin_type, status FROM outbox').all()).toEqual([{ origin_type: 'review_group', status: 'sent' }]); }
      finally { db.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const [name, value] of [
  ['TELEGRAM_TOPIC_ID', '0'], ['TELEGRAM_REVIEW_TOPIC_ID', '12junk'],
  ['TELEGRAM_CHAT_ID', 'private-chat-name'],
  ['TELEGRAM_USER_MAP', '{bad'], ['TELEGRAM_USER_MAP', '[]'], ['TELEGRAM_USER_MAP', '{"user":"oops"}'],
] as const) {
  test(`rejects malformed ${name} without exposing value`, () => {
    expect(() => loadConfig({ ...env, [name]: value })).toThrow(name);
  });
}
