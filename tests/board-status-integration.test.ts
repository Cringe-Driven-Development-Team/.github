import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { reconcileClosedIssue, reconcileMergedPullRequest } from '../scripts/issue-status.ts';

const frontendDir = process.env.FRONTEND_DIR;
if (!frontendDir?.startsWith('/')) throw Error('Set FRONTEND_DIR to the absolute frontend checkout path');
const { updateReleaseBoard } = await import(`${frontendDir}/scripts/release/board.ts`);
const { recoverReleaseBoard } = await import(`${frontendDir}/scripts/release/recovery.ts`);
const { readChangeReport } = await import(`${frontendDir}/scripts/release/report.ts`);
const { fixture, REPO } = await import(`${frontendDir}/scripts/release/test/fixture.ts`);
const owner = 'Cringe-Driven-Development-Team';
const when = '2026-11-01T01:00:00Z';
const after = '2026-11-01T04:00:00Z';
const page = (nodes: any[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
let f: ReturnType<typeof fixture>;
let intercept: ((url: URL, body: any, init?: RequestInit) => Response | undefined) | undefined;
let warn: ReturnType<typeof spyOn>;
let expectedWarnings: string[];

beforeEach(() => {
  f = fixture();
  f.issues.delete(1); f.issues.delete(3);
  f.issues.get(2)!.card = { id: 'C2', status: 'In review', updatedAt: '2026-10-31T00:00:00Z' };
  f.publish();
  intercept = undefined;
  expectedWarnings = [];
  warn = spyOn(console, 'warn').mockImplementation(() => {});
  const pr = (number: number) => ({ ...f.prs.get(number), repository: { nameWithOwner: REPO, defaultBranchRef: { name: 'main', target: { oid: f.main } } } });
  // Both implementations share one state; only GitHub HTTP responses are replaced.
  f.extra = (url, body, init) => {
    const override = intercept?.(url, body, init);
    if (override) return override;
    if (url.pathname !== '/graphql') return;
    const query = String(body.query), v = body.variables;
    if (query.includes('BoardCard') && f.issues.get(2)!.card.status === '') return Response.json({ data: { node: { projectItems: page([{ id: 'C2', project: { id: 'P' }, fieldValueByName: null }]) } } });
    if (!/IssueStatus/.test(query)) return;
    const issue = f.issues.get(Number(String(v.id).slice(1)));
    if (query.includes('IssueStatusPullRequest')) return Response.json({ data: { repository: {
      nameWithOwner: REPO, defaultBranchRef: { name: 'main', target: { oid: f.main } },
      pullRequest: { ...pr(v.number), closingIssuesReferences: page([...f.issues.values()].filter(i => i.prs.includes(v.number)).map(i => ({ id: i.id, number: i.number, repository: { nameWithOwner: REPO } }))) },
    } } });
    if (query.includes('IssueStatusLinks')) return Response.json({ data: { node: { closedByPullRequestsReferences: page(issue!.prs.map(pr)) } } });
    if (query.includes('IssueStatusIssue')) return Response.json({ data: { node: {
      __typename: 'Issue', id: issue!.id, closed: issue!.state === 'closed', closedAt: issue!.state === 'closed' ? after : null,
      stateReason: issue!.state_reason?.toUpperCase() ?? null, repository: { nameWithOwner: REPO },
      timelineItems: page(issue!.events.map(event => ({ ...event, __typename: event.kind }))),
    } } });
    if (query.includes('IssueStatusCards')) return Response.json({ data: { node: { projectItems: page([{
      id: issue!.card.id, project: { id: 'P', number: 1, owner: { login: owner } },
      fieldValueByName: issue!.card.status ? { name: issue!.card.status, updatedAt: issue!.card.updatedAt } : null,
    }]) } } });
    if (query.includes('IssueStatusProject')) return Response.json({ data: { organization: { projectV2: {
      id: 'P', viewerCanUpdate: true, fields: page([{ id: 'F', name: 'Status', options: ['Ready for build', 'Done'].map(name => ({ id: name, name })) }]),
    } } } });
    if (query.includes('IssueStatusUpdate')) {
      const item = f.issues.get(Number(v.item.slice(1)))!;
      item.card.status = v.option; item.card.updatedAt = after;
      f.writes.push({ kind: 'status', issue: item.number, status: v.option });
      return Response.json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: v.item } } } });
    }
    throw Error(`Unexpected shared query ${query}`);
  };
});
afterEach(() => {
  try { expect(warn.mock.calls).toEqual(expectedWarnings.map(message => [message])); }
  finally { warn.mockRestore(); f.restore(); }
});
const input = () => ({ repository: REPO, issueId: 'I2', closedAt: after });
const closed = () => reconcileClosedIssue(input(), 'project-token');
const merge = async () => {
  const result = await reconcileMergedPullRequest({ repository: REPO, number: 2 }, 'project-token');
  expect(result.errors).toEqual([]);
  return result;
};
const report = () => readChangeReport(REPO, f.root, f.b);
function production(...args: Parameters<typeof f.production>) {
  const id = f.production(...args);
  // CD closes at 04:00; subsequent operations must have strictly later success timestamps.
  f.deployments[0]!.created_at = `2026-11-01T0${id + 3}:00:00Z`;
  return id;
}
async function board(kind: 'publish' | 'deploy' | 'rollback', id?: number) {
  const result = await updateReleaseBoard(kind, await report(), id);
  expectedWarnings.push(...result.errors);
  expect(result.errors).toEqual([]);
  return result;
}
function pair(state: string, status: string) {
  const issue = f.issues.get(2)!;
  expect([issue.state, issue.card.status]).toEqual([state, status]);
}
function manuallyClose(reason = 'completed') {
  const issue = f.issues.get(2)!;
  issue.state = 'closed'; issue.state_reason = reason;
  issue.events.push({ kind: 'ClosedEvent', createdAt: after, closer: null });
}

