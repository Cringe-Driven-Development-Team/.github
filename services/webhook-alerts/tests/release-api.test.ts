import { expect, test } from 'bun:test';
import { createReleaseApi } from '../src/release-api';
import { A, B, C, REPO } from './helpers/release';
function fixture() {
  const image = `ghcr.io/cringe-driven-development-team/bff@sha256:${'d'.repeat(64)}`;
  const artifact = {
    id: 2,
    sha: B,
    environment: 'release-artifacts',
    task: 'publish',
    creator: { login: 'github-actions[bot]' },
    created_at: '2026-11-01T20:00:00Z',
    payload: {
      image_ref: image,
      assets: `releases/${B}/`,
      ci_run: `https://github.com/${REPO}/actions/runs/10`,
      notification: {
        base_sha: A,
        report_url: `https://github.com/${REPO}/actions/runs/10#summary`,
        run_attempt: 1,
      },
    },
  };
  const production = {
    id: 1,
    sha: B,
    environment: 'production',
    task: 'deploy',
    creator: { login: 'github-actions[bot]' },
    created_at: '2026-11-01T20:01:00Z',
    payload: {
      image_ref: image,
      assets: `releases/${B}/`,
      action: 'deploy',
      run: `https://github.com/${REPO}/actions/runs/20`,
      notification: {
        base_sha: A,
        report_url: `https://github.com/${REPO}/actions/runs/20#summary`,
        run_attempt: 1,
      },
    },
  };
  const runs = new Map(
    [10, 20].map((id) => [
      id,
      {
        id,
        run_attempt: 1,
        workflow_id: id === 10 ? 100 : 101,
        path: `.github/workflows/${id === 10 ? 'ci' : 'cd'}.yml`,
        event: id === 10 ? 'push' : 'workflow_dispatch',
        head_branch: 'main',
        head_sha: id === 10 ? B : C,
        repository: { full_name: REPO },
        head_repository: { full_name: REPO },
        actor: { login: 'YarikMix' },
        triggering_actor: { login: 'YarikMix' },
        status: 'in_progress',
      },
    ]),
  );
  const state = {
    artifact,
    production,
    runs,
    calls: [] as string[],
    extra: undefined as undefined | ((url: URL) => Response | undefined),
  };
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(String(input)),
      p = u.pathname.replace(`/repos/${REPO}`, '');
    state.calls.push(u.href);
    const extra = state.extra?.(u);
    if (extra) return extra;
    if (p === '/deployments/1') return Response.json(state.production);
    if (p === '/deployments/2') return Response.json(state.artifact);
    if (/^\/deployments\/\d+\/statuses$/.test(p))
      return Response.json([{ id: 1, state: 'success', created_at: '2026-11-01T20:02:00Z' }]);
    if (p === '/deployments')
      return Response.json(
        u.searchParams.get('environment') === 'release-artifacts' ? [state.artifact] : [state.production],
      );
    if (p.startsWith('/actions/workflows/')) return Response.json({ id: p.endsWith('ci.yml') ? 100 : 101 });
    const run = /^\/actions\/runs\/(\d+)(?:\/attempts\/1)?$/.exec(p);
    if (run) return Response.json(state.runs.get(Number(run[1])));
    if (p.endsWith('/jobs'))
      return Response.json({
        jobs: [
          {
            id: 100,
            name: p.includes('/10/') ? 'Publish release' : 'CD',
            steps: [{ name: 'Health check', conclusion: 'success' }],
          },
        ],
      });
    if (p.startsWith('/compare/'))
      return Response.json({ status: 'ahead', total_commits: 1, commits: [{ sha: B }] });
    if (p.startsWith('/commits/'))
      return Response.json([
        { number: 125, title: 'PR', merge_commit_sha: B, merged_at: '2026-11-01T19:00:00Z' },
      ]);
    if (u.pathname === '/graphql')
      return Response.json({
        data: {
          repository: {
            pullRequest: String(init?.body).includes('closingIssuesReferences')
              ? { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
              : {
                  merged: false,
                  state: 'OPEN',
                  baseRefName: 'main',
                  mergeQueueEntry: {
                    id: 'ENTRY1',
                    enqueuedAt: '2026-11-01T20:00:00Z',
                    enqueuer: { login: 'YarikMix' },
                  },
                },
          },
        },
      });
    throw new Error(`Unexpected fake endpoint ${p}`);
  }) as unknown as typeof fetch;
  return Object.assign(state, { api: createReleaseApi({ token: 'secret-test', fetch: fetcher }) });
}
test('cd_target_sha_can_differ_from_run_head', async () => {
  const f = fixture();
  const op = await f.api.operation(1);
  expect(op.sha).toBe(B);
  expect(op.run.headSha).toBe(C);
  expect(op.run.attempt).toBe(1);
  expect(op.state).toBe('success');
});
test('source_attempt_is_loaded_even_when_run_is_still_in_progress', async () => {
  const f = fixture();
  const op = await f.api.operation(2);
  expect(op.run.workflow).toBe('CI');
  expect(f.calls.some((u) => u.endsWith('/actions/runs/10/attempts/1'))).toBe(true);
  expect(f.calls.some((u) => u.includes('/attempts/2'))).toBe(false);
});
for (const invalid of [
  'creator',
  'digest',
  'assets',
  'foreign_run',
  'attempt',
  'source_branch',
  'workflow_id',
])
  test(`rejects_${invalid}`, async () => {
    const f = fixture();
    if (invalid === 'creator') f.artifact.creator.login = 'YarikMix';
    if (invalid === 'digest') f.artifact.payload.image_ref = 'ghcr.io/evil/bff@sha256:' + 'd'.repeat(64);
    if (invalid === 'assets') f.artifact.payload.assets = 'releases/other/';
    if (invalid === 'foreign_run') f.artifact.payload.ci_run = 'https://evil.invalid/actions/runs/10';
    if (invalid === 'attempt') f.artifact.payload.notification.run_attempt = 0;
    if (invalid === 'source_branch') f.runs.get(10)!.head_branch = 'feature';
    if (invalid === 'workflow_id') f.runs.get(10)!.workflow_id = 999;
    await expect(f.api.operation(2)).rejects.toThrow();
    expect(f.calls.some((u) => u.includes('evil.invalid'))).toBe(false);
  });
