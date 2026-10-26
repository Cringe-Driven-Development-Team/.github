# Apidog MR-only alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send only Apidog MR opened, closed and merged notifications to Telegram.

**Architecture:** Poll the authenticated Apidog MR list every 30 seconds. Insert stable synthetic deliveries in the existing SQLite queue; on first start suppress only history before the stored cutoff. Project only synthetic MR deliveries to Telegram, leaving signed webhook intake and GitHub behavior intact.

**Tech Stack:** Bun/TypeScript, bun:sqlite, Hono, existing Telegram sender.

**Spec:** `docs/superpowers/specs/2026-10-26-apidog-mr-only-design.md`

## Global Constraints

- No new dependency or schema table: use the current delivery ID uniqueness and `prepared` flag.
- Preserve signed Apidog intake, durable delivery, both Telegram buttons and mapped user pings.
- Never log API payloads, tokens or Telegram credentials.
- Poll all pages before inserting any state; bound pagination at 20 pages as in the current client.

## Review Focus

- A MR created and merged before the next poll produces OPENED then MERGED once.
- A pre-existing OPEN MR closed after rollout produces only CLOSED.
- An API failure or malformed later page leaves no partial state.
- A restart while the first API call is failing retains the original cutoff.
- Raw `API_UPDATED`, `BRANCH_CREATED` and `BRANCH_MERGED` webhook deliveries produce no Telegram message.

---

### Task 1: List MR state from Apidog

**Files:** `services/webhook-alerts/src/apidog-api.ts`, `services/webhook-alerts/tests/apidog-api.test.ts`

**Interface:** Add `listMergeRequests(input: {projectId: number; targetBranchId: number}): Promise<ApidogMr[]>` to `ApidogApi`. `ApidogMr` includes positive numeric ID, sourceBranchId, targetBranchId, createdById and reviewerIds, status `OPEN|CLOSED|MERGED`, description string, createdAt string, closedAt string/null and closedById/null. Validate each row and target branch. Follow `meta.nextPage`, reject cycles and >20 pages, and return only after all pages succeed. Keep the existing read timeout/error classification.

- [ ] Write tests for full pagination, invalid rows, wrong target and failure on page two; run them red.
- [ ] Implement the smallest read-only client method; run those tests green and `bunx tsc --noEmit`.
- [ ] Commit the task.

### Task 2: Durable cutoff and synthetic deliveries

**Files:** `services/webhook-alerts/src/store.ts`, `services/webhook-alerts/tests/store.test.ts`

**Interface:** Add `Store.startApidogMrMonitoring(now: number): void` and `Store.recordApidogMergeRequests(rows: ApidogMr[]): number`. Store the first start as a prepared sentinel delivery. For each MR, insert stable `mr-poll:<id>:OPENED` plus the terminal status delivery when applicable. Events before cutoff are inserted prepared; events at/after cutoff are unprepared. Run all inserts for one snapshot in one immediate transaction. `record...` returns new unprepared count.

- [ ] Write tests for first-start cutoff, existing OPEN later CLOSED, new terminal MR, duplicate poll/restart, and invalid/partial snapshot rollback; run red.
- [ ] Implement with current SQLite table and hash helper; run focused tests green and `bunx tsc --noEmit`.
- [ ] Commit the task.

### Task 3: MR cards and filtering

**Files:** `services/webhook-alerts/src/apidog.ts`, `services/webhook-alerts/src/worker.ts`, `services/webhook-alerts/tests/apidog.test.ts`, `services/webhook-alerts/tests/worker.test.ts`, obsolete branch/merge projector tests as needed.

**Interface:** Only deliveries with stable `mr-poll:` IDs and events `MR_OPENED|MR_CLOSED|MR_MERGED` project to Telegram. Cards have escaped details, mapped mentions, `Открыть MR` button and `Контракт API` second button. Every other Apidog delivery projects `[]`. Keep GitHub projector unchanged. Reuse existing format and people-map code where practical.

- [ ] Write failing tests for three MR cards, exact URLs, escaping and silence for API/branch webhook events.
- [ ] Implement filtering and formatting; run tests green and `bunx tsc --noEmit`.
- [ ] Commit the task.

### Task 4: Poll loop, docs and integration

**Files:** `services/webhook-alerts/src/main.ts`, `services/webhook-alerts/src/worker.ts`, `services/webhook-alerts/tests/main.test.ts`, `services/webhook-alerts/README.md`.

**Interface:** Start the cutoff before the first read. Poll every 30 seconds without overlapping calls, log fixed error codes on failure, and insert the complete snapshot before `runOnce`. Stop on abort. Reuse configured API token, project ID and target branch ID. Update README to state only MR alerts are sent.

- [ ] Write failing service tests for baseline, periodic poll, API failure/recovery and no raw-webhook Telegram output.
- [ ] Implement the loop and docs; run full `bun test` and `bunx tsc --noEmit`.
- [ ] Commit the task.

### Task 5: Publish and deploy

**Files:** `ansible/roles/hooks/defaults/main.yml` in infra after the image is published.

- [ ] Review whole branch, run full tests, open service PR and verify CI/head/conflicts before merging.
- [ ] Confirm new GHCR OCI index digest; update only image digest and source SHA in an isolated infra worktree.
- [ ] Run hooks tests and syntax check, open infra PR, verify CI/head/conflicts and merge.
- [ ] Confirm post-merge deploy/verify, exact image digest, health and first poll without historical spam.
