import { afterEach, expect, test } from 'bun:test';
import { reconcileClosedIssue } from '../scripts/issue-status.ts';

const org = 'Cringe-Driven-Development-Team';
const when = '2026-11-04T18:29:47Z';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture(repo = 'frontend') {
  const input = { repository: `${org}/${repo}`, issueId: 'I_119', closedAt: when };
  const closer = { __typename: 'PullRequest', merged: true, baseRefName: 'main', repository: { nameWithOwner: input.repository, defaultBranchRef: { name: 'main' } } };
  const issue: any = { __typename: 'Issue', id: input.issueId, closed: true, closedAt: when, stateReason: 'COMPLETED', title: 'Любое название', repository: { nameWithOwner: input.repository } };
  const events: any[] = [{ __typename: 'ClosedEvent', createdAt: when, closer }];
  const card: any = { id: 'card-119', project: { id: 'P_1', number: 1, owner: { login: org } }, fieldValueByName: { name: 'In review', updatedAt: '2026-11-03T00:00:00Z' } };
  const fields = [{ id: 'F_status', name: 'Status', options: ['Ready for build', 'Ready for release', 'Done'].map(name => ({ id: name, name })) }];
  const project: any = { id: 'P_1', viewerCanUpdate: true };
  const writes: any[] = [];
  let reads = 0;
  const state = { input, issue, events, card, fields, project, writes, cards: [card], paged: false, beforeRead: (_: number) => {}, error: '' };
  const page = (nodes: any[], cursor: string | null) => state.paged && !cursor
    ? { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page2' } }
    : { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe('https://api.github.com/graphql');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const { query, variables: v } = JSON.parse(init.body);
    if (state.error === 'http') return new Response('test-token', { status: 503 });
    if (state.error === '403') return new Response('test-token', { status: 403 });
    if (state.error === 'graphql') return Response.json({ errors: [{ message: 'test-token' }] });
    if (state.error === 'data') return Response.json({});
    if (query.includes('mutation')) {
      if (state.error === 'mutation') return Response.json({ errors: [{ message: 'denied' }] });
      expect(v.project).toBe('P_1');
      expect(v.field).toBe('F_status');
      writes.push({ item: v.item, status: v.option });
      card.fieldValueByName = { name: v.option, updatedAt: when };
      return Response.json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: v.item } } } });
    }
    if (query.includes('IssueStatusIssue')) {
      state.beforeRead(++reads);
      expect(v.id).toBe('I_119');
      return Response.json({ data: { node: { ...issue, timelineItems: page(events, v.cursor) } } });
    }
    if (query.includes('IssueStatusCards')) return Response.json({ data: { node: { projectItems: page(state.cards, v.cursor) } } });
    if (query.includes('IssueStatusProject')) return Response.json({ data: { organization: { projectV2: { ...project, fields: page(fields, v.cursor) } } } });
    throw Error(`Unexpected query ${query}`);
  }) as typeof fetch;
  return state;
}

test.each([
  ['frontend', 'merge', 'Ready for build'], ['backend', 'merge', 'Done'], ['infra', 'merge', 'Done'],
  ['frontend', 'manual', 'Done'], ['frontend', 'not planned', 'Done'], ['frontend', 'foreign', 'Done'],
  ['frontend', 'topic', 'Done'], ['frontend', 'unmerged', 'Done'],
])('%s %s closes into %s, rerun is idempotent', async (repo, reason, want) => {
  const f = fixture(repo);
  if (reason === 'manual') f.events[0].closer = null;
  if (reason === 'not planned') f.issue.stateReason = 'NOT_PLANNED';
  if (reason === 'foreign') f.events[0].closer.repository.nameWithOwner = 'other/frontend';
  if (reason === 'topic') f.events[0].closer.baseRefName = 'topic';
  if (reason === 'unmerged') f.events[0].closer.merged = false;
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('changed');
  expect(f.writes).toEqual([{ item: 'card-119', status: want }]);
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('unchanged');
  expect(f.writes).toHaveLength(1);
});

test('null Status and pagination of timeline, cards and fields', async () => {
  const f = fixture(); f.card.fieldValueByName = null; f.paged = true;
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('changed');
  expect(f.writes[0].status).toBe('Ready for build');
});

test.each(['Ready for release', 'Done'])('late close preserves %s only for the current cycle', async status => {
  const f = fixture(); f.card.fieldValueByName = { name: status, updatedAt: when };
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('unchanged');
  f.card.fieldValueByName.updatedAt = '2026-11-03T00:00:00Z';
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('changed');
  expect(f.writes).toEqual([{ item: 'card-119', status: 'Ready for build' }]);
});

