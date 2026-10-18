import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import type { GitHubApi } from "../src/api.js";
import { executeAction } from "../src/main.js";
import type { Clock } from "../src/verify.js";

const repo = "Cringe-Driven-Development-Team/frontend";
const sha = "a".repeat(40);
const clock: Clock = { now: () => 0, sleep: async () => {} };
const api: GitHubApi = {
  getRun: async () => ({ id: 101, event: "push", head_branch: "main", head_sha: sha,
    repository: { full_name: repo }, head_repository: { full_name: repo },
    status: "completed", run_attempt: 1, workflow_id: 77 }),
  getWorkflow: async () => ({ id: 77, path: ".github/workflows/ci.yml" }),
  getAttemptJobs: async () => [{ id: 1, name: "Check", run_id: 101, run_attempt: 1,
    status: "completed", conclusion: "success" }],
};
const env = { SOURCE_REPO: repo, CI_RUN_ID: "101", SHA: sha, GH_TOKEN: "secret", GITHUB_OUTPUT: "/tmp/output" };

test("writes_only_fixed_target_after_success", async () => {
  const output: string[] = [];
  await executeAction(env, api, clock, line => output.push(line));
  assert.deepEqual(output, ["target=frontend-park-mail-ru/2026_2_Cringe_Driven_Development\n"]);
});

test("failure_never_writes_output", async () => {
  const output: string[] = [];
  await assert.rejects(executeAction({ ...env, SHA: "bad" }, api, clock, line => output.push(line)), /sha/);
  await assert.rejects(executeAction({ ...env, GITHUB_OUTPUT: undefined }, api, clock, line => output.push(line)), /GITHUB_OUTPUT/);
  assert.deepEqual(output, []);
});

test("direct_entry_refuses_invalid_input_without_an_api_request", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...env, SHA: "bad" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Course sync refused: sha/);
});
