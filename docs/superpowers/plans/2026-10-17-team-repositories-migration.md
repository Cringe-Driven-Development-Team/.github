# Team Repositories Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** перенести разработку фронта и бэка в существующие репозитории команды с сохранением задач и истории и автоматическим обновлением учебного `main`.

**Architecture:** общий reusable workflow проверяет происхождение кандидата CI и отправляет его в фиксированный учебный репозиторий обычным fast-forward push. Истории приложения и заглушки объединяются локально, затем принимаются migration PR с ревью. Настройки, metadata и production переключаются по runbook: сначала frontend, затем backend; синхронизация и deploy включаются отдельно.

**Tech Stack:** Git, GitHub Actions, Bash, jq, GitHub CLI, Projects v2 GraphQL; существующие Bun/Turborepo, Go/Docker/GHCR и Ansible. Тесты shared scripts — существующий подход с Bash и заглушками; без нового тестового фреймворка.

**Spec:** [2026-10-17-team-repositories-migration-design.md](../specs/2026-10-17-team-repositories-migration-design.md). Вызов пользователем writing-plans разрешает подготовку этого плана; согласование преподавателей и разрешение на переключение ещё не получены.

## Global Constraints

- «Использовать существующие репозитории `frontend` и `backend`, сохранив их задачи и номера».
- «Копируется история, достижимая из выбранного коммита `main`, включая исходные авторские и merge-коммиты».
- «Ветки разработки, теги, releases, PR, апрувы, обсуждения, checks и артефакты Actions не синхронизируются».
- «Файлы `.github/workflows` входят в дерево и копируются без изменений».
- «Переписывать старые SHA и применять force push не требуется». Не использовать `git push --mirror`, squash/rebase при импорте и пересоздание репозиториев.
- Фиксированная карта: `Cringe-Driven-Development-Team/frontend` → `frontend-park-mail-ru/2026_2_Cringe_Driven_Development`; `Cringe-Driven-Development-Team/backend` → `go-park-mail-ru/2026_2_Cringe_Driven_Development`.
- «Успех deploy/upload не является дополнительным условием». Sync фронта зависит от `check`, бэка — от `lint`, `test`, `docker`.
- «Переключатели — `PRODUCTION_ENABLED` и `COURSE_SYNC_ENABLED`, только строка `true` включает действие, отсутствие означает выключенное состояние».
- «Приватная часть хранится только в соответствующем основном репозитории как `COURSE_SYNC_SSH_KEY`». Для двух назначений используются разные deploy keys.
- «Создание ключей и секретов, изменение правил, push кода, отключение Actions и переключение production выполняются после согласования преподавателей и отдельного разрешения пользователя на миграцию».
- До этой границы задачи 1–8 выполняются локально: без публикации PR, запуска удалённых workflow и изменений GitHub settings. Задачи 9–10 — фактический rollout.
- Сохранять обязательное ревью; существующий персональный bypass не использовать как разрешение на обход правил. Одно разрешённое окно миграции включает предусмотренные им проверки и восстановление, без повторного запроса на каждое штатное действие.

## Review Focus

- Устаревший запуск после более нового успешного sync: учебный `main` не откатывается — тест `stale_run_is_noop`, задача 1.
- В учебный `main` независимо добавили коммит, даже поверх кандидата: чужое изменение не признаётся успешной синхронизацией — тест `unknown_descendant_is_divergence`, задача 1.
- CI run из PR/чужого репозитория или проверка, упавшая при повторе: нельзя принять непроверенный SHA по старому зелёному результату — тесты `reject_untrusted_run` и `latest_job_results_win`, задача 2.
- При импорте исторический `Closes #N` изменил существующую задачу и карточку: расхождение обнаруживается, исходные поля можно восстановить — тест `import_side_effects_are_reported`, задача 5.
- Новый job завершился ошибкой, а Telegram недоступен: sync остаётся красным, stdout/stderr не раскрывают ключ или токен — тест `notification_failure_is_visible_without_secrets`, задача 3.

---

## Рабочие каталоги, файлы и порядок

Основной локальный репозиторий документации: `F:/Github/cringe-driven-development-team/.github`, текущая ветка `docs/team-repositories-migration-design`. Перед реализацией execution skill создаёт изолированный checkout/worktree. Каталоги `2026_H2__archive` — исторические копии; не использовать их как актуальный исходник и не изменять.

Ниже `.github:`, `frontend:`, `backend:`, `infra:` и `agent-plugins:` означают корни одноимённых репозиториев `Cringe-Driven-Development-Team`. Источник кода для импорта — актуальный учебный `main`, а не содержимое нынешней заглушки. Для каждой новой копии прочитать её актуальные `AGENTS.md`/`CLAUDE.md`, проверить remote, ветку и чистоту; чужие незакоммиченные изменения не трогать.

