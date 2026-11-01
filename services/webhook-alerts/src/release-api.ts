import { GithubApiError } from './github-api';
const REPO = 'Cringe-Driven-Development-Team/frontend';
const PREFIX = `/repos/${REPO}`;
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
  workflow: 'CI' | 'CD' | 'Rollback';
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
  queue(number: number): Promise<{
    merged: boolean;
    closed: boolean;
    baseRef: string;
    entry: null | { id: string; enqueuer: string; enqueuedAt: string };
  }>;
  operation(id: number): Promise<VerifiedOperation>;
  changes(base: string | null, head: string): Promise<ChangeReport>;
  production(): Promise<VerifiedProduction[]>;
  job(id: number): Promise<VerifiedJob>;
  isAncestor(base: string, head: string): Promise<boolean>;
}
interface RecordInfo {
  id: number;
  kind: OperationKind;
  sha: string;
  imageRef: string;
  createdAt: string;
  runId: number;
  notification: Metadata | null;
}
function runId(value: unknown): number {
  const match = new RegExp(`^https://github\\.com/${REPO}/actions/runs/([1-9][0-9]*)$`).exec(str(value));
  if (!match) throw new GithubApiError('untrusted_run_url');
  return positive(Number(match[1]));
}
function record(value: unknown): RecordInfo {
  const r = obj(value),
    p = obj(r.payload),
    id = positive(r.id),
    target = sha(r.sha),
    environment = str(r.environment),
    task = str(r.task);
  if (obj(r.creator).login !== 'github-actions[bot]') throw new GithubApiError('untrusted_creator');
  const kind =
    environment === 'release-artifacts' && task === 'publish'
      ? 'publish'
      : environment === 'production' && ['deploy', 'rollback'].includes(task) && p.action === task
        ? (task as 'deploy' | 'rollback')
        : undefined;
  if (!kind) throw new GithubApiError('untrusted_operation');
  const imageRef = str(p.image_ref);
  if (
    !/^ghcr\.io\/cringe-driven-development-team\/bff@sha256:[0-9a-f]{64}$/.test(imageRef) ||
    p.assets !== `releases/${target}/`
  )
    throw new GithubApiError('untrusted_artifacts');
  const sourceId = runId(kind === 'publish' ? p.ci_run : p.run),
    url = `https://github.com/${REPO}/actions/runs/${sourceId}`;
  let notification: Metadata | null = null;
  if (p.notification !== undefined) {
    const n = obj(p.notification);
    notification = {
      base_sha: n.base_sha === null ? null : sha(n.base_sha),
      report_url: n.report_url === null ? null : str(n.report_url),
      run_attempt: positive(n.run_attempt),
    };
    if (notification.report_url !== null && notification.report_url !== `${url}#summary`)
      throw new GithubApiError('untrusted_report_url');
  }
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
  options: { token?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): ReleaseApi {
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
      ['ci.yml', 'CI', 'push', 'Publish release'],
      ['cd.yml', 'CD', 'workflow_dispatch', 'CD'],
      ['rollback.yml', 'Rollback', 'workflow_dispatch', 'Rollback'],
    ] as const;
    const expected = entry.find((e) => raw.path === `.github/workflows/${e[0]}`);
    if (
      !expected ||
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
          job = jobs.map(obj).find((j) => j.name === expected[3]);
        if (job)
          steps = list(job.steps).map((s) => ({
            name: str(obj(s).name),
            outcome: outcome(obj(s).conclusion),
          }));
      } catch {
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
    if (
      (info.kind === 'publish' && (run.workflow !== 'CI' || run.headSha !== info.sha)) ||
      (info.kind === 'deploy' && run.workflow !== 'CD') ||
      (info.kind === 'rollback' && run.workflow !== 'Rollback')
    )
      throw new GithubApiError('untrusted_run');
  }
  async function published(target: string, imageRef: string): Promise<void> {
    const rows = await pages(`/deployments?environment=release-artifacts&sha=${target}&per_page=100`);
    let reference: string | null = null,
      found = false;
    for (const raw of rows) {
      const info = record(raw);
      if (info.kind !== 'publish' || info.sha !== target) continue;
      const state = await statuses(info.id);
      if (state.state !== 'success') continue;
      if (reference !== null && reference !== info.imageRef) throw new GithubApiError('untrusted_artifacts');
      reference = info.imageRef;
      matchSource(info, await readRun(info.runId, info.notification?.run_attempt));
      if (info.imageRef === imageRef) found = true;
    }
    if (!found) throw new GithubApiError('untrusted_artifacts');
  }

  const api: ReleaseApi = {
    queue: async (number) => {
      const data = await graphql(
          `
            query ReleaseQueue($number: Int!) {
              repository(owner: "Cringe-Driven-Development-Team", name: "frontend") {
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
      const info = record(await get(`/deployments/${positive(id)}`));
      if (info.id !== id || !info.notification) throw new GithubApiError('notification_missing');
      const run = await readRun(info.runId, info.notification.run_attempt, info.kind !== 'publish');
      matchSource(info, run);
      const state = await statuses(id);
      if (info.kind !== 'publish' || state.state === 'success') await published(info.sha, info.imageRef);
      return { ...info, notification: info.notification, run, ...state };
    },
    production: async () => {
      const result: VerifiedProduction[] = [];
      for (const raw of await pages('/deployments?environment=production&per_page=100')) {
        const r = obj(raw),
          p = obj(r.payload);
        if (!p.image_ref && !p.action && !p.run) continue;
        const info = record(raw);
        if (info.kind === 'publish') throw new GithubApiError('untrusted_operation');
        const run = await readRun(info.runId, info.notification?.run_attempt);
        matchSource(info, run);
        const state = await statuses(info.id);
        await published(info.sha, info.imageRef);
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
        let cursor: string | null = null;
        do {
          const data = await graphql(
              `
                query ReleaseIssues($number: Int!, $cursor: String) {
                  repository(owner: "Cringe-Driven-Development-Team", name: "frontend") {
                    pullRequest(number: $number) {
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
              { number: pr.number, cursor },
            ),
            connection = obj(obj(obj(data.repository).pullRequest).closingIssuesReferences);
          for (const raw of list(connection.nodes)) {
            const i = obj(raw),
              id = str(i.id),
              existing = issues.get(id);
            if (existing) existing.prNumbers.push(pr.number);
            else
              issues.set(id, {
                id,
                number: positive(i.number),
                title: str(i.title),
                repo: str(obj(i.repository).nameWithOwner),
                prNumbers: [pr.number],
              });
          }
          const page = obj(connection.pageInfo);
          cursor = page.hasNextPage ? str(page.endCursor) : null;
          if (page.hasNextPage && !cursor) throw new GithubApiError('pagination');
        } while (cursor);
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
        expected = run.workflow === 'CI' ? 'Publish release' : run.workflow;
      if (
        name !== expected ||
        raw.head_sha !== run.headSha ||
        raw.status !== 'completed' ||
        raw.conclusion == null
      )
        throw new GithubApiError('untrusted_job');
      let operation: VerifiedOperation | null = null;
      const environment = run.workflow === 'CI' ? 'release-artifacts' : 'production';
      for (const value of await pages(`/deployments?environment=${environment}&per_page=100`)) {
        const p = obj(obj(value).payload);
        if (
          (p.ci_run ?? p.run) !== run.url ||
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
