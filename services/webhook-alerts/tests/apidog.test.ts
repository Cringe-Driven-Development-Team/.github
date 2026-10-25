import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { loadConfig } from '../src/config';
import { createApp, type IncomingDelivery } from '../src/http';
import { openStore, type Delivery } from '../src/store';
import * as apidog from '../src/apidog';
import fixture from './fixtures/apidog/synthetic.json';
import observed from './fixtures/apidog/anonymized-live-structure.json';
const secret = 'synthetic-apidog-key';
const env = { GITHUB_WEBHOOK_SECRET: 'github-local', APIDOG_SIGNATURE_KEY: secret, APIDOG_SIGNATURE_HEADER: 'X-Synthetic-Signature' };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const raw = encode(fixture);
function request(body = raw, headers: Record<string, string> = {}) {
  return new Request('http://localhost/webhooks/apidog', { method: 'POST', body: new Uint8Array(body), headers: {
    'content-type': 'application/json', 'x-synthetic-signature': `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`, ...headers,
  } });
}
function delivery(value: unknown, event = 'endpoint.updated'): Delivery {
  return { id: 1, source: 'apidog', deliveryId: 'test', event, raw: encode(value), bodyHash: '', receivedAt: 1000, prepared: false, leaseUntil: null };
}
describe('Apidog signed intake', () => {
  test('accepts configured SHA-1 header over exact bytes', async () => {
    const received: IncomingDelivery[] = [];
    const app = createApp({ config: loadConfig(env), checkDb() {}, accept(input) { received.push(input); return 'accepted'; } });
    const bytes = new TextEncoder().encode(` ${JSON.stringify(fixture)}\n`);
    expect((await app.fetch(request(bytes))).status).toBe(202);
    expect(received).toEqual([{ source: 'apidog', deliveryId: 'synthetic-notification-1', event: 'endpoint.updated', raw: bytes }]);
  });
  test('accepts live base64 SHA-1 over exact bytes without invented ID', async () => {
    const received: IncomingDelivery[] = [];
    const app = createApp({ config: loadConfig({ ...env, APIDOG_SIGNATURE_HEADER: 'X-Apidog-Signature' }), checkDb() {}, accept(input) { received.push(input); return 'accepted'; } });
    const bytes = new TextEncoder().encode(` ${JSON.stringify(observed)}\n`);
    expect((await app.fetch(request(bytes, { 'X-Apidog-Signature': createHmac('sha1', secret).update(bytes).digest('base64') }))).status).toBe(202);
    expect(received).toEqual([{ source: 'apidog', event: 'API_UPDATED', raw: bytes }]);
  });
  test('rejects malformed and mismatched base64 before storage', async () => {
    let writes = 0;
    const app = createApp({ config: loadConfig(env), checkDb() {}, accept() { writes++; return 'accepted'; } });
    const bytes = encode(observed);
    const signature = createHmac('sha1', secret).update(bytes).digest('base64');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const noncanonical = signature.slice(0, -2) + alphabet[alphabet.indexOf(signature.at(-2)!) + 1] + '=';
    for (const value of ['', signature.slice(0, -1), signature + '=', '!' + signature.slice(1), noncanonical,
      Buffer.alloc(19).toString('base64'), Buffer.alloc(21).toString('base64'),
      createHmac('sha1', 'wrong-key').update(bytes).digest('base64'),
      createHmac('sha1', secret).update(JSON.stringify(observed, null, 2)).digest('base64')]) {
      expect((await app.fetch(request(bytes, { 'x-synthetic-signature': value }))).status).toBe(401);
    }
    expect(writes).toBe(0);
  });
  test('rejects missing, incorrect, wrong-header and reserialized signatures before storage', async () => {
    let writes = 0;
    const app = createApp({ config: loadConfig(env), checkDb() {}, accept() { writes++; return 'accepted'; } });
    const headers: Record<string, string>[] = [
      { 'x-synthetic-signature': '' }, { 'x-synthetic-signature': `sha1=${'0'.repeat(40)}` },
      { 'x-synthetic-signature': '', 'x-hub-signature': `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}` },
      { 'x-synthetic-signature': `sha1=${createHmac('sha1', secret).update(JSON.stringify(fixture, null, 2)).digest('hex')}` },
    ];
    for (const value of headers) expect((await app.fetch(request(raw, value))).status).toBe(401);
    expect(writes).toBe(0);
  });
  test('validates media type, JSON and 1 MiB actual/advertised limits without storage', async () => {
    let writes = 0;
    const app = createApp({ config: loadConfig(env), checkDb() {}, accept() { writes++; return 'accepted'; } });
    expect((await app.fetch(request(raw, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await app.fetch(request(new TextEncoder().encode('{broken')))).status).toBe(400);
    expect((await app.fetch(request(new Uint8Array([0xff])))).status).toBe(400);
    expect((await app.fetch(request(raw, { 'content-length': '1048577' }))).status).toBe(413);
    expect((await app.fetch(request(new Uint8Array(1048577), { 'content-length': '1' }))).status).toBe(413);
    expect(writes).toBe(0);
  });
  test('real stable notification IDs dedupe and conflicting bodies return 409', async () => {
    const store = openStore(':memory:');
    try {
      const app = createApp({ config: loadConfig(env), checkDb: () => store.checkHealth(), accept: input => store.accept(input) });
      expect((await app.fetch(request())).status).toBe(202);
      expect((await app.fetch(request())).status).toBe(200);
      expect((await app.fetch(request(encode({ ...fixture, event: 'schema.updated' })))).status).toBe(409);
    } finally { store.close(); }
  });
  test('omits invented IDs and uses rolling body dedupe across a time bucket', async () => {
    const store = openStore(':memory:');
    let now = 299999;
    const inputs: IncomingDelivery[] = [];
    try {
      const app = createApp({ config: loadConfig(env), checkDb() {}, accept(input) { inputs.push(input); return store.accept({ ...input, receivedAt: now }); } });
      const body = encode({ event: 'document.updated', id: 'object-id-is-not-notification-id' });
      expect((await app.fetch(request(body))).status).toBe(202);
      now = 300001;
      expect((await app.fetch(request(body))).status).toBe(200);
      now = 600000;
      expect((await app.fetch(request(body))).status).toBe(202);
      expect(inputs.every(input => !Object.hasOwn(input, 'deliveryId'))).toBe(true);
      expect(apidog.extractApidogDeliveryId(body, JSON.parse(new TextDecoder().decode(body)), now)).toBeUndefined();
    } finally { store.close(); }
  });
  test('storage errors return fixed diagnostics even for unknown events', async () => {
    const app = createApp({ config: loadConfig(env), checkDb() {}, accept() { throw new Error(secret); } });
    const response = await app.fetch(request(encode({ event: 'future' })));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"storage_unavailable"}');
  });
});
describe('Apidog cards', () => {
  for (const event of ['API_UPDATED', 'schema.updated', 'document.updated', 'test.completed']) {
    test(`${event} projects only source/event/title/content/link to configured topic`, () => {
      const [card] = apidog.formatApidog(delivery({ ...observed, event, extra: 'private-extra-field' }, event), { apidogTopic: 88 });
      expect(card!.topic).toBe(88);
      expect(card!.html).toContain('Apidog');
      expect(card!.html).toContain(event);
      expect(card!.html).toContain('Public API updated');
      expect(card!.html).toContain('GET /example\nResponse schema changed');
      expect(card!.button?.url).toBe('https://app.apidog.com/project/12345');
      expect(card!.html).not.toContain('private-extra-field');
    });
  }
  test('unknown/missing fields and unsafe/missing URLs stay readable', () => {
    for (const value of [null, [], { appLink: 'javascript:alert(1)' }, { appLink: 'https://user:pass@example.com' }]) {
      const [card] = apidog.formatApidog(delivery(value, 'future'), { apidogTopic: 89 });
      expect(card!.html).toContain('future');
      expect(card!.html).toContain('Apidog');
      expect(card!.button).toBeUndefined();
      expect(card!.html).not.toContain('<a');
    }
  });
  test('untrusted event/title/content text is escaped and bounded below Telegram limits', () => {
    const [card] = apidog.formatApidog(delivery({ title: '<b>&'.repeat(10000), content: 'First <script>\nSecond &' + '<i>&'.repeat(10000), appLink: 'https://app.apidog.com/?a=1&b=2' }, '<script>'.repeat(10000)), { apidogTopic: 9 });
    expect(card!.html).not.toContain('<script>');
    expect(card!.html).toContain('&lt;b&gt;&amp;');
    expect(card!.html).toContain('First &lt;script&gt;\nSecond &amp;');
    expect(card!.html.length).toBeLessThan(4096);
  });
});
