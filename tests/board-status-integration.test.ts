import { afterEach, beforeEach, expect, test } from 'bun:test';
import { reconcileClosedIssue } from '../scripts/issue-status.ts';

const frontendDir = process.env.FRONTEND_DIR;
if (!frontendDir?.startsWith('/')) throw Error('Set FRONTEND_DIR to the absolute frontend checkout path');
const { syncBoard } = await import(`${frontendDir}/scripts/release/board.ts`);
const { readReleaseSnapshot } = await import(`${frontendDir}/scripts/release/catalog.ts`);
const { fixture, REPO } = await import(`${frontendDir}/scripts/release/test/fixture.ts`);
const shared: any = Bun.YAML.parse(await Bun.file(`${import.meta.dir}/../.github/workflows/add-to-project.yml`).text());
const boardWorkflow: any = Bun.YAML.parse(await Bun.file(`${frontendDir}/.github/workflows/release-status.yml`).text());
const closeConfig = shared.jobs['issue-status'].concurrency;
const boardConfig = boardWorkflow.jobs.board.concurrency;
const closeGroup = Function('github', `return (${closeConfig.group.replace(/^\$\{\{\s*|\s*\}\}$/g, '')});`)({ repository: REPO });
const when = '2026-11-01T01:00:00Z';
const after = '2026-11-01T04:00:00Z';
let f: ReturnType<typeof fixture>;
let cards: Map<number, any>;
let writes: { issue: number; status: string }[];
let pauseClose: (() => Promise<void>) | undefined;
let fail = false;
let failSet = false;
let staleTimestamp = false;
let resets = 0;
const input = (number: number, closedAt = when) => ({ repository: REPO, issueId: `I${number}`, closedAt });
const page = (nodes: any[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } });

beforeEach(() => {
  f = fixture(); f.publish();
  process.env.GITHUB_STEP_SUMMARY = `${f.dir}/summary.md`;
  cards = new Map([1, 2, 3].map(number => [number, { closed: true, closedAt: when, reason: 'COMPLETED', closer: number, status: { name: 'In review', updatedAt: '2026-10-31T00:00:00Z' } }]));
  writes = []; pauseClose = undefined; fail = false; failSet = false; staleTimestamp = false; resets = 0;
  f.extra = async (url: URL, body: any) => {
    if (url.pathname !== '/graphql' || String(body?.query).includes('LinkedIssues')) return;
    const query = String(body.query); const v = body.variables;
    if (fail) return new Response('unavailable', { status: 503 });
    if (query.includes('IssueStatusProject') || query.includes('ReleaseProject')) return Response.json({ data: { organization: { projectV2: {
      id: 'P', viewerCanUpdate: true, fields: page([{ id: 'F', name: 'Status', options: ['Ready for build', 'Ready for release', 'Done'].map(name => ({ id: name, name })) }]),
    } } } });
    if (query.includes('mutation')) {
      if (query.includes('IssueStatusUpdate')) await pauseClose?.();
      const number = Number(v.item.slice(1));
      if (v.reset) {
        resets++;
        cards.get(number).status = null;
        if (failSet) return Response.json({ errors: [{ message: 'set failed after clear' }] });
      }
      // A same-option no-op need not update GitHub's timestamp.
      if (cards.get(number).status?.name !== v.option) cards.get(number).status = { name: v.option, updatedAt: staleTimestamp ? '2026-10-31T00:00:00Z' : after };
      writes.push({ issue: number, status: v.option });
      return Response.json({ data: { clearProjectV2ItemFieldValue: v.reset ? { projectV2Item: { id: v.item } } : undefined, updateProjectV2ItemFieldValue: { projectV2Item: { id: v.item } } } });
    }
    const number = Number(v.id.slice(1)); const state = cards.get(number);
    if (!state) throw Error(`Unexpected issue ${v.id}`);
    if (query.includes('IssueStatusIssue') || query.includes('BoardIssue')) {
      const closer = state.closer === null ? null : {
        __typename: 'PullRequest', kind: 'PullRequest', number: state.closer, merged: true, baseRefName: 'main',
        repository: { nameWithOwner: REPO, defaultBranchRef: { name: 'main' } },
      };
      return Response.json({ data: { node: {
        __typename: 'Issue', id: v.id, closed: state.closed, closedAt: state.closedAt, stateReason: state.reason, title: 'Без префикса', repository: { nameWithOwner: REPO },
        timelineItems: page([{ __typename: 'ClosedEvent', kind: 'ClosedEvent', createdAt: state.closedAt, closer }]),
      } } });
    }
    if (query.includes('IssueStatusCards') || query.includes('BoardCard')) return Response.json({ data: { node: { projectItems: page([{
      id: `C${number}`, project: { id: 'P', number: 1, owner: { login: 'Cringe-Driven-Development-Team' } }, fieldValueByName: state.status,
    }]) } } });
    throw Error(`Unexpected query ${query}`);
  };
});
afterEach(() => f.restore());

