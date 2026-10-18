// src/main.ts
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// src/api.ts
var ApiError = class extends Error {
  constructor(status, retryable2, detail) {
    super(detail);
    this.status = status;
    this.retryable = retryable2;
    this.name = "ApiError";
  }
  status;
  retryable;
};
var IncompleteJobsError = class extends Error {
  constructor(detail) {
    super(`jobs pagination: ${detail}`);
    this.name = "IncompleteJobsError";
  }
};
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function createGitHubApi(token, fetchImpl = fetch, timeoutMs = 1e4) {
  const request = async (path, deadline) => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal: deadline ? AbortSignal.any([AbortSignal.timeout(timeoutMs), deadline]) : AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ApiError(0, true, timeout ? "GitHub API timeout" : "GitHub API network error");
    }
    if (!response.ok) {
      const retryable2 = response.status === 429 || response.status >= 500;
      throw new ApiError(response.status, retryable2, `GitHub API HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new ApiError(response.status, true, "GitHub API invalid JSON");
    }
  };
  return {
    getRun: (repo, runId, deadline) => request(`repos/${repo}/actions/runs/${runId}`, deadline),
    getWorkflow: (repo, deadline) => request(`repos/${repo}/actions/workflows/ci.yml`, deadline),
    async getAttemptJobs(repo, runId, attempt, deadline) {
      const result = [];
      const ids = /* @__PURE__ */ new Set();
      let expectedCount;
      for (let page = 1; ; page++) {
        const body = record(await request(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`, deadline));
        const totalCount = body?.total_count;
        const jobs = body?.jobs;
        if (!Number.isSafeInteger(totalCount) || Number(totalCount) < 0 || !Array.isArray(jobs)) {
          throw new IncompleteJobsError(`attempt ${attempt}, page ${page}: invalid shape`);
        }
        if (expectedCount === void 0) expectedCount = Number(totalCount);
        if (expectedCount !== totalCount) {
          throw new IncompleteJobsError(`attempt ${attempt}, page ${page}: total_count changed`);
        }
        if (jobs.length > 100 || jobs.length === 0 && result.length < expectedCount) {
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
    }
  };
}

