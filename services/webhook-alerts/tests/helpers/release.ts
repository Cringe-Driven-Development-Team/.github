import type { Delivery } from '../../src/store';
import type {
  ReleaseApi,
  VerifiedOperation,
  VerifiedJob,
  ChangeReport,
  VerifiedProduction,
} from '../../src/release-api';
export const REPO = 'Cringe-Driven-Development-Team/frontend';
export const A = 'a'.repeat(40),
  B = 'b'.repeat(40),
  C = 'c'.repeat(40);
export function releaseFixture() {
  const operation: VerifiedOperation = {
    id: 1,
    kind: 'deploy',
    sha: B,
    state: 'success',
    everSucceeded: true,
    createdAt: '2026-11-01T20:00:00Z',
    imageRef: `ghcr.io/cringe-driven-development-team/bff@sha256:${'d'.repeat(64)}`,
    notification: {
      base_sha: A,
      report_url: `https://github.com/${REPO}/actions/runs/10#summary`,
      run_attempt: 1,
    },
    run: {
      id: 10,
      attempt: 1,
      workflow: 'CD',
      event: 'workflow_dispatch',
      headSha: C,
      actor: 'YarikMix',
      url: `https://github.com/${REPO}/actions/runs/10`,
      steps: [{ name: 'Health check', outcome: 'success' }],
    },
  };
  const report: ChangeReport = {
    baseSha: A,
    headSha: B,
    complete: true,
    prs: [
      { number: 125, title: 'Human readable PR', url: `https://github.com/${REPO}/pull/125`, mergeSha: B },
    ],
    issues: [{ id: 'I1', number: 27, title: 'Frontend. Подстановка static', repo: REPO, prNumbers: [125] }],
  };
  const state = {
    operation,
    report,
    queue: {
      merged: false,
      closed: false,
      baseRef: 'main',
      entry: { id: 'ENTRY1', enqueuer: 'YarikMix', enqueuedAt: '2026-11-01T20:00:00Z' } as null | {
        id: string;
        enqueuer: string;
        enqueuedAt: string;
      },
    },
    history: [] as VerifiedProduction[],
    job: {
      id: 100,
      name: 'CD',
      conclusion: 'failure',
      run: operation.run,
      operation: null,
      failedStep: 'Ready release',
    } as VerifiedJob,
    calls: [] as string[],
  };
  const api: ReleaseApi = {
    queue: async () => {
      state.calls.push('queue');
      return state.queue;
    },
    operation: async () => {
      state.calls.push('operation');
      return state.operation;
    },
    changes: async () => {
      state.calls.push('changes');
      return state.report;
    },
    production: async () => {
      state.calls.push('production');
      return state.history;
    },
    job: async () => {
      state.calls.push('job');
      return state.job;
    },
    isAncestor: async (base, head) => base === head || head === C,
  };
  return { ...state, api };
}
export function delivery(event: string, payload: Record<string, unknown>, id = 1): Delivery {
  return {
    id,
    source: 'github',
    deliveryId: `delivery-${id}`,
    event,
    raw: new TextEncoder().encode(JSON.stringify({ repository: { full_name: REPO }, ...payload })),
    bodyHash: 'test',
    receivedAt: 1793563200000,
    prepared: false,
    leaseUntil: null,
  };
}
export const enqueue = (action = 'enqueued') =>
  delivery('pull_request', {
    action,
    number: 125,
    pull_request: {
      number: 125,
      base: { ref: 'main' },
      title: 'Human readable PR',
      html_url: `https://github.com/${REPO}/pull/125`,
    },
  });
export const status = (state = 'success', environment = 'production') =>
  delivery('deployment_status', {
    action: 'created',
    deployment: { id: 1, environment },
    deployment_status: { state },
  });
