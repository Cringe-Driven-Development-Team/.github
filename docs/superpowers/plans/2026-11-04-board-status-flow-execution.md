# SDD ledger — plan: docs/superpowers/plans/2026-11-04-board-status-flow.md
Executor: executing-plans, explicitly chosen by user. Spec approved.
Base .github: 644eb71c6627c1bb12fe9a49b8055b973a560304; documentation HEAD 74d4a44.
Worktrees: /home/oleg/2026_H2/.github-board-status-flow; /home/oleg/2026_H2/frontend-board-status-flow.
Pre-flight 1→2,4: reconcileClosedIssue signature, event identity and import safety match consumers.
Pre-flight 3→4: syncBoard/readReleaseSnapshot/fixture remain the existing public interfaces.
Pre-flight 2↔3: both jobs use release-board with queue:max, cancel:false in frontend caller scope; no outer lock.
Pre-flight 2→5: caller inventory covers active repos; external cutover requires actual authorization and UI evidence.
Ruling: Task 5 will prepare concrete draft PRs/runbook before merge/cutover approval, and final review will cover all code before external cutover — developer requires reviewable work before approval — live acceptance remains pending until approved cutover/events.
Ruling: For multi-repository tasks, task-done records the .github range; frontend/plugin commit ranges are recorded separately here — helper works in one git repository — omission would obscure part of the reviewed change.
Task 1: complete (commits 74d4a44..dc6bc93, tests: bun test tests/issue-status.test.ts → Ran 33 tests across 1 file. [23.00ms])
Task 2 caller ranges: agent-plugins 3ee04ec..6108547; agent-plugins-private f309c43..1cdb6ea. Separate isolated worktrees; public AGENTS read; private has no AGENTS.
PAT metadata: org ADD_TO_PROJECT_PAT visibility=all (2026-11-04); no secret changes needed.
Task 2 validation: both plugin caller YAML pass actionlint; intentionally invalid concurrency.typo remains rejected with narrow queue ignore.
Frontend baseline: 3f780a94ea99f8989f366ee0534b119a28bfbde7, release suite 86 pass. Frozen install succeeded.
Task 2: complete (commits dc6bc93..bd2ce25, tests: bash -c 'bun test tests/issue-status.test.ts tests/issue-status-workflow.test.ts tests/webhook-workflows.test.ts && bash tests/close.sh && bash tests/lint.sh' → lint ok)
Task 3 evidence: board RED 9 failures (working/null/old status, title, non-default PR and old waits); GREEN board 18/18, release suite 95/95. check/test/build PASS, actionlint PASS with narrow queue ignore. Full scripts suite 154/154; other turbo tasks successful (some cache hits). Removed introduced lint warning before commit.
Task 3: complete (commits bd2ce25..bd2ce25, tests: bash -c 'cd /home/oleg/2026_H2/frontend-board-status-flow && bun test scripts/release && bun run check && bun run test && bun run build && actionlint -ignore '^unexpected key "queue" for "concurrency" section\.'' →   Time:    16ms >>> FULL TURBO)
Task 3 frontend commit range: 3f780a9..aeda11e.
Task 4: complete (commits bd2ce25..a31ee90, tests: env FRONTEND_DIR=/home/oleg/2026_H2/frontend-board-status-flow bun test tests/board-status-integration.test.ts → Ran 8 tests across 1 file. [367.00ms])
Final review: gpt-6-astra fresh review of all four repos; one Important/P2 (Board no-op on old matching status lets delayed close regress). No deferred minors.
Final: Ruling: hosted Actions queue and native workflow configuration remain pending live acceptance — reviewer cannot certify external state from harness, and browser is signed out — false assumption would allow native Done or queue interference after cutover.
Final: Ruling: Board performance remains out of scope — explicitly excluded by user/spec — status transitions retain existing traversal delay.
Final: Ruling: For a proven release whose matching Status predates the current closure, Board will clear then set that same target in serial GraphQL mutation fields and verify the new timestamp — same-value writes need not update updatedAt, so the plan's no-op rule cannot prove current cycle — a failed second mutation can leave an empty Status until visible-error rerun; no new marker/store or intermediate false Done.
Final: fixed delayed close regression after Board no-op — unchanged-old Ready for release/Done cases plus partial-reset failure and stale timestamp RED 4 fail→GREEN 12/12 integration; combined .github suite 62/62, close 22/22, lint pass; frontend release 95/95, scripts 154/154 and check/test/build/actionlint pass. One fix pass, no re-review; reviewer clarification only concerned same-value timestamp semantics.
Task 5 partial: issues .github#54 and frontend#152 created, native sub-issue relationship verified, blocked_by empty; draft PRs .github#55, frontend#153, agent-plugins#28, agent-plugins-private#4. Main SHAs unchanged at preflight; eight callers verified; plugin Actions enabled and PAT visibility=all. Private rules endpoint returns 403 plan limitation, not mistaken for absence of rules.
Task 5 pending: merge permission, actual cutover and remaining live acceptance. Browser signed out (Sign in visible), Item closed #7 enabled=true via API. Native workflow configuration not accessible.
Final commit ranges: .github 644eb71..3b19101; frontend 3f780a9..7a7cbe5; agent-plugins 3ee04ec..6108547; agent-plugins-private f309c43..1cdb6ea. Fixes committed and pushed; worktrees clean.
Final review gate: no remaining Important/Critical findings after verified fix pass. No deferred minors. External task 5 remains incomplete; do not mark plan achieved or claim Item closed disabled.
Finishing: draft PR route already authorized by implementation plan; preserving worktrees for feedback and cutover. Execution ledger archived below docs before deleting only this plan's scratch workspace.

Live acceptance follow-up (user authorized merge): all four PRs merged; frontend main/course copy dc03761, .github 6cbdc68, plugins 2bca06a/9c03162. Post-merge checks and publication pass. User disabled Item closed; API confirms enabled=false and other workflows preserved.
Live finding: Issue.closedAt 19:45:26Z differs from ClosedEvent.createdAt 19:45:27Z on frontend#152. Exact equality incorrectly skipped valid closure. Reproduced in unit test (34 pass /1 fail); use current Issue.closedAt as cycle identity, reject timeline older than that cycle, permit later event creation. This is a live correctness fix, not a second review pass.
