import { escapeHtml, truncate } from './format';
import { createGithubReader, GithubApiError } from './github-api';
import { INFRA_REPO, type Delivery, type OutgoingMessage, type ReleaseNotice } from './store';

const PUBLISHER_REPO = 'Cringe-Driven-Development-Team/.github';
const DEPLOYMENT_TASK = 'infra-alerts';
const ENVIRONMENT = 'production';
const workflows = {
  infra: { path: '.github/workflows/infra.yml', job: 'Выкатка на прод' },
  auxiliary: { path: '.github/workflows/auxiliary-deploy.yml', job: 'production' },
} as const;

type Kind = keyof typeof workflows;
type JsonRecord = Record<string, unknown>;
interface Attempt {
  runId: number;
  attempt: number;
  sha: string;
}
interface Deployment extends Attempt {
  id: number;
  kind: Kind;
  operation?: 'deploy' | 'initialize';
  service?: 'githubbot' | 'webhook-alerts';
  sourceSha?: string;
}

export interface InfraReleaseApi {
  runAttempt(runId: number, attempt: number): Promise<unknown>;
  jobs(runId: number, attempt: number): Promise<unknown[]>;
  deployment(id: number): Promise<unknown>;
  deployments(sha: string): Promise<unknown[]>;
  cutoffMs(): number;
  started(deploymentId: number, url: string, cutoff: number, statusId?: number): Promise<boolean>;
  pullRequest(repository: string, sha: string): Promise<number | undefined>;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function payload(value: unknown): JsonRecord {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); }
  catch { return {}; }
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function fullSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function since(value: unknown, cutoff: number): boolean {
  return typeof value === 'string' && Date.parse(value) >= cutoff;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GithubApiError('invalid_response');
  return value;
}

export function createInfraReleaseApi(options: { token?: string; fetch?: typeof fetch; cutoffMs: () => number }): InfraReleaseApi {
  const read = createGithubReader(options);
  const prefix = `/repos/${INFRA_REPO}`;
  const get = (path: string) => read(async pages => (await pages(prefix + path, false))[0]);
  return {
    runAttempt: (runId, attempt) => get(`/actions/runs/${runId}/attempts/${attempt}`),
    jobs: (runId, attempt) => read(async pages => (await pages(`${prefix}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`))
      .flatMap(page => array(record(page).jobs))),
    deployment: id => get(`/deployments/${id}`),
    deployments: sha => read(async pages => (await pages(`${prefix}/deployments?sha=${sha}&environment=${ENVIRONMENT}&task=${DEPLOYMENT_TASK}&per_page=100`)).flatMap(array)),
    cutoffMs: options.cutoffMs,
    started: async (id, url, cutoff, statusId) => {
      const historyPath = `/deployments/${id}/statuses`;
      const isStart = (value: unknown) => {
        const status = record(value);
        return status.state === 'in_progress' && status.environment === ENVIRONMENT && status.log_url === url && since(status.created_at, cutoff);
      };
      if (statusId !== undefined) {
        const status = record(await get(`${historyPath}/${statusId}`));
        return status.id === statusId && isStart(status);
      }
      const statuses = await read(async pages => (await pages(`${prefix}${historyPath}?per_page=100`)).flatMap(array));
      return statuses.some(isStart);
    },
    pullRequest: async (repository, sha) => {
      const pulls = await read(async pages => (await pages(`/repos/${repository}/commits/${sha}/pulls?per_page=100`)).flatMap(array));
      const matches = pulls.map(record).flatMap(pr => {
        const base = record(pr.base);
        if (!positive(pr.number) || !since(pr.merged_at, -Infinity) || pr.merge_commit_sha !== sha
          || base.ref !== 'main' || record(base.repo).full_name !== repository) return [];
        return [pr.number];
      });
      return matches.length === 1 ? matches[0] : undefined;
    },
  };
}

