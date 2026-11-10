import { createHash } from 'node:crypto';
import { GithubApiError } from './github-api';
const REPO = 'Cringe-Driven-Development-Team/frontend';
const PREFIX = `/repos/${REPO}`;
const IMAGE = /^ghcr\.io\/cringe-driven-development-team\/bff@sha256:[0-9a-f]{64}$/;
const ARCHIVES = ['frontend-dist.tar.gz', 'bff-image.tar.gz', 'release.json'];
const MAX_ASSET = 2 * 1024 ** 3,
  MAX_TEXT = 64 * 1024;
type Obj = Record<string, unknown>;
function obj(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GithubApiError('invalid_response');
  return value as Obj;
}
function str(value: unknown): string {
  if (typeof value !== 'string') throw new GithubApiError('invalid_response');
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new GithubApiError('invalid_id');
  return value;
}
function sha(value: unknown): string {
  const text = str(value);
  if (!/^[0-9a-f]{40}$/.test(text)) throw new GithubApiError('invalid_sha');
  return text;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GithubApiError('invalid_response');
  return value;
}
export interface LinkedIssue {
  id: string;
  number: number;
  title: string;
  repo: string;
  prNumbers: number[];
}
export interface ChangeReport {
  baseSha: string | null;
  headSha: string;
  prs: { number: number; title: string; url: string; mergeSha: string }[];
  issues: LinkedIssue[];
  complete: boolean;
}
export interface ReleaseStep {
  name: string;
  outcome: 'success' | 'failure' | 'cancelled' | 'skipped' | 'pending';
}
export interface VerifiedRun {
  id: number;
  attempt: number;
  workflow: 'CI' | 'CD' | 'Rollback' | 'Release import';
  event: 'push' | 'workflow_dispatch';
  headSha: string;
  actor: string;
  url: string;
  steps: ReleaseStep[] | null;
}
export type OperationKind = 'publish' | 'deploy' | 'rollback';
export type OperationState =
  | 'pending'
  | 'queued'
  | 'in_progress'
  | 'success'
  | 'failure'
  | 'error'
  | 'inactive';
