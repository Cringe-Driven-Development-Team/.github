# Локальная подготовка миграции — 2026-10-17

Выполнена подготовка задач 1–8. Финальное независимое review: ожидается.
Никаких push, PR, merge на GitHub, изменений settings/flags/secrets, deploy или
отправки сообщений эта подготовка не выполняла. Окна 9–10 ждут согласования.

Корень локальных checkout: F:/Github/cringe-driven-development-team.
Общая автоматика: .github/.worktrees/migration-automation.
Остальные подготовленные checkout: migration-prep/.

| Checkout | Локальная ветка | Подготовленный commit / диапазон review |
| --- | --- | --- |
| .github/.worktrees/migration-automation | prep/team-repositories-migration | 5bf41b0..5acbbf2 (код); этот журнал добавлен позже |
| migration-prep/frontend | migration/import | 550af0c..e3c2895 |
| migration-prep/backend | migration/import | 0f4b657..5e9437d |
| migration-prep/infra | prep/team-backend-image | 9ca55ec..2dfca7a |
| migration-prep/shared-docs-phase-a | docs/migration-phase-a | 5acbbf2..5c73751 |
| migration-prep/shared-docs-phase-b | docs/migration-phase-b | 5c73751..8d33f5c |
| migration-prep/agent-plugins | docs/migration-phase-a | 91dea02..e3a951f |
| migration-prep/agent-plugins | docs/migration-phase-b | e3a951f..ab06a4b |

Ветки doc-B содержат doc-A. Принимать только нужную фазу после acceptance пары;
основная prep ветка .github сохраняет текущие инструкции до переноса.
Frontend/backend origin пока указывает на локальный tasks bundle, course — на
локальный course bundle. Нельзя случайно push в преподавательский main из этой подготовки.

## Истории и общий SHA

- Frontend raw import: 550af0c2ba0b80d3455911a9cb2054c10e8a4afc.
  Родители: be7933e0d4dbe77b921088f8f43497e90adcf3f9 (tasks),
  67128ed1a4092f8805732e78859ba83f23e53ea3 (course).
- Backend raw import: 0f4b657bbcb5fe9e52c92052e497827c063d4ee8.
  Родители: 4943e34d7ec8d086797be7995d62c9d471dd7510 (tasks),
  ea43353dfadd1a36d414f2d77eb5c9c58eda617b (course).
- В каждом application checkout migration/import-base указывает на raw import,
  migration/import — на конфигурационные commits поверх него.
- AUTOMATION_REF callers: b532b271f3e816fc329d46fec954ab61467e6b6e.
  Перед окном общий commit должен стать доступен в опубликованной .github;
  после исправлений общего sync обновить обе пары literal refs.
- Raw import tree равен course tree, оба исходных main — его предки. Это
  подготовительные данные, свежий import в окне пересобирается из новых bundles.

## Проверки

- Shared: telegram 134, reminders 120, close 22, sprint 47 assertions;
  Git sync 11 сценариев, CI context 11, notifier 9, workflow blocks 3,
  import 6, snapshot 9; actionlint/shellcheck.
- Frontend: Bun 1.4.2 frozen install, check, build; actionlint;
  caller matrix 4 теста / 37 assertions.
- Backend: Go 1.27.1 tidy -diff, build, make test с race (coverage 65,7%),
  make lint, make docker-build, actionlint; caller matrix 5 / 44.
  AGENTS.md — 144 строки, продуктовые исходники не менялись.
- Infra: ansible-core 2.19.7, 11 deployment tests с fake inventory/Vault/transport,
  Compose config без SSH/registry/production.
- cdd-tasks: check_docs для A/B, ручной walkthrough всех eval criteria;
  свежие application tests для A и B подтвердили карту, closing lines,
  sub-issue и обязательное review ментора.
- Реальный read-only frontend snapshot: complete manifest, полный GraphQL
  запрос прошёл. Raw данные вне Git в migration-prep/artifacts/.
  Это smoke, не baseline будущего окна.

Команды для повторной проверки после установки стандартных инструментов:

~~~bash
# .github
for suite in telegram reminders close sprint course-sync-git course-sync-context course-sync-notify course-sync-workflow course-import migration-state lint; do
  bash "tests/$suite.sh"
