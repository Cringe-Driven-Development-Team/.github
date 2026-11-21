import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { startService } from '../src/main';
import { openStore, type OutgoingMessage, type ReleaseNotice } from '../src/store';
import { sendMessage } from '../src/telegram';
import { deliverOnce } from '../src/worker';

const repo = 'Cringe-Driven-Development-Team/infra';
const publisher = 'Cringe-Driven-Development-Team/.github';
const infraSha = '1234567890abcdef1234567890abcdef12345678';
const imageSha = 'abcdef1234567890abcdef1234567890abcdef12';
const attemptUrl = `https://github.com/${repo}/actions/runs/7/attempts/2`;
const env = { GITHUB_WEBHOOK_SECRET: 'signed-test', GITHUB_API_TOKEN: 'synthetic-never-print', TELEGRAM_INFRA_ALERTS_TOPIC_ID: '14389' };

function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'infra-alerts-'));
  return { path: join(dir, 'queue.sqlite'), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

function fixture(attempt = 2) {
  const run = {
    id: 7, run_attempt: attempt, path: '.github/workflows/infra.yml', head_sha: infraSha, head_branch: 'main', event: 'push',
    repository: { full_name: repo }, head_repository: { full_name: repo }, actor: { login: 'original' },
    triggering_actor: { login: 'maintainer' },
  };
  const job = {
    id: 70 + attempt, name: 'Выкатка на прод', run_id: 7, run_attempt: attempt, head_sha: infraSha, head_branch: 'main',
    status: 'completed', conclusion: 'success', completed_at: new Date().toISOString(), steps: [{ name: 'verify.yml', conclusion: 'success' }],
  };
  const deployment = {
    id: 700 + attempt, ref: infraSha, sha: infraSha, task: 'infra-alerts', environment: 'production',
    payload: { schema: 1, kind: 'infra', run_id: 7, run_attempt: attempt } as Record<string, unknown>,
  };
  const status = {
    id: 7000 + attempt, state: 'in_progress', environment: 'production', created_at: new Date().toISOString(),
    log_url: `https://github.com/${repo}/actions/runs/7/attempts/${attempt}`,
  };
  return { run, job, deployment, status, withDeployment: true };
}

type Fixture = ReturnType<typeof fixture>;
type TelegramCard = { message_thread_id: number; text: string; link_preview_options: unknown; reply_markup: { inline_keyboard: { text: string; url: string }[][] } };

async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 3_000;
  while (!predicate() && Date.now() < until) await Bun.sleep(20);
  expect(predicate()).toBe(true);
}

