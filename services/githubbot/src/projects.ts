import type { Config } from './config';
import { ApiError, type Issue } from './github';

export interface Iteration { id: string; title: string; startDate: string; duration: number }
export interface ProjectItem { id: string; issue: Issue; archived: boolean; sprintId: string | null; status: string | null }
export interface Board {
  id: string; sprintFieldId: string; statusFieldId: string; backlogOptionId: string;
  iterations: Iteration[]; items: ProjectItem[];
}
export interface Projects {
  readBoard(): Promise<Board>;
  initializeIssue(issue: Issue): Promise<ProjectItem>;
  toCurrentSprint(issue: Issue, now: Date): Promise<{ item: ProjectItem; iteration: Iteration; statusChangedExternally: boolean }>;
}

const owner = 'Cringe-Driven-Development-Team';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fail = (message: string): never => { throw new ApiError('github', 'rejected', message); };
const text = (value: unknown): string => typeof value === 'string' && value ? value : fail('Invalid GitHub Projects response');
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail('Invalid GitHub Projects connection');
function calendarDay(date: string): number {
  const day = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) return fail('Invalid Sprint date');
  return day / 86_400_000;
}

export function currentIteration(iterations: Iteration[], now: Date): Iteration {
  if (!Number.isFinite(now.getTime())) return fail('Invalid current date');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  const today = calendarDay(`${part('year')}-${part('month')}-${part('day')}`);
  const current = iterations.filter(it => {
    if (!Number.isSafeInteger(it.duration) || it.duration <= 0) return fail('Invalid Sprint duration');
    const start = calendarDay(it.startDate);
    return start <= today && today < start + it.duration;
  });
  if (current.length !== 1) return fail('Не удалось определить единственный текущий Sprint.');
  return current[0]!;
}

