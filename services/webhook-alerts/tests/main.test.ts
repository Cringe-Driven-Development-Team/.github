import { expect, test, spyOn } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { loadConfig } from '../src/config';
import { openStore } from '../src/store';
import * as main from '../src/main';
import review from './fixtures/github/review-submitted.json';
const mergeEnv = { APIDOG_PROJECT_ID: '1382426', APIDOG_TARGET_BRANCH_ID: '1388508', APIDOG_PROJECT_NAME: 'Example', APIDOG_CONTRACT_URL: 'https://vb78fyael1.apidog.io/', APIDOG_ACCESS_TOKEN: 'local-api', APIDOG_TELEGRAM_USER_MAP: '{}' };
const env = { ...mergeEnv, GITHUB_WEBHOOK_SECRET: 'local-github', APIDOG_SIGNATURE_KEY: 'local-apidog', APIDOG_SIGNATURE_HEADER: 'X-Test-Signature' };

test('startup requires Apidog signature settings and enabled mode requires Telegram config/topic', () => {
  expect(() => loadConfig({ GITHUB_WEBHOOK_SECRET: 'local' })).toThrow('APIDOG_SIGNATURE_KEY');
  expect(() => loadConfig({ ...env, APIDOG_SIGNATURE_HEADER: '' })).toThrow('APIDOG_SIGNATURE_HEADER');
  expect(() => loadConfig({ ...env, APIDOG_SIGNATURE_HEADER: 'invalid header' })).toThrow('APIDOG_SIGNATURE_HEADER');
  expect(() => loadConfig({ ...env, WEBHOOK_ALERTS_SEND_ENABLED: 'true' })).toThrow('TELEGRAM_BOT_TOKEN');
  expect(() => loadConfig({ ...env, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local' })).toThrow('TELEGRAM_CHAT_ID');
  expect(() => loadConfig({ ...env, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local', TELEGRAM_CHAT_ID: '-1001' })).toThrow('TELEGRAM_APIDOG_TOPIC_ID');
  expect(() => loadConfig({ ...env, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_APIDOG_TOPIC_ID: '88' })).toThrow('TELEGRAM_APIDOG_BOT_TOKEN');
});

for (const proxyUrl of ['http://proxy.internal:2080', 'https://proxy.internal:2080']) {
  test('enabled config retains an HTTP or HTTPS Telegram proxy', () => {
    const config = loadConfig({ ...env, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local', TELEGRAM_APIDOG_BOT_TOKEN: 'apidog-local', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_APIDOG_TOPIC_ID: '88', TELEGRAM_PROXY_URL: proxyUrl });
    expect(config.telegram).toMatchObject({ proxyUrl });
    expect(config.apidogTelegram).toMatchObject({ botToken: 'apidog-local', chatId: '-1001', proxyUrl });
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

for (const proxyUrl of [undefined, 'http://proxy.internal:2080']) {
test(`enabled entrypoint sends through real worker ${proxyUrl === undefined ? 'without explicit proxy' : 'with Telegram-only proxy'}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hooks-enabled-'));
  const path = join(directory, 'queue.sqlite');
  const store = openStore(path);
  store.accept({ source: 'apidog', deliveryId: 'mr-poll:39834:MERGED', event: 'MR_MERGED', raw: new TextEncoder().encode(JSON.stringify({ id: 39834, sourceBranchId: 5, targetBranchId: 1388508, createdById: 1, reviewerIds: [], status: 'MERGED', description: 'Contract update', createdAt: '2026-10-26T10:00:00Z', closedAt: '2026-10-26T10:28:47Z', closedById: 2 })), receivedAt: 1 });
  store.accept({ source: 'github', event: 'pull_request_review', deliveryId: 'review', raw: new TextEncoder().encode(JSON.stringify({ ...review, review: { ...review.review, user: { ...review.review.user, login: 'IndependentReviewer' } } })), receivedAt: 2 });
  store.close();
  const bodies: Record<string, unknown>[] = [];
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url).startsWith('https://api.apidog.com/')) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer local-api');
      expect(init).not.toHaveProperty('proxy');
      if (String(url).endsWith('/sprint-branches')) return Response.json({ success: true, data: [{ id: 5, name: 'feature' }] });
      const row = { id: 39834, sourceBranchId: 5, targetBranchId: 1388508, createdById: 1, reviewerIds: [], description: 'Contract update', createdAt: '2026-10-26T10:00:00Z', closedById: 2, status: 'MERGED', closedAt: '2026-10-26T10:28:47Z' };
      return String(url).includes('?') ? Response.json({ success: true, data: [row], meta: { nextPage: null } }) : Response.json({ success: true, data: row });
    }
    if (String(url).startsWith('https://api.github.com/')) return Response.json([]);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: bodies.length } });
  }) as unknown as typeof fetch;
  const service = main.startService(loadConfig({ ...env, DATABASE_PATH: path, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local-token', TELEGRAM_APIDOG_BOT_TOKEN: 'apidog-token', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_APIDOG_TOPIC_ID: '88', TELEGRAM_REVIEW_TOPIC_ID: '88', TELEGRAM_PROXY_URL: proxyUrl, GITHUB_API_TOKEN: 'local-github-token' }), { fetch: fetcher });
  try {
    const deadline = Date.now() + 3000;
    while (bodies.length < 2 && Date.now() < deadline) await Bun.sleep(5);
  } finally { await service.stop(); }
  try {
    expect(bodies).toHaveLength(2);
    const apidogBody = bodies.find(body => String(body.text).startsWith('<b>Apidog</b>'))!;
    expect(apidogBody.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Открыть MR', url: 'https://app.apidog.com/project/1382426/branch/1388508/merge-request/39834' }, { text: 'Контракт API', url: 'https://vb78fyael1.apidog.io/' }]] });
    expect(JSON.stringify(bodies)).not.toContain('local-api');
    const githubRequests = requests.filter(request => request.url.startsWith('https://api.github.com/'));
    const telegramRequests = requests.filter(request => request.url.startsWith('https://api.telegram.org/bot'));
    expect(githubRequests.length).toBeGreaterThan(0);
    expect(telegramRequests).toHaveLength(2);
    expect(telegramRequests.map(request => request.url).sort()).toEqual([
      'https://api.telegram.org/botapidog-token/sendMessage',
      'https://api.telegram.org/botlocal-token/sendMessage',
    ]);
    const routed = telegramRequests.map(request => ({ url: request.url, body: JSON.parse(String(request.init?.body)) as Record<string, unknown> }));
    expect(routed.find(request => String(request.body.text).startsWith('<b>Apidog</b>'))?.url)
      .toBe('https://api.telegram.org/botapidog-token/sendMessage');
    expect(routed.find(request => !String(request.body.text).startsWith('<b>Apidog</b>'))?.url)
      .toBe('https://api.telegram.org/botlocal-token/sendMessage');
    for (const request of githubRequests) expect(request.init).not.toHaveProperty('proxy');
    for (const request of telegramRequests) {
      if (proxyUrl === undefined) expect(request.init).not.toHaveProperty('proxy');
      else expect(request.init).toHaveProperty('proxy', { url: 'http://proxy.internal:2080', respectNoProxy: false });
    }
    expect(bodies.map(body => body.message_thread_id).sort()).toEqual([88, 88]);
    expect(bodies.every(body => body.chat_id === '-1001')).toBe(true);
    const db = new Database(path);
    try { expect(db.query<{ status: string }, []>('SELECT status FROM outbox').all()).toEqual([{ status: 'sent' }, { status: 'sent' }]); }
    finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

}

for (const [name, value] of [
  ['TELEGRAM_TOPIC_ID', '0'], ['TELEGRAM_REVIEW_TOPIC_ID', '12junk'],
  ['TELEGRAM_APIDOG_TOPIC_ID', '-1'], ['TELEGRAM_CHAT_ID', 'private-chat-name'],
  ['TELEGRAM_USER_MAP', '{bad'], ['TELEGRAM_USER_MAP', '[]'], ['TELEGRAM_USER_MAP', '{"user":"oops"}'],
] as const) {
  test(`rejects malformed ${name} without exposing value`, () => {
    expect(() => loadConfig({ ...env, [name]: value })).toThrow(name);
  });
}

test('enabled merge config requires token/map and validates IDs without exposing values', () => {
  const enabled = { ...env, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local', TELEGRAM_APIDOG_BOT_TOKEN: 'local', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_APIDOG_TOPIC_ID: '88' };
  for (const name of ['APIDOG_ACCESS_TOKEN', 'APIDOG_TELEGRAM_USER_MAP']) expect(() => loadConfig({ ...enabled, [name]: undefined })).toThrow(name);
  for (const [name, value] of [['APIDOG_PROJECT_ID', '1junk'], ['APIDOG_TARGET_BRANCH_ID', '0'], ['APIDOG_TELEGRAM_USER_MAP', '{"1":{"name":"x","telegramId":"bad"}}'], ['APIDOG_CONTRACT_URL', 'javascript:bad']]) expect(() => loadConfig({ ...enabled, [name!]: value })).toThrow(name!);
});

test('MR polling baselines before reading, recovers periodically and ignores raw webhooks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hooks-poll-'));
  const path = join(directory, 'queue.sqlite');
  const bodies: Record<string, unknown>[] = [];
  const realNow = Date.now.bind(Date);
  const startedAt = realNow();
  let elapsed = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => startedAt + elapsed);
  let reads = 0;
  let cutoffSeen = false;
  let partialVisible = false;
  const row = { id: 41, sourceBranchId: 5, targetBranchId: 1388508, createdById: 1, reviewerIds: [], status: 'OPEN', description: 'Historical', createdAt: '2020-01-01T00:00:00Z', closedAt: null, closedById: null };
  const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith('https://api.apidog.com/')) {
      const db = new Database(path);
      try {
        cutoffSeen = !!db.query("SELECT 1 FROM deliveries WHERE delivery_id = 'mr-poll:cutoff'").get();
        if (String(url).includes('page=2')) {
          partialVisible = !!db.query("SELECT 1 FROM deliveries WHERE delivery_id = 'mr-poll:42:OPENED'").get();
          return Response.json({ success: true, data: [], meta: { nextPage: null } });
        }
      } finally { db.close(); }
      reads++;
      if (reads === 2) return new Response('private failure payload', { status: 503 });
      return Response.json({ success: true, data: reads === 1 ? [row] : [row, { ...row, id: 42, description: 'New contract', createdAt: new Date(Date.now()).toISOString() }], meta: { nextPage: reads === 1 ? null : 2 } });
    }
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: bodies.length } });
  }) as typeof fetch;
  const service = main.startService(loadConfig({ ...env, DATABASE_PATH: path, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local-token', TELEGRAM_APIDOG_BOT_TOKEN: 'apidog-token', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_APIDOG_TOPIC_ID: '88' }), { fetch: fetcher });
  try {
    const raw = new TextEncoder().encode('{"event":"API_UPDATED","title":"Changed","content":"raw webhook"}');
    expect((await service.app.request('/webhooks/apidog', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-test-signature': `sha1=${createHmac('sha1', env.APIDOG_SIGNATURE_KEY).update(raw).digest('hex')}` } })).status).toBe(202);
    await Bun.sleep(50);
    expect(cutoffSeen).toBe(true);
    expect(reads).toBe(1);
    expect(bodies).toHaveLength(0);
    elapsed = 29900;
    await Bun.sleep(1100);
    expect(reads).toBe(1);
    elapsed = 30000;
    const failureDeadline = realNow() + 2500;
    while (reads < 2 && realNow() < failureDeadline) await Bun.sleep(10);
    expect(reads).toBe(2);
    expect(bodies).toHaveLength(0);
    elapsed += 30000;
    const deadline = realNow() + 2500;
    while (bodies.length === 0 && realNow() < deadline) await Bun.sleep(10);
    expect(reads).toBe(3);
    expect(partialVisible).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(String(bodies[0]!.text)).toContain('New contract');
  } finally { await service.stop(); clock.mockRestore(); }
  const finalReads = reads;
  await Bun.sleep(1050);
  expect(reads).toBe(finalReads);
  rmSync(directory, { recursive: true, force: true });
}, 10000);

test('enabled startup suppresses old raw Apidog outbox durably while preserving sent, GitHub and MR messages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hooks-cutover-'));
  const path = join(directory, 'queue.sqlite');
  const store = openStore(path);
  const seeds = [
    ['apidog', 'raw-pending', 'API_UPDATED', 'pending', null],
    ['apidog', 'raw-leased', 'BRANCH_CREATED', 'leased', 1],
    ['apidog', 'raw-active-lease', 'BRANCH_MERGED', 'leased', Number.MAX_SAFE_INTEGER],
    ['apidog', 'raw-failed', 'API_UPDATED', 'failed', null],
    ['apidog', 'raw-sent', 'API_UPDATED', 'sent', null],
    ['github', 'github-pending', 'issues', 'pending', null],
    ['apidog', 'mr-poll:123:OPENED', 'MR_OPENED', 'leased', 1],
  ] as const;
  for (const [source, deliveryId, event] of seeds) {
    store.accept({ source, deliveryId, event, raw: new TextEncoder().encode('{}'), receivedAt: 1 });
  }
  store.close();
  const db = new Database(path);
  for (const [, deliveryId, , status, lease] of seeds) {
    db.query(`INSERT INTO outbox (origin_type, origin_id, ordinal, topic, html, status, due_at, lease_until, error_code, telegram_message_id)
      SELECT 'delivery', id, 0, 88, delivery_id, ?, 1, ?, ?, ? FROM deliveries WHERE delivery_id = ?`)
      .run(status, lease, status === 'failed' ? 'telegram_400' : null, status === 'sent' ? 99 : null, deliveryId);
  }
  db.exec("UPDATE deliveries SET prepared = 1");
  db.exec("INSERT INTO outbox (origin_type, origin_id, ordinal, topic, html, due_at) VALUES ('review_group', 1, 0, 88, 'github-review-group', 1)");
  db.close();
  const bodies: string[] = [];
  const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith('https://api.apidog.com/')) return Response.json({ success: true, data: [], meta: { nextPage: null } });
    bodies.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true, result: { message_id: bodies.length } });
  }) as typeof fetch;
  const config = loadConfig({ ...env, DATABASE_PATH: path, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local', TELEGRAM_APIDOG_BOT_TOKEN: 'local', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_APIDOG_TOPIC_ID: '88' });
  const disabled = main.startService({ ...config, sendEnabled: false }, { fetch: fetcher });
  await disabled.stop();
  const before = new Database(path);
  try { expect(before.query('SELECT status FROM outbox ORDER BY id').all()).toEqual([
    { status: 'pending' }, { status: 'leased' }, { status: 'leased' }, { status: 'failed' },
    { status: 'sent' }, { status: 'pending' }, { status: 'leased' }, { status: 'pending' },
  ]); } finally { before.close(); }
  const service = main.startService(config, { fetch: fetcher });
  try {
    const deadline = Date.now() + 3000;
    while (bodies.length < 3 && Date.now() < deadline) await Bun.sleep(5);
  } finally { await service.stop(); }
  try {
    expect(bodies).toEqual(['github-pending', 'mr-poll:123:OPENED', 'github-review-group']);
    const inspect = new Database(path);
    try {
      expect(inspect.query('SELECT html, status, lease_until, error_code, telegram_message_id FROM outbox ORDER BY id').all()).toEqual([
        { html: 'raw-pending', status: 'failed', lease_until: null, error_code: 'APIDOG_RAW_SUPPRESSED', telegram_message_id: null },
        { html: 'raw-leased', status: 'failed', lease_until: null, error_code: 'APIDOG_RAW_SUPPRESSED', telegram_message_id: null },
        { html: 'raw-active-lease', status: 'failed', lease_until: null, error_code: 'APIDOG_RAW_SUPPRESSED', telegram_message_id: null },
        { html: 'raw-failed', status: 'failed', lease_until: null, error_code: 'APIDOG_RAW_SUPPRESSED', telegram_message_id: null },
        { html: 'raw-sent', status: 'sent', lease_until: null, error_code: null, telegram_message_id: 99 },
        { html: 'github-pending', status: 'sent', lease_until: null, error_code: null, telegram_message_id: 1 },
        { html: 'mr-poll:123:OPENED', status: 'sent', lease_until: null, error_code: null, telegram_message_id: 2 },
        { html: 'github-review-group', status: 'sent', lease_until: null, error_code: null, telegram_message_id: 3 },
      ]);
    } finally { inspect.close(); }
    const reopened = openStore(path);
    try {
      for (const id of [1, 2, 3, 4]) expect(reopened.retryFailed(id, Date.now())).toBe(false);
      reopened.startApidogMrMonitoring(Date.now());
      expect(reopened.claimDue(Number.MAX_SAFE_INTEGER - 1000, 100)).toEqual([]);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