// Models group exclusion, not GitHub's implementation or its hosted queue capacity.
function scheduler() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(group: string, work: () => Promise<T>): Promise<T> => {
    const promise = (tails.get(group) ?? Promise.resolve()).then(work);
    tails.set(group, promise.catch(() => {}));
    return promise;
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function board() {
  const result = await syncBoard(await readReleaseSnapshot(f.dir), f.dir);
  expect(result.errors).toEqual([]);
}
async function overlapping(group: string) {
  const schedule = scheduler(); const reachedWrite = deferred(); const allowWrite = deferred();
  pauseClose = async () => { reachedWrite.resolve(); await allowWrite.promise; };
  const close = schedule(closeGroup, () => reconcileClosedIssue(input(2), 'project-token'));
  await reachedWrite.promise;
  let boardEntered = false;
  const reconcile = schedule(group, async () => { boardEntered = true; await board(); });
  // A microtask turn lets an unlocked Board enter; a locked Board cannot start.
  await Promise.resolve(); await Promise.resolve();
  const overlapped = boardEntered;
  if (overlapped) await reconcile;
  allowWrite.resolve();
  await Promise.all([close, reconcile]);
  return overlapped;
}

test.each([false, true])('actual workflow groups serialize close and Board (production=%s)', async deployed => {
  if (deployed) f.deploy(f.b);
  expect(await overlapping(boardConfig.group)).toBe(false);
  expect(cards.get(2).status.name).toBe(deployed ? 'Done' : 'Ready for release');
  const count = writes.length;
  expect(await reconcileClosedIssue(input(2), 'project-token')).toBe('unchanged');
  await board();
  expect(writes).toHaveLength(count);
});

test('different group fixture exposes the real read/write regression', async () => {
  const broken = { ...boardConfig, group: 'wrong-board-group' };
  expect(await overlapping(broken.group)).toBe(true);
  expect(writes.some(write => write.issue === 2 && write.status === 'Ready for release')).toBe(true);
  expect(cards.get(2).status.name).toBe('Ready for build');
});

test.each([false, true])('Board before delayed close preserves its result (production=%s)', async deployed => {
  if (deployed) f.deploy(f.b);
  await board();
  const count = writes.length;
  expect(await reconcileClosedIssue(input(2), 'project-token')).toBe('unchanged');
  expect(cards.get(2).status.name).toBe(deployed ? 'Done' : 'Ready for release');
  expect(writes).toHaveLength(count);
});

test('three different closures use a non-replacing queue and all complete', async () => {
  expect(closeConfig.queue).toBe('max'); expect(closeConfig['cancel-in-progress']).toBe(false);
  expect(boardConfig.queue).toBe('max'); expect(boardConfig['cancel-in-progress']).toBe(false);
  const schedule = scheduler();
  expect(await Promise.all([1, 2, 3].map(number => schedule(closeGroup, () => reconcileClosedIssue(input(number), 'project-token'))))).toEqual(['changed', 'changed', 'changed']);
  expect(writes).toEqual([1, 2, 3].map(issue => ({ issue, status: 'Ready for build' })));
});

test('old closure cannot write a new cycle; manual close remains Done through Board', async () => {
  const state = cards.get(2);
  state.closed = false;
  expect(await reconcileClosedIssue(input(2), 'project-token')).toBe('skipped');
  state.closed = true; state.closedAt = after; state.closer = null;
  expect(await reconcileClosedIssue(input(2), 'project-token')).toBe('skipped');
  expect(await reconcileClosedIssue(input(2, after), 'project-token')).toBe('changed');
  await board();
  expect(writes.filter(write => write.issue === 2)).toEqual([{ issue: 2, status: 'Done' }]);
});

test('API failure rejects and rerun recovers without duplicate writes', async () => {
  fail = true;
  await expect(reconcileClosedIssue(input(2), 'project-token')).rejects.toThrow('HTTP 503');
  expect(writes).toEqual([]);
  fail = false;
  expect(await reconcileClosedIssue(input(2), 'project-token')).toBe('changed');
  expect(await reconcileClosedIssue(input(2), 'project-token')).toBe('unchanged');
  expect(writes).toEqual([{ issue: 2, status: 'Ready for build' }]);
});


test.each([false, true])('Board confirms unchanged old status before delayed close (production=%s)', async deployed => {
  if (deployed) f.deploy(f.b);
  const target = deployed ? 'Done' : 'Ready for release';
  cards.get(2).status = { name: target, updatedAt: '2026-10-31T00:00:00Z' };
  await board();
  expect(await reconcileClosedIssue(input(2), 'project-token')).toBe('unchanged');
  expect(cards.get(2).status.name).toBe(target);
  expect(resets).toBe(1);
  const count = writes.length;
  await board();
  expect(writes).toHaveLength(count);
});

test('failed set after clear is visible and rerun repairs the empty status', async () => {
  cards.get(2).status = { name: 'Ready for release', updatedAt: '2026-10-31T00:00:00Z' };
  failSet = true;
  expect((await syncBoard(await readReleaseSnapshot(f.dir), f.dir)).errors.length).toBeGreaterThan(0);
  expect(cards.get(2).status).toBeNull();
  failSet = false;
  await board();
  expect(cards.get(2).status.name).toBe('Ready for release');
  expect(await reconcileClosedIssue(input(2), 'project-token')).toBe('unchanged');
});

test('Board reports an unconfirmed current-cycle timestamp after reset', async () => {
  cards.get(2).status = { name: 'Ready for release', updatedAt: '2026-10-31T00:00:00Z' };
  staleTimestamp = true;
  const result = await syncBoard(await readReleaseSnapshot(f.dir), f.dir);
  expect(result.errors.join()).toContain('Status');
});
