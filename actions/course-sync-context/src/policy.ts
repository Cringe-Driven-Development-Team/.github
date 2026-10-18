export type SourceRepo =
  | "Cringe-Driven-Development-Team/frontend"
  | "Cringe-Driven-Development-Team/backend";
export type TargetRepo =
  | "frontend-park-mail-ru/2026_2_Cringe_Driven_Development"
  | "go-park-mail-ru/2026_2_Cringe_Driven_Development";

export interface Candidate {
  sourceRepo: SourceRepo;
  runId: number;
  sha: string;
  target: TargetRepo;
  requiredJobs: readonly string[];
}

export interface RunSnapshot {
  id: number;
  attempt: number;
  sha: string;
  sourceRepo: SourceRepo;
  workflowId: number;
  event: "push";
  headBranch: "main";
}

export class InputError extends Error {
  constructor(message: string) { super(message); this.name = "InputError"; }
}

export class CheckError extends Error {
  constructor(
    public readonly field: string,
    public readonly expected: string,
    public readonly actual: string,
    public readonly retryable: boolean,
  ) {
    super(`${field}: expected ${expected}, got ${actual}`);
    this.name = "CheckError";
  }
}

const policy = {
  "Cringe-Driven-Development-Team/frontend": {
    target: "frontend-park-mail-ru/2026_2_Cringe_Driven_Development",
    requiredJobs: ["Check"],
  },
  "Cringe-Driven-Development-Team/backend": {
    target: "go-park-mail-ru/2026_2_Cringe_Driven_Development",
    requiredJobs: ["lint", "test", "docker"],
  },
} as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nested(value: unknown, field: string): unknown {
  return object(value)?.[field];
}

function printable(value: unknown): string {
  if (value === undefined) return "<missing>";
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).slice(0, 160);
  }
  return Array.isArray(value) ? "<array>" : "<object>";
}

function check(field: string, expected: unknown, actual: unknown, retryable = true): void {
  if (actual !== expected) throw new CheckError(field, printable(expected), printable(actual), retryable);
}

export function parseCandidate(input: { sourceRepo: string; runId: string; sha: string }): Candidate {
  if (!Object.hasOwn(policy, input.sourceRepo)) throw new InputError("sourceRepo: unknown source repository");
  if (!/^[1-9][0-9]*$/.test(input.runId) || !Number.isSafeInteger(Number(input.runId))) {
    throw new InputError("runId: expected positive safe integer");
  }
  if (!/^[0-9a-f]{40}$/.test(input.sha)) throw new InputError("sha: expected full lowercase commit SHA");
  const sourceRepo = input.sourceRepo as SourceRepo;
  return { sourceRepo, runId: Number(input.runId), sha: input.sha,
    target: policy[sourceRepo].target, requiredJobs: policy[sourceRepo].requiredJobs };
}

export function verifyRun(run: unknown, workflow: unknown, candidate: Candidate): RunSnapshot {
  if (!object(workflow)) throw new CheckError("workflow", "object", printable(workflow), true);
  const workflowId = object(workflow)?.id;
  if (!Number.isSafeInteger(workflowId) || Number(workflowId) < 1) {
    throw new CheckError("workflow.id", "positive integer", printable(workflowId), true);
  }
  check("workflow.path", ".github/workflows/ci.yml", object(workflow)?.path);
  if (!object(run)) throw new CheckError("run", "object", printable(run), true);
  const fields: Array<[string, unknown, unknown]> = [
    ["id", candidate.runId, object(run)?.id],
    ["event", "push", object(run)?.event],
    ["head_branch", "main", object(run)?.head_branch],
    ["head_sha", candidate.sha, object(run)?.head_sha],
    ["repository.full_name", candidate.sourceRepo, nested(object(run)?.repository, "full_name")],
    ["head_repository.full_name", candidate.sourceRepo, nested(object(run)?.head_repository, "full_name")],
    ["workflow_id", workflowId, object(run)?.workflow_id],
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
    id: candidate.runId, attempt: Number(attempt), sha: candidate.sha,
    sourceRepo: candidate.sourceRepo, workflowId: Number(workflowId),
    event: "push", headBranch: "main",
  };
}

export function verifyJobs(
  jobsByAttempt: ReadonlyMap<number, readonly unknown[]>,
  snapshot: RunSnapshot,
  requiredJobs: readonly string[],
): void {
  const found = new Set<string>();
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
      const matching = jobs.map(object).filter(row => row?.name === name);
      if (matching.length > 1) throw new CheckError(`ambiguous job ${name}`, "one result", String(matching.length), false);
      if (matching.length === 0) continue;
      const row = matching[0]!;
      if (row.status !== "completed" || typeof row.conclusion !== "string") {
        throw new CheckError(`job ${name} success`, "completed/success", `${printable(row.status)}/${printable(row.conclusion)}`, true);
      }
      if (row.conclusion !== "success") {
        throw new CheckError(`job ${name} success`, "completed/success", `${printable(row.status)}/${printable(row.conclusion)}`, false);
      }
      found.add(name);
    }
  }
  const missing = requiredJobs.filter(name => !found.has(name));
  if (missing.length) throw new CheckError(`required job ${missing.join(",")}`, "present and successful", "<missing>", true);
}

export function assertSameRun(before: RunSnapshot, after: unknown): void {
  if (!object(after)) throw new CheckError("run", "object", printable(after), true);
  const fields: Array<[string, unknown, unknown]> = [
    ["id", before.id, object(after)?.id],
    ["run_attempt", before.attempt, object(after)?.run_attempt],
    ["head_sha", before.sha, object(after)?.head_sha],
    ["repository.full_name", before.sourceRepo, nested(object(after)?.repository, "full_name")],
    ["head_repository.full_name", before.sourceRepo, nested(object(after)?.head_repository, "full_name")],
    ["workflow_id", before.workflowId, object(after)?.workflow_id],
    ["event", before.event, object(after)?.event],
    ["head_branch", before.headBranch, object(after)?.head_branch],
  ];
  for (const [field, expected, actual] of fields) check(field, expected, actual);
}
