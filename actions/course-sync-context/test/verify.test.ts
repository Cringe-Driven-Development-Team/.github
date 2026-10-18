import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, IncompleteJobsError, type GitHubApi } from "../src/api.js";
import { parseCandidate } from "../src/policy.js";
import { verifyCandidate, type Clock } from "../src/verify.js";

const repo = "Cringe-Driven-Development-Team/frontend";
const sha = "a".repeat(40);
const candidate = parseCandidate({ sourceRepo: repo, runId: "101", sha });
const validRun = { id: 101, event: "push", head_branch: "main", head_sha: sha,
  repository: { full_name: repo }, head_repository: { full_name: repo },
  status: "completed", run_attempt: 1, workflow_id: 77 };
const workflow = { id: 77, path: ".github/workflows/ci.yml" };
const job = (attempt = 1, conclusion = "success") => ({
  id: attempt, name: "Check", run_id: 101, run_attempt: attempt,
  status: "completed", conclusion,
});
function fakeClock(): Clock & { elapsed(): number } {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; }, elapsed: () => time };
}
function fakeApi(overrides: Partial<GitHubApi> = {}): GitHubApi {
  return {
    getRun: async () => validRun,
    getWorkflow: async () => workflow,
    getAttemptJobs: async () => [job()],
    ...overrides,
  };
}

test("valid_run_returns_target", async () => {
  assert.equal(await verifyCandidate(candidate, fakeApi(), fakeClock()),
    "frontend-park-mail-ru/2026_2_Cringe_Driven_Development");
});

test("missing_head_repository_then_valid", async () => {
  let reads = 0;
  const clock = fakeClock();
  const transientApi = fakeApi({ getRun: async () => ++reads === 1 ? { ...validRun, head_repository: null } : validRun });
  assert.equal(await verifyCandidate(candidate, transientApi, clock), candidate.target);
  assert.equal(reads, 3); // first failed snapshot, then start and confirm
  assert.ok(clock.elapsed() > 0 && clock.elapsed() <= 5_000);
});

test("timeout_reports_last_field", async () => {
  const clock = fakeClock();
  const alwaysWrongApi = fakeApi({ getRun: async () => ({ ...validRun, head_repository: null }) });
  await assert.rejects(verifyCandidate(candidate, alwaysWrongApi, clock), /head_repository/);
  assert.equal(clock.elapsed(), 60_000);
});

test("incomplete_jobs_then_complete", async () => {
  let reads = 0;
  const api = fakeApi({ getAttemptJobs: async () => {
    if (++reads === 1) throw new IncompleteJobsError("first page missing");
    return [job()];
  } });
  assert.equal(await verifyCandidate(candidate, api, fakeClock()), candidate.target);
  assert.equal(reads, 2);
});

test("unfinished_required_job_then_success", async () => {
  let reads = 0;
  const clock = fakeClock();
  const api = fakeApi({ getAttemptJobs: async () => ++reads === 1
    ? [{ ...job(), status: "in_progress", conclusion: null }]
    : [job()] });
  assert.equal(await verifyCandidate(candidate, api, clock), candidate.target);
  assert.equal(reads, 2);
  assert.equal(clock.elapsed(), 5_000);
});

test("permanently_unfinished_job_expires_with_specific_error", async () => {
  const clock = fakeClock();
  const api = fakeApi({ getAttemptJobs: async () => [{ ...job(), status: "queued", conclusion: null }] });
  await assert.rejects(verifyCandidate(candidate, api, clock), /job Check success.*queued/);
  assert.equal(clock.elapsed(), 60_000);
});

test("attempt_changes_during_read", async () => {
  let reads = 0;
  const attempts: number[] = [];
  const api = fakeApi({
    getRun: async () => ({ ...validRun, run_attempt: ++reads === 1 ? 1 : 2 }),
    getAttemptJobs: async (_repo, _runId, attempt) => {
      attempts.push(attempt);
      return attempt === 2 ? [job(2)] : [job(1)];
    },
  });
  assert.equal(await verifyCandidate(candidate, api, fakeClock()), candidate.target);
  assert.deepEqual(attempts, [1, 2, 1]);
  assert.equal(reads, 4);
});

test("failed_job_and_401_do_not_retry", async () => {
  let reads = 0;
  const badJobApi = fakeApi({ getRun: async () => { reads++; return validRun; }, getAttemptJobs: async () => [job(1, "failure")] });
  await assert.rejects(verifyCandidate(candidate, badJobApi, fakeClock()), /Check.*success/);
  assert.equal(reads, 1);
  const authApi = fakeApi({ getRun: async () => { reads++; throw new ApiError(401, false, "GitHub API HTTP 401"); } });
  await assert.rejects(verifyCandidate(candidate, authApi, fakeClock()), /HTTP 401/);
  assert.equal(reads, 2);
});

test("rate_limit_retries", async () => {
  let reads = 0;
  const api = fakeApi({ getRun: async () => {
    if (++reads === 1) throw new ApiError(429, true, "GitHub API HTTP 429");
    return validRun;
  } });
  assert.equal(await verifyCandidate(candidate, api, fakeClock()), candidate.target);
  assert.equal(reads, 3);
});