test('merge → publish → deploy → rollback → deploy survives delayed events without reopening', async () => {
  expect((await merge()).changed).toBe(1); pair('open', 'Ready for build');
  await board('publish'); pair('open', 'Ready for release');
  await merge(); pair('open', 'Ready for release');
  expect(await closed()).toBe('skipped');
  expect(f.writes.filter(w => w.kind === 'close')).toHaveLength(0);
  const deploy = production();
  await board('deploy', deploy); pair('closed', 'Done');
  expect(await closed()).toBe('unchanged');
  await merge(); await board('publish'); pair('closed', 'Done');
  const rollback = production('rollback', f.root, f.b);
  await board('rollback', rollback); pair('closed', 'Rollback from production');
  await closed(); await merge(); await board('publish'); await board('deploy', deploy);
  pair('closed', 'Rollback from production');
  await board('deploy', production()); pair('closed', 'Done');
  await closed(); await board('rollback', rollback); pair('closed', 'Done');
  expect(f.writes.filter(w => w.kind === 'close')).toHaveLength(1);
  expect(f.writes.filter(w => w.kind === 'reopen')).toHaveLength(0);
});

test('close 403 then Project 503 recover using original ID after B→B→C', async () => {
  await merge(); await board('publish');
  const id = production();
  intercept = (url, _body, init) => url.pathname.endsWith('/issues/2') && init?.method === 'PATCH' ? new Response('denied', { status: 403 }) : undefined;
  const first = await updateReleaseBoard('deploy', await report(), id);
  expectedWarnings.push(...first.errors);
  expect(first.errors).toHaveLength(1); expect(first.errors[0]).toContain('403');
  pair('open', 'Ready for release');
  intercept = (_url, body) => body?.query?.includes('UpdateReleaseStatus') ? new Response('unavailable', { status: 503 }) : undefined;
  const second = await updateReleaseBoard('deploy', await report(), id);
  expectedWarnings.push(...second.errors);
  expect(second.errors).toHaveLength(1); expect(second.errors[0]).toContain('503');
  pair('closed', 'Ready for release');
  intercept = undefined;
  production('deploy', f.b, f.b); production('deploy', f.c, f.b);
  expect((await recoverReleaseBoard(id)).errors).toEqual([]); pair('closed', 'Done');
  await closed(); await merge(); await board('publish'); pair('closed', 'Done');
  expect(f.writes.filter(w => w.kind === 'close')).toHaveLength(1);
});

test('manual completed retains Done across unrelated B→B→C', async () => {
  manuallyClose();
  expect(await closed()).toBe('changed'); pair('closed', 'Done');
  production('deploy', f.b, f.b); production('deploy', f.c, f.b);
  f.issues.get(2)!.card.status = 'In review';
  expect(await closed()).toBe('changed'); pair('closed', 'Done');
  await board('publish'); pair('closed', 'Done');
  expect(f.writes.filter(w => w.kind === 'close' || w.kind === 'reopen')).toHaveLength(0);
});

test('manual completed participates in rollback only after a confirmed CD', async () => {
  manuallyClose(); await closed();
  await board('rollback', production('rollback', f.root, f.b)); pair('closed', 'Done');
  await board('deploy', production());
  await board('rollback', production('rollback', f.root, f.b)); pair('closed', 'Rollback from production');
  await closed(); pair('closed', 'Rollback from production');
  expect(f.writes.filter(w => w.kind === 'close' || w.kind === 'reopen')).toHaveLength(0);
});

