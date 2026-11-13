import { afterEach, expect, test } from 'bun:test';
import { reconcileClosedIssue, reconcileMergedPullRequest } from '../scripts/issue-status.ts';
const merge = reconcileMergedPullRequest;

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
  const state = { input, issue, events, card, fields, project, writes, cards: [card], paged: false, beforeRead: (_: number) => {}, error: '', production: [] as any[], productionState: 'success', productionStatuses: {} as Record<number, {state: string; created_at: string}>, linkedPRs: [] as any[] };
  const page = (nodes: any[], cursor: string | null) => state.paged && !cursor
    ? { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page2' } }
    : { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('/deployments') || String(url).includes('/compare/')) {
      expect(init.headers.Authorization).toBe('Bearer test-token');
      if (String(url).includes('/statuses')) {
        const id = Number(String(url).match(/deployments\/(\d+)\/statuses/)?.[1]);
        return Response.json([state.productionStatuses[id] ?? {state: state.productionState, created_at: '2026-11-05T00:00:00Z'}]);
      }
      if (String(url).includes('/compare/')) {
        const [base, head] = String(url).split('/compare/')[1].split('?')[0].split('...');
        const present = head >= base;
        return Response.json({status: present ? 'ahead' : 'behind', base_commit: {sha: base}, merge_base_commit: {sha: present ? base : head}});
      }
      const pageIndex = Number(new URL(String(url)).searchParams.get('page') ?? '1') - 1;
      return Response.json(state.production.slice(pageIndex * 100, (pageIndex + 1) * 100));
    }
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
    if (query.includes('IssueStatusLinks')) return Response.json({ data: { node: { closedByPullRequestsReferences: page(state.linkedPRs, v.cursor) } } });
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
  ['frontend', 'merge', 'Done'], ['backend', 'merge', 'Done'], ['infra', 'merge', 'Done'],
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
  expect(f.writes[0].status).toBe('Done');
});

test('manual completed before CD becomes Done even if a linked PR exists', async () => {
  const f = fixture(); f.events[0].closer = null;
  f.linkedPRs.push({number: 22, merged: true, mergedAt: when, baseRefName: 'main', mergeCommit: {oid: 'b'.repeat(40)}, repository: {nameWithOwner: `${org}/frontend`, defaultBranchRef: {name: 'main', target: {oid: 'c'.repeat(40)}}}});
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('changed');
  expect(f.writes).toEqual([{ item: 'card-119', status: 'Done' }]);
});

test('late closed after a confirmed rollback cannot overwrite Rollback', async () => {
  const f = fixture(); f.events[0].closer = null;
  f.card.fieldValueByName = { name: 'Rollback from production', updatedAt: '2026-11-03T00:00:00Z' };
  f.production = [{ id: 44, environment: 'production', task: 'rollback', sha: 'a'.repeat(40), created_at: '2026-11-05T00:00:00Z', payload: { action: 'rollback', notification: {base_sha: 'c'.repeat(40)} } }];
  f.linkedPRs.push({number: 22, merged: true, mergedAt: when, baseRefName: 'main', mergeCommit: {oid: 'b'.repeat(40)}, repository: {nameWithOwner: `${org}/frontend`, defaultBranchRef: {name: 'main', target: {oid: 'c'.repeat(40)}}}});
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('skipped');
  expect(f.writes).toEqual([]);
});

test.each([false, true])('unrelated production never suppresses manual completed, linked=%s', async linked => {
  const f = fixture(); f.events[0].closer = null;
  if (linked) f.linkedPRs.push({number: 22, merged: true, mergedAt: when, baseRefName: 'main', mergeCommit: {oid: 'b'.repeat(40)}, repository: {nameWithOwner: `${org}/frontend`, defaultBranchRef: {name: 'main', target: {oid: 'c'.repeat(40)}}}});
  f.production = [{id: 45, environment: 'production', task: 'deploy', sha: 'a'.repeat(40), created_at: '2026-11-05T00:00:00Z', payload: {action: 'deploy', notification: {base_sha: 'a'.repeat(40)}}}];
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('changed');
  expect(f.card.fieldValueByName.name).toBe('Done');
});

test('late closed preserves rollback after a later unrelated CD retaining its effect', async () => {
  const f = fixture(); f.events[0].closer = null;
  f.card.fieldValueByName = {name: 'Rollback from production', updatedAt: when};
  f.linkedPRs.push({number: 22, merged: true, mergedAt: when, baseRefName: 'main', mergeCommit: {oid: 'b'.repeat(40)}, repository: {nameWithOwner: `${org}/frontend`, defaultBranchRef: {name: 'main', target: {oid: 'c'.repeat(40)}}}});
  f.production = [
    {id: 45, environment: 'production', task: 'deploy', sha: 'a'.repeat(40), created_at: '2026-11-05T00:00:00Z', payload: {action: 'deploy', notification: {base_sha: 'a'.repeat(40)}}},
    {id: 44, environment: 'production', task: 'rollback', sha: 'a'.repeat(40), created_at: '2026-11-05T00:00:00Z', payload: {action: 'rollback', notification: {base_sha: 'c'.repeat(40)}}},
  ];
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('skipped');
  expect(f.writes).toEqual([]);
});

