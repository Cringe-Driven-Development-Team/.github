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
import { createHash } from "node:crypto";
import releaseJson from "./fixtures/github/release-published.json";
import manifestJson from "./fixtures/github/release-manifest.json";
import issueJson from "./fixtures/github/issues-opened.json";

test("HTTP release flow suppresses stale retries, deduplicates results and preserves uncertain delivery on reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "release-http-"));
  const path = join(directory, "queue.sqlite");
  const initial = openStore(path);
  const cutoff = Date.now() - 60_000;
  initial.activateReleases(cutoff);
  initial.activateReleaseContract(cutoff);
  initial.close();
  const timestamp = new Date().toISOString();
  const image = `ghcr.io/cringe-driven-development-team/bff@sha256:${"d".repeat(64)}`;
  function deployment(id: number, runId: number) {
    const run = `https://github.com/${REPO}/actions/runs/${runId}`;
    return {
      id,
      sha: B,
      creator: { login: "github-actions[bot]" },
      created_at: timestamp,
      environment: "production",
      task: "deploy",
      payload: {
        image_ref: image,
        assets: `releases/${B}/`,
        run,
        action: "deploy",
        release_id: 5,
        notification: { base_sha: A, report_url: `${run}#summary`, run_attempt: 1 },
      },
    };
  }
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestJson)),
    sumsBytes = new TextEncoder().encode(
      [
        ...releaseJson.assets.filter((a) => a.digest).map((a) => `${a.digest!.slice(7)}  ${a.name}`),
        `${sha256(manifestBytes)}  release.json`,
      ].join("\n") + "\n",
    ),
    texts = new Map([["/53", manifestBytes], ["/54", sumsBytes]]);
  const release = {
    ...releaseJson,
    published_at: timestamp,
    assets: releaseJson.assets.map((a) => {
      const bytes = texts.get(`/${a.id}`);
      return bytes ? { ...a, size: bytes.length, digest: `sha256:${sha256(bytes)}` } : a;
    }),
  };
  const production = deployment(1, 20),
    failed = deployment(3, 30);
  let merged = false,
    productionVisible = false,
    failedVisible = false,
    productionState = "in_progress";
  let issueState = "open";
  let closeAttempts = 0;
  const closeMessages = () => accepted.filter(body => String(body.text).includes("Задача закрыта"));
  let telegramAttempts = 0;
  const attempted: Record<string, unknown>[] = [],
    accepted: Record<string, unknown>[] = [],
    queries: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url),
        p = url.pathname.replace(`/repos/${REPO}`, "");
      if (p.startsWith("/bot")) {
        telegramAttempts++;
        const body = (await request.json()) as Record<string, unknown>;
        attempted.push(body);
        if (String(body.text).includes("поставлен в очередь"))
          return Response.json({ ok: false, parameters: { retry_after: 1 } }, { status: 429 });
        if (String(body.text).includes("Задача закрыта") && ++closeAttempts === 1)
          return Response.json({ ok: false, parameters: { retry_after: 1 } }, { status: 429 });
        accepted.push(body);
        // A lost success response must stay manual even after the service restarts.
        if (String(body.text).includes("ошибка"))
          return new Response("upstream unavailable", { status: 503 });
        return Response.json({ ok: true, result: { message_id: accepted.length } });
      }
      if (p === "/issues/27" && request.method === "PATCH") {
        const body = await request.json() as { state: string; state_reason: string };
        expect(body).toEqual({ state: "closed", state_reason: "completed" });
        issueState = body.state;
        return Response.json({ ...issueJson.issue, number: 27, state: issueState, state_reason: body.state_reason,
          title: "Frontend. Подстановка static", html_url: `https://github.com/${REPO}/issues/27` });
      }
      if (p.includes("/merge-requests") || p.includes("/sprint-branches"))
        return Response.json({ success: true, data: [], meta: { nextPage: null } });
      if (p === "/graphql") {
        const body = await request.text();
        queries.push(body);
        const pr = body.includes("closingIssuesReferences")
          ? {
              title: "Human readable PR",
              closingIssuesReferences: {
                nodes: [
                  {
                    id: "ISSUE27",
                    number: 27,
                    state: issueState.toUpperCase(),
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
      if (url.searchParams.get("environment") === "release-artifacts")
        return new Response("legacy catalog must not be read", { status: 500 });
      if (p === "/deployments")
        return Response.json([...(failedVisible ? [failed] : []), ...(productionVisible ? [production] : [])]);
      if (p === "/releases/5") return Response.json(release);
      if (p === `/git/ref/tags/release-${B}`) return Response.json({ object: { type: "commit", sha: B } });
      const asset = /^\/releases\/assets\/(\d+)$/.exec(p);
      if (asset)
        return new Response(null, {
          status: 302,
          headers: { location: `https://release-assets.githubusercontent.com/${asset[1]}` },
        });
      if (texts.has(p)) return new Response(texts.get(p)!);
      const status = /^\/deployments\/(\d+)\/statuses$/.exec(p);
      if (status)
        return Response.json([
          {
            id: 1,
            state: status[1] === "3" ? "failure" : productionState,
            created_at: timestamp,
          },
        ]);
      if (p === "/deployments/1") return Response.json(production);
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
    if (!["api.github.com", "api.telegram.org", "api.apidog.com", "release-assets.githubusercontent.com"].includes(url.hostname))
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
    TELEGRAM_USER_MAP: JSON.stringify({ YarikMix: "111" }),
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
    deployment: { id, environment: "production" },
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
    expect(attempted[0]!.parse_mode).toBe("HTML");
    expect(String(attempted[0]!.text)).toContain('tg://user?id=111');
    expect(issueState).toBe("open");
    expect(String(attempted[0]!.text)).toContain(`/issues/27`);
    merged = true;
    await waitFor(
      () => !!db.query("SELECT 1 FROM outbox WHERE error_code = 'release_skipped'").get(),
    );
    expect(accepted).toHaveLength(0);
    expect(
      (await post("legacy-ready", "deployment_status", { ...status(2, "success"), deployment: { id: 2, environment: "release-artifacts" } })).status,
    ).toBe(202);
    expect((await post("ready", "release", { action: "published", release: { id: 5 } })).status).toBe(202);
    await waitFor(() => accepted.length === 1);
    expect(String(accepted[0]!.text)).toContain("Human readable PR");
    expect(String(accepted[0]!.text)).toContain(`<code>release-${B}</code>`);
    expect(JSON.stringify(accepted[0]!.reply_markup)).toContain(`https://github.com/${REPO}/releases/tag/release-${B}`);
    expect((await post("ready-duplicate", "release", { action: "published", release: { id: 5 } })).status).toBe(202);
    expect(issueState).toBe("open");
    const closeMessagesBeforeDeploy = closeMessages();
    expect(closeMessagesBeforeDeploy).toHaveLength(0);
    productionVisible = true;
    expect((await post("start", "deployment_status", status(1, "in_progress"))).status).toBe(202);
    await waitFor(() => accepted.length === 2);
    expect(String(accepted[1]!.text)).toContain("Выкатка началась");
    productionState = "success";
    expect((await post("result", "deployment_status", status(1, "success"))).status).toBe(202);
    await waitFor(() => accepted.length === 3);
    expect(accepted[2]!.parse_mode).toBe("HTML");
    expect(String(accepted[2]!.text)).toContain('tg://user?id=111');
    expect(String(accepted[2]!.text)).toContain("Health Check ✅");
    expect(String(accepted[2]!.text)).toContain(`href="https://github.com/${REPO}/issues/27"`);
    expect(JSON.stringify(accepted[2]!.reply_markup)).toContain(
      `https://github.com/${REPO}/pull/125`,
    );
    expect(issueState).toBe("open");
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
    expect(accepted[3]!.parse_mode).toBe("HTML");
    expect(String(accepted[3]!.text)).toContain('tg://user?id=111');
    expect(String(accepted[3]!.text)).toContain("Health Check ❌");
    const response = await fetch(new URL(`/repos/${REPO}/issues/27`, upstream.url), {
      method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      headers: { "Content-Type": "application/json" },
    });
    const closedIssue = await response.json();
    expect((await post("api-close", "issues", { action: "closed", issue: closedIssue, sender: { login: "github-actions[bot]" } })).status).toBe(202);
    await waitFor(() => closeMessages().length === 1);
    expect((await post("api-close", "issues", { action: "closed", issue: closedIssue, sender: { login: "github-actions[bot]" } })).status).toBe(200);
    const closeMessagesAfterRetry = closeMessages();
    expect(closeMessagesAfterRetry).toHaveLength(1);
    expect(closeAttempts).toBe(2);
    expect(closeMessagesAfterRetry[0]!.message_thread_id).toBe(26);
    expect(String(closeMessagesAfterRetry[0]!.text)).toContain("#27");
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
    expect(telegramAttempts).toBe(7);
    expect(accepted).toHaveLength(5);
    expect(queries.some((query) => /projectsV2|projectV2/.test(query))).toBe(false);
    expect(
      db.query("SELECT telegram_message_id FROM outbox WHERE status = 'sent' ORDER BY id").all(),
    ).toEqual([{ telegram_message_id: 1 }, { telegram_message_id: 2 }, { telegram_message_id: 3 }, { telegram_message_id: 5 }]);
  } finally {
    await server.stop(true);
    await service.stop();
    await upstream.stop(true);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 25000);
