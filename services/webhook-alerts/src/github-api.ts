export interface Commit { sha: string; message: string }
export interface Comparison { commits: Commit[]; aheadBy?: number }
export interface Review { id: number; login: string; state: string; commitId?: string; submittedAt?: string; body?: string; htmlUrl?: string }
export interface ReviewComment { reviewId: number }
export interface PullRequest { requestedReviewers: string[] }
export interface ClosedPullRequest { number: number; title: string; htmlUrl: string; author: string; closedAt: string; merged: boolean; forcePushClosed: boolean }
export interface GithubApi {
  compare(repo: string, base: string, head: string): Promise<Comparison>;
  reviews(repo: string, number: number): Promise<Review[]>;
  reviewComments(repo: string, number: number): Promise<ReviewComment[]>;
  pullRequest(repo: string, number: number): Promise<PullRequest>;
  recentClosedPullRequests(repo: string, branch: string): Promise<ClosedPullRequest[]>;
}
export class GithubApiError extends Error {
  constructor(public readonly code: string) { super(code); }
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export function createGithubApi(options: { token?: string; fetch?: Fetch; timeoutMs?: number } = {}): GithubApi {
  const fetcher = options.fetch ?? fetch;
  const repoPath = (repo: string) => {
    const parts = repo.split('/');
    if (parts.length !== 2 || parts.some(p => !p || p === '.' || p === '..')) throw new GithubApiError('invalid_repository');
    return '/repos/' + parts.map(encodeURIComponent).join('/');
  };
  async function operation<T>(run: (get: (path: string, paginate?: boolean) => Promise<unknown[]>) => Promise<T>): Promise<T> {
    if (!options.token?.trim()) throw new GithubApiError('unavailable');
    const signal = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 5000, 5000)));
    async function pages(path: string, paginate = true): Promise<unknown[]> {
      const start = new URL(path, 'https://api.github.com');
      let url: URL | undefined = start;
      const result: unknown[] = [];
      for (let page = 0; url && page < 10; page++) {
        if (url.origin !== start.origin || url.pathname !== start.pathname) throw new GithubApiError('pagination');
        const response = await fetcher(url.href, { method: 'GET', redirect: 'error', signal,
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${options.token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
        if (!response.ok) {
          // Only a known error classification survives; never expose response text.
          const noAncestor = response.status === 404 && /No common ancestor/i.test(await response.text());
          throw new GithubApiError(noAncestor ? 'no_common_ancestor' : `http_${response.status}`);
        }
        result.push(await response.json());
        const next = paginate && response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
        url = next ? new URL(next, start) : undefined;
      }
      if (url) throw new GithubApiError('pagination_limit');
      return result;
    }
    try { return await run(pages); }
    catch (e) { throw e instanceof GithubApiError ? e : new GithubApiError(signal.aborted ? 'timeout' : 'unavailable'); }
  }
  const rows = (pages: unknown[]) => pages.flatMap(p => {
    if (!Array.isArray(p)) throw new GithubApiError('invalid_response');
    return p.map(object);
  });
  return {
    compare: (repo, base, head) => operation(async get => {
      const pages = await get(`${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`);
      const first = object(pages[0]);
      return { ...(typeof first.ahead_by === 'number' && Number.isSafeInteger(first.ahead_by) && first.ahead_by >= 0 ? { aheadBy: first.ahead_by } : {}),
        commits: pages.flatMap(p => rows([object(p).commits])).map(c => ({ sha: string(c.sha), message: string(object(c.commit).message) })) };
    }),
    reviews: (repo, number) => operation(async get => rows(await get(`${repoPath(repo)}/pulls/${number}/reviews?per_page=100`)).map(r => ({
      id: numeric(r.id), login: string(object(r.user).login), state: string(r.state),
      ...(typeof r.commit_id === 'string' ? { commitId: r.commit_id } : {}),
      ...(typeof r.submitted_at === 'string' ? { submittedAt: r.submitted_at } : {}),
      ...(typeof r.body === 'string' ? { body: r.body } : {}),
      ...(typeof r.html_url === 'string' ? { htmlUrl: r.html_url } : {}),
    }))),
    reviewComments: (repo, number) => operation(async get => rows(await get(`${repoPath(repo)}/pulls/${number}/comments?per_page=100`)).map(c => ({ reviewId: numeric(c.pull_request_review_id) }))),
    pullRequest: (repo, number) => operation(async get => {
      const pr = object((await get(`${repoPath(repo)}/pulls/${number}`))[0]);
      return { requestedReviewers: rows([pr.requested_reviewers]).map(u => string(u.login)) };
    }),
    recentClosedPullRequests: (repo, branch) => operation(async get => {
      const query = new URLSearchParams({ state: 'closed', head: `${repo.split('/')[0]}:${branch}`, sort: 'updated', direction: 'desc', per_page: '5' });
      // Only five recent candidates are relevant; don't scan all historical PRs.
      const candidates = rows(await get(`${repoPath(repo)}/pulls?${query}`, false)).slice(0, 5);
      const result: ClosedPullRequest[] = [];
      for (const pr of candidates) {
        if (pr.merged_at || !pr.closed_at) continue;
        const events = rows(await get(`${repoPath(repo)}/issues/${numeric(pr.number)}/events?per_page=100`));
        result.push({ number: numeric(pr.number), title: string(pr.title), htmlUrl: string(pr.html_url), author: string(object(pr.user).login),
          closedAt: string(pr.closed_at), merged: false,
          forcePushClosed: ['closed', 'head_ref_force_pushed'].every(kind => events.some(e => e.event === kind && e.created_at === pr.closed_at)) });
      }
      return result;
    }),
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GithubApiError('invalid_response');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new GithubApiError('invalid_response');
  return value;
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new GithubApiError('invalid_response');
  return value;
}
