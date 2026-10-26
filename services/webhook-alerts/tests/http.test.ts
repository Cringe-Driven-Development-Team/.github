import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { verifyApidog, verifyGithub } from '../src/auth';
import { loadConfig } from '../src/config';
import { createApp, type AcceptDelivery, type IncomingDelivery } from '../src/http';

const secret = 'local-test-secret';
const mergeEnv = { APIDOG_PROJECT_ID: '1382426', APIDOG_TARGET_BRANCH_ID: '1388508', APIDOG_PROJECT_NAME: 'Example', APIDOG_CONTRACT_URL: 'https://vb78fyael1.apidog.io/', APIDOG_ACCESS_TOKEN: 'local-api', APIDOG_TELEGRAM_USER_MAP: '{}' };
const apidogEnv = { ...mergeEnv, APIDOG_SIGNATURE_KEY: 'test-apidog', APIDOG_SIGNATURE_HEADER: 'X-Test-Signature' };
const config = loadConfig({ ...apidogEnv, GITHUB_WEBHOOK_SECRET: secret });
const encoder = new TextEncoder();
const json = encoder.encode('{ "message": "Привет 🌍" }\n');
const sign = (raw: Uint8Array) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

function request(raw: Uint8Array = json, headers: Record<string, string> = {}) {
  return new Request('http://localhost/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(raw),
      ...headers,
    },
    body: new Uint8Array(raw),
  });
}

function app(accept: AcceptDelivery = () => 'accepted', checkDb = () => {}) {
  return createApp({ config, accept, checkDb });
}