test('old closed cannot undo rollback when a newer linked PR merged without reopen', async () => {
  const f = fixture(); f.events[0].closer = null;
  f.card.fieldValueByName = {name: 'Rollback from production', updatedAt: when};
  const pr = {number: 22, merged: true, mergedAt: when, baseRefName: 'main', mergeCommit: {oid: 'b'.repeat(40)}, repository: {nameWithOwner: `${org}/frontend`, defaultBranchRef: {name: 'main', target: {oid: 'c'.repeat(40)}}}};
  f.linkedPRs.push(pr, {...pr, number: 23, mergedAt: '2026-11-06T00:00:00Z', mergeCommit: {oid: 'c'.repeat(40)}});
  f.production = [{id: 44, environment: 'production', task: 'rollback', sha: 'a'.repeat(40), created_at: '2026-11-05T00:00:00Z', payload: {action: 'rollback', notification: {base_sha: 'b'.repeat(40)}}}];
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('skipped');
  expect(f.writes).toEqual([]);
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
  expect(f.writes).toEqual([{ item: 'card-119', status: 'Done' }]);
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('unchanged');
});

test('later timeline timestamp does not let an old payload write a new closure', async () => {
  const f = fixture();
  f.issue.closedAt = '2026-11-04T19:00:00Z';
  f.events[0].createdAt = '2026-11-04T19:00:01Z';
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('skipped');
  expect(f.writes).toEqual([]);
});

function mergeFixture() {
  const f = fixture();
  f.issue.closed = false; f.issue.closedAt = null; f.issue.stateReason = null; f.events.length = 0;
  const pr: any = { number: 22, merged: true, mergedAt: when, baseRefName: 'main', mergeCommit: { oid: 'b'.repeat(40) }, repository: { nameWithOwner: `${org}/frontend`, defaultBranchRef: { name: 'main', target: { oid: 'c'.repeat(40) } } } };
  const linked = { id: 'I_119', number: 119, repository: { nameWithOwner: `${org}/frontend` } };
  const state = { ...f, pr, refs: [linked], prs: [pr], prReads: 0, beforePR: (_: number) => {}, badCompare: false, errorIssue: false, closeRequests: [] as any[], pages: [] as string[] };
  const previousFetch = globalThis.fetch;
  const page = (nodes: any[], cursor: string | null) => state.paged && !cursor
    ? { nodes: nodes.slice(0, 1), pageInfo: { hasNextPage: true, endCursor: 'page2' } }
    : { nodes: state.paged ? nodes.slice(1) : nodes, pageInfo: { hasNextPage: false, endCursor: null } };
  globalThis.fetch = (async (url: any, init: any) => {
    if (init?.method === 'PATCH') { state.closeRequests.push(String(url)); throw Error('Must not close'); }
    if (String(url).includes('/compare/')) {
      const [base, head] = String(url).split('/compare/')[1].split('?')[0].split('...');
      const ahead = base === head || base === 'a'.repeat(40) || head === 'c'.repeat(40);
      return Response.json({ status: state.badCompare ? 'diverged' : ahead ? 'ahead' : 'behind', base_commit: { sha: base }, merge_base_commit: { sha: ahead ? base : head } });
    }
    if (String(url) !== 'https://api.github.com/graphql') return previousFetch(url, init);
    const {query, variables: v} = JSON.parse(init.body);
    if (query.includes('IssueStatusPullRequest')) {
      state.beforePR(++state.prReads);
      state.pages.push(`pr:${v.cursor}`);
      expect(v.number).toBe(22);
      return Response.json({ data: { repository: { nameWithOwner: pr.repository.nameWithOwner, defaultBranchRef: pr.repository.defaultBranchRef, pullRequest: { ...pr, closingIssuesReferences: page(state.refs, v.cursor) } } } });
    }
    if (query.includes('IssueStatusLinks')) {
      state.pages.push(`links:${v.cursor}`);
      if (state.errorIssue) return Response.json({ errors: [{ message: 'test-token' }] });
      return Response.json({ data: { node: { closedByPullRequestsReferences: page(state.prs, v.cursor) } } });
    }
    return previousFetch(url, init);
  }) as typeof fetch;
  return state;
}

