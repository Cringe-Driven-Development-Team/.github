import { expect, test } from 'bun:test';
import { createProjects, currentIteration } from '../src/projects';
import type { Issue } from '../src/github';
import { config } from './fixtures';

const owner = 'Cringe-Driven-Development-Team';
const iterations = [
  { id: 's8', title: 'Sprint 8', startDate: '2026-11-02', duration: 7 },
  { id: 's9', title: 'Sprint 9', startDate: '2026-11-09', duration: 7 },
];
const now = new Date('2026-11-07T00:00:00Z');
const issue: Issue = { ref: { repo: 'backend', number: 7, url: `https://github.com/${owner}/backend/issues/7` }, nodeId: 'issue7', title: 'Backend. Test', state: 'CLOSED', assignees: ['octo'] };
const fields = [
  { __typename: 'ProjectV2SingleSelectField', id: 'status', name: 'Status', options: [{ id: 'backlog', name: 'Backlog' }] },
  { __typename: 'ProjectV2IterationField', id: 'sprint', name: 'Sprint', configuration: { iterations: [iterations[1]], completedIterations: [iterations[0]] } },
];

// Stateful API boundary: mutations alter the next read, including an external Status edit.
function api(options: { absent?: boolean; status?: string | null; external?: boolean; iterations?: typeof iterations; paginated?: boolean; badReadback?: boolean } = {}) {
  let present = !options.absent, status = options.status === undefined ? 'In progress' : options.status, sprint: string | null = 'old';
  const writes: { query: string; variables: Record<string, any> }[] = [];
  const reads: { query: string; variables: Record<string, any> }[] = [];
  const fetcher = (async (_input: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const { query, variables } = request;
    if (query.startsWith('mutation')) {
      writes.push(request);
      if (query.includes('addProjectV2ItemById')) { present = true; return Response.json({ data: { addProjectV2ItemById: { item: { id: 'item7' } } } }); }
      if (query.includes('clearProjectV2ItemFieldValue')) sprint = null;
      else if (variables.field === 'status') status = 'Backlog';
      else if (!options.badReadback) { sprint = variables.value.iterationId; if (options.external) status = 'Review'; }
      return Response.json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item7' } }, clearProjectV2ItemFieldValue: { projectV2Item: { id: 'item7' } } } });
    }
    reads.push(request);
    const nodes = present ? [{ id: 'item7', isArchived: false,
      content: { __typename: 'Issue', id: issue.nodeId, number: 7, title: issue.title, url: issue.ref.url, state: issue.state, repository: { nameWithOwner: `${owner}/backend` }, assignees: { nodes: [{ login: 'octo' }] } },
      sprint: sprint === null ? null : { iterationId: sprint }, status: status === null ? null : { name: status } }] : [];
    const configuredFields = options.iterations ? [fields[0], { ...fields[1], configuration: { iterations: options.iterations, completedIterations: [] } }] : fields;
    const connection = (nodes: unknown[], cursor: unknown) => options.paginated && !cursor
      ? { nodes: nodes.slice(0, 1), pageInfo: { hasNextPage: true, endCursor: 'page2' } }
      : { nodes: options.paginated ? nodes.slice(1) : nodes, pageInfo: { hasNextPage: false, endCursor: null } };
    const garbage = [null, { id: 'pr', isArchived: false, content: { __typename: 'PullRequest' } }, { id: 'draft', isArchived: false, content: { __typename: 'DraftIssue' } }, { id: 'null', isArchived: false, content: null }];
    return Response.json({ data: { organization: { projectV2: { id: 'project',
      fields: connection(configuredFields, variables.fieldsCursor), items: connection([...garbage, ...nodes], variables.itemsCursor) } } } });
  }) as typeof fetch;
  return { projects: createProjects(config(), fetcher), writes, reads };
}

