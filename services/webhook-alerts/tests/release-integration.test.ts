import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { startService } from "../src/main";
import { createSnapshot } from "../src/snapshot";
import { openStore } from "../src/store";
import { A, B, C, REPO } from "./helpers/release";

test("HTTP release flow suppresses stale retries, deduplicates results and preserves uncertain delivery on reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "release-http-"));
  const path = join(directory, "queue.sqlite");
  const initial = openStore(path);
  const cutoff = Date.now() - 60_000;
  initial.activateReleases(cutoff);
  initial.close();
  const timestamp = new Date().toISOString();
  const image = `ghcr.io/cringe-driven-development-team/bff@sha256:${"d".repeat(64)}`;
  function deployment(id: number, runId: number, publish = false) {
    const run = `https://github.com/${REPO}/actions/runs/${runId}`;
    return {
      id,
      sha: B,
      creator: { login: "github-actions[bot]" },
      created_at: timestamp,
      environment: publish ? "release-artifacts" : "production",
      task: publish ? "publish" : "deploy",
      payload: {
        image_ref: image,
        assets: `releases/${B}/`,
        ...(publish ? { ci_run: run } : { run, action: "deploy" }),
        notification: { base_sha: A, report_url: `${run}#summary`, run_attempt: 1 },
      },
    };
  }
  const artifact = deployment(2, 10, true),
    production = deployment(1, 20),
    failed = deployment(3, 30);
  let merged = false,
    productionVisible = false,
    failedVisible = false,
    productionState = "in_progress";
  let telegramAttempts = 0;
  const accepted: Record<string, unknown>[] = [],
    queries: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url),
        p = url.pathname.replace(`/repos/${REPO}`, "");
      if (p.startsWith("/bot")) {
        telegramAttempts++;
        const body = (await request.json()) as Record<string, unknown>;
        if (String(body.text).includes("поставлен в очередь"))
          return Response.json({ ok: false, parameters: { retry_after: 1 } }, { status: 429 });
        accepted.push(body);
        // A lost success response must stay manual even after the service restarts.
        if (String(body.text).includes("ошибка"))
          return new Response("upstream unavailable", { status: 503 });
        return Response.json({ ok: true, result: { message_id: accepted.length } });
      }
      if (p.includes("/merge-requests") || p.includes("/sprint-branches"))
        return Response.json({ success: true, data: [], meta: { nextPage: null } });
      if (p === "/graphql") {
        const body = await request.text();
        queries.push(body);
        const pr = body.includes("closingIssuesReferences")
          ? {
              closingIssuesReferences: {
                nodes: [
                  {
                    id: "ISSUE27",
                    number: 27,
                    title: "Frontend. Подстановка static",
                    repository: { nameWithOwner: REPO },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            }
          : {
              merged,
              state: merged ? "MERGED" : "OPEN",
              baseRefName: "main",
              mergeQueueEntry: merged
                ? null
                : { id: "ENTRY1", enqueuedAt: timestamp, enqueuer: { login: "YarikMix" } },
            };
        return Response.json({ data: { repository: { pullRequest: pr } } });
      }
      if (p === "/deployments")
        return Response.json(
          url.searchParams.get("environment") === "release-artifacts"
            ? [artifact]
            : [...(failedVisible ? [failed] : []), ...(productionVisible ? [production] : [])],
        );
      const status = /^\/deployments\/(\d+)\/statuses$/.exec(p);
      if (status)
        return Response.json([
          {
            id: 1,
            state: status[1] === "2" ? "success" : status[1] === "3" ? "failure" : productionState,
            created_at: timestamp,
          },
        ]);
      if (p === "/deployments/1") return Response.json(production);
      if (p === "/deployments/2") return Response.json(artifact);
      if (p === "/deployments/3") return Response.json(failed);
      if (p.startsWith("/actions/workflows/"))
        return Response.json({ id: p.endsWith("ci.yml") ? 100 : 101 });
      const run = /^\/actions\/runs\/(\d+)(?:\/attempts\/1)?$/.exec(p);
      if (run)
        return Response.json({
          id: Number(run[1]),
          run_attempt: 1,
          workflow_id: run[1] === "10" ? 100 : 101,
          path: `.github/workflows/${run[1] === "10" ? "ci" : "cd"}.yml`,
          event: run[1] === "10" ? "push" : "workflow_dispatch",
          head_branch: "main",
          head_sha: run[1] === "10" ? B : C,
          repository: { full_name: REPO },
          head_repository: { full_name: REPO },
          actor: { login: "YarikMix" },
          triggering_actor: { login: "YarikMix" },
          status: "in_progress",
        });
      if (p.endsWith("/jobs"))
        return Response.json({
          jobs: [
            {
              id: p.includes("/30/") ? 300 : 100,
              name: p.includes("/10/") ? "Publish release" : "CD",
              steps: [
                { name: "Switch BFF", conclusion: "success" },
                {
                  name: "Health check",
                  conclusion: p.includes("/30/")
                    ? "failure"
                    : productionState === "success"
                      ? "success"
                      : null,
                },
              ],
            },
          ],
        });
      if (p.startsWith("/compare/"))
        return Response.json({ status: "ahead", total_commits: 1, commits: [{ sha: B }] });
      if (p.startsWith("/commits/"))
        return Response.json([
          { number: 125, title: "Human readable PR", merge_commit_sha: B, merged_at: timestamp },
        ]);
      return new Response(`Unexpected test endpoint ${p}`, { status: 500 });
    },
  });
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (!["api.github.com", "api.telegram.org", "api.apidog.com"].includes(url.hostname))
      throw new Error("Unexpected test origin");
    return fetch(new URL(url.pathname + url.search, upstream.url), init);
  }) as typeof fetch;
  const config = loadConfig({
    DATABASE_PATH: path,
    GITHUB_WEBHOOK_SECRET: "test",
    GITHUB_API_TOKEN: "test",
    APIDOG_SIGNATURE_KEY: "test",
    APIDOG_SIGNATURE_HEADER: "X-Test",
    WEBHOOK_ALERTS_SEND_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "test",
    TELEGRAM_APIDOG_BOT_TOKEN: "test-apidog",
    TELEGRAM_CHAT_ID: "-1001",
    TELEGRAM_APIDOG_TOPIC_ID: "88",
    TELEGRAM_RELEASES_TOPIC_ID: "99",
    APIDOG_PROJECT_ID: "1382426",
    APIDOG_TARGET_BRANCH_ID: "1388508",
    APIDOG_PROJECT_NAME: "Example",
    APIDOG_CONTRACT_URL: "https://vb78fyael1.apidog.io/",
    APIDOG_ACCESS_TOKEN: "test",
    APIDOG_TELEGRAM_USER_MAP: "{}",
    APIDOG_MR_REVIEWERS: '[{"name":"One","telegramId":"333"},{"name":"Two","telegramId":"444"}]',
  });
  let service = startService(config, { fetch: fetcher });
  const server = Bun.serve({ port: 0, fetch: service.app.fetch });
  const db = new Database(path);
  async function waitFor(predicate: () => boolean) {
    const until = Date.now() + 7000;
    while (!predicate() && Date.now() < until) await Bun.sleep(10);
    expect(predicate()).toBe(true);
  }
  async function post(id: string, event: string, payload: Record<string, unknown>) {
    const raw = JSON.stringify({ repository: { full_name: REPO }, ...payload });
    return fetch(new URL("/webhooks/github", server.url), {
      method: "POST",
      body: raw,
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": id,
        "X-Hub-Signature-256": "sha256=" + createHmac("sha256", "test").update(raw).digest("hex"),
      },
    });
  }
  const status = (id: number, state: string) => ({
    action: "created",
    deployment: { id, environment: id === 2 ? "release-artifacts" : "production" },
    deployment_status: { state },
  });
  try {
    expect(
      (
        await post("queue", "pull_request", {
          action: "enqueued",
          number: 125,
          pull_request: { number: 125, base: { ref: "main" } },
        })
      ).status,
    ).toBe(202);
    await waitFor(() => telegramAttempts === 1);
    merged = true;
    await waitFor(
      () => !!db.query("SELECT 1 FROM outbox WHERE error_code = 'release_skipped'").get(),
    );
    expect(accepted).toHaveLength(0);
    expect((await post("ready", "deployment_status", status(2, "success"))).status).toBe(202);
    await waitFor(() => accepted.length === 1);
    expect(String(accepted[0]!.text)).toContain("Human readable PR");
    productionVisible = true;
    expect((await post("start", "deployment_status", status(1, "in_progress"))).status).toBe(202);
    await waitFor(() => accepted.length === 2);
    expect(String(accepted[1]!.text)).toContain("Выкатка началась");
    productionState = "success";
    expect((await post("result", "deployment_status", status(1, "success"))).status).toBe(202);
    await waitFor(() => accepted.length === 3);
    expect(String(accepted[2]!.text)).toContain("Health Check ✅");
    expect(String(accepted[2]!.text)).toContain(`href="https://github.com/${REPO}/issues/27"`);
    expect(JSON.stringify(accepted[2]!.reply_markup)).toContain(
      `https://github.com/${REPO}/pull/125`,
    );
    expect(accepted.every((body) => body.message_thread_id === 99)).toBe(true);
    expect((await post("result", "deployment_status", status(1, "success"))).status).toBe(200);
    expect((await post("result-duplicate", "deployment_status", status(1, "success"))).status).toBe(
      202,
    );
    expect((await post("late-start", "deployment_status", status(1, "in_progress"))).status).toBe(
      202,
    );
    failedVisible = true;
    expect((await post("uncertain", "deployment_status", status(3, "failure"))).status).toBe(202);
    await waitFor(
      () => !!db.query("SELECT 1 FROM outbox WHERE error_code = 'release_uncertain'").get(),
    );
    expect(accepted).toHaveLength(4);
    expect(String(accepted[3]!.text)).toContain("Health Check ❌");
    await service.stop();
    const snapshot = join(directory, "snapshot.sqlite");
    createSnapshot(path, snapshot);
    const reopened = openStore(snapshot);
    try {
      expect(reopened.releaseActivation()).toBe(cutoff);
      expect(reopened.claimDue(Date.now() + 300_000, 1000)).toHaveLength(0);
    } finally {
      reopened.close();
    }
    service = startService(config, { fetch: fetcher });
    await Bun.sleep(1100);
    expect(telegramAttempts).toBe(5);
    expect(accepted).toHaveLength(4);
    expect(queries.some((query) => /projectsV2|projectV2/.test(query))).toBe(false);
    expect(
      db.query("SELECT telegram_message_id FROM outbox WHERE status = 'sent' ORDER BY id").all(),
    ).toEqual([{ telegram_message_id: 1 }, { telegram_message_id: 2 }, { telegram_message_id: 3 }]);
  } finally {
    await server.stop(true);
    await service.stop();
    await upstream.stop(true);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 25000);