async function runService(
  attempts: Fixture[],
  body: (helpers: {
    post(id: string, event: string, data: object): Promise<void>;
    drained(): Promise<void>;
    cards: TelegramCard[];
    notices(): string[];
    pullLookups: string[];
    db: Database;
    restart(overrides?: Record<string, string | undefined>): Promise<void>;
  }) => Promise<void>,
  options: {
    pulls?: Record<string, unknown[]>;
    activate?: boolean;
    config?: Record<string, string | undefined>;
    seed?: (store: ReturnType<typeof openStore>) => void;
  } = {},
) {
  const disk = checkout();
  const store = openStore(disk.path);
  try {
    if (options.activate !== false) store.activateReleases(Date.now() - 10_000, repo);
    options.seed?.(store);
  } finally { store.close(); }
  const db = new Database(disk.path);
  const cards: TelegramCard[] = [];
  const pullLookups: string[] = [];
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.telegram.org') {
      cards.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: cards.length } });
    }
    const path = url.pathname.replace(`/repos/${repo}`, '');
    if (path === '/deployments') {
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ sha: infraSha, environment: 'production', task: 'infra-alerts' });
      return Response.json(attempts.filter(f => f.withDeployment).map(f => f.deployment));
    }
    for (const f of attempts) {
      const runPath = `/actions/runs/7/attempts/${f.run.run_attempt}`;
      const deploymentPath = `/deployments/${f.deployment.id}`;
      if (path === runPath) return Response.json(f.run);
      if (path === `${runPath}/jobs`) return Response.json({ total_count: 1, jobs: [f.job] });
      if (path === deploymentPath) return Response.json(f.deployment);
      if (path === `${deploymentPath}/statuses`) return Response.json([f.status]);
      if (path === `${deploymentPath}/statuses/${f.status.id}`) return Response.json(f.status);
    }
    const pulls = /\/repos\/(.+)\/commits\/([a-f0-9]{40})\/pulls$/.exec(url.pathname);
    if (pulls) {
      const lookup = `${pulls[1]}:${pulls[2]}`;
      pullLookups.push(lookup);
      return Response.json(options.pulls?.[lookup] ?? []);
    }
    throw new Error(`Unexpected test GitHub endpoint ${url.pathname}`);
  }) as typeof fetch;
  let service: ReturnType<typeof startService> | undefined;
  const restart = async (overrides?: Record<string, string | undefined>) => {
    await service?.stop();
    service = startService(loadConfig({
      ...env, DATABASE_PATH: disk.path, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: '-1001',
      ...options.config, ...overrides,
    }), { fetch: fetcher });
  };
  try {
    await restart();
    await body({
      async post(id, event, data) {
        const raw = JSON.stringify({ repository: { full_name: repo }, ...data });
        const response = await service!.app.request('/webhooks/github', { method: 'POST', body: raw, headers: {
          'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': id,
          'X-Hub-Signature-256': `sha256=${createHmac('sha256', env.GITHUB_WEBHOOK_SECRET).update(raw).digest('hex')}`,
        } });
        expect(response.status).toBe(202);
      },
      drained: () => waitFor(() => db.query("SELECT id FROM deliveries WHERE prepared = 0 UNION ALL SELECT id FROM outbox WHERE status != 'sent'").get() === null),
      cards,
      pullLookups,
      db,
      restart,
      notices: () => db.query<{ notice_key: string }, []>('SELECT notice_key FROM release_notices ORDER BY outbox_id').all().map(row => row.notice_key),
    });
  } finally {
    await service?.stop();
    db.close();
    disk.clean();
  }
}

const started = (f: Fixture) => ({ action: 'created', deployment: f.deployment, deployment_status: f.status });
const completed = (f: Fixture) => ({ action: 'completed', workflow_job: { ...f.job, steps: [] } });
const merged = (number: number, sha = infraSha, repository = repo) => ({ number, base: { ref: 'main', repo: { full_name: repository } }, merged_at: '2026-11-20T00:00:00Z', merge_commit_sha: sha });

test('infra topic is independent and requires a GitHub read token', () => {
  expect(loadConfig({ ...env, TELEGRAM_RELEASES_TOPIC_ID: '640', TELEGRAM_BACKEND_RELEASES_TOPIC_ID: '3377' })).toMatchObject({
    releasesTopic: 640, backendReleasesTopic: 3377, infraReleasesTopic: 14389,
  });
  expect(() => loadConfig({ ...env, GITHUB_API_TOKEN: '' })).toThrow('GITHUB_API_TOKEN');
  for (const topic of ['0', '14389x', ' 14389', '9007199254740992']) {
    expect(() => loadConfig({ ...env, TELEGRAM_INFRA_ALERTS_TOPIC_ID: topic })).toThrow('TELEGRAM_INFRA_ALERTS_TOPIC_ID');
  }
  for (const name of ['TELEGRAM_RELEASES_TOPIC_ID', 'TELEGRAM_BACKEND_RELEASES_TOPIC_ID']) {
    expect(() => loadConfig({ ...env, [name]: '' })).toThrow(name);
  }
});

const ordinaryIssue = {
  action: 'opened', issue: { number: 25, title: 'Обычное уведомление', html_url: `https://github.com/${repo}/issues/25` },
  sender: { login: 'maintainer' },
};

