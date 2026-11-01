import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type Store } from '../src/store';
import { createApp } from '../src/http';
import { loadConfig } from '../src/config';
import { prepareOnce, deliverOnce, startWorker } from '../src/worker';
import { projectRelease, checkReleaseNotice } from '../src/releases';
import { releaseFixture, enqueue, status, REPO } from './helpers/release';
const resources: { dir: string; store: Store }[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'release-worker-')),
    s = openStore(join(dir, 'queue.sqlite'));
  resources.push({ dir, store: s });
  s.activateReleases(500);
  return s;
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
const config = { topic: 88, siteUrl: 'https://cellestial.ru' };
test('signed_enqueue_needs_only_target_pr_and_rechecks_before_send', async () => {
  const s = store(),
    f = releaseFixture(),
    d = enqueue();
  const app = createApp({
    config: loadConfig({
      GITHUB_WEBHOOK_SECRET: 'test',
      APIDOG_SIGNATURE_KEY: 'test',
      APIDOG_SIGNATURE_HEADER: 'X-Test',
    }),
    accept: (input) => s.accept({ ...input, receivedAt: 1000 }),
    checkDb: () => s.checkHealth(),
  });
  const response = await app.request('/webhooks/github', {
    method: 'POST',
    body: new TextDecoder().decode(d.raw),
    headers: {
      'content-type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'signed',
      'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'test').update(d.raw).digest('hex'),
    },
  });
  expect(response.status).toBe(202);
  expect(f.calls).toEqual([]);
  await prepareOnce({
    store: s,
    project: (input) => projectRelease(input, f.api, config),
    now: 1000,
    lane: 'release-queue',
  });
  f.queue.merged = true;
  f.queue.entry = null;
  let sent = 0;
  await deliverOnce({
    store: s,
    now: 1000,
    send: async () => {
      sent++;
      return { kind: 'sent', telegramMessageId: 1 };
    },
    beforeReleaseSend: (n) => checkReleaseNotice(n, f.api),
  });
  expect(sent).toBe(0);
  expect(f.calls).toEqual(['queue', 'queue']);
});
test('queue_sends_while_release_enrichment_waits', async () => {
  const s = store(),
    f = releaseFixture(),
    controller = new AbortController();
  let release!: () => void, entered!: () => void, delivered!: () => void;
  const blocked = new Promise<void>((r) => (release = r)),
    entry = new Promise<void>((r) => (entered = r)),
    sent = new Promise<void>((r) => (delivered = r));
  const d = status();
  s.accept({ source: 'github', event: d.event, deliveryId: 'slow', raw: d.raw, receivedAt: 1000 });
  const worker = startWorker({
    store: s,
    project: async () => [],
    releaseProject: async (input) => {
      if (input.event === 'deployment_status') {
        entered();
        await blocked;
        return [];
      }
      return projectRelease(input, f.api, config);
    },
    beforeReleaseSend: (n) => checkReleaseNotice(n, f.api),
    send: async (message) => {
      expect(message.release?.kind).toBe('queue');
      delivered();
      return { kind: 'sent', telegramMessageId: 9 };
    },
    signal: controller.signal,
  });
  try {
    await Promise.race([
      entry,
      Bun.sleep(3000).then(() => {
        throw new Error('operation did not start');
      }),
    ]);
    const q = enqueue();
    s.accept({
      source: 'github',
      event: q.event,
      deliveryId: 'fast',
      raw: q.raw,
      receivedAt: 1001,
    });
    await Promise.race([
      sent,
      Bun.sleep(3000).then(() => {
        throw new Error('queue blocked behind operation');
      }),
    ]);
    expect(f.calls).not.toContain('changes');
  } finally {
    release();
    controller.abort();
    await worker;
  }
});
test('activation_requires_release_topic_and_token_at_service_start', async () => {
  const s = store();
  const db = resources.at(-1)!.dir + '/queue.sqlite';
  const { startService } = await import('../src/main');
  expect(() =>
    startService(
      loadConfig({
        GITHUB_WEBHOOK_SECRET: 'test',
        APIDOG_SIGNATURE_KEY: 'test',
        APIDOG_SIGNATURE_HEADER: 'X-Test',
        DATABASE_PATH: db,
      }),
    ),
  ).toThrow('release');
});

