import { expect, test } from 'bun:test';
import { createReleaseApi } from '../src/release-api';
import { A, B, C, REPO } from './helpers/release';
import { createHash } from 'node:crypto';
import releaseJson from './fixtures/github/release-published.json';
import manifestJson from './fixtures/github/release-manifest.json';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const image = `ghcr.io/cringe-driven-development-team/bff@sha256:${'d'.repeat(64)}`;
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
      release_id: 5 as number | undefined,
      run: `https://github.com/${REPO}/actions/runs/20`,
      notification: {
        base_sha: A,
        report_url: `https://github.com/${REPO}/actions/runs/20#summary`,
        run_attempt: 1,
      },
    },
  };
  const workflows = { 10: ['ci', 'push', B, 100], 20: ['cd', 'workflow_dispatch', C, 101], 30: ['release-import', 'workflow_dispatch', C, 102] } as const;
  const runs = new Map(
    Object.entries(workflows).map(([key, [file, event, head, workflow]]) => {
      const id = Number(key);
      return [
        id,
        {
          id,
          run_attempt: 1,
          workflow_id: workflow as number,
          path: `.github/workflows/${file}.yml`,
          event: event as string,
          head_branch: 'main',
          head_sha: head as string,
          repository: { full_name: REPO },
          head_repository: { full_name: REPO },
          actor: { login: 'YarikMix' },
          triggering_actor: { login: 'YarikMix' },
          status: 'in_progress',
        },
      ];
    }),
  );
  const state = {
    production,
    runs,
    release: structuredClone(releaseJson) as Record<string, unknown> & { assets: Record<string, unknown>[] },
    manifest: structuredClone(manifestJson) as Record<string, unknown> & { notification: Record<string, unknown> },
    tag: { type: 'commit', sha: B } as { type: string; sha: string },
    sums: undefined as undefined | ((lines: string[]) => string[]),
    location: (id: number) => `https://release-assets.githubusercontent.com/github-production-release-asset/${id}`,
    calls: [] as string[],
    downloads: [] as { url: string; authorization: string | null }[],
    extra: undefined as undefined | ((url: URL, init?: RequestInit) => Response | undefined),
  };
  // Assets are derived from the shared fixture so tampering one file is visible to the consumer.
  function files() {
    const manifest = new TextEncoder().encode(JSON.stringify(state.manifest, null, 2) + '\n'),
      archives = state.release.assets.filter((a) => a.digest).map((a) => `${String(a.digest).slice(7)}  ${a.name}`);
    let lines = [...archives, `${digest(manifest)}  release.json`];
    if (state.sums) lines = state.sums(lines);
    const sums = new TextEncoder().encode(lines.join('\n') + '\n');
    return new Map<number, Uint8Array>([
      [53, manifest],
      [54, sums],
    ]);
  }
  function release() {
    const bytes = files();
    return {
      ...state.release,
      assets: state.release.assets.map((a) => {
        const content = bytes.get(a.id as number);
        return content && a.digest === undefined ? { ...a, size: content.length, digest: `sha256:${digest(content)}` } : a;
      }),
    };
  }
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(String(input)),
      p = u.pathname.replace(`/repos/${REPO}`, '');
    state.calls.push(u.href);
    const extra = state.extra?.(u, init);
    if (extra) return extra;
    if (u.hostname !== 'api.github.com') {
      state.downloads.push({ url: u.href, authorization: new Headers(init?.headers).get('authorization') });
      const content = files().get(Number(u.pathname.split('/').pop()));
      return content ? new Response(content as Uint8Array<ArrayBuffer>) : new Response('missing', { status: 404 });
    }
    if (p === '/deployments/1') return Response.json(state.production);
    if (/^\/deployments\/\d+\/statuses$/.test(p))
      return Response.json([{ id: 1, state: 'success', created_at: '2026-11-01T20:02:00Z' }]);
    if (p === '/deployments') return Response.json([state.production]);
    if (p === '/releases/5' || p === `/releases/tags/release-${B}`) return Response.json(release());
    if (p.startsWith('/releases/tags/')) return new Response('{}', { status: 404 });
    if (p === `/git/ref/tags/release-${B}`) return Response.json({ object: state.tag });
    const asset = /^\/releases\/assets\/(\d+)$/.exec(p);
    if (asset) {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: state.location(Number(asset[1])) } });
    }
    if (p.startsWith('/actions/workflows/'))
      return Response.json({ id: p.endsWith('/ci.yml') ? 100 : p.endsWith('/cd.yml') ? 101 : 102 });
    const run = /^\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/.exec(p);
    if (run) {
      const raw = state.runs.get(Number(run[1]));
      return raw && (!run[2] || Number(run[2]) === raw.run_attempt) ? Response.json(raw) : new Response('{}', { status: 404 });
    }
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
              ? { title: 'Human readable PR', closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
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
const noLegacyCatalog = (calls: string[]) => expect(calls.some((u) => u.includes('release-artifacts'))).toBe(false);
test('cd_target_sha_can_differ_from_run_head_and_is_checked_against_release', async () => {
  const f = fixture();
  const op = await f.api.operation(1);
  expect(op.sha).toBe(B);
  expect(op.run.headSha).toBe(C);
  expect(op.run.attempt).toBe(1);
  expect(op.state).toBe('success');
  expect(op.release).toEqual({ id: 5, tag: `release-${B}`, url: `https://github.com/${REPO}/releases/tag/release-${B}`, imported: false });
  noLegacyCatalog(f.calls);
});
test('published_release_is_verified_from_api_and_signed_storage_without_leaking_token', async () => {
  const f = fixture();
  const op = await f.api.release(5);
  expect(op).toMatchObject({ kind: 'publish', sha: B, state: 'success', createdAt: '2026-11-01T20:00:00Z' });
  expect(op.run).toMatchObject({ id: 10, attempt: 1, workflow: 'CI', headSha: B });
  expect(op.notification).toEqual({ base_sha: A, report_url: `https://github.com/${REPO}/actions/runs/10#summary`, run_attempt: 1 });
  expect(f.downloads.map((d) => d.url.split('/').pop()).sort()).toEqual(['53', '54']);
  expect(f.downloads.every((d) => d.authorization === null)).toBe(true);
  expect(f.calls.some((u) => /\/assets\/5[12]$/.test(u))).toBe(false);
  noLegacyCatalog(f.calls);
});
test('annotated_tag_is_resolved_to_its_commit', async () => {
  const f = fixture();
  f.tag = { type: 'tag', sha: C };
  f.extra = (u) => (u.pathname.endsWith(`/git/tags/${C}`) ? Response.json({ object: { type: 'commit', sha: B } }) : undefined);
  expect((await f.api.release(5)).sha).toBe(B);
});
test('restored_draft_keeps_build_source_and_belongs_to_publishing_attempt', async () => {
  const f = fixture();
  f.runs.get(10)!.run_attempt = 2;
  f.extra = (u) =>
    u.pathname.endsWith('/actions/runs/10/attempts/1') ? Response.json({ ...f.runs.get(10), run_attempt: 1 }) : undefined;
  f.manifest.notification.run_attempt = 2;
  const op = await f.api.release(5);
  expect(op.run.attempt).toBe(2);
  expect(f.calls.some((u) => u.endsWith('/actions/runs/10/attempts/1'))).toBe(true);
});
test('imported_release_is_trusted_only_through_import_workflow_and_marked', async () => {
  const f = fixture();
  f.manifest.publication_run = `https://github.com/${REPO}/actions/runs/30`;
  f.manifest.notification = { base_sha: null, report_url: null, run_attempt: 1 };
  const op = await f.api.release(5);
  expect(op.release!.imported).toBe(true);
  expect(op.run.workflow).toBe('Release import');
  f.runs.get(30)!.head_branch = 'feature';
  await expect(f.api.release(5)).rejects.toThrow('untrusted_run');
});
const tamper: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  draft: (f) => (f.release.draft = true),
  prerelease: (f) => (f.release.prerelease = true),
  mutable: (f) => (f.release.immutable = false),
  author: (f) => (f.release.author = { login: 'YarikMix' }),
  tag_name: (f) => (f.release.tag_name = 'v1.0.0'),
  html_url: (f) => (f.release.html_url = 'https://evil.invalid/release'),
  tag_commit: (f) => (f.tag.sha = C),
  missing_asset: (f) => f.release.assets.splice(0, 1),
  extra_asset: (f) => f.release.assets.push({ id: 55, name: 'notes.txt', state: 'uploaded', size: 1, digest: `sha256:${'3'.repeat(64)}` }),
  duplicate_asset: (f) => f.release.assets.push({ ...f.release.assets[0]! }),
  starter_asset: (f) => (f.release.assets[0]!.state = 'starter'),
  oversized_asset: (f) => (f.release.assets[1]!.size = 2 * 1024 ** 3),
  asset_digest: (f) => (f.release.assets[1]!.digest = 'md5:abc'),
  checksums: (f) => (f.sums = (lines) => [`${'9'.repeat(64)}  frontend-dist.tar.gz`, ...lines.slice(1)]),
  checksums_missing: (f) => (f.sums = (lines) => lines.slice(1)),
  manifest_sha: (f) => (f.manifest.sha = C),
  manifest_image: (f) => (f.manifest.image_ref = `ghcr.io/evil/bff@sha256:${'d'.repeat(64)}`),
  manifest_image_id: (f) => (f.manifest.image_id = 'latest'),
  manifest_assets: (f) => (f.manifest.assets = 'releases/other/'),
  foreign_ci_run: (f) => (f.manifest.ci_run = 'https://evil.invalid/actions/runs/10'),
  ci_attempt: (f) => (f.manifest.ci_run_attempt = 0),
  report_url: (f) => (f.manifest.notification.report_url = `https://github.com/${REPO}/actions/runs/20#summary`),
  publication_from_cd: (f) => {
    f.manifest.publication_run = `https://github.com/${REPO}/actions/runs/20`;
    f.manifest.notification.report_url = null;
  },
  source_branch: (f) => (f.runs.get(10)!.head_branch = 'feature'),
  source_sha: (f) => (f.runs.get(10)!.head_sha = C),
  workflow_id: (f) => (f.runs.get(10)!.workflow_id = 999),
  foreign_storage: (f) => (f.location = () => 'https://evil.invalid/asset'),
};
for (const [name, change] of Object.entries(tamper))
  test(`rejects_release_${name}`, async () => {
    const f = fixture();
    change(f);
    await expect(f.api.release(5)).rejects.toThrow(/untrusted|invalid/);
    expect(f.calls.some((u) => u.includes('evil.invalid'))).toBe(false);
  });