| Файлы | Ответственность |
|---|---|
| `.github:scripts/course-sync-git.sh`, `tests/course-sync-git.sh` | Только Git-алгоритм и проверка ancestry/ref; настоящие локальные bare-репозитории в тестах |
| `.github:scripts/course-sync-context.sh`, `tests/course-sync-context.sh` | Фиксированная карта репозиториев и валидация CI run/его последней попытки через read-only API |
| `.github:.github/workflows/sync-to-course.yml`, `scripts/course-sync-notify.sh`, `tests/course-sync-notify.sh` | Доверенная обвязка, SSH, concurrency и сообщение о сбое |
| `.github:scripts/prepare-course-import.sh`, `tests/course-import.sh` | Локальное объединение двух bundle-историй без push |
| `.github:scripts/migration-state.sh`, `scripts/migration-project.graphql`, `tests/migration-state.sh` | Снимок metadata/настроек и сравнение; без автоматического восстановления |
| `.github:docs/migrations/team-repositories-runbook.md` | Пошаговое окно переключения, восстановление полей и откат |
| `frontend:.github/workflows/{ci,cd,rollback,sync-to-course}.yml`, `README.md`, `CLAUDE.md` | Новый источник разработки, ограничения запуска, ручной повтор sync |
| `backend:.github/workflows/{ci,cd,sync-to-course}.yml`, `README.md`, `AGENTS.md` | Новый источник разработки и deploy; `contract-drift.yml` сохраняется |
| `infra:ansible/roles/app/defaults/main.yml`, `ansible/tests/test_deploy.py`, `ansible/README.md`, `RUNBOOK.md` | Новый registry path и проверенный путь возврата к старому образу |
| `.github:scripts/reminders.sh`, `tests/reminders.sh`, `README.md`, `CONTRIBUTING.md`, `profile/README.md` | Мониторинг активных репозиториев и текущие правила задач |
| `agent-plugins:plugins/cdd-tasks/skills/cdd-tasks/{SKILL,REFERENCE}.md`, `tests/check_docs.sh`, `evals/multi-repo-task/{prompt.md,graders/criteria.md}` | Актуальная карта задач/PR и проверка сценария нескольких репозиториев |

Зависимости: 1 и 2 → 3; 4 и 5 → runbook; 3 и 4 → 6/7; 6/7 и 5 → 8; затем 9 → 10. Это одна связанная миграция: отдельно работающий sync не означает готовность production к переключению. Каждая задача 1–8 заканчивается локальным коммитом в соответствующем репозитории; ветки не публикуются до разрешённого окна.

Shell-команды ниже исполняются в Git Bash либо Linux, не через Windows `bash.exe`, который может открыть WSL. Нужны Git, Bash, jq, gh, GNU date, perl/awk, actionlint и shellcheck. На Windows выбирать установленный Git Bash явно; не менять глобальные конфиги и `$HOME`. Значения, прочитанные из `gh`/`jq`, очищать от CR перед сравнением. JSON и многострочные PR bodies передавать файлами. Для долгих проверок использовать вывод/сессию процесса, а не молча блокировать интерфейс.

### Task 1: Git-синхронизация одного проверенного коммита

**Files:** Create `.github:scripts/course-sync-git.sh`, `.github:tests/course-sync-git.sh`.

**Interfaces:**
- Consumes: `bash scripts/course-sync-git.sh BARE_DIR CANDIDATE_SHA`; в bare repo настроены remotes `origin` (основной) и `course` (назначение); внешняя обвязка задачи 3 задаёт только проверенные URL.
- Produces: exit 0 и JSON `{result,source_sha,course_sha}`, где `result` — `updated`, `unchanged` или `superseded`; ошибка — exit 1, диагностика в stderr. `source_sha` означает кандидата. Ref назначения — только `refs/heads/main`.
- Tests: локальные source/course bare repos, runner repo и коммиты A→B→C; `run_sync SHA` сохраняет exit status в `code`, stdout в файл `out`. Все test remotes — локальные, credentials не нужны.

- [ ] **Step 1: Написать красные `fast_forward_preserves_other_refs`, `same_sha_is_noop`, `stale_run_is_noop`.** Проверить B после A, повтор B, затем B после уже принятого C; отдельные ветка и тег course остаются прежними. Ключевые assertions:
  ```bash
  [ "$code" -eq 0 ]
  [ "$(jq -r .source_sha "$out")" = "$candidate" ]
  [ "$(git --git-dir="$course" rev-parse refs/heads/main)" = "$expected" ]
  ```
  В stale-сценарии `.result == "superseded"`, expected=C; равенство refs кроме main сравнить с сохранённым выводом `for-each-ref`.
- [ ] **Step 2: Запустить `bash tests/course-sync-git.sh`.** Expected: FAIL из-за отсутствующего production script, не из-за Git identity или setup фикстуры. Identity задаётся локально тестовым репозиториям.
- [ ] **Step 3: Реализовать CLI.** Fetch полной истории обоих main, проверить 40 hex и принадлежность кандидата основному main, затем применить порядок проверок из §5 спеки. Отправка — один явный refspec, без force. Никакой проверки/запуска файлов продукта.
- [ ] **Step 4: Добавить красные `unknown_descendant_is_divergence`, `unrelated_main_is_divergence`, `candidate_outside_source_main`, `failed_push_keeps_target`, `post_push_race_is_classified`.** Даже если candidate — предок course, неизвестный source commit даёт exit 1. Отклонение receive-hook и сетевой сбой сохраняют target; после записи заново прочитать ref и допустить только точный SHA либо известного source-потомка. Во всех отказах refs назначения равны снимку, кроме намеренно внесённого конкурентного изменения.
- [ ] **Step 5: Дополнить реализацию для новых отказов и проверки ref после push.** Устаревший запуск завершается без записи, неизвестный потомок всегда является ошибкой.
- [ ] **Step 6: Выполнить `bash tests/course-sync-git.sh` и `shellcheck -s bash scripts/course-sync-git.sh tests/course-sync-git.sh`.** Expected: все сценарии PASS, lint без ошибок.
- [ ] **Step 7: Локальный коммит.** `git add scripts/course-sync-git.sh tests/course-sync-git.sh`, затем `git commit -m 'feat: add fast-forward course synchronization'`.

### Task 2: Проверка CI-кандидата и фиксированного назначения

**Files:** Create `.github:scripts/course-sync-context.sh`, `.github:tests/course-sync-context.sh`.