test.each(['not_planned', 'duplicate'])('manual %s is untouched by merge and release operations', async reason => {
  manuallyClose(reason); await closed(); pair('closed', 'Done');
  await merge(); await board('publish'); await board('deploy', production());
  await board('rollback', production('rollback', f.root, f.b)); pair('closed', 'Done');
  expect(f.writes).toEqual([{ kind: 'status', issue: 2, status: 'Done' }]);
});

test('manual reopen after merge protects the issue from all delayed operations', async () => {
  f.issues.get(2)!.events.push({ kind: 'ReopenedEvent', createdAt: after });
  await merge(); await board('publish'); await board('deploy', production()); await closed();
  pair('open', 'In review'); expect(f.writes).toEqual([]);
});

test('native linked PR pagination protects against a newer merge on its last page', async () => {
  f.prs.set(4, { ...f.prs.get(2)!, number: 4, mergeCommit: { oid: f.c } });
  intercept = (_url, body) => {
    if (!/IssueStatusLinks|MergedIssuePullRequests/.test(String(body?.query))) return;
    const cursor = body.variables.cursor;
    const pr = { ...f.prs.get(cursor ? 4 : 2), repository: { nameWithOwner: REPO, defaultBranchRef: { name: 'main', target: { oid: f.main } } } };
    return Response.json({ data: { node: { repository: pr.repository, closedByPullRequestsReferences: { nodes: [pr], pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : 'next' } } } } });
  };
  await merge(); await board('publish'); await board('deploy', production());
  expect(f.writes).toEqual([]); pair('open', 'In review');
});

test('clear succeeds but set fails, then retry repairs the empty Status', async () => {
  const issue = f.issues.get(2)!;
  issue.card.status = 'Ready for release';
  intercept = (_url, body) => {
    if (!body?.query?.includes('UpdateReleaseStatus')) return;
    expect(body.variables.reset).toBe(true);
    issue.card.status = '';
    return Response.json({ errors: [{ message: 'set failed after clear' }] });
  };
  const result = await updateReleaseBoard('publish', await report()); expectedWarnings.push(...result.errors);
  expect(result.errors).toHaveLength(1); expect(issue.card.status).toBe('');
  intercept = undefined;
  await board('publish'); pair('open', 'Ready for release');
});

test('same Status from older cycle must obtain a confirmed current timestamp', async () => {
  const issue = f.issues.get(2)!; issue.card.status = 'Ready for release';
  let resets = 0;
  intercept = (_url, body) => {
    if (body?.query?.includes('UpdateReleaseStatus')) { expect(body.variables.reset).toBe(true); resets++; }
  };
  await board('publish'); expect(resets).toBe(1);
  await merge(); await board('publish'); expect(resets).toBe(1);
});

test('unconfirmed timestamp is reported rather than accepted as success', async () => {
  f.issues.get(2)!.card.status = 'Ready for release';
  intercept = (_url, body) => body?.query?.includes('UpdateReleaseStatus') ? Response.json({ data: {
    clearProjectV2ItemFieldValue: { projectV2Item: { id: 'C2' } }, updateProjectV2ItemFieldValue: { projectV2Item: { id: 'C2' } },
  } }) : undefined;
  const result = await updateReleaseBoard('publish', await report()); expectedWarnings.push(...result.errors);
  expect(result.errors).toHaveLength(1); expect(result.errors[0]).toContain('Нет подтверждения Status');
});

test('all real workflow writers use the same non-replacing release-board queue', async () => {
  const shared: any = Bun.YAML.parse(await Bun.file(`${import.meta.dir}/../.github/workflows/add-to-project.yml`).text());
  const configs = [shared.jobs['issue-status'].concurrency];
  for (const [name, job] of [['ci', 'publish'], ['cd', 'cd'], ['rollback', 'rollback'], ['reconcile-issues', 'reconcile']]) {
    const workflow: any = Bun.YAML.parse(await Bun.file(`${frontendDir}/.github/workflows/${name}.yml`).text());
    configs.push(workflow.jobs[job].concurrency);
  }
  for (const config of configs) {
    const group = config.group.startsWith('${{') ? Function('github', `return (${config.group.replace(/^\$\{\{\s*|\s*\}\}$/g, '')});`)({ repository: REPO }) : config.group;
    expect(group).toBe('release-board'); expect(config.queue).toBe('max'); expect(config['cancel-in-progress']).toBe(false);
  }
});
