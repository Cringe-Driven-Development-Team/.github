import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const area = process.env.CALLER_AREA;
if (!["frontend", "backend"].includes(area ?? "")) throw new Error("CALLER_AREA frontend|backend required");
const root = process.env.CALLER_DIR;
if (!root) throw new Error("CALLER_DIR required");
const load = (name: string): any => Bun.YAML.parse(readFileSync(join(root, ".github/workflows", name + ".yml"), "utf8"));
const ci = load("ci");
const primary = "Cringe-Driven-Development-Team/" + area;
function enabled(expression: string, overrides: any = {}) {
  const github = { repository: primary, ref: "refs/heads/main", event_name: "push", ...overrides.github };
  const vars = { ...overrides.vars };
  const raw = expression.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "");
  return Boolean(Function("github", "vars", "success", "always", "cancelled", "failure", "return (" + raw + ")")(
    github, vars, () => true, () => true, () => false, () => false));
}
test("production writes require exact repo, main and explicit flag", () => {
  const writes = area === "frontend"
    ? [ci.jobs.upload, load("cd").jobs.cd, load("rollback").jobs.rollback]
    : [ci.jobs.deploy, load("cd").jobs.deploy];
  for (const job of writes) {
    expect(enabled(job.if)).toBe(false);
    expect(enabled(job.if, { vars: { PRODUCTION_ENABLED: "true" } })).toBe(true);
    for (const github of [
      { repository: "other/team" }, { ref: "refs/heads/topic" }, { event_name: "pull_request" },
    ]) {
      // Frontend CD/Rollback dispatch is allowed, PR is not a trigger of those files.
      if (area === "frontend" && job !== ci.jobs.upload && github.event_name) continue;
      expect(enabled(job.if, { github, vars: { PRODUCTION_ENABLED: "true" } })).toBe(false);
    }
  }
});
test("sync is independent of production/upload/deploy but gated on code checks", () => {
  const job = ci.jobs["course-sync"];
  expect(job).toBeDefined();
  expect([job.needs].flat()).toEqual(area === "frontend" ? ["check"] : ["lint", "test", "docker"]);
  expect(enabled(job.if)).toBe(false);
  expect(enabled(job.if, { vars: { COURSE_SYNC_ENABLED: "true" } })).toBe(true);
  expect(enabled(job.if, { vars: { COURSE_SYNC_ENABLED: "true", PRODUCTION_ENABLED: "false" } })).toBe(true);
  for (const github of [{ repository: "other/team" }, { ref: "refs/heads/topic" }, { event_name: "pull_request" }]) {
    expect(enabled(job.if, { github, vars: { COURSE_SYNC_ENABLED: "true" } })).toBe(false);
  }
});
test("only CI run ID is accepted on manual retry; no production jobs", () => {
  const manual = load("sync-to-course");
  expect(Object.keys(manual.on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(manual.on.workflow_dispatch.inputs)).toEqual(["ci_run_id"]);
  expect(manual.on.workflow_dispatch.inputs.ci_run_id.type).toBe("string");
  expect(Object.keys(manual.jobs).sort()).toEqual(["resolve", "sync"]);
  expect(enabled(manual.jobs.resolve.if)).toBe(false);
  expect(enabled(manual.jobs.resolve.if, { vars: { COURSE_SYNC_ENABLED: "true" } })).toBe(true);
  expect(enabled(manual.jobs.resolve.if, { github: { ref: "refs/heads/topic" }, vars: { COURSE_SYNC_ENABLED: "true" } })).toBe(false);
  expect([manual.jobs.sync.needs].flat()).toEqual(["resolve"]);
});
test("callers pin one trusted SHA and pass only sync credentials", () => {
  for (const job of [ci.jobs["course-sync"], load("sync-to-course").jobs.sync]) {
    const match = job.uses.match(/^Cringe-Driven-Development-Team\/\.github\/\.github\/workflows\/sync-to-course\.yml@([a-f0-9]{40})$/);
    expect(match).not.toBeNull();
    expect(job.with.automation_ref).toBe(match[1]);
    expect(Object.keys(job.secrets).sort()).toEqual(["COURSE_SYNC_SSH_KEY", "TELEGRAM_BOT_TOKEN"]);
    expect(job.permissions).toEqual({ contents: "read", actions: "read" });
  }
});