**Interfaces:**
- Consumes: `bash scripts/course-sync-context.sh SOURCE_REPO CI_RUN_ID EXPECTED_SHA`, `GH_TOKEN` с `actions:read`; только GET API.
- Produces: exit 0 и JSON `{source,target,sha,run_id,run_attempt}` либо exit 1. Repo map — из Global Constraints. Входной SHA — ровно 40 hex; run id — положительное десятичное целое.
- Required jobs API names: frontend — `Check`; backend — `lint`, `test`, `docker`. Job IDs YAML: `check` и `lint/test/docker` соответственно.

- [ ] **Step 1: Написать `valid_frontend`, `valid_backend_without_deploy_success`, `reject_untrusted_run`, `latest_job_results_win`, `sync_only_rerun_inherits_successful_dependencies`, `missing_or_skipped_check`, `invalid_inputs_do_not_call_api`, `api_pagination_and_crlf`, `attempt_changes_during_read`.** `gh` подменён фиксированными ответами и журналом. Успех backend проверяется при failed deploy, но успешных lint/test/docker. Если Check упал в attempt=2, его успех attempt=1 не учитывается; если в attempt=2 повторяется только sync, не повторённый успешный Check attempt=1 остаётся действительным для того же run/SHA. Проверить обе строки карты и отказ третьему repo; смена attempt между двумя чтениями metadata даёт exit 1.
  ```bash
  [ "$code" -eq 0 ]
  [ "$(jq -r .target "$out")" = 'go-park-mail-ru/2026_2_Cringe_Driven_Development' ]
  [ "$(jq -r .sha "$out")" = "$candidate" ]
  ```
  Для отказов `[ "$code" -ne 0 ]`; журнал не содержит PATCH/POST/PUT/DELETE. Успех требует для каждой обязательной job ровно одну запись в её последнем attempt, где она запускалась, с conclusion=success.
- [ ] **Step 2: Запустить `bash tests/course-sync-context.sh`.** Expected: FAIL из-за отсутствующего selector.
- [ ] **Step 3: Реализовать CLI.** Получить `/repos/SOURCE/actions/runs/ID`, сверить source/head repository, event=`push`, head_branch=`main`, head_sha и workflow_id с `/actions/workflows/ci.yml`. Читать jobs `/actions/runs/ID/attempts/ATTEMPT/jobs?per_page=100` со всеми страницами, начиная с текущего run_attempt и спускаясь до 1 только для ещё не найденных обязательных jobs. Для каждого имени выбирается последний attempt с записью; skipped/failed/cancelled не заменять прежним успехом. Это позволяет повторить только sync без повторного build/deploy. Текущий run может быть in_progress; выбранные обязательные jobs уже должны завершиться успешно. Общий conclusion run не использовать как условие; после чтения подтвердить, что run_attempt и SHA не сменились, иначе отказать до push.
- [ ] **Step 4: Запустить тесты и shellcheck обоих файлов.** Expected: PASS; отказ при fork/PR, чужом workflow, неизвестном репозитории, отсутствующей/дублированной/skipped job, смене attempt во время чтения и 403/502. Новый неуспех проверки доминирует над старым успехом; неповторённая успешная dependency того же CI run остаётся допустимой.
- [ ] **Step 5: Локальный коммит.** `git add scripts/course-sync-context.sh tests/course-sync-context.sh`, затем `git commit -m 'feat: verify course sync candidates against CI'`.

### Task 3: Reusable workflow, SSH и сообщение о сбое

**Files:** Create `.github:.github/workflows/sync-to-course.yml`, `.github:scripts/course-sync-notify.sh`, `.github:tests/course-sync-notify.sh`; Modify `.github:README.md` — новый раздел подключения sync. Existing `.github:tests/lint.sh` уже проверяет все `scripts/*.sh` и workflow blocks, менять его без необходимости не нужно.

**Interfaces:**
- Consumes: задачи 1–2; `workflow_call.inputs` string `sha`, `ci_run_id`, `automation_ref` — все required. Secrets: `COURSE_SYNC_SSH_KEY`, `TELEGRAM_BOT_TOKEN`. Caller vars: `COURSE_SYNC_ENABLED`, `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ID`.
- Produces: job `sync`, отдельная concurrency-группа `course-sync-<github.repository>`, cancel-in-progress=false; exit status Git-core сохраняется. `AUTOMATION_REF` — полный SHA локального коммита этой задачи; в rollout его достижимость из опубликованного `.github/main` подтверждается перед использованием.
- Notifier: `bash scripts/course-sync-notify.sh SOURCE_REPO SHA RUN_URL`; env `TOKEN`, `CHAT`, `TOPIC`. Одно plain-text сообщение, exit 0 только при HTTP success и Telegram `.ok == true`; без повторной отправки внутри скрипта.