test('queue_does_not_query_deployments_or_projects', async () => {
  const f = fixture();
  expect(await f.api.queue(125)).toMatchObject({ merged: false, closed: false, entry: { id: 'ENTRY1' } });
  expect(f.calls).toEqual(['https://api.github.com/graphql']);
});
test('historical_success_survives_latest_inactive_status', async () => {
  const f = fixture();
  delete (f.production.payload as { notification?: unknown }).notification;
  f.extra = (u) =>
    u.pathname.endsWith('/deployments/1/statuses')
      ? Response.json([
          { state: 'inactive', created_at: '2026-11-01T20:05:00Z' },
          { state: 'success', created_at: '2026-11-01T20:02:00Z' },
        ])
      : undefined;
  const history = await f.api.production();
  expect(history[0]?.everSucceeded).toBe(true);
});
test('range_collects_all_pages_without_scanning_all_merged_prs', async () => {
  const f = fixture(),
    commits = [
      ...Array.from({ length: 100 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, '0') })),
      { sha: B },
    ];
  f.extra = (u) => {
    if (u.pathname.includes('/compare/')) {
      const page = Number(u.searchParams.get('page') ?? 1);
      return Response.json({
        status: 'ahead',
        total_commits: 101,
        commits: commits.slice((page - 1) * 100, page * 100),
      });
    }
    if (u.pathname.includes('/commits/'))
      return Response.json(
        u.pathname.includes(B)
          ? [
              { number: 125, title: 'PR', merged_at: '2026-11-01T19:00:00Z', merge_commit_sha: B },
              { number: 126, title: 'Open', merged_at: null, merge_commit_sha: B },
            ]
          : [],
      );
  };
  const report = await f.api.changes(A, B);
  expect(report.prs.map((p) => p.number)).toEqual([125]);
  expect(f.calls.some((u) => /\/pulls\?state=closed/.test(u))).toBe(false);
  expect(f.calls.some((u) => u.includes('page=2'))).toBe(true);
});
test('cross_origin_pagination_never_sends_the_token_elsewhere', async () => {
  const f = fixture();
  f.extra = (u) =>
    u.pathname.endsWith('/statuses')
      ? Response.json([], { headers: { link: '<https://evil.invalid/statuses>; rel="next"' } })
      : undefined;
  await expect(f.api.operation(2)).rejects.toThrow();
  expect(f.calls.some((u) => u.includes('evil.invalid'))).toBe(false);
});
test('conflicting_successful_images_for_same_sha_are_rejected', async () => {
  const f = fixture();
  f.extra = (u) =>
    u.pathname.endsWith('/deployments') && u.searchParams.get('environment') === 'release-artifacts'
      ? Response.json([
          f.artifact,
          {
            ...f.artifact,
            id: 3,
            payload: {
              ...f.artifact.payload,
              image_ref: `ghcr.io/cringe-driven-development-team/bff@sha256:${'e'.repeat(64)}`,
            },
          },
        ])
      : undefined;
  await expect(f.api.operation(2)).rejects.toThrow();
});
test('completed_job_before_any_record_is_verified_without_inventing_target_sha', async () => {
  const f = fixture();
  f.extra = (u) =>
    u.pathname.endsWith('/actions/jobs/200')
      ? Response.json({
          id: 200,
          name: 'CD',
          run_id: 20,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'failure',
          head_sha: C,
        })
      : u.pathname.endsWith('/deployments') && u.searchParams.get('environment') === 'production'
        ? Response.json([])
        : undefined;
  const job = await f.api.job(200);
  expect(job.operation).toBeNull();
  expect(job.run.headSha).toBe(C);
  expect(job.run.attempt).toBe(1);
});
test('job_ignores_records_without_notification_contract', async () => {
  const f = fixture();
  delete (f.production.payload as { notification?: unknown }).notification;
  f.extra = (u) =>
    u.pathname.endsWith('/actions/jobs/200')
      ? Response.json({
          id: 200,
          name: 'CD',
          run_id: 20,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'failure',
          head_sha: C,
        })
      : undefined;
  expect((await f.api.job(200)).operation).toBeNull();
});