describe('configuration', () => {
  test('requires a nonempty webhook secret without exposing its value', () => {
    expect(() => loadConfig({})).toThrow('GITHUB_WEBHOOK_SECRET');
    expect(() => loadConfig({ ...apidogEnv, GITHUB_WEBHOOK_SECRET: '  ' })).toThrow('GITHUB_WEBHOOK_SECRET');
  });

  test('defaults to paused sending, port 8080 and persistent database path', () => {
    expect(config.sendEnabled).toBe(false);
    expect(config.port).toBe(8080);
    expect(config.databasePath).toBe('/data/queue.sqlite');
    expect(loadConfig({ ...apidogEnv, GITHUB_WEBHOOK_SECRET: secret, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local', TELEGRAM_APIDOG_BOT_TOKEN: 'apidog-local', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_APIDOG_TOPIC_ID: '88' }).sendEnabled).toBe(true);
  });

  test('rejects malformed flags, invalid ports and empty database paths', () => {
    for (const port of ['0', '-1', '65536', '8080junk', '1.5', '']) {
      expect(() => loadConfig({ ...apidogEnv, GITHUB_WEBHOOK_SECRET: secret, PORT: port })).toThrow('PORT');
    }
    expect(() => loadConfig({ ...apidogEnv, GITHUB_WEBHOOK_SECRET: secret, WEBHOOK_ALERTS_SEND_ENABLED: 'yes' })).toThrow('WEBHOOK_ALERTS_SEND_ENABLED');
    expect(() => loadConfig({ ...apidogEnv, GITHUB_WEBHOOK_SECRET: secret, DATABASE_PATH: '' })).toThrow('DATABASE_PATH');
  });
});

describe('HMAC verification', () => {
  test('matches the official GitHub Hello, World! vector', () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
    expect(verifyGithub(encoder.encode('Hello, World!'),
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      "It's a Secret to Everybody")).toBe(true);
  });

  test('Apidog checks SHA-1 raw bytes and rejects modified or malformed signatures', () => {
    const signature = `sha1=${createHmac('sha1', secret).update(json).digest('hex')}`;
    expect(verifyApidog(json, signature, secret)).toBe(true);
    expect(verifyApidog(encoder.encode('{}'), signature, secret)).toBe(false);
    for (const value of ['', 'sha1=bad', `sha256=${'a'.repeat(64)}`, `sha1=${'z'.repeat(40)}`, `${signature}\n`]) {
      expect(verifyApidog(json, value, secret)).toBe(false);
    }
  });

  test('GitHub rejects a valid signature with a trailing newline', () => {
    expect(verifyGithub(json, `${sign(json)}\n`, secret)).toBe(false);
  });
});

describe('GitHub ingress', () => {
  test('accepts signed JSON with its exact raw bytes and delivery metadata', async () => {
    const received: IncomingDelivery[] = [];
    const response = await app(delivery => { received.push(delivery); return 'accepted'; }).fetch(request());
    expect(response.status).toBe(202);
    expect(received).toEqual([{ source: 'github', deliveryId: 'delivery-1', event: 'issues', raw: json }]);
  });

  test('does not acknowledge before the acceptance callback completes', async () => {
    let release!: () => void;
    const saved = new Promise<void>(resolve => { release = resolve; });
    let responded = false;
    const response = app(async () => { await saved; return 'accepted' as const; }).fetch(request());
    void Promise.resolve(response).then(() => { responded = true; });
    await Bun.sleep(5);
    expect(responded).toBe(false);
    release();
    expect((await response).status).toBe(202);
  });

  test('rejects absent, incorrect and malformed signatures without accepting', async () => {
    let accepted = 0;
    const server = app(() => { accepted++; return 'accepted'; });
    for (const signature of ['', `sha256=${'0'.repeat(64)}`, 'sha256=abc', `sha256=${'z'.repeat(64)}`, `sha1=${'0'.repeat(40)}`]) {
      expect((await server.fetch(request(json, { 'x-hub-signature-256': signature }))).status).toBe(401);
    }
    expect(accepted).toBe(0);
  });

  test('rejects missing delivery ID and event', async () => {
    for (const header of ['x-github-delivery', 'x-github-event']) {
      expect((await app().fetch(request(json, { [header]: '' }))).status).toBe(400);
    }
  });

  test('rejects invalid JSON without accepting', async () => {
    let accepted = 0;
    const response = await app(() => { accepted++; return 'accepted'; }).fetch(request(encoder.encode('{ broken')));
    expect(response.status).toBe(400);
    expect(accepted).toBe(0);
  });

  test('rejects non-JSON content type', async () => {
    expect((await app().fetch(request(json, { 'content-type': 'text/plain' }))).status).toBe(415);
  });

  test('acknowledges duplicate deliveries and rejects conflicting stored bodies', async () => {
    expect((await app(() => 'duplicate').fetch(request())).status).toBe(200);
    // Persistence and body comparison live in Task 2; HTTP maps the store result.
    expect((await app(() => 'conflict').fetch(request(encoder.encode('{"altered":true}')))).status).toBe(409);
  });

  test('accepts unsupported signed event types for durable filtering later', async () => {
    expect((await app().fetch(request(json, { 'x-github-event': 'future-event' }))).status).toBe(202);
  });

  test('returns 404 for unknown routes', async () => {
    expect((await app().request('/unknown')).status).toBe(404);
  });

  test('rejects advertised bodies over one MiB before reading their stream', async () => {
    let read = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { read = true; controller.close(); } }, { highWaterMark: 0 });
    const response = await app().fetch(new Request('http://localhost/webhooks/github', {
      method: 'POST', headers: { 'content-length': '1048577' }, body,
    }));
    expect(response.status).toBe(413);
    expect(read).toBe(false);
  });

  test('bounds streams without Content-Length and cancels after exceeding one MiB', async () => {
    let canceled = false;
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(524289)); },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    const req = request();
    const response = await app().fetch(new Request(req.url, { method: 'POST', headers: req.headers, body }));
    expect(response.status).toBe(413);
    expect(reads).toBe(2);
    expect(canceled).toBe(true);
  });

  test('enforces actual size even when Content-Length understates the body', async () => {
    const raw = new Uint8Array(1048577);
    expect((await app().fetch(request(raw, { 'content-length': '1' }))).status).toBe(413);
  });

  test('accepts exactly one MiB of valid signed JSON', async () => {
    const raw = encoder.encode(`"${'x'.repeat(1048574)}"`);
    expect((await app().fetch(request(raw))).status).toBe(202);
  });

  test('maps a real SQLite write failure to 503 without leaking payload or errors', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE deliveries (id TEXT)');
    db.exec('PRAGMA query_only = ON');
    try {
      const response = await app(() => { db.query('INSERT INTO deliveries VALUES (?)').run('delivery-1'); return 'accepted'; }).fetch(request());
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"error":"storage_unavailable"}');
    } finally { db.close(); }
  });
});

describe('health', () => {
  test('checks the database with no Telegram configuration or network dependency', async () => {
    let checks = 0;
    const server = app(undefined, () => { checks++; });
    expect((await server.request('/health')).status).toBe(200);
    expect(checks).toBe(1);
  });

  test('reports unavailable database without exposing its diagnostic', async () => {
    const response = await app(undefined, () => { throw new Error('private database path'); }).request('/health');
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"storage_unavailable"}');
  });
});

test('sender configuration rejects malformed Apidog identities without echoing map', () => {
  const enabled = { ...apidogEnv, GITHUB_WEBHOOK_SECRET: secret, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'local', TELEGRAM_APIDOG_BOT_TOKEN: 'local', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_APIDOG_TOPIC_ID: '88' };
  for (const [name, value] of [['APIDOG_ACCESS_TOKEN', undefined], ['APIDOG_TELEGRAM_USER_MAP', undefined], ['APIDOG_TELEGRAM_USER_MAP', '{"private":{"name":"secret-name","telegramId":"1"}}'], ['APIDOG_PROJECT_ID', '1.5']]) {
    let message = '';
    try { loadConfig({ ...enabled, [name!]: value }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(name!); expect(message).not.toContain('secret-name');
  }
});