test.each(['', ' \t '])('ordinary Infra issue is delivered before activation with a blank Infra topic (%j)', async topic => {
  await runService([], async ({ post, drained, cards }) => {
    await post('issue', 'issues', ordinaryIssue);
    await drained();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ message_thread_id: 26, text: expect.stringContaining('Обычное уведомление') });
  }, { activate: false, config: { TELEGRAM_INFRA_ALERTS_TOPIC_ID: topic, GITHUB_API_TOKEN: undefined } });
});

test.each([undefined, ''])('after activation a disabled Infra topic (%j) pauses the queue until re-enabled', async topic => {
  const frontend = topic === '';
  const release = fixture(2);
  release.withDeployment = false;
  await runService([release], async ({ post, drained, cards, db, restart, notices }) => {
    const cutoff = () => db.query('SELECT cutoff_ms FROM infra_release_activation').get();
    const activatedAt = cutoff();
    await post('paused-result', 'workflow_job', completed(release));
    if (frontend) {
      await post('frontend', 'workflow_job', { repository: { full_name: 'Cringe-Driven-Development-Team/frontend' }, action: 'queued' });
      await waitFor(() => !!db.query("SELECT 1 FROM deliveries WHERE delivery_id = 'frontend' AND prepared = 1").get());
    }
    await post('issue', 'issues', ordinaryIssue);
    await waitFor(() => cards.some(card => card.message_thread_id === 26));
    expect(cards.map(card => card.message_thread_id)).toEqual([26]);
    expect(db.query("SELECT prepared FROM deliveries WHERE delivery_id = 'paused-result'").get()).toEqual({ prepared: 0 });
    expect(db.query('SELECT status, attempts FROM outbox WHERE topic = 14389').all()).toEqual([{ status: 'pending', attempts: 0 }]);
    await restart({ TELEGRAM_INFRA_ALERTS_TOPIC_ID: '14389', GITHUB_API_TOKEN: env.GITHUB_API_TOKEN });
    await drained();
    expect(cards.map(card => card.message_thread_id)).toEqual([26, 14389, 14389]);
    expect(notices()).toEqual([`start:${repo}:7:1`, `result:${repo}:7:2`]);
    expect(cutoff()).toEqual(activatedAt);
  }, {
    config: {
      TELEGRAM_INFRA_ALERTS_TOPIC_ID: topic,
      TELEGRAM_RELEASES_TOPIC_ID: frontend ? '640' : undefined,
      GITHUB_API_TOKEN: frontend ? env.GITHUB_API_TOKEN : undefined,
    },
    seed: store => {
      if (frontend) store.activateReleases(Date.now() - 10_000);
      enqueueAttempt(store, 1, ['start'], Date.now());
    },
  });
});

test('migration from v6 preserves previous activations and CLI keeps the infra cutoff immutable', () => {
  const disk = checkout();
  try {
    const store = openStore(disk.path);
    store.activateReleases(100);
    store.activateReleases(200, 'Cringe-Driven-Development-Team/backend');
    store.close();
    const db = new Database(disk.path);
    db.exec('DROP TABLE IF EXISTS infra_release_activation; PRAGMA user_version = 6');
    db.close();
    const cli = join(import.meta.dir, '../src/cli.ts');
    const activate = (cutoff: string) => Bun.spawnSync([process.execPath, 'run', cli, 'infra-release-activate', cutoff], { env: { ...process.env, ...env, DATABASE_PATH: disk.path } });
    const result = activate('2020-01-01T00:00:00Z');
    expect(result.exitCode).toBe(0);
    expect(activate('2020-01-01T00:00:00Z').exitCode).toBe(0);
    const moved = activate('2020-01-02T00:00:00Z');
    expect(moved.exitCode).toBe(1);
    expect(moved.stderr.toString()).not.toContain(env.GITHUB_API_TOKEN);
    const migrated = openStore(disk.path);
    try {
      expect(migrated.releaseActivation()).toBe(100);
      expect(migrated.releaseActivation('Cringe-Driven-Development-Team/backend')).toBe(200);
      expect(migrated.releaseActivation(repo)).toBe(1577836800000);
    } finally { migrated.close(); }
  } finally { disk.clean(); }
});