- [ ] **Step 1: Написать `one_failure_message`, `telegram_false_is_error`, `missing_token_is_error`, `notification_failure_is_visible_without_secrets` по образцу `tests/lib.sh`/`tests/stub-curl.sh`.** Фиктивные token/key и chat=-100/topic=26. Проверить ровно один вызов, repo/SHA/run link в тексте, ненулевой exit при transport error или `.ok=false`, отсутствие значений credentials в stdout/stderr.
- [ ] **Step 2: Запустить `bash tests/course-sync-notify.sh`.** Expected: FAIL до реализации notifier.
- [ ] **Step 3: Реализовать notifier по указанному CLI.** Plain-text payload без parse_mode, secrets только из env, nonzero при недоступном Telegram и отсутствие credentials в диагностике.
- [ ] **Step 4: Запустить `bash tests/course-sync-notify.sh`.** Expected: PASS для обычного сообщения, отсутствующего токена, HTTP error и `.ok=false`.
- [ ] **Step 5: Реализовать workflow.** Проверить repo/ref/flag и формат inputs, затем checkout только `.github` по `automation_ref` в `automation/`, persist-credentials=false; использовать `actions/checkout@v4`, как в existing shared workflows. Значение ref — доверенный literal commit SHA caller, не application head. Контексты и inputs передаются скриптам через env и quoted arguments, без прямой подстановки текста в shell code. Запустить context selector до использования SSH; создать временный bare repo, origin по source, course по target selector, вызвать Git-core. Права — `contents:read`, `actions:read`, без production environment. Закрытый SSH key-файл создаётся с umask=077 только для push и удаляется always; GitHub host key берётся из официального источника и закрепляется в обвязке. При failure отправить уведомление, при ошибке самого уведомления оставить заметную ошибку; не превращать основной сбой в success.
- [ ] **Step 6: Выполнить три новых тестовых файла, `bash tests/lint.sh` и существующие `telegram.sh`, `reminders.sh`, `close.sh`, `sprint.sh`.** Expected: все PASS. На review явно проверить: нет запуска на PR, secret не передаётся продуктовым скриптам, flag отсутствует → job skipped, concurrency не совпадает с CI-группой. Чужой `automation_ref` не должен поступать из входов ручного запуска; caller materializes SHA этой задачи.
- [ ] **Step 7: Локальный коммит и запись интерфейса.** `git add .github/workflows/sync-to-course.yml scripts/course-sync-notify.sh tests/course-sync-notify.sh README.md`, затем `git commit -m 'feat: add reusable course synchronization workflow'`; `git rev-parse HEAD` сохранить как `AUTOMATION_REF` в локальном журнале подготовки. При публикации использовать merge с сохранением этого SHA; если код задач 1–3 позже исправляется, пересчитать ref и обновить оба caller literal до rollout.

### Task 4: Локальный импорт двух историй

**Files:** Create `.github:scripts/prepare-course-import.sh`, `.github:tests/course-import.sh`.

**Interfaces:**
- Consumes: `bash scripts/prepare-course-import.sh COURSE_BUNDLE TASKS_BUNDLE OUTPUT_DIR`; оба bundle содержат `refs/heads/main`, OUTPUT_DIR ещё не существует. Существующие checkout не меняются.
- Produces: новый локальный checkout с веткой `migration/import`, дерево которой совпадает с course/main; stdout — SHA нового merge-коммита, первый parent tasks/main, второй course/main. Любая ошибка — nonzero. Remotes пока указывают только на локальные bundles; push отсутствует.

- [ ] **Step 1: Написать `unrelated_roots_preserve_history_and_tree`, `existing_output_is_untouched`, `missing_main_or_broken_bundle_fails`, `authors_are_not_rewritten`.** Фикстуры содержат разные README и workflow. Проверить:
  ```bash
  git -C "$output" merge-base --is-ancestor "$tasks_sha" HEAD
  git -C "$output" merge-base --is-ancestor "$course_sha" HEAD
  [ "$(git -C "$output" rev-parse HEAD^{tree})" = "$course_tree" ]
  [ "$(git -C "$output" rev-parse HEAD^1)" = "$tasks_sha" ]
  [ "$(git -C "$output" rev-parse HEAD^2)" = "$course_sha" ]
  ```
  Сравнить author/committer исходных объектов и SHA всех refs исходных репозиториев до/после.
- [ ] **Step 2: Запустить `bash tests/course-import.sh`.** Expected: FAIL из-за отсутствующего helper.
- [ ] **Step 3: Реализовать helper.** Проверить bundles и отсутствие output, импортировать объекты, создать merge через `git commit-tree COURSE_TREE -p TASKS_SHA -p COURSE_SHA`, переключить `migration/import`. Не восстанавливать конфликты эвристикой, не запускать приложение и не подключать live remote. Только новый merge-коммит получает новую identity/date.
- [ ] **Step 4: Запустить тесты и shellcheck.** Expected: PASS; повтор с тем же output отказывает, не удаляя содержимое. Пользовательские пути с пробелами входят в фикстуру.
- [ ] **Step 5: Локальный коммит.** `git add scripts/prepare-course-import.sh tests/course-import.sh`, затем `git commit -m 'feat: prepare repository history imports from bundles'`.

### Task 5: Снимки задач, доски и настроек; runbook восстановления

**Files:** Create `.github:scripts/migration-state.sh`, `.github:scripts/migration-project.graphql`, `.github:tests/migration-state.sh`, `.github:docs/migrations/team-repositories-runbook.md`.

**Interfaces:**
- Consumes: `bash scripts/migration-state.sh snapshot PRIMARY_REPO COURSE_REPO OUTPUT_DIR` и `bash scripts/migration-state.sh compare BEFORE_DIR AFTER_DIR`. Snapshot выполняет только read-only запросы; compare не обращается к GitHub и ничего не восстанавливает.
- Produces: schema_version=1 в `manifest.json`; raw `issues.json`, `subissues.json`, `project.json`, `settings-primary.json`, `settings-course.json`; canonical `state.json` и diff JSON `{issues,relations,project}`. Compare exit=0 при равенстве, 1 при изменениях, 2 при неполном/невалидном snapshot.
- State: issue number/id/title/body/state/state_reason, отсортированные assignee logins/label names; пары parent/sub-issue IDs; item ID/content issue ID и field ID/type/value. Project №1, org `Cringe-Driven-Development-Team`; mutable значения single-select, iteration, text, number, date сохраняются с option/iteration IDs, включая отсутствие значения. Settings сохраняются отдельно и не участвуют в сравнении metadata, поскольку их изменение ожидается.

