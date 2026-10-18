import type { SourceRepo } from "./policy.js";

export interface GitHubApi {
  getRun(repo: SourceRepo, runId: number, deadline?: AbortSignal): Promise<unknown>;
  getWorkflow(repo: SourceRepo, deadline?: AbortSignal): Promise<unknown>;
  getAttemptJobs(repo: SourceRepo, runId: number, attempt: number, deadline?: AbortSignal): Promise<readonly unknown[]>;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly retryable: boolean, detail: string) {
    super(detail);
    this.name = "ApiError";
  }
}

export class IncompleteJobsError extends Error {
  constructor(detail: string) {
    super(`jobs pagination: ${detail}`);
    this.name = "IncompleteJobsError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function createGitHubApi(
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): GitHubApi {
  const request = async (path: string, resource: string, deadline?: AbortSignal): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.github.com/${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: deadline ? AbortSignal.any([AbortSignal.timeout(timeoutMs), deadline]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ApiError(0, true, timeout ? `GitHub API ${resource} timeout` : `GitHub API ${resource} network error`);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new ApiError(response.status, retryable, `GitHub API ${resource} HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ApiError(response.status, true, timeout ? `GitHub API ${resource} timeout` : `GitHub API ${resource} invalid JSON`);
    }
  };

  return {
    getRun: (repo, runId, deadline) => request(`repos/${repo}/actions/runs/${runId}`, "run", deadline),
    getWorkflow: (repo, deadline) => request(`repos/${repo}/actions/workflows/ci.yml`, "workflow", deadline),
    async getAttemptJobs(repo, runId, attempt, deadline) {
      const result: unknown[] = [];
      const ids = new Set<number>();
      let expectedCount: number | undefined;
      for (let page = 1; ; page++) {
        const body = record(await request(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`, `jobs attempt ${attempt} page ${page}`, deadline));
        const totalCount = body?.total_count;
        const jobs = body?.jobs;
        if (!Number.isSafeInteger(totalCount) || Number(totalCount) < 0 || !Array.isArray(jobs)) {
          throw new IncompleteJobsError(`attempt ${attempt}, page ${page}: invalid shape`);
        }
        if (expectedCount === undefined) expectedCount = Number(totalCount);
        if (expectedCount !== totalCount) {
          throw new IncompleteJobsError(`attempt ${attempt}, page ${page}: total_count changed`);
        }
        if (jobs.length > 100 || (jobs.length === 0 && result.length < expectedCount)) {
          throw new IncompleteJobsError(`attempt ${attempt}, page ${page}: incomplete page`);
        }
        for (const item of jobs) {
          const id = record(item)?.id;
          if (!Number.isSafeInteger(id) || Number(id) < 1 || ids.has(Number(id))) {
            throw new IncompleteJobsError(`attempt ${attempt}, page ${page}: duplicate or invalid job id`);
          }
          ids.add(Number(id));
          result.push(item);
        }
        if (result.length > expectedCount) {
          throw new IncompleteJobsError(`attempt ${attempt}: more jobs than total_count`);
        }
        if (result.length === expectedCount) return result;
      }
    },
  };
}