test.each([
  ['action_required', 'требует действий'],
  ['neutral', 'завершилась с нейтральным результатом'],
  ['timed_out', 'завершилась с ошибкой'],
])('signed production job outcome %s sends one result across duplicate deliveries', async (conclusion, heading) => {
  const release = fixture();
  release.withDeployment = false;
  release.job.conclusion = conclusion;
  release.job.steps = [];
  await runService([release], async ({ post, drained, cards, notices }) => {
    await post('terminal', 'workflow_job', completed(release));
    await post('terminal-duplicate', 'workflow_job', completed(release));
    await drained();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ message_thread_id: 14389, text: expect.stringContaining(`Выкатка инфры ${heading}`) });
    expect(notices()).toEqual([`result:${repo}:7:2`]);
  });
});

test('signed start and job completion become separate Infra cards with attempt logs and a uniquely confirmed PR', async () => {
  const release = fixture();
  await runService([release], async ({ post, drained, cards }) => {
    await post('start', 'deployment_status', started(release));
    await post('deploy-success', 'deployment_status', { ...started(release), deployment_status: { ...release.status, state: 'success' } });
    await drained();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ message_thread_id: 14389, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'PR', url: `https://github.com/${repo}/pull/171` }], [{ text: 'Логи выкатки', url: attemptUrl }]] } });
    expect(cards[0]!.text).toContain('Выкатка инфры началась');
    expect(cards[0]!.text).toContain('Запустил: maintainer');
    expect(cards[0]!.text).not.toContain('Health Check');
    await post('result', 'workflow_job', completed(release));
    await drained();
    expect(cards).toHaveLength(2);
    expect(cards[1]!.text).toContain('Выкатка инфры завершилась успешно');
    expect(cards[1]!.text).toContain('Health Check ✅');
    expect(cards[1]!.reply_markup.inline_keyboard).toEqual([[{ text: 'PR', url: `https://github.com/${repo}/pull/171` }], [{ text: 'Логи выкатки', url: attemptUrl }]]);
  }, { pulls: { [`${repo}:${infraSha}`]: [merged(171), merged(172, imageSha)] } });
});

test('a result before its start enqueues start first, deduplicates new delivery IDs and permits the next attempt', async () => {
  const second = fixture(), third = fixture(3);
  await runService([second, third], async ({ post, drained, cards, notices }) => {
    await post('result-first', 'workflow_job', completed(second));
    await drained();
    expect(cards.map(card => card.text.split('\n')[0])).toEqual(['<b>⏳ Выкатка инфры началась</b>', '<b>✅ Выкатка инфры завершилась успешно</b>']);
    await post('late-start', 'deployment_status', started(second));
    await post('second-result-delivery', 'workflow_job', completed(second));
    await post('third-attempt-result', 'workflow_job', completed(third));
    await drained();
    expect(notices()).toEqual([`start:${repo}:7:2`, `result:${repo}:7:2`, `start:${repo}:7:3`, `result:${repo}:7:3`]);
    expect(cards).toHaveLength(4);
    expect(cards[3]!.reply_markup.inline_keyboard[0]![0]!.url).toEndWith('/attempts/3');
  });
});

test('preview, an unrelated run, an automatic Deployment and an event inconsistent with the verified job are silent', async () => {
  const foreign = fixture(1), preview = fixture(2), automatic = fixture(3), real = fixture(4), skipped = fixture(5);
  foreign.run.path = '.github/workflows/other.yml';
  preview.run.head_branch = 'preview';
  automatic.deployment.task = 'deploy';
  skipped.job.conclusion = 'skipped';
  await runService([foreign, preview, automatic, real, skipped], async ({ post, drained, cards }) => {
    await post('foreign', 'workflow_job', completed(foreign));
    await post('preview', 'workflow_job', completed(preview));
    await post('automatic', 'deployment_status', started(automatic));
    await post('wrong-conclusion', 'workflow_job', { ...completed(real), workflow_job: { ...real.job, conclusion: 'cancelled' } });
    await post('wrong-identity', 'workflow_job', { ...completed(real), workflow_job: { ...real.job, head_sha: imageSha } });
    await post('unsigned-field-conflict', 'deployment_status', { ...started(real), deployment: { ...real.deployment, ref: imageSha } });
    await post('skipped-start', 'deployment_status', started(skipped));
    await post('skipped-result', 'workflow_job', completed(skipped));
    await drained();
    expect(cards).toEqual([]);
  });
});

