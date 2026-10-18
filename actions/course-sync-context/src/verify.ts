import { ApiError, IncompleteJobsError, type GitHubApi } from "./api.js";
import { assertSameRun, CheckError, type Candidate, type TargetRepo, verifyJobs, verifyRun } from "./policy.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

const RETRY_WINDOW_MS = 60_000;
const RETRY_PAUSE_MS = 5_000;

function retryable(error: unknown): boolean {
  if (error instanceof CheckError || error instanceof ApiError) return error.retryable;
  return error instanceof IncompleteJobsError;
}

export async function verifyCandidate(
  candidate: Candidate,
  api: GitHubApi,
  clock: Clock,
): Promise<TargetRepo> {
  const expiresAt = clock.now() + RETRY_WINDOW_MS;
  // This signal also bounds an in-flight HTTP request at the real deadline.
  const deadline = AbortSignal.timeout(RETRY_WINDOW_MS);
  let lastError: Error | undefined;
  for (;;) {
    if (clock.now() >= expiresAt || deadline.aborted) {
      throw lastError ?? new CheckError("deadline", "verification within 60 seconds", "expired", false);
    }
    try {
      const run = await api.getRun(candidate.sourceRepo, candidate.runId, deadline);
      const workflow = await api.getWorkflow(candidate.sourceRepo, deadline);
      const snapshot = verifyRun(run, workflow, candidate);
      const jobs = new Map<number, readonly unknown[]>();
      for (let attempt = snapshot.attempt; attempt >= 1; attempt--) {
        jobs.set(attempt, await api.getAttemptJobs(candidate.sourceRepo, candidate.runId, attempt, deadline));
      }
      verifyJobs(jobs, snapshot, candidate.requiredJobs);
      const confirmed = await api.getRun(candidate.sourceRepo, candidate.runId, deadline);
      assertSameRun(snapshot, confirmed);
      if (clock.now() >= expiresAt || deadline.aborted) {
        throw new CheckError("deadline", "verification within 60 seconds", "expired", false);
      }
      return candidate.target;
    } catch (error) {
      if (!retryable(error)) throw error;
      lastError = error instanceof Error ? error : new Error("unknown verification error");
      const remaining = expiresAt - clock.now();
      if (remaining <= 0 || deadline.aborted) throw lastError;
      await clock.sleep(Math.min(RETRY_PAUSE_MS, remaining));
    }
  }
}