function readDeployment(value: unknown): Deployment | undefined {
  const { id, ref, sha, task, environment, payload: rawPayload } = record(value);
  if (!positive(id) || !fullSha(sha) || ref !== sha || task !== DEPLOYMENT_TASK || environment !== ENVIRONMENT) return;
  const { schema, kind, run_id: runId, run_attempt: attempt, operation, service, source_sha: sourceSha } = payload(rawPayload);
  if (schema !== 1 || !positive(runId) || !positive(attempt)) return;
  if (kind === 'infra') return { id, sha, runId, attempt, kind };
  if (kind === 'auxiliary' && operation === 'initialize') return { id, sha, runId, attempt, kind, operation };
  if (kind === 'auxiliary' && operation === 'deploy' && (service === 'githubbot' || service === 'webhook-alerts') && fullSha(sourceSha)) {
    return { id, sha, runId, attempt, kind, operation, service, sourceSha };
  }
}

function matchesAttempt(raw: JsonRecord, attempt: Attempt): boolean {
  return raw.run_id === attempt.runId && raw.run_attempt === attempt.attempt && raw.head_sha === attempt.sha;
}

async function verifyAttempt(api: InfraReleaseApi, attempt: Attempt) {
  const run = record(await api.runAttempt(attempt.runId, attempt.attempt));
  const kind = run.path === workflows.infra.path ? 'infra' : run.path === workflows.auxiliary.path ? 'auxiliary' : undefined;
  if (!kind || run.id !== attempt.runId || run.run_attempt !== attempt.attempt || run.head_sha !== attempt.sha
    || run.head_branch !== 'main' || record(run.repository).full_name !== INFRA_REPO || record(run.head_repository).full_name !== INFRA_REPO
    || (run.event !== 'workflow_dispatch' && !(kind === 'infra' && run.event === 'push'))) return;
  const jobs = (await api.jobs(attempt.runId, attempt.attempt)).map(record).filter(job => job.name === workflows[kind].job);
  const job = jobs[0];
  if (jobs.length !== 1 || !job || !positive(job.id) || !matchesAttempt(job, attempt) || job.head_branch !== 'main') return;
  const actor = record(run.triggering_actor ?? run.actor).login;
  return { ...attempt, kind, job, jobId: job.id, actor: typeof actor === 'string' ? actor : undefined,
    url: `https://github.com/${INFRA_REPO}/actions/runs/${attempt.runId}/attempts/${attempt.attempt}` };
}

type VerifiedAttempt = NonNullable<Awaited<ReturnType<typeof verifyAttempt>>>;
const labels = {
  start: '⏳', success: '✅', failure: '❌', cancelled: '⚪',
} as const;
type Outcome = keyof typeof labels;
const outcomes: Record<Outcome, string> = {
  start: 'началась', success: 'завершилась успешно', failure: 'завершилась с ошибкой', cancelled: 'отменена',
};

function releaseSource(run: VerifiedAttempt, deployment?: Deployment) {
  if (deployment?.sourceSha) return { repository: PUBLISHER_REPO, sha: deployment.sourceSha };
  if (run.kind === 'infra' || deployment?.operation === 'initialize') return { repository: INFRA_REPO, sha: run.sha };
}

function card(topic: number, run: VerifiedAttempt, deployment: Deployment | undefined, outcome: Outcome, prUrl?: string): OutgoingMessage {
  const title = run.kind === 'infra' ? 'Выкатка инфры' : deployment?.service ? `Выкатка ${deployment.service}`
    : deployment?.operation === 'initialize' ? 'Инициализация VPS3' : 'Операция на VPS3';
  const version = releaseSource(run, deployment)?.sha;
  const lines = [`<b>${labels[outcome]} ${title} ${outcomes[outcome]}</b>`, version ? `production · <code>${version.slice(0, 7)}</code>` : 'production'];
  if (outcome !== 'start') {
    const steps = Array.isArray(run.job.steps) ? run.job.steps.map(record) : [];
    if (outcome === 'failure' || outcome === 'cancelled') {
      const failed = steps.find(step => step.conclusion === 'failure' || step.conclusion === 'cancelled')?.name;
      if (typeof failed === 'string' && failed) lines.push(`Этап сбоя — ${escapeHtml(truncate(failed, 160))}`);
    }
    const health = run.kind === 'infra' ? steps.find(step => step.name === 'verify.yml')?.conclusion : undefined;
    if (health === 'success' || health === 'failure') lines.push(`Health Check ${labels[health]}`);
  }
  if (run.actor) lines.push(`Запустил: ${escapeHtml(run.actor)}`);
  const kind = outcome === 'start' ? 'start' : 'result';
  const notice = { key: `${kind}:${INFRA_REPO}:${run.runId}:${run.attempt}`, repository: INFRA_REPO, runId: run.runId, attempt: run.attempt } as const;
  const release: ReleaseNotice = outcome === 'start' && deployment
    ? { ...notice, kind: 'start', deploymentId: deployment.id }
    : { ...notice, kind: 'result', jobId: run.jobId, ...(deployment ? { deploymentId: deployment.id } : {}) };
  const keyboard = [[{ text: 'Логи выкатки', url: run.url }]];
  if (prUrl) keyboard.unshift([{ text: 'PR', url: prUrl }]);
  return { topic, html: lines.join('\n'), keyboard, release };
}