function auxiliary(f: Fixture) {
  f.run.path = '.github/workflows/auxiliary-deploy.yml';
  f.run.event = 'workflow_dispatch';
  f.job.name = 'production';
  f.deployment.payload.kind = 'auxiliary';
}

test('an early VPS3 failure has a failed step and no substituted image SHA, while cancellation stays distinct', async () => {
  const early = fixture(1), cancelled = fixture(2);
  auxiliary(early);
  early.withDeployment = false;
  early.job.conclusion = 'failure';
  early.job.steps = [{ name: 'Validate <release> & source', conclusion: 'failure' }, { name: 'verify.yml', conclusion: 'skipped' }];
  cancelled.withDeployment = false;
  cancelled.job.conclusion = 'cancelled';
  cancelled.job.steps = [{ name: 'pulumi up', conclusion: 'cancelled' }];
  await runService([early, cancelled], async ({ post, drained, cards }) => {
    await post('early', 'workflow_job', completed(early));
    await post('cancelled', 'workflow_job', completed(cancelled));
    await drained();
    expect(cards).toHaveLength(2);
    expect(cards[0]!.text).toContain('Операция на VPS3 завершилась с ошибкой');
    expect(cards[0]!.text).toContain('Validate &lt;release&gt; &amp; source');
    expect(cards[0]!.text).not.toContain('1234567');
    expect(cards[0]!.text).not.toContain('Health Check');
    expect(cards[1]!.text).toContain('Выкатка инфры отменена');
    expect(cards[1]!.text).toContain('pulumi up');
    expect(cards[1]!.text).not.toContain('Health Check');
  });
});

test('VPS3 deploy and initialize use the PR matching each verified source for both phases', async () => {
  const deploy = fixture(1), initialize = fixture(2);
  auxiliary(deploy);
  auxiliary(initialize);
  Object.assign(deploy.deployment.payload, { operation: 'deploy', service: 'webhook-alerts', source_sha: imageSha });
  initialize.deployment.payload.operation = 'initialize';
  await runService([deploy, initialize], async ({ post, drained, cards, pullLookups }) => {
    await post('deploy', 'workflow_job', completed(deploy));
    await post('initialize', 'workflow_job', completed(initialize));
    await drained();
    expect(cards).toHaveLength(4);
    expect(cards[1]!.text).toContain('Выкатка webhook-alerts завершилась успешно');
    expect(cards[1]!.text).toContain('<code>abcdef1</code>');
    expect(cards[1]!.text).not.toContain('1234567');
    expect(cards[1]!.text).not.toContain('Health Check');
    expect(cards[3]!.text).toContain('Инициализация VPS3 завершилась успешно');
    expect(cards[3]!.text).toContain('<code>1234567</code>');
    for (const card of [cards[3]!, cards[2]!]) {
      expect(card.reply_markup.inline_keyboard[0]).toEqual([{ text: 'PR', url: `https://github.com/${repo}/pull/171` }]);
    }
    for (const card of cards.slice(0, 2)) {
      expect(card.reply_markup.inline_keyboard[0]).toEqual([{ text: 'PR', url: `https://github.com/${publisher}/pull/35` }]);
    }
    expect(pullLookups).toEqual([`${publisher}:${imageSha}`, `${repo}:${infraSha}`]);
  }, { pulls: { [`${publisher}:${imageSha}`]: [merged(35, imageSha, publisher), merged(36, imageSha, repo)], [`${repo}:${infraSha}`]: [merged(171)] } });
});