// src/policy.ts
var InputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
};
var CheckError = class extends Error {
  constructor(field, expected, actual, retryable2) {
    super(`${field}: expected ${expected}, got ${actual}`);
    this.field = field;
    this.expected = expected;
    this.actual = actual;
    this.retryable = retryable2;
    this.name = "CheckError";
  }
  field;
  expected;
  actual;
  retryable;
};
var policy = {
  "Cringe-Driven-Development-Team/frontend": {
    target: "frontend-park-mail-ru/2026_2_Cringe_Driven_Development",
    requiredJobs: ["Check"]
  },
  "Cringe-Driven-Development-Team/backend": {
    target: "go-park-mail-ru/2026_2_Cringe_Driven_Development",
    requiredJobs: ["lint", "test", "docker"]
  }
};
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function nested(value, field) {
  return object(value)?.[field];
}
function printable(value) {
  if (value === void 0) return "<missing>";
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).slice(0, 160);
  }
  return Array.isArray(value) ? "<array>" : "<object>";
}
function check(field, expected, actual, retryable2 = true) {
  if (actual !== expected) throw new CheckError(field, printable(expected), printable(actual), retryable2);
}
function parseCandidate(input) {
  if (!Object.hasOwn(policy, input.sourceRepo)) throw new InputError("sourceRepo: unknown source repository");
  if (!/^[1-9][0-9]*$/.test(input.runId) || !Number.isSafeInteger(Number(input.runId))) {
    throw new InputError("runId: expected positive safe integer");
  }
  if (!/^[0-9a-f]{40}$/.test(input.sha)) throw new InputError("sha: expected full lowercase commit SHA");
  const sourceRepo = input.sourceRepo;
  return {
    sourceRepo,
    runId: Number(input.runId),
    sha: input.sha,
    target: policy[sourceRepo].target,
    requiredJobs: policy[sourceRepo].requiredJobs
  };
}
function verifyRun(run, workflow, candidate) {
  if (!object(workflow)) throw new CheckError("workflow", "object", printable(workflow), true);
  const workflowId = object(workflow)?.id;
  if (!Number.isSafeInteger(workflowId) || Number(workflowId) < 1) {
    throw new CheckError("workflow.id", "positive integer", printable(workflowId), true);
  }
  check("workflow.path", ".github/workflows/ci.yml", object(workflow)?.path);
  if (!object(run)) throw new CheckError("run", "object", printable(run), true);
  const fields = [
    ["id", candidate.runId, object(run)?.id],
    ["event", "push", object(run)?.event],
    ["head_branch", "main", object(run)?.head_branch],
    ["head_sha", candidate.sha, object(run)?.head_sha],
    ["repository.full_name", candidate.sourceRepo, nested(object(run)?.repository, "full_name")],
    ["head_repository.full_name", candidate.sourceRepo, nested(object(run)?.head_repository, "full_name")],
    ["workflow_id", workflowId, object(run)?.workflow_id]
  ];
  for (const [field, expected, actual] of fields) check(field, expected, actual);
  const status = object(run)?.status;
  if (status !== "in_progress" && status !== "completed") {
    throw new CheckError("status", "in_progress or completed", printable(status), true);
  }
  const attempt = object(run)?.run_attempt;
  if (!Number.isSafeInteger(attempt) || Number(attempt) < 1) {
    throw new CheckError("run_attempt", "positive integer", printable(attempt), true);
  }
  return {
    id: candidate.runId,
    attempt: Number(attempt),
    sha: candidate.sha,
    sourceRepo: candidate.sourceRepo,
    workflowId: Number(workflowId),
    event: "push",
    headBranch: "main"
  };
}
function verifyJobs(jobsByAttempt, snapshot, requiredJobs) {
  const found = /* @__PURE__ */ new Set();
  for (let attempt = snapshot.attempt; attempt >= 1 && found.size < requiredJobs.length; attempt--) {
    const jobs = jobsByAttempt.get(attempt);
    if (!jobs) throw new CheckError(`jobs.attempt.${attempt}`, "complete list", "<missing>", true);
    for (const job of jobs) {
      const row = object(job);
      if (!row) throw new CheckError("job", "object", printable(job), true);
      check("job.run_id", snapshot.id, row.run_id);
      check("job.run_attempt", attempt, row.run_attempt);
      if (typeof row.name !== "string") {
        throw new CheckError("job.name", "string", printable(row.name), true);
      }
    }
    for (const name of requiredJobs) {
      if (found.has(name)) continue;
      const matching = jobs.map(object).filter((row2) => row2?.name === name);
      if (matching.length > 1) throw new CheckError(`ambiguous job ${name}`, "one result", String(matching.length), false);
      if (matching.length === 0) continue;
      const row = matching[0];
      if (row.status !== "completed" || row.conclusion !== "success") {
        throw new CheckError(`job ${name} success`, "completed/success", `${printable(row.status)}/${printable(row.conclusion)}`, false);
      }
      found.add(name);
    }
  }
  const missing = requiredJobs.filter((name) => !found.has(name));
  if (missing.length) throw new CheckError(`required job ${missing.join(",")}`, "present and successful", "<missing>", true);
}
function assertSameRun(before, after) {
  if (!object(after)) throw new CheckError("run", "object", printable(after), true);
  const fields = [
    ["id", before.id, object(after)?.id],
    ["run_attempt", before.attempt, object(after)?.run_attempt],
    ["head_sha", before.sha, object(after)?.head_sha],
    ["repository.full_name", before.sourceRepo, nested(object(after)?.repository, "full_name")],
    ["head_repository.full_name", before.sourceRepo, nested(object(after)?.head_repository, "full_name")],
    ["workflow_id", before.workflowId, object(after)?.workflow_id],
    ["event", before.event, object(after)?.event],
    ["head_branch", before.headBranch, object(after)?.head_branch]
  ];
  for (const [field, expected, actual] of fields) check(field, expected, actual);
}

// src/verify.ts
var systemClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};
var RETRY_WINDOW_MS = 6e4;
var RETRY_PAUSE_MS = 5e3;
function retryable(error) {
  if (error instanceof CheckError || error instanceof ApiError) return error.retryable;
  return error instanceof IncompleteJobsError;
}
async function verifyCandidate(candidate, api, clock) {
  const expiresAt = clock.now() + RETRY_WINDOW_MS;
  const deadline = AbortSignal.timeout(RETRY_WINDOW_MS);
  let lastError;
  for (; ; ) {
    if (clock.now() >= expiresAt || deadline.aborted) {
      throw lastError ?? new CheckError("deadline", "verification within 60 seconds", "expired", false);
    }
    try {
      const run = await api.getRun(candidate.sourceRepo, candidate.runId, deadline);
      const workflow = await api.getWorkflow(candidate.sourceRepo, deadline);
      const snapshot = verifyRun(run, workflow, candidate);
      const jobs = /* @__PURE__ */ new Map();
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

// src/main.ts
async function executeAction(env, api, clock, writeOutput) {
  if (!env.GH_TOKEN) throw new InputError("GH_TOKEN: missing token");
  if (!env.GITHUB_OUTPUT) throw new InputError("GITHUB_OUTPUT: missing output file");
  const candidate = parseCandidate({
    sourceRepo: env.SOURCE_REPO ?? "",
    runId: env.CI_RUN_ID ?? "",
    sha: env.SHA ?? ""
  });
  const target = await verifyCandidate(candidate, api, clock);
  writeOutput(`target=${target}
`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  executeAction(
    env,
    createGitHubApi(env.GH_TOKEN ?? ""),
    systemClock,
    (line) => appendFileSync(env.GITHUB_OUTPUT, line, "utf8")
  ).catch((error) => {
    const detail = error instanceof Error ? error.message : "unexpected error";
    console.error(`Course sync refused: ${detail}`);
    process.exitCode = 1;
  });
}
export {
  executeAction
};
