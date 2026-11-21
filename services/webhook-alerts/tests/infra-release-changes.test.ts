import { expect, test } from 'bun:test';
import { createInfraReleaseApi, type InfraReleaseApi } from '../src/infra-releases';

const repo = 'Cringe-Driven-Development-Team/infra';
const publisher = 'Cringe-Driven-Development-Team/.github';
const base = '0e89eb5139d35c834ae720655588ae1f26d4d62d';
const head = '430053a157dcd6d9660f8da1285b37482384b256';
const imageA = 'a'.repeat(40), imageB = 'b'.repeat(40), imageHead = 'c'.repeat(40);
const prSha = 'd'.repeat(40), secondPrSha = 'e'.repeat(40), laterSha = 'f'.repeat(40);
const startedAt = '2026-11-21T17:07:10Z';
type Service = 'githubbot' | 'webhook-alerts';

function release(runId: number, sha: string, completedAt: string, conclusion = 'success', service?: Service, sourceSha?: string) {
  const kind = service ? 'auxiliary' : 'infra';
  const environment = 'production';
  return {
    id: runId + 500, sha, ref: sha, environment, task: 'infra-alerts',
    created_at: new Date(Date.parse(completedAt) - 15_000).toISOString(),
    payload: {
      schema: 1, kind, run_id: runId, run_attempt: 1,
      ...(service ? { operation: 'deploy', service, source_sha: sourceSha } : {}),
    },
    conclusion, completedAt,
  };
}

function current(service?: Service, sourceSha = imageHead) {
  const kind = service ? 'auxiliary' : 'infra';
  const attempt = { kind, runId: 10, attempt: 1, sha: head, job: { started_at: startedAt } } as const;
  const deployment = { ...attempt, id: 510, ...(service ? { operation: 'deploy' as const, service, sourceSha } : {}) };
  return [attempt, deployment] satisfies Parameters<InfraReleaseApi['changes']>;
}

function pr(repository: string, number: number, sha: string, title: string) {
  return { number, title, merge_commit_sha: sha, merged_at: startedAt, base: { ref: 'main', repo: { full_name: repository } } };
}

const issue = { id: 'issue-9', number: 9, title: 'Связанная задача', repository: { nameWithOwner: repo } };

function github({
  history = [release(3, base, '2026-11-21T16:44:40Z')],
  commits = [head], total = commits.length, status = 200, relation = 'ahead',
  pulls = {}, issues = {}, files = {}, beforePulls,
}: {
  history?: ReturnType<typeof release>[];
  commits?: string[];
  total?: number;
  status?: number;
  relation?: string;
  pulls?: Record<string, ReturnType<typeof pr>[]>;
  issues?: Record<number, typeof issue[]>;
  files?: Record<number, { filename: string; previous_filename?: string }[]>;
  beforePulls?: (sha: string) => Promise<void>;
} = {}) {
  const requested: string[] = [];
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    requested.push(url.href);
    if (path === '/graphql') {
      const query = JSON.parse(String(init?.body));
      const number = query.variables.number;
      return Response.json({ data: { repository: { pullRequest: {
        title: 'PR', closingIssuesReferences: { nodes: issues[number] ?? [], pageInfo: { hasNextPage: false } },
      } } } });
    }
    if (path === '/repos/' + repo + '/deployments') {
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ environment: 'production', task: 'infra-alerts' });
      return Response.json(history);
    }
    for (const entry of history) {
      const { run_id: runId, kind } = entry.payload;
      const logUrl = 'https://github.com/' + repo + '/actions/runs/' + runId + '/attempts/1';
      if (path === '/repos/' + repo + '/deployments/' + entry.id + '/statuses') {
        return Response.json([
          { state: 'inactive', created_at: '2026-11-21T18:00:00Z', environment: 'production', log_url: logUrl },
          { state: entry.conclusion, created_at: entry.completedAt, environment: 'production', log_url: logUrl },
        ]);
      }
      const attemptPath = '/repos/' + repo + '/actions/runs/' + runId + '/attempts/1';
      if (path === attemptPath) return Response.json({
        id: runId, run_attempt: 1, head_sha: entry.sha, head_branch: 'main', event: 'workflow_dispatch',
        repository: { full_name: repo }, head_repository: { full_name: repo },
        path: kind === 'infra' ? '.github/workflows/infra.yml' : '.github/workflows/auxiliary-deploy.yml',
      });
      if (path === attemptPath + '/jobs') return Response.json({ jobs: [{
        id: runId + 200, name: kind === 'infra' ? 'Выкатка на прод' : 'production',
        run_id: runId, run_attempt: 1, head_sha: entry.sha, head_branch: 'main',
        status: 'completed', conclusion: entry.conclusion, completed_at: entry.completedAt,
      }] });
    }
    if (path.includes('/compare/')) return Response.json({ status: relation, total_commits: total, commits: commits.map(sha => ({ sha })) }, { status });
    const merge = path.match(/\/commits\/([a-f0-9]{40})\/pulls$/);
    if (merge?.[1]) {
      await beforePulls?.(merge[1]);
      return Response.json(pulls[merge[1]] ?? []);
    }
    const pullFiles = path.match(/\/pulls\/(\d+)\/files$/);
    if (pullFiles) return Response.json(files[Number(pullFiles[1])] ?? []);
    throw new Error('Unexpected GitHub endpoint: ' + path);
  }) as typeof fetch;
  return { api: createInfraReleaseApi({ token: 'stub-token', fetch: fetcher, cutoffMs: () => 0 }), requested };
}

