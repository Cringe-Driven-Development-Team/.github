import type { Config } from './config';
import type { IssueRef } from './commands';

export interface Issue {
  ref: IssueRef;
  nodeId: string;
  title: string;
  state: 'OPEN' | 'CLOSED';
  assignees: string[];
}

export interface Github {
  getIssue(ref: IssueRef): Promise<Issue>;
  createIssue(repo: string, title: string, body: string): Promise<Issue>;
  canAssign(repo: string, login: string): Promise<boolean>;
  addAssignee(ref: IssueRef, login: string): Promise<Issue>;
  removeAssignee(ref: IssueRef, login: string): Promise<Issue>;
  closeIssue(ref: IssueRef): Promise<Issue>;
}

export class ApiError extends Error {
  constructor(
    public readonly provider: 'github' | 'telegram',
    public readonly kind: 'rejected' | 'retryable' | 'uncertain',
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Internal control flow: preserve the durable checkpoint when shutdown stops the next HTTP stage.
export class ShutdownError extends Error {}

const owner = 'Cringe-Driven-Development-Team';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function createGithub(config: Config, fetcher: typeof fetch): Github {
  const reject = (message: string): never => { throw new ApiError('github', 'rejected', message); };
  function repository(repo: string): string {
    const allowed = config.repositories.find(r => r.name.toLowerCase() === repo.toLowerCase());
    if (!allowed || !/^[a-z0-9_.-]+$/i.test(allowed.name) || ['.', '..'].includes(allowed.name)) return reject('Invalid GitHub repository');
    return allowed.name;
  }
  function issueRef(repo: string, number: number): IssueRef {
    repo = repository(repo);
    if (!positiveInteger(number)) return reject('Invalid GitHub issue number');
    return { repo, number, url: `https://github.com/${owner}/${repo}/issues/${number}` };
  }
  function loginPath(login: string): string {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(login)) return reject('Invalid GitHub login');
    return encodeURIComponent(login);
  }
  const repoPath = (repo: string) => `/repos/${owner}/${encodeURIComponent(repository(repo))}`;
  const issuePath = (ref: IssueRef) => `${repoPath(ref.repo)}/issues/${issueRef(ref.repo, ref.number).number}`;

  async function request(path: string, method = 'GET', body?: unknown, creating = false, allow404 = false): Promise<Response> {
    let response: Response;
    try {
      response = await fetcher(`https://api.github.com${path}`, {
        method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof ShutdownError) throw error;
      throw new ApiError('github', creating ? 'uncertain' : 'retryable', 'GitHub transport failed');
    }
    if (response.ok || (allow404 && response.status === 404)) return response;
    const retry = response.headers.get('retry-after');
    const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
    let secondaryLimit = false;
    if (response.status === 403 && !retry && !exhausted) {
      try { secondaryLimit = /(?:secondary rate limit|rate limit exceeded)/i.test(String(object(await response.json()).message)); }
      catch { /* An unreadable error body remains a permission rejection. */ }
    }
    if (response.status === 429 || (response.status === 403 && (retry !== null || exhausted || secondaryLimit))) {
      const seconds = retry !== null && retry.trim() !== '' ? Number(retry) : NaN;
      const retryDate = retry === null ? NaN : Date.parse(retry);
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
        : Number.isFinite(retryDate) ? retryDate - Date.now()
        : exhausted && Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() : 60_000;
      throw new ApiError('github', 'retryable', 'GitHub rate limit', Math.max(0, delay));
    }
    throw new ApiError('github', response.status >= 500 ? (creating ? 'uncertain' : 'retryable') : 'rejected', `GitHub HTTP ${response.status}`);
  }

  async function readIssue(response: Response, repo: string, number?: number, creating = false): Promise<Issue> {
    const invalid = (): never => { throw new ApiError('github', creating ? 'uncertain' : 'retryable', 'Invalid GitHub issue response'); };
    let value: Record<string, unknown>;
    try { value = object(await response.json()); }
    catch { return invalid(); }
    if ('pull_request' in value) {
      if (creating) return invalid();
      return reject('GitHub pull requests are not supported');
    }
    if (!positiveInteger(value.number) || (number !== undefined && value.number !== number)
      || typeof value.node_id !== 'string' || !value.node_id || typeof value.title !== 'string'
      || (value.state !== 'open' && value.state !== 'closed') || !Array.isArray(value.assignees)
      || !value.assignees.every(a => typeof object(a).login === 'string' && object(a).login !== '')) return invalid();
    return { ref: issueRef(repo, value.number), nodeId: value.node_id, title: value.title,
      state: value.state === 'open' ? 'OPEN' : 'CLOSED', assignees: value.assignees.map(a => object(a).login as string) };
  }

  const getIssue = async (ref: IssueRef): Promise<Issue> => readIssue(await request(issuePath(ref)), ref.repo, ref.number);
  const hasAssignee = (issue: Issue, login: string) => issue.assignees.some(a => a.toLowerCase() === login.toLowerCase());
  const canAssign = async (repo: string, login: string): Promise<boolean> => {
    const response = await request(`${repoPath(repo)}/assignees/${loginPath(login)}`, 'GET', undefined, false, true);
    if (response.status !== 204 && response.status !== 404) throw new ApiError('github', 'retryable', 'Invalid GitHub assignment response');
    return response.status === 204;
  };
  async function changeAssignee(ref: IssueRef, login: string, adding: boolean): Promise<Issue> {
    loginPath(login);
    const before = await getIssue(ref);
    if (hasAssignee(before, login) === adding) return before;
    if (adding && !await canAssign(ref.repo, login)) return reject('GitHub user cannot be assigned');
    await request(`${issuePath(ref)}/assignees`, adding ? 'POST' : 'DELETE', { assignees: [login] });
    const after = await getIssue(ref);
    if (hasAssignee(after, login) !== adding) return reject('GitHub assignee change was not applied');
    return after;
  }

  return {
    getIssue, canAssign,
    async createIssue(repo, title, body) {
      const path = `${repoPath(repo)}/issues`;
      if (!title.trim()) return reject('GitHub issue title must not be empty');
      const response = await request(path, 'POST', { title, body }, true);
      if (response.status !== 201) throw new ApiError('github', 'uncertain', 'Invalid GitHub create status');
      // Return the known identity before another request can fail; the handler persists it first.
      return readIssue(response, repo, undefined, true);
    },
    addAssignee: (ref, login) => changeAssignee(ref, login, true),
    removeAssignee: (ref, login) => changeAssignee(ref, login, false),
    async closeIssue(ref) {
      const before = await getIssue(ref);
      if (before.state === 'CLOSED') return before;
      await request(issuePath(ref), 'PATCH', { state: 'closed', state_reason: 'completed' });
      const after = await getIssue(ref);
      if (after.state !== 'CLOSED') return reject('GitHub issue close was not applied');
      return after;
    },
  };
}
