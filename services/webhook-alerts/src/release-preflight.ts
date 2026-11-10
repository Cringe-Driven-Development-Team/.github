import { BACKEND_REPO } from './backend-releases';
import { GithubApiError } from './github-api';
// Read-only checks; run with the actual service token before backend activation.
export async function checkBackendReleaseAccess(token: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!token.trim()) throw new GithubApiError('unavailable');
  for (const path of ['', '/actions/runs?per_page=1', '/deployments?environment=production&per_page=1',
    '/contents/.github/workflows/ci.yml?ref=main', '/contents/.github/workflows/rollback.yml?ref=main',
    '/issues?per_page=1', '/pulls?per_page=1']) {
    try {
      const response = await fetcher(`https://api.github.com/repos/${BACKEND_REPO}${path}`, {
        method:'GET', redirect:'error', signal:AbortSignal.timeout(5000),
        headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28'},
      });
      if (!response.ok) throw new GithubApiError(`http_${response.status}`);
      await response.arrayBuffer();
    } catch (error) {
      throw error instanceof GithubApiError ? error : new GithubApiError('unavailable');
    }
  }
}