test('recovery cannot queue a pre-activation start, verify.yml reports failure and ambiguous PRs are omitted', async () => {
  const release = fixture();
  release.status.created_at = '2020-01-01T00:00:00Z';
  release.job.conclusion = 'failure';
  release.job.steps = [{ name: 'verify.yml', conclusion: 'failure' }];
  await runService([release], async ({ post, drained, cards, notices }) => {
    await post('recent-result', 'workflow_job', completed(release));
    await drained();
    expect(notices()).toEqual([`result:${repo}:7:2`]);
    expect(cards[0]!.text).toContain('Health Check ❌');
    expect(cards[0]!.text).toContain('Этап сбоя — verify.yml');
    expect(cards[0]!.reply_markup.inline_keyboard).toHaveLength(1);
  }, { pulls: { [`${repo}:${infraSha}`]: [merged(171), merged(172)] } });
});


test('recent redelivery of a signed start or result from before activation is silent', async () => {
  const release = fixture();
  release.status.created_at = '2020-01-01T00:00:00Z';
  release.job.completed_at = '2020-01-01T00:01:00Z';
  await runService([release], async ({ post, drained, cards, notices }) => {
    await post('old-start', 'deployment_status', started(release));
    await post('old-result', 'workflow_job', completed(release));
    await drained();
    expect(cards).toEqual([]);
    expect(notices()).toEqual([]);
  });
});


function enqueueAttempt(store: ReturnType<typeof openStore>, attempt: number, phases: ('start' | 'result')[], receivedAt = 1000) {
  store.accept({ source: 'github', deliveryId: `attempt-${attempt}`, event: 'workflow_job', receivedAt,
    raw: new TextEncoder().encode(JSON.stringify({ repository: { full_name: repo } })) });
  const delivery = store.claimUnprepared(receivedAt, 100, 'release-operation')[0]!;
  store.prepare(delivery.id, phases.map((kind): OutgoingMessage => {
    const notice = { key: `${kind}:${repo}:7:${attempt}`, repository: repo, runId: 7, attempt } as const;
    const release: ReleaseNotice = kind === 'start'
      ? { ...notice, kind, deploymentId: 700 + attempt }
      : { ...notice, kind, jobId: 70 + attempt };
    return { topic: 14389, html: `${kind} ${attempt}`, release };
  }));
}

test('an Infra result waits after Telegram 429 on its start while another attempt sends', async () => {
  const store = openStore(':memory:');
  try {
    store.activateReleases(0, repo);
    enqueueAttempt(store, 2, ['start', 'result']);
    enqueueAttempt(store, 3, ['result']);
    const requests: string[] = [];
    const fetcher = (async (_input, init) => {
      const text = JSON.parse(String(init?.body)).text;
      requests.push(text);
      if (requests.length === 1) return Response.json({ ok: false, parameters: { retry_after: 2 } }, { status: 429 });
      return Response.json({ ok: true, result: { message_id: requests.length } });
    }) as typeof fetch;
    const send = (message: OutgoingMessage) => sendMessage(message, { botToken: 'fake', chatId: '-1001' }, fetcher);
    await deliverOnce({ store, send, now: 1000, lane: 'release-operation' });
    expect(requests).toEqual(['start 2', 'result 3']);
    await deliverOnce({ store, send, now: 5000, lane: 'release-operation' });
    expect(requests).toEqual(['start 2', 'result 3', 'start 2', 'result 2']);
  } finally { store.close(); }
});

test('an Infra result cannot be claimed while its start is leased, then proceeds after terminal failure', () => {
  const store = openStore(':memory:');
  try {
    store.activateReleases(0, repo);
    enqueueAttempt(store, 2, ['start', 'result']);
    const start = store.claimDue(1000, 100, 1, 'release-operation')[0]!;
    expect(start.html).toBe('start 2');
    expect(store.claimDue(1001, 100, 1, 'release-operation')).toEqual([]);
    store.markFailed(start.id, 'telegram_400');
    expect(store.claimDue(1002, 100, 1, 'release-operation').map(message => message.html)).toEqual(['result 2']);
  } finally { store.close(); }
});