- [ ] **Step 1: Написать `import_side_effects_are_reported`, `order_and_updated_at_are_ignored`, `missing_page_or_failed_api_is_incomplete`, `unchanged_relations_are_preserved`, `empty_project_field_is_not_zero`.** Фикстура: issue#12 open→closed/completed, Status→Done, Sprint сменился; compare возвращает 1 и точные issue/item/field IDs с before/after. Пустое значение отличается от number=0. Parent в другом репозитории и внешняя sub-issue входят в снимок. PR из REST issues не входит в state; новые migration PR не создают ложную разницу.
- [ ] **Step 2: Запустить `bash tests/migration-state.sh`.** Expected: FAIL до реализации.
- [ ] **Step 3: Реализовать snapshot/compare и GraphQL query.** Полная пагинация issues; связи собирать через `Issue.parent { id }` и `Issue.subIssues` с пагинацией, чтобы сохранить входящие связи из других репозиториев. Projects items читать с pageInfo/totalCount, fieldValues и конфигурацией single-select/iteration. Проверить полноту страниц и вложенных collections; при невозможности выгрузить все данные завершиться ошибкой, а не писать successful manifest. Settings включают repository IDs/default branch, Actions permissions, все rulesets с деталями, branch protection (404=нет), environments/branch policies/protection rules, имена секретов и vars, collaborators/permissions. Значения secrets не запрашиваются и не сохраняются. Compare нормализует только описанные поля, без timestamps и системного timeline.
- [ ] **Step 4: Написать runbook с таблицей двух пар и последовательностью §9 спеки.** Включить точные API/CLI действия: snapshot; git clone --mirror и bundle create --all/verify; инвентаризация branches/PR/job; чтение и переключение Actions permissions; two-parent import; PR body через файл; правила review/checks; ключи/env/vars; включение flags; SHA/health checks. Артефакты — вне Git checkout, например `F:/Github/migration-artifacts/YYYY-MM-DD/frontend` и `/backend`; даты и SHA берутся в окне, не из старого плана.
- [ ] **Step 5: Дописать восстановление metadata и откат в runbook.** Для случайного закрытия — PATCH issue сохранёнными state/state_reason через JSON body file; для project fields — `updateProjectV2ItemFieldValue`, для исходно пустого значения — `clearProjectV2ItemFieldValue`, IDs только из snapshot. Изменение body/assignees/sub-issues не восстанавливать массово молча: это нарушение окна, которое оператор разбирает по diff. До/после восстановления повторить snapshot/compare. Для Git-отката восстановить сохранённое course-дерево новым review-коммитом; после новых рабочих merge сохранить всю принятую историю, отключить новые writers и только затем возвращать старые. Отдельно описать stable rollback и старый GHCR path/credential.
- [ ] **Step 6: Запустить `bash tests/migration-state.sh`, `bash tests/course-import.sh`, `bash tests/lint.sh`.** Expected: PASS; само-review runbook по сценарию «import прошёл, metadata поменялась, sync запрещён сервером»: работа не открывается до сверки, новые production writers выключены, старый runtime остаётся доступным. Для GET, который вернул 403, нет продолжения с пустым snapshot.
- [ ] **Step 7: Локальный коммит.** Добавить пять файлов этой задачи; `git commit -m 'feat: add migration snapshots and recovery runbook'`.

### Task 6: Подготовить frontend к работе в организации команды

**Files:** Modify `frontend:.github/workflows/ci.yml` (jobs check/upload), `.github/workflows/cd.yml` (job cd), `.github/workflows/rollback.yml` (job rollback), `README.md`, `CLAUDE.md`; Create `frontend:.github/workflows/sync-to-course.yml` (ручной повтор).

**Interfaces:**
- Consumes: локальный checkout задачи 4 для frontend, shared SHA `AUTOMATION_REF` задачи 3, workflow inputs из задачи 3.
- Produces: CI `Check` без переименования, job `course-sync` с needs=[check], ручной workflow с единственным string input `ci_run_id`. Production S3/CDN API и existing release CLI остаются прежними.

- [ ] **Step 1: Подготовить локальные bundles актуальных source/task main и выполнить helper задачи 4.** Read-only fetch разрешён только в чистых task checkout. Записать оба исходных SHA и результат, проверить ancestry/tree. Результирующий checkout пока связан с локальными bundles.
- [ ] **Step 2: Внести workflow-изменения.** `check` работает на PR и main. `upload`, `cd`, `rollback` требуют точный repo `Cringe-Driven-Development-Team/frontend`, ref main и `PRODUCTION_ENABLED == 'true'`; upload дополнительно push. `course-sync` требует тот же repo/ref, push и `COURSE_SYNC_ENABLED == 'true'`, needs=check, не upload. В `uses` и `with.automation_ref` записать literal 40-char `AUTOMATION_REF`, а не expression/заглушку. Передавать только два secrets задачи 3, permissions contents:read/actions:read.
- [ ] **Step 3: Добавить ручной повтор.** Ограничить main/repo/COURSE_SYNC_ENABLED. Job `resolve` читает head_sha указанного run через GET; следующий job вызывает тот же reusable workflow с этим sha и run id. Повторная полная валидация остаётся в shared selector. Нет пользовательского input для SHA, target или automation_ref; повтор не вызывает deploy/upload.
- [ ] **Step 4: Обновить README/CLAUDE.md.** Код/PR/issues теперь вместе; `Closes #N`, `web-N`, ревью ментора; учебная ссылка обозначена копией main. Сохранить команды Bun monorepo и описание S3 release/rollback. Не менять release-реализацию ради этой миграции.
- [ ] **Step 5: Выполнить `bun install --frozen-lockfile`, `bun run check`, `bun run build`, `actionlint -shellcheck= -pyflakes=`.** Expected: success. Review матрица: PR→только проверки; flags отсутствуют→без side effects; sync=true/production=false→sync разрешён; upload failure не является dependency sync; manual повтор→без S3 write. Проверить `git diff` на отсутствие продуктовых изменений и секретов.
- [ ] **Step 6: Локальный коммит в `migration/import`.** Добавить перечисленные workflow/doc файлы, включая новый ручной workflow; `git commit -m 'ci: prepare frontend development in team organization'`. Записать SHA ветки для последующего review; не публиковать и не включать Actions.