test('blocked_ready_guard_does_not_hold_queue_or_ordinary_sends_and_transport_stays_serial', async () => {
  const s = store(),
    f = releaseFixture(),
    controller = new AbortController();
  f.operation.kind = 'publish';
  let unblock!: () => void, entered!: () => void, queueSent!: () => void, ordinarySent!: () => void;
  const blocked = new Promise<void>((resolve) => (unblock = resolve));
  const checking = new Promise<void>((resolve) => (entered = resolve));
  const queueDone = new Promise<void>((resolve) => (queueSent = resolve));
  const ordinaryDone = new Promise<void>((resolve) => (ordinarySent = resolve));
  f.api.production = async () => {
    entered();
    await blocked;
    return [];
  };
  const d = status('success', 'release-artifacts');
  s.accept({ source: 'github', event: d.event, deliveryId: 'ready', raw: d.raw, receivedAt: 1000 });
  await prepareOnce({
    store: s,
    project: (input) => projectRelease(input, f.api, config),
    now: 1000,
    lane: 'release-operation',
  });
  let active = 0,
    maxActive = 0;
  const worker = startWorker({
    store: s,
    signal: controller.signal,
    project: async () => [{ topic: 26, html: 'Ordinary' }],
    releaseProject: (input) => projectRelease(input, f.api, config),
    beforeReleaseSend: (notice) => checkReleaseNotice(notice, f.api),
    send: async (message) => {
      maxActive = Math.max(maxActive, ++active);
      await Bun.sleep(20);
      active--;
      if (message.release?.kind === 'queue') queueSent();
      if (!message.release) ordinarySent();
      return { kind: 'sent', telegramMessageId: 1 };
    },
  });
  try {
    await checking;
    const q = enqueue();
    s.accept({
      source: 'github',
      event: q.event,
      deliveryId: 'queue',
      raw: q.raw,
      receivedAt: 1001,
    });
    s.accept({
      source: 'github',
      event: 'issues',
      deliveryId: 'ordinary',
      raw: new TextEncoder().encode('{}'),
      receivedAt: 1002,
    });
    await Promise.race([
      Promise.all([queueDone, ordinaryDone]),
      Bun.sleep(2500).then(() => {
        throw new Error('ready history blocked unrelated delivery');
      }),
    ]);
    expect(maxActive).toBe(1);
  } finally {
    unblock();
    controller.abort();
    await worker;
  }
});

test('send_lease_and_next_claim_use_time_after_slow_guard', async () => {
  const s = store(),
    d = status();
  s.accept({
    source: 'github',
    event: d.event,
    deliveryId: 'slow-guard',
    raw: d.raw,
    receivedAt: 1000,
  });
  s.prepare(s.claimUnprepared(1000, 100, 'release-operation')[0]!.id, [
    {
      topic: 88,
      html: 'Ready',
      release: {
        kind: 'ready',
        key: 'ready',
        sha: 'b'.repeat(40),
        operationKey: 'result:publish:10:1',
      },
    },
  ]);
  let elapsed = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => elapsed);
  const claim = spyOn(s, 'claimDue');
  const db = new Database(resources.at(-1)!.dir + '/queue.sqlite');
  try {
    let sent = 0;
    await deliverOnce({
      store: s,
      now: 1000,
      startedAt: 0,
      beforeReleaseSend: async () => {
        elapsed = 130000;
        return 'send';
      },
      send: async () => {
        expect(
          db.query<{ lease_until: number }, []>('SELECT lease_until FROM outbox').get()!.lease_until,
        ).toBeGreaterThan(elapsed + 1000);
        sent++;
        return { kind: 'sent', telegramMessageId: 1 };
      },
    });
    expect(sent).toBe(1);
    expect(claim.mock.calls[1]![0]).toBe(131000);
  } finally {
    db.close();
    claim.mockRestore();
    clock.mockRestore();
  }
});