export interface VerifiedRelease {
  id: number;
  tag: string;
  url: string;
  imported: boolean;
}
interface Metadata {
  base_sha: string | null;
  report_url: string | null;
  run_attempt: number;
}
export interface VerifiedOperation {
  id: number;
  kind: OperationKind;
  sha: string;
  state: OperationState;
  everSucceeded: boolean;
  createdAt: string;
  imageRef: string;
  notification: Metadata;
  run: VerifiedRun;
  release?: VerifiedRelease;
}
export interface VerifiedProduction {
  id: number;
  kind: 'deploy' | 'rollback';
  sha: string;
  imageRef: string;
  everSucceeded: boolean;
  createdAt: string;
  runId: number;
}
export interface VerifiedJob {
  id: number;
  name: string;
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped';
  run: VerifiedRun;
  operation: VerifiedOperation | null;
  failedStep: string | null;
}
export interface ReleaseApi {
  pullRequest(number: number): Promise<{ title: string; issues: LinkedIssue[] }>;
  queue(number: number): Promise<{
    merged: boolean;
    closed: boolean;
    baseRef: string;
    entry: null | { id: string; enqueuer: string; enqueuedAt: string };
  }>;
  operation(id: number): Promise<VerifiedOperation>;
  release(id: number): Promise<VerifiedOperation>;
  changes(base: string | null, head: string): Promise<ChangeReport>;
  production(): Promise<VerifiedProduction[]>;
  job(id: number): Promise<VerifiedJob>;
  isAncestor(base: string, head: string): Promise<boolean>;
}
interface RecordInfo {
  id: number;
  kind: 'deploy' | 'rollback';
  sha: string;
  imageRef: string;
  createdAt: string;
  runId: number;
  notification: Metadata | null;
}
function runId(value: unknown, repository = REPO): number {
  const match = new RegExp(`^https://github\\.com/${repository}/actions/runs/([1-9][0-9]*)$`).exec(str(value));
  if (!match) throw new GithubApiError('untrusted_run_url');
  return positive(Number(match[1]));
}
function metadata(value: unknown, run: number, repository = REPO): Metadata {
  const n = obj(value),
    result: Metadata = {
      base_sha: n.base_sha === null ? null : sha(n.base_sha),
      report_url: n.report_url === null ? null : str(n.report_url),
      run_attempt: positive(n.run_attempt),
    };
  if (result.report_url !== null && result.report_url !== `https://github.com/${repository}/actions/runs/${run}#summary`)
    throw new GithubApiError('untrusted_report_url');
  return result;
}
function record(value: unknown, repository = REPO): RecordInfo {
  const backend = repository.endsWith("/backend");
  const r = obj(value),
    p = obj(r.payload),
    id = positive(r.id),
    target = sha(r.sha),
    environment = str(r.environment),
    task = str(r.task);
  if (obj(r.creator).login !== 'github-actions[bot]') throw new GithubApiError('untrusted_creator');
  if (environment !== 'production' || !['deploy', 'rollback'].includes(task) || p.action !== task)
    throw new GithubApiError('untrusted_operation');
  const kind = task as 'deploy' | 'rollback',
    imageRef = str(p.image_ref);
  if (!(backend ? /^ghcr\.io\/cringe-driven-development-team\/backend@sha256:[0-9a-f]{64}$/ : IMAGE).test(imageRef) || (backend ? r.ref !== target : p.assets !== `releases/${target}/`)) throw new GithubApiError('untrusted_artifacts');
  const sourceId = runId(p.run, repository),
    notification = p.notification === undefined ? null : metadata(p.notification, sourceId, repository);
  if (backend && notification && notification.report_url !== `https://github.com/${repository}/actions/runs/${sourceId}#summary`) throw new GithubApiError("untrusted_report_url");
  const createdAt = str(r.created_at);
  if (!Number.isFinite(Date.parse(createdAt))) throw new GithubApiError('invalid_timestamp');
  return { id, kind, sha: target, imageRef, createdAt, runId: sourceId, notification };
}
function outcome(value: unknown): ReleaseStep['outcome'] {
  return value === null || value === undefined
    ? 'pending'
    : value === 'success' || value === 'skipped' || value === 'cancelled'
      ? value
      : 'failure';
}
export function createReleaseApi(
  options: { token?: string; fetch?: typeof fetch; timeoutMs?: number; repository?: string } = {},
): ReleaseApi {
  const REPO = options.repository ?? "Cringe-Driven-Development-Team/frontend";
  if (!["Cringe-Driven-Development-Team/frontend", "Cringe-Driven-Development-Team/backend"].includes(REPO)) throw new GithubApiError("untrusted_repository");
  const PREFIX = `/repos/${REPO}`, backend = REPO.endsWith("/backend");
  const fetcher = options.fetch ?? fetch;
  async function request(path: string, init?: RequestInit): Promise<{ body: unknown; next: string | null }> {
    if (!options.token?.trim()) throw new GithubApiError('unavailable');
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com' || url.username || url.password)
      throw new GithubApiError('pagination');
    try {
      const response = await fetcher(url.href, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 5000, 5000))),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
        },
      });
      if (!response.ok) throw new GithubApiError(`http_${response.status}`);
      return {
        body: await response.json(),
        next: response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null,
      };
    } catch (error) {
      throw error instanceof GithubApiError ? error : new GithubApiError('unavailable');
    }
  }
  const get = async (path: string) => (await request(PREFIX + path)).body;
  // Small text assets only: GitHub answers with a redirect to signed storage that must not receive the token.
  async function assetBytes(id: number): Promise<Uint8Array> {
    if (!options.token?.trim()) throw new GithubApiError('unavailable');
    const signal = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 5000, 5000)));
    try {
      let response = await fetcher(`https://api.github.com${PREFIX}/releases/assets/${positive(id)}`, {
        redirect: 'manual',
        signal,
        headers: {
          accept: 'application/octet-stream',
          authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = URL.parse(response.headers.get('location') ?? '');
        if (
          location?.protocol !== 'https:' ||
          !location.hostname.endsWith('.githubusercontent.com') ||
          location.username ||
          location.password
        )
          throw new GithubApiError('untrusted_asset_url');
        response = await fetcher(location.href, { redirect: 'error', signal });
      }
      if (!response.ok) throw new GithubApiError(`http_${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw error instanceof GithubApiError ? error : new GithubApiError('unavailable');
    }
  }
  async function pages(path: string, field?: string): Promise<unknown[]> {
    const start = new URL(PREFIX + path, 'https://api.github.com'),
      seen = new Set<string>(),
      result: unknown[] = [];
    let url: URL | null = start;
    while (url) {
      if (url.origin !== start.origin || url.pathname !== start.pathname || seen.has(url.href))
        throw new GithubApiError('pagination');
      seen.add(url.href);
      const next = await request(url.href);
      result.push(...list(field ? obj(next.body)[field] : next.body));
      url = next.next ? new URL(next.next, start) : null;
    }
    return result;
  }
  async function graphql(query: string, variables: Record<string, unknown>): Promise<Obj> {
    const { body } = await request('/graphql', {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
      }),
      data = obj(body);
    if (data.errors !== undefined && list(data.errors).length) throw new GithubApiError('graphql');
    return obj(data.data);
  }
  async function readRun(id: number, attempt?: number, withSteps = false): Promise<VerifiedRun> {
    const raw = obj(
        await get(`/actions/runs/${positive(id)}${attempt ? `/attempts/${positive(attempt)}` : ''}`),
      ),
      actualAttempt = positive(raw.run_attempt);
    const entry = [
      ['ci.yml', 'CI', 'push', backend ? 'deploy / deploy' : 'Publish release'],
      ['cd.yml', 'CD', 'workflow_dispatch', 'CD'],
      ['rollback.yml', 'Rollback', 'workflow_dispatch', backend ? 'rollback / deploy' : 'Rollback'],
      ['release-import.yml', 'Release import', 'workflow_dispatch', 'Release import'],
    ] as const;
    const expected = entry.find((e) => raw.path === `.github/workflows/${e[0]}`);
    if (
      !expected ||
      (backend && !["CI", "Rollback"].includes(expected[1])) ||
      raw.id !== id ||
      (attempt !== undefined && attempt !== actualAttempt) ||
      raw.head_branch !== 'main' ||
      raw.event !== expected[2] ||
      obj(raw.repository).full_name !== REPO ||
      obj(raw.head_repository).full_name !== REPO
    )
      throw new GithubApiError('untrusted_run');
    if (raw.workflow_id !== obj(await get(`/actions/workflows/${expected[0]}`)).id)
      throw new GithubApiError('untrusted_workflow');
    let steps: ReleaseStep[] | null = null;
    if (withSteps) {
      try {
        const jobs = await pages(`/actions/runs/${id}/attempts/${actualAttempt}/jobs?per_page=100`, 'jobs'),
          candidates = jobs.map(obj).filter((j) => j.name === expected[3]);
        if (backend && candidates.length !== 1) throw new GithubApiError('untrusted_job');
        const job = candidates[0];
        if (job)
          steps = list(job.steps).map((s) => ({
            name: str(obj(s).name),
            outcome: outcome(obj(s).conclusion),
          }));
      } catch (error) {
        if (backend) throw error;
        steps = null;
      }
    }
    return {
      id,
      attempt: actualAttempt,
      workflow: expected[1],
      event: expected[2],
      headSha: sha(raw.head_sha),
      actor: str(obj(raw.triggering_actor ?? raw.actor).login),
      url: `https://github.com/${REPO}/actions/runs/${id}`,
      steps,
    };
  }
  async function statuses(id: number): Promise<{ state: OperationState; everSucceeded: boolean }> {
    const states = (await pages(`/deployments/${id}/statuses?per_page=100`)).map((v) => str(obj(v).state));
    if (
      states.some(
        (s) => !['pending', 'queued', 'in_progress', 'success', 'failure', 'error', 'inactive'].includes(s),
      )
    )
      throw new GithubApiError('invalid_state');
    return { state: (states[0] ?? 'pending') as OperationState, everSucceeded: states.includes('success') };
  }
  function matchSource(info: RecordInfo, run: VerifiedRun): void {
    if (run.workflow !== (info.kind === 'deploy' ? (backend ? 'CI' : 'CD') : 'Rollback') || (backend && info.kind === 'deploy' && run.headSha !== info.sha)) throw new GithubApiError('untrusted_run');
  }
  async function verifyRelease(value: unknown): Promise<VerifiedOperation> {
    const r = obj(value),
      id = positive(r.id),
      tag = str(r.tag_name),
      target = /^release-([0-9a-f]{40})$/.exec(tag)?.[1],
      url = `https://github.com/${REPO}/releases/tag/${tag}`,
      publishedAt = str(r.published_at);
    if (
      !target ||
      r.draft !== false ||
      r.prerelease !== false ||
      r.immutable !== true ||
      r.html_url !== url ||
      obj(r.author).login !== 'github-actions[bot]' ||
      !Number.isFinite(Date.parse(publishedAt))
    )
      throw new GithubApiError('untrusted_release');
    let ref = obj(obj(await get(`/git/ref/tags/${tag}`)).object);
    if (ref.type === 'tag') ref = obj(obj(await get(`/git/tags/${sha(ref.sha)}`)).object);
    if (ref.type !== 'commit' || sha(ref.sha) !== target) throw new GithubApiError('untrusted_tag');
    const assets = new Map<string, { id: number; size: number; digest: string }>();
    for (const raw of list(r.assets)) {
      const a = obj(raw),
        name = a.name,
        digest = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest))?.[1];
      if (
        typeof name !== 'string' ||
        ![...ARCHIVES, 'SHA256SUMS'].includes(name) ||
        assets.has(name) ||
        a.state !== 'uploaded' ||
        !digest ||
        !Number.isSafeInteger(a.size) ||
        (a.size as number) <= 0 ||
        (a.size as number) >= MAX_ASSET
      )
        throw new GithubApiError('untrusted_release_assets');
      assets.set(name, { id: positive(a.id), size: a.size as number, digest });
    }
    if (assets.size !== 4) throw new GithubApiError('untrusted_release_assets');
    const text = async (name: string) => {
      const asset = assets.get(name)!;
      if (asset.size > MAX_TEXT) throw new GithubApiError('untrusted_release_assets');
      const bytes = await assetBytes(asset.id);
      if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.digest)
        throw new GithubApiError('untrusted_release_assets');
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new GithubApiError('untrusted_release_assets');
      }
    };
    const sums = new Map<string, string>();
    for (const line of (await text('SHA256SUMS')).split('\n').filter(Boolean)) {
      const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line);
      if (!m || sums.has(m[2]!)) throw new GithubApiError('untrusted_checksums');
      sums.set(m[2]!, m[1]!);
    }
    if (sums.size !== 3 || ARCHIVES.some((name) => sums.get(name) !== assets.get(name)!.digest))
      throw new GithubApiError('untrusted_checksums');
    const body = await text('release.json');
    let imageRef: string, publication: number, notification: Metadata, ciRun: number, ciAttempt: number;
    try {
      const manifest = obj(JSON.parse(body));
      imageRef = str(manifest.image_ref);
      publication = runId(manifest.publication_run);
      notification = metadata(manifest.notification, publication);
      ciRun = runId(manifest.ci_run);
      ciAttempt = positive(manifest.ci_run_attempt);
      if (
        manifest.sha !== target ||
        !IMAGE.test(imageRef) ||
        !/^sha256:[0-9a-f]{64}$/.test(str(manifest.image_id)) ||
        manifest.assets !== `releases/${target}/`
      )
        throw new Error();
    } catch {
      throw new GithubApiError('untrusted_manifest');
    }
    const source = await readRun(ciRun, ciAttempt);
    if (source.workflow !== 'CI' || source.headSha !== target) throw new GithubApiError('untrusted_run');
    const run = await readRun(publication, notification.run_attempt),
      imported = run.workflow === 'Release import';
    // Normal publication comes from push/main CI of the same SHA; the one-off import runs from main.
    if (!imported && (run.workflow !== 'CI' || run.headSha !== target)) throw new GithubApiError('untrusted_run');
    return {
      id,
      kind: 'publish',
      sha: target,
      state: 'success',
      everSucceeded: true,
      createdAt: publishedAt,
      imageRef,
      notification,
      run,
      release: { id, tag, url, imported },
    };
  }
  async function releaseFor(target: string): Promise<VerifiedOperation | null> {
    let raw: unknown;
    try {
      raw = await get(`/releases/tags/release-${sha(target)}`);
    } catch (error) {
      // Drafts are invisible through the tag endpoint, so a missing Release means not published.
      if (error instanceof GithubApiError && error.code === 'http_404') return null;
      throw error;
    }
    return verifyRelease(raw);
  }

  async function rollbackTarget(current: RecordInfo): Promise<void> {
    let found = false;
    const refs = new Set<string>();
    for (const raw of await pages(`/deployments?environment=production&sha=${current.sha}&per_page=100`)) {
      const r = obj(raw);
      if (r.id === current.id || Date.parse(str(r.created_at)) > Date.parse(current.createdAt)) continue;
      let info: RecordInfo;
      try { info = record(raw, REPO); } catch (e) {
        if (e instanceof GithubApiError && e.code.startsWith('untrusted')) continue;
        throw e;
      }
      if (info.sha !== current.sha || !info.notification || !(await statuses(info.id)).everSucceeded) continue;
      matchSource(info, await readRun(info.runId, info.notification.run_attempt));
      refs.add(info.imageRef);
      if (info.imageRef === current.imageRef) found = true;
    }
    if (!found || refs.size !== 1) throw new GithubApiError('untrusted_rollback_target');
  }

  const api: ReleaseApi = {
    pullRequest: async (number) => {
      const issues = new Map<string, LinkedIssue>();
      let cursor: string | null = null,
        title = '';
      do {
        const data = await graphql(
            `
              query ReleaseIssues($number: Int!, $cursor: String) {
                repository(owner: "Cringe-Driven-Development-Team", name: "${backend ? 'backend' : 'frontend'}") {
                  pullRequest(number: $number) {
                    title
                    closingIssuesReferences(first: 100, after: $cursor) {
                      nodes {
                        id
                        number
                        title
                        repository {
                          nameWithOwner
                        }
                      }
                      pageInfo {
                        hasNextPage
                        endCursor
                      }
                    }
                  }
                }
              }
            `,
            { number: positive(number), cursor },
          ),
          pr = obj(obj(data.repository).pullRequest),
          connection = obj(pr.closingIssuesReferences);
        title = str(pr.title);
        for (const raw of list(connection.nodes)) {
          const i = obj(raw),
            id = str(i.id);
          issues.set(id, {
            id,
            number: positive(i.number),
            title: str(i.title),
            repo: str(obj(i.repository).nameWithOwner),
            prNumbers: [number],
          });
        }
        const page = obj(connection.pageInfo);
        cursor = page.hasNextPage ? str(page.endCursor) : null;
        if (page.hasNextPage && !cursor) throw new GithubApiError('pagination');
      } while (cursor);
      return { title, issues: [...issues.values()] };
    },
    queue: async (number) => {
      const data = await graphql(
          `
            query ReleaseQueue($number: Int!) {
              repository(owner: "Cringe-Driven-Development-Team", name: "${backend ? 'backend' : 'frontend'}") {
                pullRequest(number: $number) {
                  merged
                  state
                  baseRefName
                  mergeQueueEntry {
                    id
                    enqueuedAt
                    enqueuer {
                      login
                    }
                  }
                }
              }
            }
          `,
          { number: positive(number) },
        ),
        pr = obj(obj(data.repository).pullRequest);
      if (typeof pr.merged !== 'boolean' || !['OPEN', 'CLOSED', 'MERGED'].includes(str(pr.state)))
        throw new GithubApiError('invalid_response');
      const q = pr.mergeQueueEntry === null ? null : obj(pr.mergeQueueEntry);
      return {
        merged: pr.merged,
        closed: pr.state !== 'OPEN',
        baseRef: str(pr.baseRefName),
        entry: q
          ? {
              id: str(q.id),
              enqueuedAt: (() => {
                const at = str(q.enqueuedAt);
                if (!Number.isFinite(Date.parse(at))) throw new GithubApiError('invalid_timestamp');
                return at;
              })(),
              enqueuer: q.enqueuer ? str(obj(q.enqueuer).login) : '',
            }
          : null,
      };
    },
    operation: async (id) => {
      const raw = await get(`/deployments/${positive(id)}`),
        info = record(raw, REPO),
        releaseId = obj(obj(raw).payload).release_id;
      if (info.id !== id || !info.notification) throw new GithubApiError('notification_missing');
      if (!backend && releaseId === undefined) throw new GithubApiError('untrusted_release_missing');
      const run = await readRun(info.runId, info.notification.run_attempt, true);
      matchSource(info, run);
      if (backend) {
        const state = await statuses(id);
        if (info.kind === 'rollback') await rollbackTarget(info);
        return {...info, notification:info.notification, run, ...state};
      }
      const release = await api.release(positive(releaseId));
      if (release.sha !== info.sha || release.imageRef !== info.imageRef) throw new GithubApiError('untrusted_release');
      const state = await statuses(id);
      return { ...info, notification: info.notification, run, ...state, release: release.release };
    },
    release: async (id) => {
      if (backend) throw new GithubApiError('untrusted_backend_release');
      const release = await verifyRelease(await get(`/releases/${positive(id)}`));
      if (release.id !== id) throw new GithubApiError('untrusted_release');
      return release;
    },
    production: async () => {
      const result: VerifiedProduction[] = [];
      for (const raw of await pages('/deployments?environment=production&per_page=100')) {
        const r = obj(raw),
          p = obj(r.payload);
        if (!p.image_ref && !p.action && !p.run) continue;
        // Old records without release_id stay historical SHA/digest evidence.
        const info = record(raw, REPO);
        const run = await readRun(info.runId, info.notification?.run_attempt);
        matchSource(info, run);
        const state = await statuses(info.id);
        result.push({
          id: info.id,
          kind: info.kind,
          sha: info.sha,
          imageRef: info.imageRef,
          createdAt: info.createdAt,
          runId: info.runId,
          everSucceeded: state.everSucceeded,
        });
      }
      return result;
    },
    isAncestor: async (base, head) => {
      const comparison = obj(await get(`/compare/${sha(base)}...${sha(head)}?per_page=1`));
      if (!['identical', 'ahead', 'behind', 'diverged'].includes(str(comparison.status)))
        throw new GithubApiError('invalid_comparison');
      return comparison.status === 'ahead' || comparison.status === 'identical';
    },
    changes: async (base, head) => {
      sha(head);
      const report: ChangeReport = { baseSha: base, headSha: head, prs: [], issues: [], complete: false };
      if (base === null) return report;
      sha(base);
      const commits = new Set<string>();
      for (let page = 1; ; page++) {
        const b = obj(await get(`/compare/${base}...${head}?per_page=100&page=${page}`)),
          total = b.total_commits,
          previous = commits.size;
        if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
          throw new GithubApiError('invalid_comparison');
        for (const c of list(b.commits)) commits.add(sha(obj(c).sha));
        if (commits.size === total) break;
        if (commits.size <= previous || commits.size > total)
          throw new GithubApiError('incomplete_comparison');
      }
      const prs = new Map<number, ChangeReport['prs'][number]>();
      for (const commit of commits)
        for (const raw of await pages(`/commits/${commit}/pulls?per_page=100`)) {
          const p = obj(raw);
          if (!p.merged_at || typeof p.merge_commit_sha !== 'string' || !commits.has(p.merge_commit_sha))
            continue;
          const number = positive(p.number);
          prs.set(number, {
            number,
            title: str(p.title),
            url: `https://github.com/${REPO}/pull/${number}`,
            mergeSha: p.merge_commit_sha,
          });
        }
      report.prs = [...prs.values()].sort((a, b) => a.number - b.number);
      const issues = new Map<string, LinkedIssue>();
      for (const pr of report.prs) {
        for (const issue of (await api.pullRequest(pr.number)).issues) {
          const existing = issues.get(issue.id);
          if (existing) existing.prNumbers.push(pr.number);
          else issues.set(issue.id, issue);
        }
      }
      report.issues = [...issues.values()];
      report.complete = true;
      return report;
    },
    job: async (id) => {
      const raw = obj(await get(`/actions/jobs/${positive(id)}`));
      if (raw.id !== id) throw new GithubApiError('invalid_job');
      const run = await readRun(positive(raw.run_id), positive(raw.run_attempt), true),
        name = str(raw.name),
        expected = backend ? (run.workflow === 'CI' ? 'deploy / deploy' : 'rollback / deploy') : run.workflow === 'CI' ? 'Publish release' : run.workflow;
      if (
        name !== expected ||
        raw.head_sha !== run.headSha ||
        raw.status !== 'completed' ||
        raw.conclusion == null
      )
        throw new GithubApiError('untrusted_job');
      let operation: VerifiedOperation | null = null;
      if (!backend && run.workflow === 'CI') {
        try {
          const release = await releaseFor(run.headSha);
          if (release?.run.id === run.id && release.run.attempt === run.attempt) operation = release;
        } catch (error) {
          if (!(error instanceof GithubApiError && error.code.startsWith('untrusted'))) throw error;
        }
      } else for (const value of await pages('/deployments?environment=production&per_page=100')) {
        const p = obj(obj(value).payload);
        if (
          p.run !== run.url ||
          p.notification === undefined ||
          obj(p.notification).run_attempt !== run.attempt
        )
          continue;
        operation = await api.operation(positive(obj(value).id));
        break;
      }
      const result = outcome(raw.conclusion);
      if (result === 'pending') throw new GithubApiError('invalid_job');
      return {
        id,
        name,
        run,
        operation,
        conclusion: result,
        failedStep:
          run.steps?.find((s) => s.outcome === 'failure' || s.outcome === 'cancelled')?.name ?? null,
      };
    },
  };
  return api;
}