test('merged default frontend PR advances open issue with no close request; retry is safe', async () => {
  const f = mergeFixture();
  expect(await merge({repository: `${org}/frontend`, number: 22}, 'test-token')).toEqual({changed: 1, skipped: 0, errors: []});
  expect(f.closeRequests).toEqual([]);
  expect(f.card.fieldValueByName.name).toBe('Ready for build');
  expect(await merge({repository: `${org}/frontend`, number: 22}, 'test-token')).toEqual({changed: 0, skipped: 1, errors: []});
});

test.each(['unmerged', 'foreign', 'topic', 'Part of', 'foreign issue', 'closed', 'not planned', 'reopened', 'latest merge', 'newer before write'])('merge skips %s', async kind => {
  const f = mergeFixture();
  if (kind === 'unmerged') f.pr.merged = false;
  if (kind === 'foreign') f.pr.repository.nameWithOwner = `${org}/backend`;
  if (kind === 'topic') f.pr.baseRefName = 'topic';
  if (kind === 'Part of') f.refs.length = 0;
  if (kind === 'foreign issue') f.refs[0].repository.nameWithOwner = `${org}/backend`;
  if (['closed', 'not planned'].includes(kind)) { f.issue.closed = true; f.issue.closedAt = when; f.issue.stateReason = kind === 'closed' ? 'COMPLETED' : 'NOT_PLANNED'; }
  if (kind === 'reopened') f.events.push({__typename: 'ReopenedEvent', createdAt: '2026-11-05T00:00:00Z'});
  if (kind === 'latest merge') f.prs.push({...f.pr, number: 23, mergeCommit: {oid: 'c'.repeat(40)}});
  if (kind === 'newer before write') f.beforePR = n => { if (n === 2) f.prs.push({...f.pr, number: 23, mergeCommit: {oid: 'c'.repeat(40)}}); };
  const result = await merge({repository: `${org}/frontend`, number: 22}, 'test-token');
  expect(result.changed).toBe(0); expect(result.errors).toEqual([]);
  expect(f.writes).toEqual([]); expect(f.closeRequests).toEqual([]);
});

test.each(['Ready for release', 'Done', 'Rollback from production'])('late merge preserves %s', async name => {
  const f = mergeFixture(); f.card.fieldValueByName = {name, updatedAt: when};
  expect((await merge({repository: `${org}/frontend`, number: 22}, 'test-token')).errors).toEqual([]);
  expect(f.writes).toEqual([]);
});

test('new merge after reopen starts a cycle despite an older Done; relations all paginate', async () => {
  const f = mergeFixture(); f.paged = true;
  f.refs.unshift({id: 'I_other', number: 7, repository: {nameWithOwner: `${org}/backend`}});
  f.events.push({__typename: 'ReopenedEvent', createdAt: '2026-11-03T00:00:00Z'});
  f.card.fieldValueByName = {name: 'Done', updatedAt: '2026-11-03T00:00:00Z'};
  expect(await merge({repository: `${org}/frontend`, number: 22}, 'test-token')).toEqual({changed: 1, skipped: 1, errors: []});
  expect(f.card.fieldValueByName.name).toBe('Ready for build');
  expect(f.pages).toContain('pr:page2'); expect(f.pages).toContain('links:page2');
});

test('failed linked issue is reported without revealing token', async () => {
  const f = mergeFixture(); f.errorIssue = true;
  const result = await merge({repository: `${org}/frontend`, number: 22}, 'test-token');
  expect(result.errors).toHaveLength(1); expect(result.errors.join()).not.toContain('test-token');
  expect(f.writes).toEqual([]);
});

test('newer native merge on a later page protects the issue from an older merge event', async () => {
  const f = mergeFixture(); f.paged = true;
  f.prs.push({...f.pr, number: 23, mergeCommit: {oid: 'c'.repeat(40)}});
  expect((await merge({repository: `${org}/frontend`, number: 22}, 'test-token')).changed).toBe(0);
  expect(f.writes).toEqual([]);
});

test('merge outside default history fails visibly without writing', async () => {
  const f = mergeFixture(); f.badCompare = true;
  await expect(merge({repository: `${org}/frontend`, number: 22}, 'test-token')).rejects.toThrow('Merge outside default branch');
  expect(f.writes).toEqual([]);
});

