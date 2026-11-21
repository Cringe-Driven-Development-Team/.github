import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { startService } from '../src/main';
import { openStore } from '../src/store';

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

async function runService(
  attempts: Fixture[],
  body: (helpers: {
    post(id: string, event: string, data: object): Promise<void>;
    drained(): Promise<void>;
    cards: TelegramCard[];
    notices(): string[];
  }) => Promise<void>,
  options: { pulls?: Record<string, unknown[]> } = {},
) {
  const disk = checkout();
  const store = openStore(disk.path);
  store.activateReleases(Date.now() - 10_000, repo);
  store.close();
  const db = new Database(disk.path);
  const cards: TelegramCard[] = [];
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
    if (pulls) return Response.json(options.pulls?.[`${pulls[1]}:${pulls[2]}`] ?? []);
    throw new Error(`Unexpected test GitHub endpoint ${url.pathname}`);
  }) as typeof fetch;
  const service = startService(loadConfig({
    ...env, DATABASE_PATH: disk.path, WEBHOOK_ALERTS_SEND_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: '-1001',
  }), { fetch: fetcher });
  try {
    await body({
      async post(id, event, data) {
        const raw = JSON.stringify({ repository: { full_name: repo }, ...data });
        const response = await service.app.request('/webhooks/github', { method: 'POST', body: raw, headers: {
          'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': id,
          'X-Hub-Signature-256': `sha256=${createHmac('sha256', env.GITHUB_WEBHOOK_SECRET).update(raw).digest('hex')}`,
        } });
        expect(response.status).toBe(202);
      },
      async drained() {
        const drained = () => db.query('SELECT id FROM deliveries WHERE prepared = 0 UNION ALL SELECT id FROM outbox WHERE status != \'sent\'').get() === null;
        const until = Date.now() + 3_000;
        while (!drained() && Date.now() < until) await Bun.sleep(20);
        expect(drained()).toBe(true);
      },
      cards,
      notices: () => db.query<{ notice_key: string }, []>('SELECT notice_key FROM release_notices ORDER BY outbox_id').all().map(row => row.notice_key),
    });
  } finally {
    await service.stop();
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
  expect(() => loadConfig({ ...env, TELEGRAM_INFRA_ALERTS_TOPIC_ID: '0' })).toThrow('TELEGRAM_INFRA_ALERTS_TOPIC_ID');
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
    const activate = (cutoff: string) => Bun.spawnSync([process.execPath, 'run', 'src/cli.ts', 'infra-release-activate', cutoff], { env: { ...process.env, ...env, DATABASE_PATH: disk.path } });
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
    expect(() => startService(loadConfig({ ...env, DATABASE_PATH: disk.path, TELEGRAM_RELEASES_TOPIC_ID: '640', TELEGRAM_BACKEND_RELEASES_TOPIC_ID: '3377', TELEGRAM_INFRA_ALERTS_TOPIC_ID: undefined }))).toThrow('infra');
  } finally { disk.clean(); }
});

test('signed start and job completion become separate Infra cards with attempt logs and a uniquely confirmed PR', async () => {
  const release = fixture();
  await runService([release], async ({ post, drained, cards }) => {
    await post('start', 'deployment_status', started(release));
    await post('deploy-success', 'deployment_status', { ...started(release), deployment_status: { ...release.status, state: 'success' } });
    await drained();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ message_thread_id: 14389, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'Логи выкатки', url: attemptUrl }]] } });
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
  const foreign = fixture(1), preview = fixture(2), automatic = fixture(3), real = fixture(4);
  foreign.run.path = '.github/workflows/other.yml';
  preview.run.head_branch = 'preview';
  automatic.deployment.task = 'deploy';
  await runService([foreign, preview, automatic, real], async ({ post, drained, cards }) => {
    await post('foreign', 'workflow_job', completed(foreign));
    await post('preview', 'workflow_job', completed(preview));
    await post('automatic', 'deployment_status', started(automatic));
    await post('wrong-conclusion', 'workflow_job', { ...completed(real), workflow_job: { ...real.job, conclusion: 'cancelled' } });
    await post('wrong-identity', 'workflow_job', { ...completed(real), workflow_job: { ...real.job, head_sha: imageSha } });
    await post('unsigned-field-conflict', 'deployment_status', { ...started(real), deployment: { ...real.deployment, ref: imageSha } });
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

test('VPS3 deploy uses the validated image source and its PR, while initialize uses the infra SHA', async () => {
  const deploy = fixture(1), initialize = fixture(2);
  auxiliary(deploy);
  auxiliary(initialize);
  Object.assign(deploy.deployment.payload, { operation: 'deploy', service: 'webhook-alerts', source_sha: imageSha });
  initialize.deployment.payload.operation = 'initialize';
  await runService([deploy, initialize], async ({ post, drained, cards }) => {
    await post('deploy', 'workflow_job', completed(deploy));
    await post('initialize', 'workflow_job', completed(initialize));
    await drained();
    expect(cards).toHaveLength(4);
    expect(cards[1]!.text).toContain('Выкатка webhook-alerts завершилась успешно');
    expect(cards[1]!.text).toContain('<code>abcdef1</code>');
    expect(cards[1]!.text).not.toContain('1234567');
    expect(cards[1]!.text).not.toContain('Health Check');
    expect(cards[1]!.reply_markup.inline_keyboard[0]).toEqual([{ text: 'PR', url: `https://github.com/${publisher}/pull/35` }]);
    expect(cards[3]!.text).toContain('Инициализация VPS3 завершилась успешно');
    expect(cards[3]!.text).toContain('<code>1234567</code>');
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