const fieldsQuery = `query($fieldsCursor: String) { organization(login: "${owner}") { projectV2(number: 1) {
  id fields(first: 100, after: $fieldsCursor) { pageInfo { hasNextPage endCursor } nodes {
    __typename ... on ProjectV2Field { id name }
    ... on ProjectV2SingleSelectField { id name options { id name } }
    ... on ProjectV2IterationField { id name configuration {
      iterations { id title startDate duration } completedIterations { id title startDate duration }
    } }
  } }
} } }`;
const itemsQuery = `query($itemsCursor: String) { organization(login: "${owner}") { projectV2(number: 1) {
  id items(first: 100, after: $itemsCursor) { pageInfo { hasNextPage endCursor } nodes {
    id isArchived content { __typename ... on Issue {
      id number title url state repository { nameWithOwner } assignees(first: 100) { nodes { login } }
    } }
    sprint: fieldValueByName(name: "Sprint") { ... on ProjectV2ItemFieldIterationValue { iterationId } }
    status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  } }
} } }`;
const updateMutation = `mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: $value}) { projectV2Item { id } }
}`;
const clearMutation = `mutation($project: ID!, $item: ID!, $field: ID!) {
  clearProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field}) { projectV2Item { id } }
}`;
const addMutation = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: {projectId: $project, contentId: $content}) { item { id } }
}`;

export function createProjects(config: Config, fetcher: typeof fetch): Projects {
  async function request(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetcher('https://api.github.com/graphql', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${config.githubToken}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch { throw new ApiError('github', 'retryable', 'GitHub Projects transport failed'); }
    let body: Record<string, unknown>;
    try { body = object(await response.json()); }
    catch {
      if (response.ok) throw new ApiError('github', 'retryable', 'Invalid GitHub Projects JSON');
      body = {};
    }
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const retry = response.headers.get('retry-after');
    const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
    if (response.status === 429 || (response.status === 403 && (retry !== null || exhausted || /rate limit/i.test(String(body.message))))
      || errors.some(e => object(e).type === 'RATE_LIMITED')) {
      const seconds = retry?.trim() ? Number(retry) : NaN;
      const retryDate = retry === null ? NaN : Date.parse(retry);
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isFinite(retryDate) ? retryDate - Date.now()
        : exhausted && Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() : 60_000;
      throw new ApiError('github', 'retryable', 'GitHub Projects rate limit', Math.max(0, delay));
    }
    if (!response.ok) throw new ApiError('github', response.status >= 500 ? 'retryable' : 'rejected', `GitHub Projects HTTP ${response.status}`);
    if (errors.length || !body.data || typeof body.data !== 'object') return fail('GitHub Projects GraphQL request rejected');
    return object(body.data);
  }

  async function pages(key: 'fields' | 'items'): Promise<{ id: string; nodes: unknown[] }> {
    const nodes: unknown[] = [], cursors = new Set<string>();
    let cursor: string | null = null, id = '';
    while (true) {
      const data = await request(key === 'fields' ? fieldsQuery : itemsQuery, { [`${key}Cursor`]: cursor });
      const project = object(object(data.organization).projectV2);
      const nextId = text(project.id);
      if (id && id !== nextId) return fail('GitHub Projects identity changed');
      id = nextId;
      const connection = object(project[key]), info = object(connection.pageInfo);
      nodes.push(...array(connection.nodes));
      if (info.hasNextPage === false) return { id, nodes };
      if (info.hasNextPage !== true) return fail('Invalid GitHub Projects pagination');
      cursor = text(info.endCursor);
      if (cursors.has(cursor)) return fail('Repeated GitHub Projects cursor');
      cursors.add(cursor);
    }
  }

  async function readBoard(): Promise<Board> {
    const fields = await pages('fields'), items = await pages('items');
    if (fields.id !== items.id) return fail('GitHub Projects identity changed');
    const sprint = fields.nodes.map(object).filter(f => f.name === 'Sprint' && f.__typename === 'ProjectV2IterationField');
    const status = fields.nodes.map(object).filter(f => f.name === 'Status' && f.__typename === 'ProjectV2SingleSelectField');
    if (sprint.length !== 1 || status.length !== 1) return fail('Sprint or Status field is missing or ambiguous');
    const backlog = array(status[0]!.options).map(object).filter(o => o.name === 'Backlog');
    if (backlog.length !== 1) return fail('Backlog option is missing or ambiguous');
    const configuration = object(sprint[0]!.configuration);
    const iterations = [...array(configuration.iterations), ...array(configuration.completedIterations)].map(raw => {
      const it = object(raw);
      if (!Number.isSafeInteger(it.duration) || Number(it.duration) <= 0) return fail('Invalid Sprint duration');
      const startDate = text(it.startDate); calendarDay(startDate);
      return { id: text(it.id), title: text(it.title), startDate, duration: Number(it.duration) };
    });
    const parsedItems: ProjectItem[] = [];
    for (const raw of items.nodes) {
      const item = object(raw), content = object(item.content);
      if (content.__typename !== 'Issue') continue;
      const name = text(object(content.repository).nameWithOwner);
      const repo = config.repositories.find(r => `${owner}/${r.name}`.toLowerCase() === name.toLowerCase());
      if (!repo) continue;
      if (!Number.isSafeInteger(content.number) || Number(content.number) <= 0 || typeof content.title !== 'string'
        || !['OPEN', 'CLOSED'].includes(String(content.state)) || typeof item.isArchived !== 'boolean') return fail('Invalid GitHub Project Issue');
      const number = Number(content.number);
      const issue: Issue = {
        ref: { repo: repo.name, number, url: `https://github.com/${owner}/${repo.name}/issues/${number}` },
        nodeId: text(content.id), title: content.title, state: content.state as Issue['state'],
        assignees: array(object(content.assignees).nodes).map(a => text(object(a).login)),
      };
      parsedItems.push({ id: text(item.id), issue, archived: item.isArchived,
        sprintId: item.sprint == null ? null : text(object(item.sprint).iterationId),
        status: item.status == null ? null : text(object(item.status).name) });
    }
    return { id: fields.id, sprintFieldId: text(sprint[0]!.id), statusFieldId: text(status[0]!.id),
      backlogOptionId: text(backlog[0]!.id), iterations, items: parsedItems };
  }

  function find(board: Board, issue: Issue): ProjectItem | undefined {
    if (!config.repositories.some(r => r.name.toLowerCase() === issue.ref.repo.toLowerCase()) || !issue.nodeId) return fail('Invalid GitHub Project Issue');
    return board.items.find(i => i.issue.nodeId === issue.nodeId);
  }
  async function ensureItem(board: Board, issue: Issue): Promise<ProjectItem> {
    const existing = find(board, issue);
    if (existing) return existing;
    const data = await request(addMutation, { project: board.id, content: issue.nodeId });
    const id = text(object(object(data.addProjectV2ItemById).item).id);
    const added = find(await readBoard(), issue);
    if (!added || added.id !== id) return fail('GitHub Project membership was not applied');
    return added;
  }
  return {
    readBoard,
    async initializeIssue(issue) {
      const board = await readBoard(), item = await ensureItem(board, issue);
      await request(updateMutation, { project: board.id, item: item.id, field: board.statusFieldId, value: { singleSelectOptionId: board.backlogOptionId } });
      await request(clearMutation, { project: board.id, item: item.id, field: board.sprintFieldId });
      const after = find(await readBoard(), issue);
      if (!after || after.status !== 'Backlog' || after.sprintId !== null) return fail('GitHub Project initialization was not applied');
      return after;
    },
    async toCurrentSprint(issue, now) {
      const board = await readBoard(), iteration = currentIteration(board.iterations, now);
      const item = await ensureItem(board, issue);
      if (item.sprintId !== iteration.id) await request(updateMutation, { project: board.id, item: item.id, field: board.sprintFieldId, value: { iterationId: iteration.id } });
      const after = find(await readBoard(), issue);
      if (!after || after.sprintId !== iteration.id) return fail('GitHub Sprint change was not applied');
      return { item: after, iteration, statusChangedExternally: after.status !== item.status };
    },
  };
}