test('selects the last real Infra success before this attempt, ignoring later inactive and failed deploys', async () => {
  const { api } = github({ history: [
    release(11, laterSha, '2026-11-21T17:18:00Z'),
    release(10, head, '2026-11-21T17:13:00Z'),
    release(9, laterSha, '2026-11-21T17:04:00Z', 'failure'),
    release(3, base, '2026-11-21T16:44:40Z'),
  ] });
  const [attempt, deployment] = current();
  const actual = await api.changes(attempt, deployment);
  expect(actual).toMatchObject({ base, head, compareUrl: 'https://github.com/' + repo + '/compare/' + base + '...' + head });
  const finished = { ...attempt, job: { ...attempt.job, completed_at: '2026-11-21T17:13:00Z' } };
  expect(await api.changes(finished, deployment)).toEqual(actual);
});

test('deduplicates a shared issue and includes a PR without an issue', async () => {
  const { api } = github({
    commits: [prSha, secondPrSha, head],
    pulls: { [prSha]: [pr(repo, 171, prSha, 'Первый PR')], [secondPrSha]: [pr(repo, 172, secondPrSha, 'Второй PR')],
      [head]: [pr(repo, 173, head, 'Очистить остатки интеграции')] },
    issues: { 171: [issue], 172: [issue] },
  });
  expect((await api.changes(...current()))?.entries).toEqual([
    { kind: 'issue', title: 'Связанная задача', url: 'https://github.com/' + repo + '/issues/9' },
    { kind: 'pr', title: 'Очистить остатки интеграции', url: 'https://github.com/' + repo + '/pull/173' },
  ]);
});

test.each([['webhook-alerts', imageA], ['githubbot', imageB]] as const)('selects the previous image of %s and filters PRs to that publisher', async (service, previous) => {
  const other = service === 'githubbot' ? 'webhook-alerts' : 'githubbot';
  const { api, requested } = github({
    history: [
      release(8, '1'.repeat(40), '2026-11-21T17:02:00Z', 'success', 'githubbot', imageB),
      release(3, base, '2026-11-21T16:44:40Z', 'success', 'webhook-alerts', imageA),
    ],
    commits: [prSha, secondPrSha, imageHead],
    pulls: {
      [prSha]: [pr(publisher, 78, prSha, 'Другой сервис')],
      [secondPrSha]: [pr(publisher, 79, secondPrSha, 'Текущий сервис')],
      [imageHead]: [pr(publisher, 81, imageHead, 'Общая публикация')],
    },
    files: { 78: [{ filename: 'services/' + other + '/src/main.ts' }],
      79: [{ filename: 'services/' + service + '/src/main.ts' }],
      81: [{ filename: 'scripts/auxiliary-publish.sh' }] },
  });
  expect(await api.changes(...current(service))).toEqual({
    base: previous, head: imageHead, compareUrl: 'https://github.com/' + publisher + '/compare/' + previous + '...' + imageHead,
    entries: [
      { kind: 'pr', title: 'Текущий сервис', url: 'https://github.com/' + publisher + '/pull/79' },
      { kind: 'pr', title: 'Общая публикация', url: 'https://github.com/' + publisher + '/pull/81' },
    ],
  });
  expect(requested.some(url => url.includes('/repos/' + publisher + '/compare/'))).toBe(true);
});

test('looks up independent commits concurrently within the enrichment deadline', async () => {
  let inFlight = 0;
  let peak = 0;
  const { api } = github({
    commits: [prSha, secondPrSha, head],
    pulls: { [head]: [pr(repo, 173, head, 'Выкатка инфры')] },
    async beforePulls() {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight--;
    },
  });
  const changes = await api.changes(...current());
  expect(changes?.entries).toHaveLength(1);
  expect(peak).toBeGreaterThan(1);
});

test('equal versions give an empty list without comparing files or commits', async () => {
  const { api, requested } = github({ history: [release(3, head, '2026-11-21T16:44:40Z')] });
  expect(await api.changes(...current())).toMatchObject({ base: head, head, entries: [] });
  expect(requested.some(url => url.includes('/compare/'))).toBe(false);
});

test('initialization and an unconfirmed history have no range', async () => {
  const { api, requested } = github({ history: [release(9, base, '2026-11-21T17:04:00Z', 'failure')] });
  const [run, deployment] = current('githubbot');
  expect(await api.changes(run, { ...deployment, operation: 'initialize' })).toBeUndefined();
  expect(requested).toEqual([]);
  expect(await api.changes(...current())).toBeUndefined();
});

test.each([{ status: 503 }, { total: 2 }, { relation: 'diverged' }])('an unavailable or incomplete comparison yields no list (%j)', async (options) => {
  expect(await github(options).api.changes(...current())).toBeUndefined();
});