### Task 7: Подготовить backend и infra к новому GHCR namespace

**Files:** Modify `backend:.github/workflows/ci.yml` (docker/deploy и новый course-sync), `.github/workflows/cd.yml` (job deploy), `README.md`, `AGENTS.md`; Create `backend:.github/workflows/sync-to-course.yml`; Modify `infra:ansible/roles/app/defaults/main.yml`, `ansible/tests/test_deploy.py`, `ansible/README.md`, `RUNBOOK.md` в отдельной локальной ветке.

**Interfaces:**
- Consumes: задачи 3–5; backend checkout из helper, `AUTOMATION_REF`; существующие `backend_image_tag` и `app_backend_image` Ansible.
- Produces: `ghcr.io/cringe-driven-development-team/backend`, теги `sha-<short>` и `main` без latest, CI job names lint/test/docker сохраняются; новый course-sync needs=[lint,test,docker]. Существующие SSH/Vault/health checks не меняются.

- [ ] **Step 1: Подготовить backend import checkout по задаче 4 и чистую локальную ветку infra.** Сохранить SHA; прочитать актуальные инструкции. Изменения infra не публиковать и не вливать заранее: старый deploy сейчас читает infra@main и должен оставаться работоспособным.
- [ ] **Step 2: Добавить красный `test_registry_switch_and_explicit_rollback_image` в существующий `infra:ansible/tests/test_deploy.py`.** Загрузить defaults и отрендерить существующий compose template тестовым inventory: default api image должен быть `ghcr.io/cringe-driven-development-team/backend:sha-1234567`; явный override старого path должен давать `ghcr.io/go-park-mail-ru/2026_2_cringe_driven_development:sha-1234567`. Не обращаться к настоящему registry/SSH и не менять volume names.
- [ ] **Step 3: Выполнить из `infra:ansible` `COMPOSE_CLI='docker compose' python -m unittest discover -s tests -v`.** Expected: только новый registry assertion FAIL. Использовать deployment Python environment и существующие requirements; fake Docker stub — по образцу текущих tests.
- [ ] **Step 4: Обновить default `app_backend_image` и backend workflows.** В metadata-action явно получить нижний регистр нового path, сохранить image source label нового repo. Login/push Docker требуют точный основной repo/main/push; PR продолжает build без publish. Deploy в caller и reusable cd требует repo/main/push/PRODUCTION_ENABLED. Sync требует отдельный COURSE_SYNC_ENABLED, не depends deploy. Добавить ручной повтор с тем же интерфейсом, что задача 6. Не отдавать registry/Vault секреты в sync job и не менять contract-drift implementation.
- [ ] **Step 5: Обновить backend README/AGENTS.md и infra runbooks.** Новый origin/issues/Closes #N/api-N, GHCR path, APIDOG_TOKEN, production secrets; для отката точный old path вместе с old sha-tag и read credentials. Найти `app_backend_image` overrides через `rg -n 'app_backend_image|go-park-mail-ru/2026_2_cringe_driven_development' ansible` и учесть каждый активный override; архивные спеки не переписывать. AGENTS.md остаётся не длиннее 150 строк.
- [ ] **Step 6: Выполнить Ansible-тесты повторно; в backend — `go mod tidy -diff`, `go build ./...`, `make test`, `make lint`, `make docker-build`, `actionlint -shellcheck= -pyflakes=`.** Expected: PASS, только локальная сборка без publish. Сверить матрицу flags и независимость sync/deploy как у frontend. Production registry push/pull остаётся проверкой окна задачи 10.
- [ ] **Step 7: Локальные коммиты в двух репозиториях.** Backend: `git commit -m 'ci: prepare backend development in team organization'`; infra: `git commit -m 'deploy: prepare team backend image and rollback'`. Добавлять только перечисленные изменённые файлы, не snapshots/credentials.

### Task 8: Подготовить мониторинг и переход правил задач

**Files:** Modify `.github:scripts/reminders.sh`, `tests/reminders.sh`, `.github/workflows/reminders.yml`, `README.md`, `CONTRIBUTING.md`, `profile/README.md`, `docs/migrations/team-repositories-runbook.md`; Modify `agent-plugins:plugins/cdd-tasks/skills/cdd-tasks/SKILL.md`, `REFERENCE.md`, `tests/check_docs.sh`, `evals/multi-repo-task/prompt.md`, `evals/multi-repo-task/graders/criteria.md`.

**Interfaces:**
- Consumes: роли/флаги из задач 3,6,7; per-pair phase из runbook.
- Produces: `COURSE_MIGRATED_REPOS` — JSON-array caller var в `.github` со значениями `[]`, `["frontend"]` либо `["frontend","backend"]`; отсутствие означает []. Это только мониторинговый сигнал о завершённом переключении, не новый источник истины для sync/deploy. На его основе старые учебные репозитории исключаются из active REPOS, а у соответствующих основных дополнительно проверяются `ci.yml` и ручной `sync-to-course.yml`. Содержимое прочих REPOS не меняется.