test('Moscow calendar determines the unique current iteration at midnight', () => {
  expect(currentIteration(iterations, new Date('2026-11-08T20:59:59Z')).title).toBe('Sprint 8');
  expect(currentIteration(iterations, new Date('2026-11-08T21:00:00Z')).title).toBe('Sprint 9');
  expect(() => currentIteration([], now)).toThrow();
  expect(() => currentIteration([iterations[0]!, { ...iterations[0]!, id: 'overlap' }], now)).toThrow();
});

test('reads every fields/items page, completed iterations and only Issues', async () => {
  const fake = api({ paginated: true });
  const board = await fake.projects.readBoard();
  expect(board).toMatchObject({ id: 'project', sprintFieldId: 'sprint', statusFieldId: 'status', backlogOptionId: 'backlog' });
  expect(board.items).toHaveLength(1);
  expect(board.items[0]!.issue).toEqual(issue);
  expect(board.iterations).toHaveLength(2);
  expect(fake.reads.some(r => r.variables.fieldsCursor === 'page2')).toBe(true);
  expect(fake.reads.some(r => r.variables.itemsCursor === 'page2')).toBe(true);
});

test('initialize reuses existing item, writes Backlog, clears Sprint and verifies by read', async () => {
  const fake = api();
  expect(await fake.projects.initializeIssue(issue)).toMatchObject({ id: 'item7', status: 'Backlog', sprintId: null });
  expect(fake.writes).toHaveLength(2);
  expect(fake.writes.some(w => w.query.includes('addProjectV2ItemById'))).toBe(false);
  expect(fake.reads.length).toBeGreaterThanOrEqual(2);
});

for (const status of ['In progress', null]) test(`tosprint moves a closed Issue and preserves Status ${status}`, async () => {
  const fake = api({ status });
  expect(await fake.projects.toCurrentSprint(issue, now)).toMatchObject({ item: { sprintId: 's8', status }, iteration: iterations[0], statusChangedExternally: false });
  expect(fake.writes).toHaveLength(1);
  expect(fake.writes[0]!.variables).toMatchObject({ field: 'sprint', value: { iterationId: 's8' } });
});

test('reports external Status change without restoring it', async () => {
  const fake = api({ external: true });
  expect(await fake.projects.toCurrentSprint(issue, now)).toMatchObject({ item: { status: 'Review' }, statusChangedExternally: true });
  expect(fake.writes).toHaveLength(1);
});

test('adds missing membership only after resolving a unique current Sprint', async () => {
  for (const its of [[], [iterations[0]!, { ...iterations[0]!, id: 'overlap' }]]) {
    const fake = api({ absent: true, iterations: its });
    await expect(fake.projects.toCurrentSprint(issue, now)).rejects.toThrow();
    expect(fake.writes).toHaveLength(0);
  }
  const fake = api({ absent: true, status: null });
  expect(await fake.projects.toCurrentSprint(issue, now)).toMatchObject({ item: { id: 'item7', status: null, sprintId: 's8' } });
  expect(fake.writes).toHaveLength(2);
  expect(fake.writes[0]!.query).toContain('addProjectV2ItemById');
});

test('fails when Sprint readback differs', async () => {
  await expect(api({ badReadback: true }).projects.toCurrentSprint(issue, now)).rejects.toThrow();
});

test('HTTP 200 GraphQL errors reject instead of accepting partial data', async () => {
  const projects = createProjects(config(), (async () => Response.json({ data: {}, errors: [{ message: 'Forbidden' }] })) as unknown as typeof fetch);
  await expect(projects.readBoard()).rejects.toMatchObject({ provider: 'github', kind: 'rejected' });
});

test('non-JSON rate and permission failures preserve their HTTP classification', async () => {
  for (const [status, kind] of [[429, 'retryable'], [403, 'rejected']] as const) {
    const projects = createProjects(config(), (async () => new Response('upstream error', { status, headers: status === 429 ? { 'retry-after': '2' } : {} })) as unknown as typeof fetch);
    await expect(projects.readBoard()).rejects.toMatchObject({ provider: 'github', kind, ...(status === 429 ? { retryAfterMs: 2000 } : {}) });
  }
});
