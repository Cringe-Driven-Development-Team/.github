# Fixed Apidog MR Reviewers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show and ping Alexander Batovkin and Yaroslav Mikhalev in every Apidog `MR_OPENED` Telegram card.

**Architecture:** Read an ordered pair of `{name, telegramId}` from a required Vault-backed environment variable. Pass it through the existing Apidog configuration to `formatApidogMr`; render it only for `MR_OPENED` using the existing `mention` helper and per-card deduplication set. No Apidog API or queue changes.

**Tech Stack:** Bun, TypeScript, `bun:test`, Ansible, Ansible Vault, GHCR, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-10-31-apidog-fixed-mr-reviewers-design.md`

## Global Constraints

- The visible line is `Ревьюверы: Александр Батовкин, Ярослав Михалев`, in that order, in every `MR_OPENED` card.
- Each person gets at most one Telegram mention per card, including when the creator is a reviewer.
- `MR_CLOSED`, `MR_MERGED`, buttons, topic, queue and Apidog assignments retain current behavior.
- Telegram IDs stay in `vault_hooks_env`; never print them in logs, commits, PRs or test output.
- The `infra` checkout currently contains untracked `.apidog/`; keep it untouched and use an isolated worktree for infra edits.

## Review Focus

- Missing or malformed `APIDOG_MR_REVIEWERS`: startup rejects it without leaking the value (Task 1 config test).
- Duplicate or invalid Telegram IDs: startup rejects them (Task 1 config test).
- HTML characters in a configured name: Telegram HTML is escaped (Task 1 formatter test).
- Creator also appears among fixed reviewers: name remains visible but only one mention is sent (Task 1 formatter test).
- Long MR description: both reviewer names remain within Telegram's 4096-character HTML limit (Task 1 formatter test).

---

### Task 1: Configure and format the fixed reviewer line (`.github`)

**Files:**
- Modify: `services/webhook-alerts/src/apidog-merge.ts` (add `reviewers` to `ApidogMergeConfig`).
- Modify: `services/webhook-alerts/src/config.ts` (parse and validate `APIDOG_MR_REVIEWERS`).
- Modify: `services/webhook-alerts/src/apidog.ts` (append line to `MR_OPENED` only).
- Modify: `services/webhook-alerts/tests/apidog.test.ts`, `tests/main.test.ts`, `tests/http.test.ts`, `tests/worker.test.ts`, `tests/apidog-branch.test.ts`, `tests/apidog-merge.test.ts` (new config and behavior).
- Modify: `services/webhook-alerts/README.md` (configuration and example with synthetic IDs).

**Interfaces:**
- Consumes: existing `mention(name, { [name]: telegramId })`, `fitHtml`, and the per-card `seen` set in `formatApidogMr`.
- Produces: `ApidogMergeConfig.reviewers: { name: string; telegramId: string }[]`; `loadConfig` reads `APIDOG_MR_REVIEWERS` as a JSON array with exactly two nonempty names and distinct decimal Telegram IDs.

- [ ] **Step 1: Write failing tests.** In `tests/main.test.ts`, assert absent, malformed, wrong-length, empty-name, invalid-ID and duplicate-ID config is rejected; valid synthetic pair is retained in `config.apidogMerge!.reviewers`. Add the synthetic setting to enabled-env fixtures in `tests/http.test.ts`. In `tests/apidog.test.ts`, assert `MR_OPENED` shows the exact ordered line with two `tg://user` links regardless of `reviewerIds`; `MR_CLOSED`/`MR_MERGED` omit the line; HTML names are escaped; creator overlap produces one link; long descriptions retain both names under 4096 characters.
- [ ] **Step 2: Verify red.** Run `bun test tests/apidog.test.ts tests/main.test.ts tests/http.test.ts` from `services/webhook-alerts`; expect the new assertions to fail for the missing config/line.
- [ ] **Step 3: Implement the minimal change.** Extend `ApidogMergeConfig`, `loadConfig(env)`, and `formatApidogMr(delivery, config)` with the tested behavior. Validate the env value at startup; use the existing formatter and reserve footer space before truncating the description. Add required synthetic `reviewers` in remaining typed test fixtures and document the setting.
- [ ] **Step 4: Verify green.** Run `bun test` and `bun run typecheck` from `services/webhook-alerts`; expect zero failures. Run the repository's `webhook-alerts` CI-equivalent Docker build/smoke check if Docker is available.
- [ ] **Step 5: Commit.** Commit only service code, tests and README with a focused `feat(webhook-alerts): mention fixed Apidog MR reviewers` message.

### Task 2: Wire the setting into Ansible and Vault (`infra`)

**Files:**
- Modify: `ansible/roles/hooks/tasks/validate.yml` (require setting when sending is enabled).
- Modify: `ansible/inventory/group_vars/all/vault.yml` (encrypted value; no plaintext file committed).
- Modify: `RUNBOOK.md` (where to update the fixed reviewer pair).

**Interfaces:**
- Consumes: Task 1's exact `APIDOG_MR_REVIEWERS` JSON shape.
- Produces: `hooks_env.APIDOG_MR_REVIEWERS` for the auxiliary VPS, preserving the configured order.

- [ ] **Step 1: Establish the IDs securely.** Reuse Alexander's Telegram ID from `APIDOG_TELEGRAM_USER_MAP`. Resolve Yaroslav's ID from a verified existing Telegram source, such as the Apidog bot's chat administrators; if no reliable match is available, request that the owner add the verified ID to Vault before deployment. Never display the IDs.
- [ ] **Step 2: Write the Ansible gate.** Add `APIDOG_MR_REVIEWERS` to the required-send-variable assertion, then put the two objects into `vault_hooks_env` using Ansible Vault. Document the setting in `RUNBOOK.md` without IDs.
- [ ] **Step 3: Verify.** Run `ansible-playbook auxiliary.yml --syntax-check` and `ansible-playbook auxiliary.yml --check --diff` with the established Vault/inventory setup; expect no validation or config failure. Inspect the generated environment only via non-secret shape checks.
- [ ] **Step 4: Commit.** Commit the encrypted Vault file, Ansible assertion and runbook in an isolated infra branch; do not add the existing `.apidog/` directory.

### Task 3: Integrate, publish and verify

**Files:**
- Modify: `infra/ansible/roles/hooks/defaults/main.yml` (new verified GHCR manifest digest and source tag).

**Interfaces:**
- Consumes: green `.github` and `infra` PR checks and Task 2's Vault-backed setting.
- Produces: running auxiliary service with the new `MR_OPENED` format.

- [ ] **Step 1: Integrate code.** Create the `.github` PR, verify current head, required checks and conflict status, then merge if authorized. Confirm post-merge image workflow succeeded and read its immutable manifest digest.
- [ ] **Step 2: Pin and integrate infra.** Update `hooks_image` and `hooks_image_source_tag`; run relevant Ansible checks. Create the infra PR, verify head/checks/conflicts, merge if authorized and check post-merge jobs.
- [ ] **Step 3: Deploy and verify.** Apply `auxiliary.yml` with the verified digest, check `/health`, container status and outbox backlog. Use a local synthetic `MR_OPENED` formatting check; verify a real Telegram card on the next genuine MR rather than creating a fake project MR.