done
CALLER_AREA=frontend CALLER_DIR=/path/to/frontend bun test tests/team-callers.test.ts
CALLER_AREA=backend CALLER_DIR=/path/to/backend bun test tests/team-callers.test.ts
# frontend
bun install --frozen-lockfile
bun run check
bun run build
actionlint -shellcheck= -pyflakes=
# backend
go mod tidy -diff
go build ./...
make test
make lint
make docker-build
actionlint -shellcheck= -pyflakes=
# infra/ansible, deployment requirements установлены
COMPOSE_CLI='docker compose' python -m unittest discover -s tests -v
# agent-plugins, отдельно для каждой подготовленной ветки
bash plugins/cdd-tasks/tests/check_docs.sh
~~~

Windows jq не исполнялся в sandbox; shared tests выполнялись в Ubuntu/WSL.
Frontend Bun — установленный Windows binary; backend — официальный локальный
Go container, Docker build без publish. Deployment Python dependencies
установлены в отдельный --target каталог. В наших свежих infra/plugin clones
нормализованы CRLF→LF, чтобы Linux shebangs исполнялись. Системный Python не менялся.

## Что остаётся в окнах 9–10

[Runbook](team-repositories-runbook.md) задаёт свежие snapshots/bundles,
заморозку, review импорта, metadata compare/recovery, отдельные sync keys,
rulesets/env/secret настройки, CI bootstrap, sync acceptance, production,
GHCR/infra порядок и rollback. Реальные push/permissions/keys/package pull,
mentor reviews и health на production проверяются только после разрешения окна.

## Решения исполнения

Полный список Ruling из локального ledger (с ценой ошибки):

- Ruling: fallback to a manual project-local worktree after native worktree creation failed because the task host is F:/Github, not the nested repository — isolation is still provided — cost if wrong: extra local checkout only.
- Ruling: user explicitly authorized tasks 1–8 and chose executing-plans, including its required isolated workspace — no separate worktree consent needed — cost if wrong: removable local worktree.
- Ruling: run checks under local Ubuntu instead of sandboxed Git Bash: baseline Git Bash failed because Winget jq execution is denied, and Ubuntu telegram baseline passes 134/134 — matches GitHub Actions Linux — cost if wrong: Windows-only runtime differences need a separate platform check.
- Ruling: use a relative .git pointer in this worktree so Windows and Ubuntu Git resolve the same common directory — no tracked file or remote change — cost if wrong: repairable worktree discovery metadata.
- Task 3: Ruling: add tests/course-sync-workflow.sh and a minimal inline failure notifier fallback — checkout failure would otherwise make the notifier script unavailable; also exercise key cleanup on failure — cost if wrong: a small duplicated notification payload to maintain.
- Task 5: Ruling: retain the planned Bash CLI but implement structured snapshot/pagination/compare in Python standard-library modules, with a Bash test entrypoint — nested JSON and nullable field values are clearer and safer without shell quoting — cost if wrong: local snapshot tooling requires Python 3.
- Ruling: normalize the plan marker to a repository-relative path and consolidate completion records from the Windows/Ubuntu spellings of this same plan — both marker identities and git log were checked; no tasks are repeated — cost if wrong: incorrect resume state, mitigated by verified commit ranges.
- Task 6: Ruling: user-authorized local plan execution takes precedence over inherited CLAUDE instructions to avoid Git and pause between stages — commits and continuous local preparation are explicit plan steps — cost if wrong: local commits can be discarded; no remote write.
- Task 6: Ruling: add shared Bun-native YAML caller matrix tests for both applications — verifies PR/main/flags and credential boundaries without new dependencies — cost if wrong: running this optional cross-check requires Bun.
- Task 7: Ruling: normalize LF checkout endings only in fresh local infra/plugin clones; use pinned deployment libraries in an isolated --target directory and an ephemeral official Go container with /app safe.directory — Windows CRLF broke the fake Docker shebang, host Ansible was too old, and ensurepip was absent — cost if wrong: tests differ from Windows execution; no repository content beyond intended edits or system Python configuration changes.
- Task 8: Ruling: treat cdd-tasks edits as a reference-map migration and test the prior version plus fresh phase-A/phase-B application scenarios, without five wording-pressure repetitions — discipline rules are unchanged and reference tests use retrieval/application, not persuasion micro-tests — cost if wrong: one sample per phase gives limited stochastic assurance; final whole-change review remains.