test('late closed reads all production pages before overwriting rollback', async () => {
  const f = fixture(); f.events[0].closer = null;
  f.card.fieldValueByName = {name: 'Rollback from production', updatedAt: when};
  f.linkedPRs.push({number: 22, merged: true, mergedAt: when, baseRefName: 'main', mergeCommit: {oid: 'b'.repeat(40)}, repository: {nameWithOwner: `${org}/frontend`, defaultBranchRef: {name: 'main', target: {oid: 'c'.repeat(40)}}}});
  f.production = Array.from({length: 100}, (_, n) => ({id: 200 - n, environment: 'production', task: 'deploy', sha: 'a'.repeat(40), created_at: '2026-11-05T00:00:00Z', payload: {action: 'deploy', notification: {base_sha: 'a'.repeat(40)}}}));
  f.production.push({id: 44, environment: 'production', task: 'rollback', sha: 'a'.repeat(40), created_at: '2026-11-05T00:00:00Z', payload: {action: 'rollback', notification: {base_sha: 'c'.repeat(40)}}});
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('skipped');
  expect(f.writes).toEqual([]);
});

function productionFixture() {
  const f = fixture(); f.events[0].closer = null;
  f.linkedPRs.push({number: 22, merged: true, mergedAt: when, baseRefName: 'main', mergeCommit: {oid: 'b'.repeat(40)}, repository: {nameWithOwner: `${org}/frontend`, defaultBranchRef: {name: 'main', target: {oid: 'c'.repeat(40)}}}});
  f.production.push({id: 44, environment: 'production', task: 'rollback', sha: 'a'.repeat(40), created_at: '2026-11-05T00:00:00Z', payload: {action: 'rollback', notification: {base_sha: 'c'.repeat(40)}}});
  return f;
}

test.each(['success', 'failure'])('manual completed ignores older legacy production %s before closure', async status => {
  const f = productionFixture(); f.productionState = status; f.input.closedAt = '2026-11-06T00:00:00Z';
  f.issue.closedAt = f.input.closedAt; f.events[0].createdAt = f.input.closedAt;
  f.production[0].payload = {action: 'deploy'};
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('changed');
  expect(f.card.fieldValueByName.name).toBe('Done');
});

test('invalid production payload never reflects secrets in errors', async () => {
  const f = productionFixture(); f.production[0].payload = 'test-token';
  let caught: unknown;
  try { await reconcileClosedIssue(f.input, 'test-token'); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).not.toContain('test-token');
  expect(f.writes).toEqual([]);
});

test('production proof rejects contradictory action and Git direction', async () => {
  const f = productionFixture(); f.production[0].task = 'deploy'; f.production[0].payload.action = 'deploy';
  await expect(reconcileClosedIssue(f.input, 'test-token')).rejects.toThrow('Invalid production direction');
  expect(f.writes).toEqual([]);
});

test.each(['pending', 'failure'])('unconfirmed latest production %s cannot justify a status write', async status => {
  const f = productionFixture(); f.productionState = status;
  await expect(reconcileClosedIssue(f.input, 'test-token')).rejects.toThrow('Latest production attempt is not success');
  expect(f.writes).toEqual([]);
});

test.each([['B→B', 'b'], ['B→C', 'c']])('unrelated later CD %s preserves manual completed → Done for a PR already in B', async (_, head) => {
  const f = productionFixture(); f.input.closedAt = '2026-11-06T00:00:00Z';
  f.issue.closedAt = f.input.closedAt; f.events[0].createdAt = f.input.closedAt;
  f.production = [
    {id: 45, environment: 'production', task: 'deploy', sha: head.repeat(40), created_at: '2026-11-07T00:00:00Z', payload: {action: 'deploy', notification: {base_sha: 'b'.repeat(40)}}},
    {id: 44, environment: 'production', task: 'deploy', sha: 'b'.repeat(40), created_at: '2026-11-05T00:00:00Z', payload: {action: 'deploy', notification: {base_sha: 'a'.repeat(40)}}},
  ];
  f.productionStatuses[45] = {state: 'success', created_at: '2026-11-07T00:00:00Z'};
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('changed');
  expect(f.writes).toEqual([{item: 'card-119', status: 'Done'}]);
});

test('unrelated later CD still searches an earlier relevant deploy after closure', async () => {
  const f = productionFixture();
  f.production = [
    {id: 45, environment: 'production', task: 'deploy', sha: 'b'.repeat(40), created_at: '2026-11-07T00:00:00Z', payload: {action: 'deploy', notification: {base_sha: 'b'.repeat(40)}}},
    {id: 44, environment: 'production', task: 'deploy', sha: 'b'.repeat(40), created_at: '2026-11-05T00:00:00Z', payload: {action: 'deploy', notification: {base_sha: 'a'.repeat(40)}}},
  ];
  f.productionStatuses[45] = {state: 'success', created_at: '2026-11-07T00:00:00Z'};
  expect(await reconcileClosedIssue(f.input, 'test-token')).toBe('skipped');
  expect(f.writes).toEqual([]);
});