test.each(['open', 'new close', 'no card', 'other project', 'other repo', 'PR node'])('%s is skipped', async kind => {
  const f = fixture();
  if (kind === 'open') f.issue.closed = false;
  if (kind === 'new close') f.issue.closedAt = '2026-11-04T19:00:00Z';
  if (kind === 'no card') f.cards = [];
  if (kind === 'other project') f.card.project.number = 2;
  if (kind === 'other repo') f.issue.repository.nameWithOwner = `${org}/backend`;
  if (kind === 'PR node') f.issue.__typename = 'PullRequest';
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('skipped');
  expect(f.writes).toEqual([]);
});

test.each(['reopen', 'reclose', 'status'])('changed %s before write prevents a stale mutation', async kind => {
  const f = fixture(); f.beforeRead = n => { if (n === 2) {
    if (kind === 'reopen') f.issue.closed = false;
    if (kind === 'reclose') f.issue.closedAt = '2026-11-04T19:00:00Z';
    if (kind === 'status') f.card.fieldValueByName = { name: 'Ready for release', updatedAt: when };
  } };
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('skipped');
  expect(f.writes).toEqual([]);
});

test.each(['http', '403', 'graphql', 'data', 'mutation'])('%s failure is visible and does not reveal token', async kind => {
  const f = fixture(); f.error = kind;
  let caught: unknown;
  try { await reconcileClosedIssue(f.input, 'test-token'); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).not.toContain('test-token');
  expect(f.writes).toEqual([]);
});

test.each(['timeline', 'closer', 'permission', 'option', 'timestamp', 'id'])('invalid %s is not treated as a manual closure', async kind => {
  const f = fixture();
  if (kind === 'timeline') f.events.length = 0;
  if (kind === 'closer') delete f.events[0].closer;
  if (kind === 'permission') f.project.viewerCanUpdate = false;
  if (kind === 'option') f.fields[0].options = [];
  if (kind === 'timestamp') f.card.fieldValueByName.updatedAt = 'yesterday';
  if (kind === 'id') delete f.issue.id;
  await expect(reconcileClosedIssue(f.input, 'test-token')).rejects.toThrow();
  expect(f.writes).toEqual([]);
});

test('timeline from an earlier closure cannot describe the current cycle', async () => {
  const f = fixture();
  f.events[0].createdAt = '2026-11-04T18:00:00Z';
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('skipped');
  expect(f.writes).toEqual([]);
});

test('CLI ignores unrelated events and rejects foreign or mismatched repositories before networking', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/issue-status-cli-`);
  try {
    writeFileSync(`${dir}/deny.ts`, 'globalThis.fetch = (() => { console.log("NETWORK_CALLED"); throw Error("network forbidden"); }) as typeof fetch;');
    const input = { action: 'closed', repository: { full_name: 'other/frontend' }, issue: { node_id: 'I_119', closed_at: when } };
    writeFileSync(`${dir}/event.json`, JSON.stringify(input));
    for (const [event, repo, code] of [['pull_request', 'other/frontend', 0], ['issues', 'other/frontend', 1], ['issues', `${org}/frontend`, 1]] as const) {
      const child = Bun.spawnSync([process.execPath, '--preload', `${dir}/deny.ts`, 'scripts/issue-status.ts'], {
        cwd: `${import.meta.dir}/..`, env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: `${dir}/event.json`, GITHUB_EVENT_NAME: event, GITHUB_REPOSITORY: repo, ADD_TO_PROJECT_PAT: 'test-token' },
      });
      expect(child.exitCode).toBe(code);
      expect(child.stdout.toString() + child.stderr.toString()).not.toContain('NETWORK_CALLED');
      expect(child.stderr.toString()).not.toContain('test-token');
    }
    const imported = Bun.spawnSync([process.execPath, '--preload', `${dir}/deny.ts`, '-e', 'await import("./scripts/issue-status.ts")'], {
      cwd: `${import.meta.dir}/..`, env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'issues', GITHUB_EVENT_PATH: '/missing' },
    });
    expect(imported.exitCode).toBe(0);
    expect(imported.stdout.toString()).toBe('');
  } finally { rmSync(dir, { recursive: true }); }
});


test('GitHub may record ClosedEvent one second after issue.closedAt', async () => {
  const f = fixture();
  f.events[0].createdAt = '2026-11-04T18:29:48Z';
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('changed');
  expect(f.writes).toEqual([{ item: 'card-119', status: 'Ready for build' }]);
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('unchanged');
});

test('later timeline timestamp does not let an old payload write a new closure', async () => {
  const f = fixture();
  f.issue.closedAt = '2026-11-04T19:00:00Z';
  f.events[0].createdAt = '2026-11-04T19:00:01Z';
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('skipped');
  expect(f.writes).toEqual([]);
});
