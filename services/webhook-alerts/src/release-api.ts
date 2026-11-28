import { createHash } from 'node:crypto';
import { GithubApiError } from './github-api';
import {
  MAX_RESULT_ZIP, SERVICE_ARCHIVES, readBackendDeployment, readBackendManifest, readBackendResult,
  readResultArchive, sameVersion, type BackendDeployment, type ServiceInventory,
} from './backend-release-evidence';
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
type ReleaseRepository = `Cringe-Driven-Development-Team/${'frontend' | 'backend' | 'infra' | '.github'}`;

export async function readReleasePullRequest(
  repository: ReleaseRepository,
  graphql: (query: string, variables: Record<string, unknown>) => Promise<Obj>,
  number: number,
): ReturnType<ReleaseApi['pullRequest']> {
  const [, name] = repository.split('/');
  const issues = new Map<string, LinkedIssue>();
  const cursors = new Set<string>();
  let cursor: string | null = null,
    title = '';
  do {
    const data = await graphql(
        `
          query ReleaseIssues($number: Int!, $cursor: String) {
            repository(owner: "Cringe-Driven-Development-Team", name: "${name}") {
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
    if (typeof page.hasNextPage !== 'boolean') throw new GithubApiError('invalid_response');
    cursor = page.hasNextPage ? str(page.endCursor) : null;
    if (page.hasNextPage && (!cursor || cursors.has(cursor))) throw new GithubApiError('pagination');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { title, issues: [...issues.values()] };
}

async function inBatches<T, R>(items: T[], size: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.all(items.slice(i, i + size).map(read)));
  }
  return results;
}

export async function readReleaseChanges(
  repository: ReleaseRepository,
  base: string | null,
  head: string,
  { get, pages, pullRequest, include }: {
    get: (path: string) => Promise<unknown>;
    pages: (path: string) => Promise<unknown[]>;
    pullRequest: ReleaseApi['pullRequest'];
    include?: (number: number) => Promise<boolean>;
  },
): Promise<ChangeReport> {
  sha(head);
  const report: ChangeReport = { baseSha: base, headSha: head, prs: [], issues: [], complete: false };
  if (base === null) return report;
  sha(base);
  const commits = new Set<string>();
  const strictRange = repository.endsWith('/infra') || repository.endsWith('/.github');
  let expectedTotal: number | undefined;
  for (let page = 1; ; page++) {
    const b = obj(await get(`/compare/${base}...${head}?per_page=100&page=${page}`)),
      total = b.total_commits,
      previous = commits.size;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
      throw new GithubApiError('invalid_comparison');
    if (strictRange && (b.status !== 'ahead' || total === 0 || (expectedTotal !== undefined && expectedTotal !== total)))
      throw new GithubApiError('invalid_comparison');
    expectedTotal = total;
    for (const c of list(b.commits)) commits.add(sha(obj(c).sha));
    if (commits.size === total) break;
    if (commits.size <= previous || commits.size > total)
      throw new GithubApiError('incomplete_comparison');
  }
  const batchSize = strictRange ? 6 : 1;
  const pullsByCommit = await inBatches([...commits], batchSize, commit => pages(`/commits/${commit}/pulls?per_page=100`));
  const prs = new Map<number, ChangeReport['prs'][number]>();
  for (const pulls of pullsByCommit)
    for (const raw of pulls) {
      const p = obj(raw);
      if (!p.merged_at || typeof p.merge_commit_sha !== 'string' || !commits.has(p.merge_commit_sha))
        continue;
      if (strictRange && (obj(p.base).ref !== 'main' || obj(obj(p.base).repo).full_name !== repository)) continue;
      const number = positive(p.number);
      prs.set(number, {
        number,
        title: str(p.title),
        url: `https://github.com/${repository}/pull/${number}`,
        mergeSha: p.merge_commit_sha,
      });
    }
  const sorted = [...prs.values()].sort((a, b) => a.number - b.number);
  const issues = new Map<string, LinkedIssue>();
  const changes = await inBatches(sorted, batchSize, async pr => {
    if (include && !await include(pr.number)) return;
    return { pr, issues: (await pullRequest(pr.number)).issues };
  });
  for (const change of changes) {
    if (!change) continue;
    const { pr } = change;
    report.prs.push(pr);
    for (const issue of change.issues) {
      const existing = issues.get(issue.id);
      if (existing) existing.prNumbers.push(pr.number);
      else issues.set(issue.id, issue);
    }
  }
  report.issues = [...issues.values()];
  report.complete = true;
  return report;
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
  imageRef?: string;
  notification: Metadata;
  run: VerifiedRun;
  release?: VerifiedRelease;
  backendDeployment?: BackendDeployment;
  backendPublication?: ServiceInventory;
}
export interface VerifiedProduction {
  id: number;
  kind: 'deploy' | 'rollback';
  sha: string;
  imageRef?: string;
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
  imageRef?: string;
  createdAt: string;
  runId: number;
  notification: Metadata | null;
  backendDeployment?: BackendDeployment;
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
  const kind = task as 'deploy' | 'rollback';
  const sourceId = runId(p.run, repository),
    notification = p.notification === undefined ? null : metadata(p.notification, sourceId, repository);
  if (backend && notification && notification.report_url !== `https://github.com/${repository}/actions/runs/${sourceId}#summary`)
    throw new GithubApiError('untrusted_report_url');
  const createdAt = str(r.created_at);
  if (!Number.isFinite(Date.parse(createdAt))) throw new GithubApiError('invalid_timestamp');
  const base = { id, kind, sha: target, createdAt, runId: sourceId, notification };
  if (backend && r.ref !== target) throw new GithubApiError('untrusted_artifacts');
  if (p.schema_version === 2 && backend)
    return { ...base, backendDeployment: readBackendDeployment(p, target, kind) };
  if (backend && p.schema_version !== undefined && p.schema_version !== 1)
    throw new GithubApiError('untrusted_backend_schema');
  const imageRef = str(p.image_ref);
  if (!(backend ? /^ghcr\.io\/cringe-driven-development-team\/backend@sha256:[0-9a-f]{64}$/ : IMAGE).test(imageRef)
      || (!backend && p.assets !== `releases/${target}/`)) throw new GithubApiError('untrusted_artifacts');
  return { ...base, imageRef };
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
  if (REPO !== "Cringe-Driven-Development-Team/frontend" && REPO !== "Cringe-Driven-Development-Team/backend") throw new GithubApiError("untrusted_repository");
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
  // Release text assets and Actions results may redirect to signed storage. Only the GitHub API receives the token.
  async function downloadBytes(path: string, maxBytes: number, actionsArtifact = false): Promise<Uint8Array> {
    if (!options.token?.trim()) throw new GithubApiError('unavailable');
    const signal = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 5000, 5000)));
    try {
      let response = await fetcher(`https://api.github.com${PREFIX}${path}`, {
        redirect: 'manual',
        signal,
        headers: {
          accept: 'application/octet-stream',
          authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = URL.parse(response.headers.get('location') ?? '');
        if (!location || location.protocol !== 'https:' || location.port || location.username || location.password
            || !(location.hostname.endsWith('.githubusercontent.com')
              || (actionsArtifact && location.hostname.endsWith('.blob.core.windows.net'))))
          throw new GithubApiError('untrusted_asset_url');
        response = await fetcher(location.href, { redirect: 'error', signal });
      }
      if (!response.ok) throw new GithubApiError(`http_${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new GithubApiError('untrusted_asset_size');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new GithubApiError('untrusted_asset_size');
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      throw error instanceof GithubApiError ? error : new GithubApiError('unavailable');
    }
  }
  async function pages(path: string, field?: string): Promise<unknown[]> {
    const start = new URL(PREFIX + path, 'https://api.github.com'),
      result: unknown[] = [];
    const url = new URL(start);
    while (true) {
      const response = await request(url.href);
      result.push(...list(field ? obj(response.body)[field] : response.body));
      if (!response.next) break;

      const link = URL.parse(response.next, start);
      if (!link || link.origin !== start.origin || link.username || link.password)
        throw new GithubApiError('pagination');
      const canonicalPath = link.pathname.replace(/^\/repositories\/[1-9]\d*(?=\/)/, PREFIX);
      const [nextPage, duplicate] = link.searchParams.getAll('page');
      const page = Number(nextPage);
      if (canonicalPath !== start.pathname || !nextPage || duplicate !== undefined || !/^[1-9]\d*$/.test(nextPage) ||
          !Number.isSafeInteger(page) || page <= Number(url.searchParams.get('page') ?? 1))
        throw new GithubApiError('pagination');
      // GitHub may link by repository ID. Keep the original route and its filters.
      url.searchParams.set('page', nextPage);
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
      ['cd.yml', 'CD', 'workflow_dispatch', backend ? 'deploy' : 'CD'],
      ['rollback.yml', 'Rollback', 'workflow_dispatch', backend ? 'rollback / deploy' : 'Rollback'],
      ['release-import.yml', 'Release import', 'workflow_dispatch', 'Release import'],
    ] as const;
    const expected = entry.find((e) => raw.path === `.github/workflows/${e[0]}`);
    if (
      !expected ||
      (backend && !["CI", "CD", "Rollback"].includes(expected[1])) ||
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
  async function statuses(id: number, verifiedRun?: VerifiedRun): Promise<{ state: OperationState; everSucceeded: boolean }> {
    const records = (await pages(`/deployments/${id}/statuses?per_page=100`)).map(obj);
    const states = records.map(record => str(record.state));
    if (verifiedRun && records.some(record =>
      obj(record.creator).login !== 'github-actions[bot]' || record.environment_url !== 'https://cellestial.ru'
      || record.log_url !== `${verifiedRun.url}/attempts/${verifiedRun.attempt}`))
      throw new GithubApiError('untrusted_backend_status');
    if (
      states.some(
        (s) => !['pending', 'queued', 'in_progress', 'success', 'failure', 'error', 'inactive'].includes(s),
      )
    )
      throw new GithubApiError('invalid_state');
    return { state: (states[0] ?? 'pending') as OperationState, everSucceeded: states.includes('success') };
  }
  function matchSource(info: RecordInfo, run: VerifiedRun): void {
    const allowed = info.kind === 'deploy' ? (backend && !info.backendDeployment ? ['CI', 'CD'] : ['CD']) : ['Rollback'];
    if (!allowed.includes(run.workflow) || (backend && run.workflow === 'CI' && run.headSha !== info.sha)) throw new GithubApiError('untrusted_run');
  }
  async function verifiedReleaseAssets(value: unknown, archives: readonly string[]) {
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
        ![...archives, 'SHA256SUMS'].includes(name) ||
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
    if (assets.size !== archives.length + 1) throw new GithubApiError('untrusted_release_assets');
    const text = async (name: string) => {
      const asset = assets.get(name)!;
      if (asset.size > MAX_TEXT) throw new GithubApiError('untrusted_release_assets');
      const bytes = await downloadBytes(`/releases/assets/${asset.id}`, asset.size);
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
    if (sums.size !== archives.length || archives.some((name) => sums.get(name) !== assets.get(name)!.digest))
      throw new GithubApiError('untrusted_checksums');
    return { id, target, tag, url, publishedAt, assets, body: await text('release.json') };
  }
  async function verifyRelease(value: unknown): Promise<VerifiedOperation> {
    const { id, target, tag, url, publishedAt, body } = await verifiedReleaseAssets(value, ARCHIVES);
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
  async function verifyBackendRelease(value: unknown): Promise<VerifiedOperation> {
    const entry = await verifiedReleaseAssets(value, [...SERVICE_ARCHIVES, 'release.json']);
    let manifest: unknown;
    try { manifest = JSON.parse(entry.body); }
    catch { throw new GithubApiError('untrusted_backend_manifest'); }
    const { versions, ciUrl } = readBackendManifest(manifest, entry.target, entry.assets);
    const run = await readRun(runId(ciUrl, REPO));
    if (run.workflow !== 'CI' || run.headSha !== entry.target) throw new GithubApiError('untrusted_backend_publication');
    return {
      id: entry.id, kind: 'publish', sha: entry.target, state: 'success', everSucceeded: true,
      createdAt: entry.publishedAt, notification: { base_sha: null, report_url: run.url + '#summary', run_attempt: run.attempt },
      run, release: { id: entry.id, tag: entry.tag, url: entry.url, imported: false }, backendPublication: versions,
    };
  }

  async function backendResult(info: RecordInfo, run: VerifiedRun, state: OperationState) {
    const operation = info.backendDeployment!;
    const release = await verifyBackendRelease(await get(`/releases/tags/${operation.releaseTag}`));
    if (release.sha !== info.sha || release.release?.tag !== operation.releaseTag)
      throw new GithubApiError('untrusted_backend_target');
    const releases = new Map([[release.sha, release]]);
    for (const service of operation.selected) {
      const target = operation.desired[service]!;
      if (!releases.has(target.source_sha)) {
        const tag = `release-${target.source_sha}`;
        const source = await verifyBackendRelease(await get(`/releases/tags/${tag}`));
        if (source.release?.tag !== tag || source.sha !== target.source_sha)
          throw new GithubApiError('untrusted_backend_target');
        releases.set(source.sha, source);
      }
      if (!sameVersion(target, releases.get(target.source_sha)!.backendPublication?.[service]))
        throw new GithubApiError('untrusted_backend_target');
    }
    if (!['success', 'failure', 'error'].includes(state)) return operation;
    const name = `backend-deployment-${run.id}-${run.attempt}`;
    const artifacts = (await pages(`/actions/runs/${run.id}/artifacts?per_page=100&name=${name}`, 'artifacts'))
      .map(obj).filter(artifact => artifact.name === name);
    if (!artifacts.length) {
      const upload = run.steps?.find(step => step.name === 'Upload deployment evidence')?.outcome;
      if (state !== 'success' && (upload === 'failure' || upload === 'cancelled' || upload === 'skipped')) return operation;
      throw new GithubApiError('artifact_not_ready');
    }
    const artifact = artifacts[0]!;
    const hash = /^sha256:([0-9a-f]{64})$/.exec(String(artifact.digest))?.[1];
    const size = positive(artifact.size_in_bytes);
    if (artifacts.length !== 1 || artifact.expired !== false || !hash || size > MAX_RESULT_ZIP)
      throw new GithubApiError('untrusted_backend_artifact');
    if (artifact.workflow_run !== undefined) {
      const origin = obj(artifact.workflow_run);
      if (origin.id !== run.id || origin.head_sha !== run.headSha || origin.head_branch !== 'main')
        throw new GithubApiError('untrusted_backend_artifact');
    }
    const bytes = await downloadBytes(`/actions/artifacts/${positive(artifact.id)}/zip`, size, true);
    if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== hash)
      throw new GithubApiError('untrusted_backend_artifact');
    if (state === 'success' && ['Switch backend', 'Health check'].some(name => {
      const matches = run.steps?.filter(step => step.name === name);
      return matches?.length !== 1 || matches[0]?.outcome !== 'success';
    })) throw new GithubApiError('untrusted_backend_success');
    return { ...operation, result: readBackendResult(readResultArchive(bytes), operation, {
      id: info.id, sha: info.sha, kind: info.kind, runId: run.id, attempt: run.attempt, success: state === 'success',
    }) };
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
      if (info.sha !== current.sha || !info.imageRef || !info.notification || !(await statuses(info.id)).everSucceeded) continue;
      matchSource(info, await readRun(info.runId, info.notification.run_attempt));
      refs.add(info.imageRef);
      if (info.imageRef === current.imageRef) found = true;
    }
    if (!found || refs.size !== 1) throw new GithubApiError('untrusted_rollback_target');
  }

  const api: ReleaseApi = {
    pullRequest: number => readReleasePullRequest(REPO, graphql, number),
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
        const state = await statuses(id, info.backendDeployment ? run : undefined);
        if (info.backendDeployment) {
          const backendDeployment = await backendResult(info, run, state.state);
          return { ...info, notification: info.notification, run, ...state, backendDeployment };
        }
        if (info.kind === 'rollback') await rollbackTarget(info);
        return {...info, notification:info.notification, run, ...state};
      }
      const release = await api.release(positive(releaseId));
      if (release.sha !== info.sha || release.imageRef !== info.imageRef) throw new GithubApiError('untrusted_release');
      const state = await statuses(id);
      return { ...info, notification: info.notification, run, ...state, release: release.release };
    },
    release: async (id) => {
      const raw = await get(`/releases/${positive(id)}`);
      const release = backend ? await verifyBackendRelease(raw) : await verifyRelease(raw);
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
        const state = info.backendDeployment ? await api.operation(info.id) : await statuses(info.id);
        result.push({
          id: info.id,
          kind: info.kind,
          sha: info.sha,
          ...(info.imageRef ? { imageRef: info.imageRef } : {}),
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
    changes: (base, head) => readReleaseChanges(REPO, base, head, { get, pages, pullRequest: api.pullRequest }),
    job: async (id) => {
      const raw = obj(await get(`/actions/jobs/${positive(id)}`));
      if (raw.id !== id) throw new GithubApiError('invalid_job');
      const run = await readRun(positive(raw.run_id), positive(raw.run_attempt), true),
        name = str(raw.name),
        expected = backend ? (run.workflow === 'CI' ? 'deploy / deploy' : run.workflow === 'CD' ? 'deploy' : 'rollback / deploy') : run.workflow === 'CI' ? 'Publish release' : run.workflow;
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
