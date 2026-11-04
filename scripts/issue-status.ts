const owner = 'Cringe-Driven-Development-Team';
const frontend = `${owner}/frontend`;
type Input = { repository: string; issueId: string; closedAt: string };
type Page = { nodes: any[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

function requireData(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function timestamp(value: unknown): number {
  requireData(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'Invalid timestamp');
  return Date.parse(value as string);
}
function next(page: Page): string | null {
  requireData(Array.isArray(page?.nodes) && typeof page?.pageInfo?.hasNextPage === 'boolean', 'Incomplete connection');
  if (!page.pageInfo.hasNextPage) return null;
  requireData(typeof page.pageInfo.endCursor === 'string' && page.pageInfo.endCursor, 'Missing cursor');
  return page.pageInfo.endCursor;
}
async function graphql(query: string, variables: object, token: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch('https://api.github.com/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new Error('GitHub request failed'); }
  requireData(response.ok, `GitHub HTTP ${response.status}`);
  const result = await response.json();
  // API messages may reflect request data; do not print credentials or response bodies.
  requireData(result?.data && !result.errors?.length, 'GitHub GraphQL failed');
  return result.data;
}

async function state(input: Input, token: string) {
  let cursor: string | null = null;
  let issue: any;
  const events: any[] = [];
  const seen = new Set<string>();
  do {
    const data = await graphql(`query IssueStatusIssue($id: ID!, $cursor: String) {
      node(id: $id) { __typename ... on Issue {
        id closed closedAt stateReason repository { nameWithOwner }
        timelineItems(first: 100, after: $cursor, itemTypes: [CLOSED_EVENT, REOPENED_EVENT]) {
          nodes { __typename ... on ClosedEvent {
            createdAt closer { __typename ... on PullRequest {
              merged baseRefName repository { nameWithOwner defaultBranchRef { name } }
            } }
          } ... on ReopenedEvent { createdAt } }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`, { id: input.issueId, cursor }, token);
    issue = data.node;
    requireData(issue && typeof issue.__typename === 'string', 'Missing issue');
    if (issue.__typename !== 'Issue') return null;
    requireData(issue.id && typeof issue.repository?.nameWithOwner === 'string' && typeof issue.closed === 'boolean', 'Incomplete issue');
    if (issue.id !== input.issueId || issue.repository.nameWithOwner !== input.repository || !issue.closed) return null;
    timestamp(issue.closedAt);
    if (issue.closedAt !== input.closedAt) return null;
    requireData(['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'].includes(issue.stateReason), 'Missing close reason');
    cursor = next(issue.timelineItems);
    events.push(...issue.timelineItems.nodes);
    if (cursor) { requireData(!seen.has(cursor), 'Repeated timeline cursor'); seen.add(cursor); }
  } while (cursor);
  requireData(events.length, 'Missing closure history');
  for (const event of events) {
    requireData(event && ['ClosedEvent', 'ReopenedEvent'].includes(event.__typename), 'Invalid timeline event');
    timestamp(event.createdAt);
  }
  // Connections are chronological; array order also resolves equal timestamps.
  const latest = events.at(-1);
  // GitHub may create the timeline event after issue.closedAt; the issue above identifies the cycle.
  if (latest.__typename !== 'ClosedEvent' || timestamp(latest.createdAt) < timestamp(input.closedAt)) return null;
  requireData(Object.hasOwn(latest, 'closer'), 'Missing closer');
  const closer = latest.closer;
  requireData(closer === null || typeof closer?.__typename === 'string', 'Invalid closer');
  if (closer?.__typename === 'PullRequest') {
    requireData(typeof closer.merged === 'boolean' && typeof closer.baseRefName === 'string'
      && typeof closer.repository?.nameWithOwner === 'string'
      && Object.hasOwn(closer.repository, 'defaultBranchRef'), 'Incomplete closing PR');
    requireData(closer.repository.defaultBranchRef === null || typeof closer.repository.defaultBranchRef?.name === 'string', 'Invalid default branch');
  }
  const release = input.repository === frontend && issue.stateReason === 'COMPLETED'
    && closer?.__typename === 'PullRequest' && closer.merged
    && closer.repository.nameWithOwner === frontend
    && closer.baseRefName === closer.repository.defaultBranchRef?.name;
  let card: any = null;
  seen.clear();
  do {
    const data = await graphql(`query IssueStatusCards($id: ID!, $cursor: String) {
      node(id: $id) { ... on Issue { projectItems(first: 100, after: $cursor) {
        nodes { id project { id number owner { ... on Organization { login } ... on User { login } } }
          fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt } }
        } pageInfo { hasNextPage endCursor }
      } } }
    }`, { id: input.issueId, cursor }, token);
    const page = data.node?.projectItems;
    cursor = next(page);
    for (const item of page.nodes) {
      requireData(item?.id && item.project?.id && typeof item.project.number === 'number' && item.project.owner?.login, 'Incomplete project item');
      if (item.project.number === 1 && item.project.owner.login === owner) {
        requireData(Object.hasOwn(item, 'fieldValueByName'), 'Missing Status value');
        if (item.fieldValueByName !== null) {
          requireData(typeof item.fieldValueByName?.name === 'string', 'Invalid Status');
          timestamp(item.fieldValueByName.updatedAt);
        }
        card = item;
      }
    }
    if (cursor) { requireData(!seen.has(cursor), 'Repeated items cursor'); seen.add(cursor); }
  } while (cursor);
  return card ? { release: Boolean(release), card, closedAt: issue.closedAt, closer, reason: issue.stateReason } : null;
}

async function project(token: string, id: string, target: string) {
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const data = await graphql(`query IssueStatusProject($cursor: String) {
      organization(login: "Cringe-Driven-Development-Team") { projectV2(number: 1) {
        id viewerCanUpdate fields(first: 100, after: $cursor) {
          nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`, { cursor }, token);
    const value = data.organization?.projectV2;
    requireData(value?.id === id && value.viewerCanUpdate === true, 'Project unavailable or not writable');
    cursor = next(value.fields);
    const field = value.fields.nodes.find((field: any) => field?.name === 'Status');
    if (field) {
      const option = field.options?.find((option: any) => option.name === target);
      requireData(field.id && option?.id, `Project Status lacks ${target}`);
      return { field: field.id, option: option.id };
    }
    if (cursor) { requireData(!seen.has(cursor), 'Repeated fields cursor'); seen.add(cursor); }
  } while (cursor);
  throw new Error('Project lacks Status');
}

/** Reconcile one current issue closure; Actions serializes frontend writers with Board. */
export async function reconcileClosedIssue(input: Input, token: string): Promise<'changed' | 'unchanged' | 'skipped'> {
  requireData(input.repository?.startsWith(`${owner}/`) && /^[\w.-]+$/.test(input.repository.slice(owner.length + 1)), 'Invalid repository');
  requireData(typeof input.issueId === 'string' && input.issueId && token, 'Missing issue ID or token');
  timestamp(input.closedAt);
  const initial = await state(input, token);
  if (!initial) return 'skipped';
  const target = initial.release ? 'Ready for build' : 'Done';
  const config = await project(token, initial.card.project.id, target);
  const current = initial.card.fieldValueByName;
  if (current?.name === target || (initial.release && ['Ready for release', 'Done', 'Rollback from production'].includes(current?.name)
    && timestamp(current.updatedAt) >= timestamp(input.closedAt))) return 'unchanged';
  const latest = await state(input, token);
  if (JSON.stringify(latest) !== JSON.stringify(initial)) return 'skipped';
  const data = await graphql(`mutation IssueStatusUpdate($project: ID!, $item: ID!, $field: ID!, $option: String!) {
    updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field,
      value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
  }`, { project: initial.card.project.id, item: initial.card.id, ...config }, token);
  requireData(data.updateProjectV2ItemFieldValue?.projectV2Item?.id === initial.card.id, 'Status mutation unconfirmed');
  return 'changed';
}

if (import.meta.main) {
  try {
    const event = await Bun.file(process.env.GITHUB_EVENT_PATH ?? '').json();
    if (process.env.GITHUB_EVENT_NAME === 'issues' && event.action === 'closed') {
      const repository = process.env.GITHUB_REPOSITORY ?? '';
      requireData(event.repository?.full_name === repository, 'Event repository mismatch');
      requireData(!event.issue?.pull_request, 'Expected issue, not PR');
      const result = await reconcileClosedIssue({ repository, issueId: event.issue?.node_id, closedAt: event.issue?.closed_at }, process.env.ADD_TO_PROJECT_PAT ?? '');
      console.log(`Issue status: ${result}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Issue status failed');
    process.exitCode = 1;
  }
}
