import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSameRun, parseCandidate, verifyJobs, verifyRun } from "../src/policy.js";

const backend = "Cringe-Driven-Development-Team/backend";
const frontend = "Cringe-Driven-Development-Team/frontend";
const sha = "a".repeat(40);
const candidate = parseCandidate({ sourceRepo: backend, runId: "101", sha });
const validWorkflow = { id: 77, path: ".github/workflows/ci.yml" };
const validRun = {
  id: 101, event: "push", head_branch: "main", head_sha: sha,
  repository: { full_name: backend }, head_repository: { full_name: backend },
  status: "completed", run_attempt: 2, workflow_id: 77,
};
const job = (name: string, attempt: number, conclusion = "success") => ({
  name, run_id: 101, run_attempt: attempt, status: "completed", conclusion,
});

test("valid_backend_target_and_jobs", () => {
  assert.deepEqual(candidate.requiredJobs, ["lint", "test", "docker"]);
  assert.equal(candidate.target, "go-park-mail-ru/2026_2_Cringe_Driven_Development");
  assert.equal(verifyRun(validRun, validWorkflow, candidate).attempt, 2);
});

test("valid_frontend_check", () => {
  const result = parseCandidate({ sourceRepo: frontend, runId: "101", sha });
  assert.equal(result.target, "frontend-park-mail-ru/2026_2_Cringe_Driven_Development");
  assert.deepEqual(result.requiredJobs, ["Check"]);
});

test("invalid_input", () => {
  for (const sourceRepo of ["other/repo", "", backend + "/other"]) {
    assert.throws(() => parseCandidate({ sourceRepo, runId: "101", sha }), /sourceRepo/);
  }
  for (const runId of ["0", "-1", "1.5", "1foo", "9007199254740992"]) {
    assert.throws(() => parseCandidate({ sourceRepo: backend, runId, sha }), /runId/);
  }
  assert.throws(() => parseCandidate({ sourceRepo: backend, runId: "101", sha: "abc" }), /sha/);
});

test("wrong_run_field", () => {
  const changed: Record<string, unknown>[] = [
    { id: 102 }, { event: "workflow_dispatch" }, { head_branch: "dev" },
    { head_sha: "wrong" }, { repository: { full_name: frontend } },
    { head_repository: null }, { status: "queued" },
    { run_attempt: 0 }, { run_attempt: 1.5 }, { workflow_id: 78 },
  ];
  for (const patch of changed) {
    const field = Object.keys(patch)[0];
    assert.throws(() => verifyRun({ ...validRun, ...patch }, validWorkflow, candidate), new RegExp(field));
  }
  assert.throws(() => verifyRun(null, validWorkflow, candidate), /run/);
  assert.throws(() => verifyRun(validRun, { ...validWorkflow, path: "other.yml" }, candidate), /workflow.path/);
});

test("ambiguous_or_failed_job", () => {
  const snapshot = verifyRun(validRun, validWorkflow, candidate);
  const valid = [job("lint", 2), job("test", 2), job("docker", 2)];
  assert.throws(() => verifyJobs(new Map([[2, [valid[0], valid[0], valid[1], valid[2]]]]), snapshot, candidate.requiredJobs), /ambiguous.*lint/);
  assert.throws(() => verifyJobs(new Map([[2, [job("lint", 2, "failure"), valid[1], valid[2]]]]), snapshot, candidate.requiredJobs), /lint.*success/);
  assert.throws(() => verifyJobs(new Map([[2, [job("lint", 1), valid[1], valid[2]]]]), snapshot, candidate.requiredJobs), /run_attempt/);
  assert.throws(() => verifyJobs(new Map([[2, [valid[0], valid[1]]], [1, []]]), snapshot, candidate.requiredJobs), /docker/);
});

test("latest_attempt_wins", () => {
  const snapshot = verifyRun(validRun, validWorkflow, candidate);
  verifyJobs(new Map([
    [2, [job("lint", 2)]],
    [1, [job("lint", 1, "failure"), job("test", 1), job("docker", 1)]],
  ]), snapshot, candidate.requiredJobs);
  assert.throws(() => verifyJobs(new Map([
    [2, [job("lint", 2, "failure")]],
    [1, [job("lint", 1), job("test", 1), job("docker", 1)]],
  ]), snapshot, candidate.requiredJobs), /lint.*success/);
});

test("run_changed", () => {
  const snapshot = verifyRun(validRun, validWorkflow, candidate);
  assertSameRun(snapshot, validRun);
  assert.throws(() => assertSameRun(snapshot, { ...validRun, run_attempt: 3 }), /run_attempt/);
  assert.throws(() => assertSameRun(snapshot, { ...validRun, head_repository: null }), /head_repository/);
});