- [ ] **Step 1: Добавить красные сценарии `only_frontend_migrated`, `both_pairs_migrated`, `sync_failure_is_reported`, `manual_sync_failure_is_reported`, `invalid_phase_is_warning` в существующий reminders test.** Fixture фронта migrated: запросов к frontend-park нет, go-park остаётся; у team/frontend проверяются CI и ручной sync. Ошибка CI с course-sync job или ручного sync даёт ссылку в ops; неверный JSON не исключает учебные репозитории молча. Свежие failures не повторяются вне существующего SINCE окна.
- [ ] **Step 2: Запустить `bash tests/reminders.sh`.** Expected: новые phase/CI tests FAIL, существующие не менять ради прохождения новых.
- [ ] **Step 3: Реализовать phase-aware REPOS и дополнительный WFS список в reminders.sh, передать var из reminders.yml.** Сохранить структуру existing reminders и обычные telemetry jobs. Срок PAT после завершения обеих пар описывает обновление org secret, не уже выключенных учебных consumers. Общий job close не удалять.
- [ ] **Step 4: Подготовить поэтапную документацию и cdd-tasks.** До frontend rollout активные инструкции остаются старыми. Подготовить два небольших doc-коммита: A переводит только frontend на same-repo PR/Closes #N, B затем backend. Промежуточная карта обязана поддерживать смешанное состояние. Исторические спеки не переписывать; в текущих README дать ссылку на новую схему. При фактическом редактировании SKILL.md применить инструкции writing-skills; эта задача плана сама по себе skill ещё не меняет.
- [ ] **Step 5: Адаптировать existing check_docs и eval.** После A сценарий multi-repo-task начинает работу в `Cringe-Driven-Development-Team/frontend`, infra остаётся sub-issue, оба PR закрывают свои задачи короткими ссылками, infra merge раньше frontend; обязательное ревью сохраняется. После B аналогично карта backend. Проверки могут требовать наличие учебных ссылок как копий, но не старый Closes как единственный способ работы.
- [ ] **Step 6: Запустить `bash tests/reminders.sh`, `bash tests/lint.sh`, все существующие shared tests; в agent-plugins — `bash plugins/cdd-tasks/tests/check_docs.sh`.** Expected: PASS для фаз A/B; вручную пройти eval по criteria без записи в GitHub. Не создавать новые тесты, которые лишь дублируют формулировки документа.
- [ ] **Step 7: Сохранить локальные коммиты.** Отдельно backward-compatible monitoring, doc-A и doc-B в `.github`/agent-plugins; записать SHA каждого в runbook prep journal. Публикация соответствующего doc-коммита только после принятия пары в задачах 9/10. Финальную карту с обоими migrated не выкатывать заранее.

### Task 9: Выполнить разрешённое окно frontend

**Files:** Использовать `.github:docs/migrations/team-repositories-runbook.md`; создать вне checkout `migration-artifacts/ACTUAL_DATE/frontend/operations.md` и snapshots/bundles. Изменить только GitHub settings и reviewed branches, перечисленные в runbook.

**Interfaces:**
- Consumes: завершённые задачи 1–8; явное согласование преподавателей; разрешение пользователя на окно миграции; доступ ментора к новому frontend; секреты из исходного хранилища. Без этих условий задача остаётся невыполненной, локальная подготовка сохраняется.
- Produces: frontend основной у команды, учебный main синхронизирован, production работает только из team repo; phase=["frontend"], backend пока по старой схеме.

- [ ] **Step 1: Проверить условия и зафиксировать окно.** Остановить merge/deployment writers, дождаться активных runs. Прочитать актуальные SHA, PR, рабочие ветки, rulesets и environments; при новых открытых PR не продолжать до штатного решения. Snapshot pre, bundles --all/verify и protected backup refs; source code SHA отличается от подготовленного → пересобрать import по задачам 4/6 и повторить проверки. Не отменять чужую работу автоматически.
- [ ] **Step 2: Подготовить общую автоматизацию и доступ.** После review опубликовать и принять shared изменения 1–5/monitoring без будущей карты задач; подтвердить доступность literal AUTOMATION_REF из `.github/main`. Создать отдельный frontend deploy key и согласованное исключение для sync, сохранить приватную часть как COURSE_SYNC_SSH_KEY в team/frontend. Подготовить production env, S3 secrets/vars и доступ к Telegram/project org secrets. Установить оба flags=false; не читать значения секретов из API.
- [ ] **Step 3: Отключить Actions в обеих frontend-копиях и принять migration PR обычным merge с ревью.** Import branch публикуется в существующий team/frontend; source histories и IDs repos/задач сверены. На bootstrap PR действуют review/local checks; после импорта включить обычные required CI checks, без постоянного bypass для продуктовых PR.
- [ ] **Step 4: Снять post-import snapshot и восстановить случайные изменения задач/полей по runbook.** Compare должен дать 0; неизвестные изменения body/relations означают остановку окна для разбора. Предыдущий снимок не затрагивает согласованные новые рабочие изменения после завершения окна.
- [ ] **Step 5: Включить team Actions при flags=false и проверить первый обычный PR с ревью и main CI.** События, пропущенные при выключенных Actions, не проигрываются задним числом: открыть согласованный docs PR, фиксирующий фактическую дату/результат импорта в README; дождаться PR CI, закрепить фактическое имя `Check` как required check, затем принять с ревью. Его push в main даст проверочный CI run; простой push уже существующего ref не считается способом запуска. При возможности PR закрывает штатную задачу. PR/main checks зелёные, автоматизация и доска работают, никаких S3 writes.
- [ ] **Step 6: Включить COURSE_SYNC_ENABLED и запустить ручной sync по успешному push CI run.** Реальный write проверяет серверные rules; затем `git ls-remote` подтверждает равенство SHA main, а fetch обоих refs и `git rev-parse REF^{tree}` — дерево. Повтор идемпотентен. В учебном Actions нет нового запуска; история авторов/старые PR доступны. Отказ → sync красный/уведомление, production пока false, восстановление из runbook без force.
- [ ] **Step 7: Включить PRODUCTION_ENABLED после проверки остановки всех старых writers.** Принять с ревью финальный docs PR с фактическими инструкциями переключения: его новый push CI выполнит frontend upload; проверенный workflow до этого содержал skipped upload, поэтому не рассчитывать на rerun skipped job. Выполнить release check, ручной promote и health check существующим процессом; при сбое вернуть прежний stable штатным rollback. Старые production env/секреты пока не удалять. Контроль: только team jobs меняют stable, очередной sync подтвердил SHA нового main.
- [ ] **Step 8: Принять doc-A после review, поставить COURSE_MIGRATED_REPOS=["frontend"], обновить description/homepage и remotes команды.** Нужные ещё не влитые ветки скопировать с сохранением SHA, без постоянного mirroring. Записать evidence: source/course SHAs, CI/deploy/sync run URLs, snapshot diff=0 до обычной работы, test issue/PR link, reviewer, runtime результат и rollback reference. Закрыть frontend окно; backend не переключать автоматически при оставшихся frontend сбоях.

