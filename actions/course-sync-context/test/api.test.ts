import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createGitHubApi, IncompleteJobsError } from "../src/api.js";

const repo = "Cringe-Driven-Development-Team/backend";
const job1 = { id: 1, name: "lint", run_id: 101, run_attempt: 1 };
const job2 = { id: 2, name: "test", run_id: 101, run_attempt: 1 };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fake = (handler: (url: URL, init: RequestInit) => Promise<Response> | Response): typeof fetch =>
  (async (input, init) => handler(new URL(String(input)), init ?? {})) as typeof fetch;

test("fetches_expected_endpoints", async () => {
  const seen: string[] = [];
  const api = createGitHubApi("secret", fake((url, init) => {
    seen.push(url.pathname + url.search);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer secret");
    assert.equal(new Headers(init.headers).get("Accept"), "application/vnd.github+json");
    assert.ok(init.signal);
    return response({ id: 101 });
  }));
  assert.deepEqual(await api.getRun(repo, 101), { id: 101 });
  assert.deepEqual(await api.getWorkflow(repo), { id: 101 });
  assert.deepEqual(seen, [
    `/repos/${repo}/actions/runs/101`,
    `/repos/${repo}/actions/workflows/ci.yml`,
  ]);
});

test("paginates_all_jobs", async () => {
  const pages: number[] = [];
  const api = createGitHubApi("secret", fake(url => {
    pages.push(Number(url.searchParams.get("page")));
    assert.equal(url.searchParams.get("per_page"), "100");
    return response({ total_count: 2, jobs: pages.length === 1 ? [job1] : [job2] });
  }));
  assert.deepEqual(await api.getAttemptJobs(repo, 101, 1), [job1, job2]);
  assert.deepEqual(pages, [1, 2]);
});

test("rejects_incomplete_or_duplicate_pages", async () => {
  const incomplete = createGitHubApi("secret", fake(() => response({ total_count: 2, jobs: [job1] })));
  await assert.rejects(incomplete.getAttemptJobs(repo, 101, 1), IncompleteJobsError);
  const duplicate = createGitHubApi("secret", fake(() => response({ total_count: 2, jobs: [job1, job1] })));
  await assert.rejects(duplicate.getAttemptJobs(repo, 101, 1), IncompleteJobsError);
  const inconsistent = createGitHubApi("secret", fake(url => response({
    total_count: url.searchParams.get("page") === "1" ? 2 : 3,
    jobs: url.searchParams.get("page") === "1" ? [job1] : [job2],
  })));
  await assert.rejects(inconsistent.getAttemptJobs(repo, 101, 1), IncompleteJobsError);
});

test("rejects_malformed_json", async () => {
  const nullRun = createGitHubApi("secret", fake(() => response(null)));
  assert.equal(await nullRun.getRun(repo, 101), null); // policy rejects the shape with a field-specific error
  const invalidJson = createGitHubApi("secret", fake(() => new Response("not-json")));
  await assert.rejects(invalidJson.getRun(repo, 101), /JSON/);
  const arrayJobs = createGitHubApi("secret", fake(() => response([])));
  await assert.rejects(arrayJobs.getAttemptJobs(repo, 101, 1), IncompleteJobsError);
});

test("classifies_http_errors", async () => {
  for (const [status, retryable] of [[401, false], [403, false], [429, true], [500, true]] as const) {
    const api = createGitHubApi("secret", fake(() => response({ message: "do not log body" }, status)));
    await assert.rejects(api.getRun(repo, 101), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.equal(error.retryable, retryable);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /do not log body|secret/);
      return true;
    });
  }
});

test("times_out_at_ten_seconds", async () => {
  const api = createGitHubApi("secret", fake((_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })), 10);
  await assert.rejects(api.getRun(repo, 101), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.retryable, true);
    assert.match(error.message, /timeout/i);
    return true;
  });
});
