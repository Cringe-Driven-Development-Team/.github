# GitHubBot Help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (owner's preserved choice). Steps use checkbox syntax for tracking.

**Goal:** Add compact `/help` to PR #68 before its already-authorized merge.
**Architecture:** Extend the existing command union/parser, pure messages formatter and durable handler. Retain authentication and use the existing outbox without GitHub/Projects calls.
**Tech Stack:** TypeScript, Bun, existing SQLite store and Telegram adapter; no new dependencies.
**Spec:** docs/superpowers/specs/2026-11-08-githubbot-help-design.md (confirmed by owner in conversation).

## Global Constraints

One Russian message containing only command names/signatures and short descriptions, no examples, extra rules, buttons or links.
Only configured users in the existing allowed group; any topic, no private/foreign chats.
Preserve forum URL regression fix, existing authorization, durable delivery and all other command behavior.
No new dependencies, API calls, credentials, configuration or live issue mutations.

## Review Focus

1. Addressed commands: current bot accepted, another bot ignored (decoder tests).
2. Private/foreign chats and unknown users remain ignored (decoder tests).
3. Unknown topic still receives help, without repo-choice buttons (handler test).
4. Telegram retry/restart reuses outbox, no GitHub/Projects calls (handler test).
5. Extra help arguments return syntax hint, not an issue-target error (decoder test).

### Task 1: Add compact help through existing command pipeline

**Files:** Modify services/githubbot/src/commands.ts, src/messages.ts, src/handler.ts; add relevant cases to tests/commands.test.ts, tests/handler.test.ts, tests/messages.test.ts; add `/help` row to services/githubbot/README.md. All src/tests paths relative to services/githubbot.
**Interfaces:** Add `{ name: 'help' }` to Command. Add `helpMessage(): Outgoing` to messages.ts; render nine lines from spec with safe `<code>` command signatures. Reuse `output`, `deliver` and authorization in handleJob. No schema/config changes.
**Binding content and constraints:** Read spec above; it contains exact nine lines to use. No examples or additional prose in response. No GitHub/Projects network call when handling help. Existing group/user restrictions apply before help handling.

- [ ] Add decoder tests: plain and bot-addressed help accepted without target; other-bot help ignored; unknown user/private/other-chat ignored; args rejected with CommandError and `Формат: /help`; optional reply/topic routing must not require issue target.
- [ ] Add formatter/handler tests: `helpMessage()` contains exactly nine short command lines, no keyboard/URL/examples, below Telegram limit; one outgoing message for help in an unmapped topic using same context, no Github/Projects calls; retry after transient Telegram failure survives store reopen and completes without side effects.
- [ ] Run focused cases to see RED before implementation. Use `/home/oleg/.bun/bin/bun test services/githubbot/tests/commands.test.ts services/githubbot/tests/messages.test.ts services/githubbot/tests/handler.test.ts`.
- [ ] Implement minimal parser, formatter and handler paths. Keep saved reply delivery semantics; adapt union narrowing without fake username/target fields.
- [ ] Add README command entry only; no unrelated cleanup.
- [ ] Run focused tests GREEN, then full `/home/oleg/.bun/bin/bun test services/githubbot/tests tests/githubbot-workflows.test.ts`, `/home/oleg/.bun/bin/bun run --cwd services/githubbot typecheck`, `git diff --check` once. Fix failures and report exact RED/GREEN evidence.
- [ ] Self-review and commit relevant code/tests/README only. Controller owns design/plan commit, PR update and merge. No push/deploy/live messages; no subagents.

## Plan self-review

All agreed content/access requirements covered by one task. Review-focus cases map to tests above. Existing `Outgoing`, `Command`, handler/outbox interfaces reused. No independent tasks or missing design decisions. Preserve previously chosen SDD; owner already authorized adding this help before merging #68.