### Task 10: Выполнить разрешённое окно backend и завершить переход

**Files:** Использовать тот же runbook; вне checkout — `migration-artifacts/ACTUAL_DATE/backend/operations.md`, snapshots/bundles. Изменить reviewed backend/infra/doc-B branches и GitHub settings по runbook.

**Interfaces:**
- Consumes: успешная задача 9, отдельная готовность backend ментора/доступов и разрешённое окно backend, задачи 7/8. Разрешение на обе пары может быть получено одним сообщением; не спрашивать его повторно, если scope уже покрыт.
- Produces: обе пары migrated, phase=["frontend","backend"], новый приватный GHCR path доступен CI и серверу, старые образы/backup сохранены.

- [ ] **Step 1: Повторить frontend preflight/backup/import/state-check последовательность для backend.** Новые SHA/PR проверяются заново. Создать отдельный backend sync key, APIDOG_TOKEN и production secrets SSH/Vault, flags=false. Учебный backend Actions отключён; обязательное ревью и job names lint/test/docker проверены. Infra change пока не вливать.
- [ ] **Step 2: Принять backend migration PR с review и включить проверки без deploy/sync.** Проверить ordinary PR review/Closes #N, main lint/test/docker, contract-drift после настройки APIDOG_TOKEN. Убедиться, что новый образ опубликован в `ghcr.io/cringe-driven-development-team/backend`, package приватный и связан с team/backend; packages write/read работают его GITHUB_TOKEN. Новый image tag и digest записать, существующий runtime не менять.
- [ ] **Step 3: Включить и проверить backend sync по успешному CI run как в задаче 9.** SHA/tree равны, repeat успешен, no new school Actions; ошибка не включает production. Runtime старого приложения должен оставаться здоровым.
- [ ] **Step 4: Переключить infra и один deploy.** Убедиться, что старый backend deployment writer остановлен. Принять infra PR после review; убедиться, что новый default/все overrides указывают на опубликованный package. В закрытом окне выставить PRODUCTION_ENABLED=true и принять согласованный финальный docs PR backend: новый push CI выполнит проверенный Docker publish и первый контролируемый deploy существующим cd.yml. Проверить temporary registry login/pull и health check; до успеха новые merge не принимать. Не пытаться запускать gated workflow при false или rerun ранее skipped deploy. При сбое поставить production=false, восстановить старый image path+tag с действующими read credentials по runbook, не меняя БД/volumes. Повторять sync отдельно через его ручной workflow, не перезапуская production ради копирования.
- [ ] **Step 5: Принять doc-B после review, поставить COURSE_MIGRATED_REPOS=["frontend","backend"], обновить remotes и branch inventory команды.** Shared job close остаётся; обычные новые PR обеих сторон используют локальные issues. В reminders больше нет запросов к учебным репозиториям, но есть мониторинг CI/manual-sync team repos.
- [ ] **Step 6: Завершить приёмку по §10 спеки и журнал.** Сверить repo IDs/issues/board, обе main-пары после latest successful sync, mentor review protection, release controls, отсутствие двух writers и доставку ops сообщений. Убедиться, что bundles/settings snapshots доступны и backup не содержит значений секретов. Старые учебные PR, packages и credentials отката не удалять в этом окне; retention — отдельная последующая работа после стабильной эксплуатации. Финальный локальный docs-коммит фиксирует только не секретные результаты и ссылки, без сырого экспорта metadata.

## Итоговая проверка плана и передача

Покрытие спеки: §1–3 → задачи 3/6–10; §4 → 4/5/9/10; §5 → 1–3/6/7; §6 → 3/9/10; §7 → 6/7/9/10; §8 → 8–10; §9 → 5/9/10; §10 → тесты 1–8 и приёмка 9–10; §11 → 5/7/9/10; §12 → Global Constraints и граница rollout. Все пять Review Focus имеют именованные проверки в owning task.

До выбора способа исполнения код не меняется. После ревью плана можно выбрать Subagent-driven или Native для локальных задач 1–8; фактический rollout 9–10 всё равно ждёт согласования преподавателей и разрешённого окна. Рекомендация — Native: задачи тесно связаны общей картой репозиториев, CI job names и поэтапным включением; один исполнитель проще сохраняет последовательность, а независимое итоговое ревью проверит всю подготовку до записи в GitHub.

Технические основания: [Git commit-tree](https://git-scm.com/docs/git-commit-tree), [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), [jobs отдельной попытки](https://docs.github.com/en/rest/actions/workflow-jobs), [повтор отдельных jobs с сохранением исходного SHA](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs). Применять текущие инструкции execution skill и AGENTS.md, а не специальные разрешения/Co-Authored-By из исторического плана переезда задач.