function result(conclusion: unknown): Exclude<Outcome, 'start'> | undefined {
  if (conclusion === 'success' || conclusion === 'failure' || conclusion === 'cancelled') return conclusion;
  if (conclusion === 'timed_out') return 'failure';
}

async function associatedPullRequest(api: InfraReleaseApi, run: VerifiedAttempt, deployment?: Deployment): Promise<string | undefined> {
  const source = releaseSource(run, deployment);
  if (!source) return;
  const { repository, sha } = source;
  try {
    const number = await api.pullRequest(repository, sha);
    if (number !== undefined) return `https://github.com/${repository}/pull/${number}`;
  } catch { /* PR enrichment does not delay the release notification. */ }
}

export async function projectInfraRelease(delivery: Delivery, api: InfraReleaseApi, topic: number): Promise<OutgoingMessage[]> {
  if (delivery.source !== 'github') return [];
  const event = record(JSON.parse(new TextDecoder().decode(delivery.raw)));
  if (record(event.repository).full_name !== INFRA_REPO) return [];
  const cutoff = api.cutoffMs();
  const deliveryCutoff = delivery.releaseRecovery ? -Infinity : cutoff;

  if (delivery.event === 'deployment_status' && event.action === 'created') {
    const status = record(event.deployment_status);
    const signed = readDeployment(event.deployment);
    if (!signed || status.state !== 'in_progress' || status.environment !== ENVIRONMENT || !positive(status.id)) return [];
    const deployment = readDeployment(await api.deployment(signed.id));
    if (!deployment || deployment.id !== signed.id || deployment.sha !== signed.sha || deployment.runId !== signed.runId
      || deployment.attempt !== signed.attempt || deployment.kind !== signed.kind || deployment.operation !== signed.operation
      || deployment.service !== signed.service || deployment.sourceSha !== signed.sourceSha) return [];
    const run = await verifyAttempt(api, deployment);
    if (!run || run.kind !== deployment.kind || status.log_url !== run.url
      || (run.job.status !== 'in_progress' && run.job.status !== 'completed') || run.job.conclusion === 'skipped') return [];
    if (!await api.started(deployment.id, run.url, deliveryCutoff, status.id)) return [];
    return [card(topic, run, deployment, 'start', await associatedPullRequest(api, run, deployment))];
  }

  if (delivery.event !== 'workflow_job' || event.action !== 'completed') return [];
  const job = record(event.workflow_job);
  const { run_id: runId, run_attempt: attempt, head_sha: sha } = job;
  const outcome = result(job.conclusion);
  if (!outcome || job.status !== 'completed' || job.head_branch !== 'main' || !positive(job.id) || !positive(runId) || !positive(attempt) || !fullSha(sha)
    || (job.name !== workflows.infra.job && job.name !== workflows.auxiliary.job)) return [];
  const run = await verifyAttempt(api, { runId, attempt, sha });
  if (!run || run.jobId !== job.id || run.job.name !== job.name) return [];
  if (run.job.status !== 'completed') throw new GithubApiError('job_not_completed');
  if (run.job.conclusion !== job.conclusion || !since(run.job.completed_at, deliveryCutoff)) return [];

  const deployments = (await api.deployments(sha)).map(readDeployment).filter(deployment => deployment?.sha === sha
    && deployment.kind === run.kind && deployment.runId === runId && deployment.attempt === attempt);
  const deployment = deployments.length === 1 ? deployments[0] : undefined;
  const started = deployment && await api.started(deployment.id, run.url, cutoff);
  const prUrl = await associatedPullRequest(api, run, deployment);
  const message = card(topic, run, deployment, outcome, prUrl);
  return started ? [card(topic, run, deployment, 'start', prUrl), message] : [message];
}
