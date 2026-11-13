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
  let result;
  try { result = await response.json(); } catch { throw new Error('Invalid GitHub JSON'); }
  // API messages may reflect request data; do not print credentials or response bodies.
  requireData(result?.data && !result.errors?.length, 'GitHub GraphQL failed');
  return result.data;
}

async function state(input: { repository: string; issueId: string; closedAt?: string }, token: string) {
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
            createdAt closer { __typename }
          } ... on ReopenedEvent { createdAt } }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`, { id: input.issueId, cursor }, token);
    issue = data.node;
    requireData(issue && typeof issue.__typename === 'string', 'Missing issue');
    if (issue.__typename !== 'Issue') return null;
    requireData(issue.id && typeof issue.repository?.nameWithOwner === 'string' && typeof issue.closed === 'boolean', 'Incomplete issue');
    if (issue.id !== input.issueId || issue.repository.nameWithOwner !== input.repository) return null;
    if (input.closedAt !== undefined) {
      if (!issue.closed || issue.closedAt !== input.closedAt) return null;
      timestamp(issue.closedAt);
      requireData(['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'].includes(issue.stateReason), 'Missing close reason');
    }
    cursor = next(issue.timelineItems);
    events.push(...issue.timelineItems.nodes);
    if (cursor) { requireData(!seen.has(cursor), 'Repeated timeline cursor'); seen.add(cursor); }
  } while (cursor);
  for (const event of events) {
    requireData(event && ['ClosedEvent', 'ReopenedEvent'].includes(event.__typename), 'Invalid timeline event');
    timestamp(event.createdAt);
  }
  if (input.closedAt !== undefined) {
    requireData(events.length, 'Missing closure history');
    const latest = events.at(-1);
    // GitHub may create the timeline event after issue.closedAt; the issue identifies the cycle.
    if (latest.__typename !== 'ClosedEvent' || timestamp(latest.createdAt) < timestamp(input.closedAt)) return null;
    requireData(Object.hasOwn(latest, 'closer'), 'Missing closer');
    requireData(latest.closer === null || typeof latest.closer?.__typename === 'string', 'Invalid closer');
  }
  const reopenedAt = events.filter(event => event.__typename === 'ReopenedEvent')
    .reduce((latest, event) => Math.max(latest, timestamp(event.createdAt)), 0);
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
  return card ? { card, closed: issue.closed, closedAt: issue.closedAt, reason: issue.stateReason, reopenedAt } : null;
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

async function update(card: any, config: { field: string; option: string }, token: string) {
  const data = await graphql(`mutation IssueStatusUpdate($project: ID!, $item: ID!, $field: ID!, $option: String!) {
    updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field,
      value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
  }`, { project: card.project.id, item: card.id, ...config }, token);
  requireData(data.updateProjectV2ItemFieldValue?.projectV2Item?.id === card.id, 'Status mutation unconfirmed');
}

async function api(path: string, token: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${frontend}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new Error('GitHub request failed'); }
  requireData(response.ok, `GitHub HTTP ${response.status}`);
  try { return await response.json(); } catch { throw new Error('Invalid GitHub JSON'); }
}
function sha(value: unknown): string {
  requireData(typeof value === 'string' && /^[0-9a-f]{40}$/.test(value), 'Invalid commit SHA');
  return value;
}
async function contains(base: string, head: string, token: string): Promise<boolean> {
  const value = await api(`/compare/${sha(base)}...${sha(head)}?per_page=1`, token);
  requireData(['ahead', 'behind', 'identical', 'diverged'].includes(value.status)
    && value.base_commit?.sha === base && value.merge_base_commit?.sha, 'Incomplete comparison');
  return ['ahead', 'identical'].includes(value.status) && value.merge_base_commit.sha === base;
}
const prFields = `number merged mergedAt baseRefName mergeCommit { oid }
  repository { nameWithOwner defaultBranchRef { name target { oid } } }`;
function merged(pr: any): boolean {
  requireData(typeof pr?.merged === 'boolean' && typeof pr.baseRefName === 'string'
    && typeof pr.repository?.nameWithOwner === 'string', 'Incomplete linked PR');
  if (!pr.merged || pr.repository.nameWithOwner !== frontend
    || pr.baseRefName !== pr.repository.defaultBranchRef?.name) return false;
  requireData(Number.isSafeInteger(pr.number) && pr.number > 0, 'Invalid PR number');
  timestamp(pr.mergedAt); sha(pr.mergeCommit?.oid);
  return true;
}
async function links(id: string, token: string) {
  const prs: any[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const data = await graphql(`query IssueStatusLinks($id: ID!, $cursor: String) {
      node(id: $id) { ... on Issue {
        closedByPullRequestsReferences(first: 100, after: $cursor, includeClosedPrs: true) {
          nodes { ${prFields} } pageInfo { hasNextPage endCursor }
        }
      } }
    }`, { id, cursor }, token);
    const page = data.node?.closedByPullRequestsReferences;
    cursor = next(page);
    for (const pr of page.nodes) {
      if (!merged(pr)) continue;
      requireData(await contains(pr.mergeCommit.oid, sha(pr.repository.defaultBranchRef?.target?.oid), token), 'Linked merge outside default branch');
      prs.push(pr);
    }
    if (cursor) { requireData(!seen.has(cursor), 'Repeated links cursor'); seen.add(cursor); }
  } while (cursor);
  let latest: any;
  for (const pr of prs) {
    if (!latest || await contains(latest.mergeCommit.oid, pr.mergeCommit.oid, token)) latest = pr;
    else requireData(await contains(pr.mergeCommit.oid, latest.mergeCommit.oid, token), 'Ambiguous linked merge order');
  }
  return { latest, prs };
}
async function pullRequest(number: number, token: string) {
  const refs = new Map<string, any>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pr: any;
  do {
    const data = await graphql(`query IssueStatusPullRequest($number: Int!, $cursor: String) {
      repository(owner: "${owner}", name: "frontend") {
        nameWithOwner defaultBranchRef { name target { oid } }
        pullRequest(number: $number) { ${prFields}
          closingIssuesReferences(first: 100, after: $cursor) {
            nodes { id number repository { nameWithOwner } } pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`, { number, cursor }, token);
    pr = data.repository?.pullRequest;
    requireData(pr, 'Missing PR');
    if (!merged(pr)) return null;
    requireData(pr.number === number && data.repository.nameWithOwner === frontend, 'PR repository mismatch');
    requireData(await contains(pr.mergeCommit.oid, sha(data.repository.defaultBranchRef?.target?.oid), token), 'Merge outside default branch');
    cursor = next(pr.closingIssuesReferences);
    for (const issue of pr.closingIssuesReferences.nodes) {
      requireData(issue?.id && Number.isSafeInteger(issue.number) && issue.number > 0 && issue.repository?.nameWithOwner, 'Incomplete linked issue');
      refs.set(issue.id, issue);
    }
    if (cursor) { requireData(!seen.has(cursor), 'Repeated PR cursor'); seen.add(cursor); }
  } while (cursor);
  return { pr, refs: [...refs.values()] };
}

async function laterProduction(input: Input, token: string): Promise<boolean> {
  const { latest, prs } = await links(input.issueId, token);
  if (!latest) return false;
  // A merge after this closure cannot make its delayed event undo an earlier production result.
  const candidates = timestamp(latest.mergedAt) > timestamp(input.closedAt) ? prs : [latest];
  const records: any[] = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/deployments?environment=production&per_page=100&page=${page}`, token);
    requireData(Array.isArray(batch), 'Incomplete production history');
    for (const record of batch) {
      requireData(Number.isSafeInteger(record?.id) && record.id > 0 && record.environment === 'production', 'Invalid production record');
      timestamp(record.created_at);
      records.push(record);
    }
    if (batch.length < 100) break;
  }
  records.sort((a, b) => b.id - a.id);
  if (!records.length) return false;
  const read = async (record: any) => {
    const statuses = await api(`/deployments/${record.id}/statuses?per_page=1`, token);
    requireData(Array.isArray(statuses) && statuses[0]?.state, 'Missing production status');
    const successAt = timestamp(statuses[0].created_at);
    if (successAt <= timestamp(input.closedAt)) return { record, payload: null, successAt };
    if (statuses[0].state !== 'success') return null;
    let payload;
    try { payload = typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload; }
    catch { throw new Error('Invalid production payload'); }
    requireData(['deploy', 'rollback'].includes(payload?.action) && record.task === payload.action, 'Invalid production action');
    sha(record.sha); sha(payload.notification?.base_sha);
    requireData(successAt >= timestamp(record.created_at), 'Invalid production order');
    const base = payload.notification.base_sha;
    requireData(await contains(payload.action === 'deploy' ? base : record.sha, payload.action === 'deploy' ? record.sha : base, token), 'Invalid production direction');
    return { record, payload, successAt };
  };
  const current = await read(records[0]);
  requireData(current, 'Latest production attempt is not success');
  if (current.successAt <= timestamp(input.closedAt)) return false;
  for (const pr of candidates) {
    const present = await contains(pr.mergeCommit.oid, current.record.sha, token);
    for (const record of records) {
      const operation = record.id === current.record.id ? current : await read(record);
      if (!operation || operation.successAt <= timestamp(input.closedAt)
        || timestamp(pr.mergedAt) > operation.successAt) continue;
      if (operation.payload.action === 'deploy') {
        if (present && await contains(pr.mergeCommit.oid, record.sha, token)) return true;
      } else if (!present && !await contains(pr.mergeCommit.oid, record.sha, token)
        && await contains(pr.mergeCommit.oid, operation.payload.notification.base_sha, token)) return true;
    }
  }
  return false;
}

/** Reconcile one current closure; only merge events write frontend build readiness. */
export async function reconcileClosedIssue(input: Input, token: string): Promise<'changed' | 'unchanged' | 'skipped'> {
  requireData(input.repository?.startsWith(`${owner}/`) && /^[\w.-]+$/.test(input.repository.slice(owner.length + 1)), 'Invalid repository');
  requireData(typeof input.issueId === 'string' && input.issueId && token, 'Missing issue ID or token');
  timestamp(input.closedAt);
  const initial = await state(input, token);
  if (!initial) return 'skipped';
  if (input.repository === frontend && initial.reason === 'COMPLETED' && await laterProduction(input, token)) return 'skipped';
  if (initial.card.fieldValueByName?.name === 'Done') return 'unchanged';
  // Check configuration before the final issue read.
  const config = await project(token, initial.card.project.id, 'Done');
  const latest = await state(input, token);
  if (JSON.stringify(latest) !== JSON.stringify(initial)) return 'skipped';
  if (input.repository === frontend && initial.reason === 'COMPLETED' && await laterProduction(input, token)) return 'skipped';
  await update(initial.card, config, token);
  return 'changed';
}

/** Advance open native-linked frontend issues after their latest default-branch merge. */
export async function reconcileMergedPullRequest(input: { repository: string; number: number }, token: string): Promise<{ changed: number; skipped: number; errors: string[] }> {
  const result = { changed: 0, skipped: 0, errors: [] as string[] };
  if (input.repository !== frontend) return result;
  requireData(Number.isSafeInteger(input.number) && input.number > 0 && token, 'Invalid PR number or token');
  const initial = await pullRequest(input.number, token);
  if (!initial) return result;
  for (const issue of initial.refs) {
    try {
      const skip = (reason: string) => {
        result.skipped++;
        console.log(`issue #${issue.number}: PR #${input.number}; -> Ready for build; skipped: ${reason}`);
      };
      if (issue.repository.nameWithOwner !== frontend) { skip('foreign issue'); continue; }
      const inputIssue = { repository: frontend, issueId: issue.id };
      const snapshot = await state(inputIssue, token);
      const ineligible = async (value: Awaited<ReturnType<typeof state>>, pr: any) => {
        if (!value) return 'missing issue or Scrumban card';
        if (value.closed) return 'issue already closed';
        if (value.reopenedAt >= timestamp(pr.mergedAt)) return 'manual reopen after merge';
        const { latest } = await links(issue.id, token);
        if (!latest || latest.number !== input.number || latest.mergeCommit.oid !== pr.mergeCommit.oid) return 'newer or missing native-linked merge';
        const status = value.card.fieldValueByName;
        if (status?.name === 'Ready for build') return 'already Ready for build';
        if (['Ready for release', 'Done', 'Rollback from production'].includes(status?.name)
          && timestamp(status.updatedAt) >= timestamp(pr.mergedAt)) return 'later Status in this merge cycle';
        return null;
      };
      const reason = await ineligible(snapshot, initial.pr);
      if (reason) { skip(reason); continue; }
      const config = await project(token, snapshot!.card.project.id, 'Ready for build');
      const currentPR = await pullRequest(input.number, token);
      const current = await state(inputIssue, token);
      if (!currentPR || !currentPR.refs.some(ref => ref.id === issue.id) || JSON.stringify(current) !== JSON.stringify(snapshot)) { skip('state or PR changed before write'); continue; }
      const currentReason = await ineligible(current, currentPR.pr);
      if (currentReason) { skip(currentReason); continue; }
      await update(current!.card, config, token);
      result.changed++;
      console.log(`issue #${issue.number}: PR #${input.number}; open/${snapshot!.card.fieldValueByName?.name ?? '?'} -> Ready for build; changed`);
    } catch (error) {
      result.errors.push(`issue #${issue.number}: ${error instanceof Error ? error.message : 'Issue status failed'}`);
    }
  }
  return result;
}

if (import.meta.main) {
  try {
    const event = await Bun.file(process.env.GITHUB_EVENT_PATH ?? '').json();
    const eventName = process.env.GITHUB_EVENT_NAME;
    if (event.action === 'closed' && (eventName === 'issues' || (eventName === 'pull_request' && event.pull_request?.merged === true))) {
      const repository = process.env.GITHUB_REPOSITORY ?? '';
      requireData(event.repository?.full_name === repository, 'Event repository mismatch');
      const token = process.env.ADD_TO_PROJECT_PAT ?? '';
      let result;
      if (eventName === 'issues') {
        requireData(!event.issue?.pull_request, 'Expected issue, not PR');
        result = await reconcileClosedIssue({ repository, issueId: event.issue?.node_id, closedAt: event.issue?.closed_at }, token);
      } else {
        result = await reconcileMergedPullRequest({ repository, number: event.pull_request?.number }, token);
        if (result.errors.length) {
          for (const error of result.errors) console.error(error);
          process.exitCode = 1;
        }
      }
      console.log(`Issue status: ${typeof result === 'string' ? result : JSON.stringify(result)}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Issue status failed');
    process.exitCode = 1;
  }
}