test('tampered_manifest_bytes_do_not_match_github_digest', async () => {
  const f = fixture();
  f.extra = (u) => (u.hostname !== 'api.github.com' && u.pathname.endsWith('/53') ? new Response('{"sha":"x"}') : undefined);
  await expect(f.api.release(5)).rejects.toThrow('untrusted_release_assets');
});
for (const invalid of ['release_missing', 'release_sha', 'release_image', 'creator', 'assets', 'foreign_run'])
  test(`production_rejects_${invalid}`, async () => {
    const f = fixture();
    if (invalid === 'release_missing') delete f.production.payload.release_id;
    if (invalid === 'release_sha') {
      f.production.sha = C;
      f.production.payload.assets = `releases/${C}/`;
    }
    if (invalid === 'release_image') f.production.payload.image_ref = `ghcr.io/cringe-driven-development-team/bff@sha256:${'e'.repeat(64)}`;
    if (invalid === 'creator') f.production.creator.login = 'YarikMix';
    if (invalid === 'assets') f.production.payload.assets = 'releases/other/';
    if (invalid === 'foreign_run') f.production.payload.run = 'https://evil.invalid/actions/runs/20';
    await expect(f.api.operation(1)).rejects.toThrow(/untrusted/);
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
  await expect(f.api.operation(1)).rejects.toThrow();
  expect(f.calls.some((u) => u.includes('evil.invalid'))).toBe(false);
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

function issuePage(number: number, more: boolean) {
  return Response.json({ data: { repository: { pullRequest: {
    title: 'Human readable PR',
    closingIssuesReferences: {
      nodes: [{ id: `I${number}`, number, title: `Task ${number}`, state: 'OPEN', repository: { nameWithOwner: REPO } }],
      pageInfo: { hasNextPage: more, endCursor: more ? 'next-page' : null },
    },
  } } } });
}
test('pull_request_reads_title_and_all_issue_pages', async () => {
  const f = fixture();
  const cursors: unknown[] = [];
  f.extra = (url, init) => {
    if (url.pathname !== '/graphql') return;
    const { query, variables } = JSON.parse(String(init?.body));
    expect(query).toContain('closingIssuesReferences');
    expect(query).toMatch(/pullRequest\(number: \$number\)\s*\{\s*title/);
    expect(variables.number).toBe(125);
    cursors.push(variables.cursor);
    return variables.cursor === null ? issuePage(27, true) : issuePage(28, false);
  };
  const result = await f.api.pullRequest(125);
  expect(result.title).toBe('Human readable PR');
  expect(result.issues.map(i => i.number)).toEqual([27, 28]);
  expect(result.issues.map(i => i.prNumbers)).toEqual([[125], [125]]);
  expect(cursors).toEqual([null, 'next-page']);
});
test('changes_deduplicates_shared_issues', async () => {
  const f = fixture();
  f.extra = url => {
    if (url.pathname.includes('/commits/')) return Response.json([125, 126].map(number => ({ number, title: 'PR', merge_commit_sha: B, merged_at: '2026-11-01T19:00:00Z' })));
    if (url.pathname === '/graphql') return issuePage(27, false);
  };
  const report = await f.api.changes(A, B);
  expect(report.issues).toHaveLength(1);
  expect(report.issues[0]!.prNumbers).toEqual([125, 126]);
});
test('pull_request_failure_is_not_empty_issues', async () => {
  const f = fixture();
  f.extra = (url, init) => {
    if (url.pathname !== '/graphql') return;
    const { variables } = JSON.parse(String(init?.body));
    return variables.cursor === null ? issuePage(27, true) : new Response('unavailable', { status: 503 });
  };
  await expect(f.api.pullRequest(125)).rejects.toThrow('http_503');
});

test('history_keeps_old_production_without_release_and_never_reads_legacy_catalog', async () => {
  const f = fixture();
  delete f.production.payload.release_id;
  const history = await f.api.production();
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ sha: B, imageRef: f.production.payload.image_ref, everSucceeded: true });
  expect(f.calls.some((u) => u.includes('/releases'))).toBe(false);
  noLegacyCatalog(f.calls);
});
const publishJob = (attempt = 1) => (u: URL) =>
  u.pathname.endsWith('/actions/jobs/300')
    ? Response.json({ id: 300, name: 'Publish release', run_id: 10, run_attempt: attempt, status: 'completed', conclusion: 'failure', head_sha: B })
    : undefined;
test('publish_job_fallback_finds_release_of_same_attempt', async () => {
  const f = fixture();
  f.extra = publishJob();
  const job = await f.api.job(300);
  expect(job.operation).toMatchObject({ kind: 'publish', state: 'success', sha: B });
  expect(job.operation!.run).toMatchObject({ id: 10, attempt: 1 });
  noLegacyCatalog(f.calls);
});
test('publish_job_fallback_ignores_release_of_other_attempt_missing_or_untrusted_release', async () => {
  const f = fixture();
  f.runs.get(10)!.run_attempt = 2;
  const attempt1 = { ...f.runs.get(10)!, run_attempt: 1 };
  f.manifest.notification.run_attempt = 2;
  let tagStatus = 200;
  f.extra = (u) =>
    u.pathname.endsWith('/actions/runs/10/attempts/1')
      ? Response.json(attempt1)
      : u.pathname.endsWith(`/releases/tags/release-${B}`) && tagStatus !== 200
        ? new Response('{}', { status: tagStatus })
        : publishJob(1)(u);
  expect((await f.api.job(300)).operation).toBeNull();
  f.release.immutable = false;
  f.manifest.notification.run_attempt = 1;
  expect((await f.api.job(300)).operation).toBeNull();
  tagStatus = 404;
  expect((await f.api.job(300)).operation).toBeNull();
  tagStatus = 502;
  await expect(f.api.job(300)).rejects.toThrow('http_502');
});


test('open_native_linked_issue_survives_queue_ready_and_production_reports', async () => {
  const f = fixture();
  f.extra = (url, init) => {
    if (url.pathname === '/graphql' && String(init?.body).includes('closingIssuesReferences')) {
      expect(String(init?.body)).not.toMatch(/states:\s*\[?CLOSED/);
      return issuePage(27, false);
    }
  };
  const queue = await f.api.queue(125);
  expect(queue.closed).toBe(false);
  const queueIssues = await f.api.pullRequest(125);
  const release = await f.api.release(5);
  const ready = await f.api.changes(release.notification.base_sha!, release.sha);
  const production = await f.api.operation(1);
  const result = await f.api.changes(production.notification.base_sha!, production.sha);
  for (const report of [queueIssues, ready, result]) {
    const issueNumbers = report.issues.map(issue => issue.number);
    expect(issueNumbers).toContain(27);
  }
});
