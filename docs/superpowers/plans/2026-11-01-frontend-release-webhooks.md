# Frontend Release Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести Telegram-уведомления фронта в существующий webhook-сервис, сохранив отдельную сверку доски в Actions.

**Architecture:** PR-события сообщают об актуальной merge queue, Deployment statuses — о готовности выпуска и результате выкатки. Ошибки до записи результата покрываются workflow_job. Сервис использует существующие SQLite, Hono и Telegram proxy; подготовка queue-сообщений не ждёт release-обогащения, отправитель один.

**Tech Stack:** Bun 1.4.4, TypeScript, Hono, bun:sqlite, GitHub REST/GraphQL/webhooks, GitHub Actions, существующая Ansible-роль hooks.

**Spec:** [2026-11-01-frontend-release-webhooks-design.md](../specs/2026-11-01-frontend-release-webhooks-design.md).

## Global Constraints

- Allowlist только `Cringe-Driven-Development-Team/frontend`, ветка `main`.
- Результаты — `release-artifacts` task publish и `production` action deploy/rollback; `release-automation` игнорируется.
- Board и ручная сверка остаются в `.github/workflows/release-status.yml`; Project PAT в webhook-сервис не передаётся.
- Тема выкаток задаётся `TELEGRAM_RELEASES_TOPIC_ID`; сохраняются действующие бот, чат и proxy.
- Перед отправкой и retry enqueue проверяются merged/closed и та же mergeQueueEntry; устаревшее сообщение пропускается.
- Сохраняются task links, названия PR при старте, Health Check, кнопки PR по две в строке для 1–6 PR, полный Summary для >6.
- Никаких новых зависимостей, сервиса, брокера, страницы отчёта, полного обхода задач или выполнения кода PR в сервисе.
- Для новых release-сообщений неизвестный результат Telegram требует ручной проверки; политика обычных GitHub/Apidog сообщений не меняется.
- Не добавлять поддержку старого notification-контракта, dual send или требования высокого uptime.
- Во время локальной реализации нет реальных Telegram-сообщений, мержа, переключения подписок или CD фронта.

## Review Focus

1. Enqueue в outbox успел устареть или сменить entry между retry — пропуск, новая entry не подавляется старой: Task 3.
2. Процесс погиб после принятия Telegram, но до записи message_id — release-сообщение не отправляется повторно автоматически: Task 2.
3. Job webhook пришёл раньше Deployment webhook — один результат по API операции, а не два по порядку доставки: Task 3.
4. Обогащение release зависло, пока пришёл enqueue — быстрый обработчик и sender продолжают работу: Task 3.
5. При обновлении существующей SQLite остались обычные карточки/review groups — строки, кнопки и их retry сохраняются: Task 2.

## Подготовка и карта файлов

Корень плана — репозиторий `.github`; метки `frontend:` и `infra:` означают другой
репозиторий, не вложенные каталоги. Текущие checkout для чтения:
`/home/oleg/2026_H2/.github-webhook-callers`, `/home/oleg/2026_H2/frontend-web-101`,
`/home/oleg/2026_H2/infra`. Для реализации проверить их состояние и изоляцию заново;
не переключать занятые пользователем ветки и не переносить туда чужие изменения.

Перед кодом создать родительскую задачу в `.github`, sub-issues frontend/infra и
проверить Relationships; номера не придумывать. PR каждого репозитория закрывает
свою задачу, `.github` при раннем мерже пишет Part of родителя, родителя закрывают
после общего результата. Входные контракты Tasks 1–3 определены этим планом, поэтому
их можно реализовать локально независимо, сверив интеграцию до переключения.

Файлы с новой ответственностью:

- `frontend:scripts/release/report.ts` — точечный состав PR/задач и запись полного Summary, без Telegram.
- `services/webhook-alerts/src/release-api.ts` — доверенный источник, очередь, операции и состав конкретного диапазона через GitHub API.
- `services/webhook-alerts/src/releases.ts` — классификация событий, выбор уведомления, формат и проверка актуальности.
- `services/webhook-alerts/src/release-schema.sql` — данные новых release-уведомлений и граница включения.
- Существующие `store.ts`, `worker.ts`, `telegram.ts`, `config.ts`, `main.ts`, `cli.ts` — хранение/доставка и подключение новых обработчиков.
- `infra:ansible/roles/hooks` — проверка конфигурации и digest опубликованного image; секреты только в действующем Vault.

### Task 1: Данные операции и полный Summary без зависимости от Telegram

**Files:**
- Create: `frontend:scripts/release/report.ts`, `report.test.ts`.
- Modify: `frontend:scripts/release/catalog.ts`, `catalog.test.ts`, `github.ts`, `deployments.ts`, `deployments.test.ts`, `index.ts`.
- Modify: `frontend:.github/workflows/ci.yml`, `cd.yml`, `rollback.yml`, `scripts/release/workflows.test.ts`, `docs/release.md`.

**Interfaces:**
- `ChangeReport = { baseSha: string | null; headSha: string; prs: {number:number; title:string; url:string; mergeSha:string}[]; issues: LinkedIssue[]; complete:boolean }`.
- `readChangeReport(repo: string, baseSha: string | null, headSha: string): Promise<ChangeReport>`: все страницы диапазона и связанные PR; существующие API/GraphQL helpers, без списка всех merged PR.
- `writeChangeSummary(report: ChangeReport): string | null`: пишет только собственный `GITHUB_STEP_SUMMARY`; URL `${runUrl()}#summary` только для полного отчёта.
- CLI `bun run release report <publish|deploy|rollback> <sha>` выводит `report_base_sha` (SHA либо пусто) и `report_url` (URL либо пусто) в GITHUB_OUTPUT; неизвестная база честно обозначена.
- Новое поле обоих Deployment payload: `notification: { base_sha: string | null; report_url: string | null; run_attempt: number }`; SHA базы для rollback остаётся before, направление сравнения меняется на target..before. run_attempt — положительный безопасный integer из GITHUB_RUN_ATTEMPT, без догадки «последняя попытка».
- register/start берут эти два значения из `RELEASE_REPORT_BASE_SHA` и `RELEASE_REPORT_URL`; проверяют SHA и URL текущего run. Существующие поля payload и подписи register/start сохраняются.

- [ ] **Step 1: Добавить RED-тесты состава и metadata.**
  В `report.test.ts`: `range_collects_all_pages_and_only_merged_prs`, `rollback_uses_target_to_before`, `null_base_does_not_scan_all_prs`, `unknown_base_does_not_invent_sha`.
  Проверить: PR mergeSha входит в commit range; ассоциированный, но не влитый PR исключён; closing issues читаются только для включённых PR; >100 коммитов не теряются.
  В deployments/workflows tests проверить точные ключи `notification.base_sha/report_url`, Summary до register/start и Production record непосредственно перед Switch BFF.
- [ ] **Step 2: Проверить RED.** `bun test scripts/release/report.test.ts scripts/release/deployments.test.ts scripts/release/workflows.test.ts` из frontend; ожидается падение новых проверок отсутствующего интерфейса/metadata.
- [ ] **Step 3: Реализовать report и targeted lookup.**
  Для commit range использовать пагинацию compare, затем `/commits/{sha}/pulls` с дедупликацией и проверкой mergeSha; closing links — прежний GraphQL helper. Разрешено повторно использовать этот алгоритм в service API без нового shared package.
  База publish — ближайший ранее опубликованный успешный предок SHA; deploy/rollback — существующий confirmed before SHA. Проверку принадлежности main и digest не ослаблять.
  Ошибка обогащения даёт неполный Summary и пустой report_url, но не блокирует публикацию/выкатку. Тесты с унаследованным Summary используют собственный temp-файл или удаляют переменную; sentinel родителя не меняется.
- [ ] **Step 4: Подключить report в workflows.**
  Отдельный шаг до register/start; передать outputs через env, значения в shell только в кавычках. Production record переместить после инструментов/SSH непосредственно перед Switch. Старые send steps пока сохранить до Task 4; новое metadata не означает разрешения второго sender.
- [ ] **Step 5: Проверить GREEN.** Предыдущая targeted-команда, `bun run check`, `bun run test`, `bun run build`; actionlint трёх workflow. Нулевые exit codes, все новые assertions прошли.
- [ ] **Step 6: Commit.** `feat(release): publish notification metadata and standalone reports` в frontend.

### Task 2: Durable release-outbox и многострочные кнопки

**Files:**
- Create: `services/webhook-alerts/src/release-schema.sql`, `tests/releases-store.test.ts`.
- Modify: `src/store.ts`, `src/telegram.ts`, `src/worker.ts`, `src/cli.ts` относительно `services/webhook-alerts/`.
- Test: `tests/store.test.ts`, `tests/worker.test.ts`, `tests/snapshot.test.ts` и новый releases-store test.

**Interfaces:**
- `ReleaseNotice`: discriminated union с kind `queue|dequeue|ready|start|result|job-error|retention`, уникальным `key`; queue содержит `prNumber`, `queueEntryId`, ready содержит `sha`, операции содержат `deploymentId/runId`, fallback — `runId/attempt/jobId`.
- В `OutgoingMessage`/`DueMessage` добавить `keyboard?: {text:string;url:string}[][]` и `release?: ReleaseNotice`. Старые button/secondaryButton остаются для действующих карточек.
- `Store.claimUnprepared(now, leaseMs, lane = 'ordinary')`, lane `ordinary|release-queue|release-operation`; `Store.prepare(deliveryId, messages)` атомарно учитывает semantic key release-сообщения.
- `Store.releaseActivation(): number | null`, `Store.activateReleases(cutoffMs): void` — одна сохраняемая граница, повтор с тем же значением идемпотентен, попытка заменить другим отклоняется.
- `Store.recoverReleaseDelivery(deliveryId: number): boolean` — адресная запись разрешения обойти cutoff для одной raw delivery, сброс её preparation lease; только GitHub release-lanes. Не обходит source/metadata/актуальность и не сбрасывает sent/uncertain outbox.
- `Store.beginReleaseSend(outboxId, now): boolean` — фиксирует начало попытки до HTTP, только для действующей lease; `Store.skipRelease(outboxId, reason): void` — терминальный отказ от устаревшей карточки.
- `SendResult` retry получает `ambiguous?: boolean`; catch сети, 5xx и недостоверный успешный ответ выставляют true. Подтверждённый 429/400 не считаются неизвестной доставкой.
- CLI `release-activate <UTC-ISO>` устанавливает границу после проверки topic/token; `release-recover <delivery-id>` вызывает адресное восстановление; существующий `retry <outbox-id>` остаётся явным ручным действием после проверки Telegram и очищает маркер неизвестной попытки атомарно. Никаких all/reset/replay команд.

- [ ] **Step 1: Написать RED-тесты долговечности.**
  `v2_database_keeps_existing_outbox_and_review_groups`, `semantic_key_is_unique_across_distinct_deliveries`, `activation_is_persistent_and_immutable`, `keyboard_round_trips_ordered_rows`.
  `accepted_message_without_saved_message_id_never_auto_resends`: после beginSend и simulated crash reopen/lease expiry переводят release в ручную проверку, число HTTP-вызовов остаётся 1.
  `ordinary_network_failure_still_retries`: прежняя политика обычных карточек не изменилась.
- [ ] **Step 2: Проверить RED.** `bun test tests/releases-store.test.ts tests/store.test.ts tests/worker.test.ts` из сервиса; новые интерфейсы/проверки пока отсутствуют.
- [ ] **Step 3: Добавить транзакционную schema migration v2 → v3.**
  Новая SQL-таблица связывает semantic key, outbox ID, guard metadata и sending marker; отдельные записи хранят activation и адресные recovery-разрешения. Добавить lane в deliveries и keyboard_json в outbox.
  Исторические deliveries/outbox/review groups не удалять, новые CHECK таблицы outbox ради дополнительных статусов не переписывать: skipped/uncertain хранятся как failed с различимыми `release_skipped`/`release_uncertain` error codes и metadata.
  Существующие raw bytes, body hash, sent message IDs, pending и timers сохраняются. Неизвестная версия БД отклоняется как сейчас. Свежая БД сразу получает актуальную схему через те же миграции.
- [ ] **Step 4: Подключить lease-safe отправку и keyboard.**
  Release с sending marker после истечения lease не попадает в автоматический retry. Любая ошибка записи после HTTP оставляет это ограничение в силе. Подтверждённый отказ/429 при markRetry атомарно очищает marker и позволяет новую проверку актуальности; HTML entities fallback сохраняет кнопки и metadata.
  Shared sender держит lease только фактически обрабатываемой строки, не десяти ожидающих сетевых запросов. Добавить необязательный limit к claimDue с прежним default 10, sender использует 1.
  Логи содержат только ID, key, код/время/результат, без bot token, raw payload или Telegram response body.
- [ ] **Step 5: Проверить GREEN.** Targeted-команда; `bun test`, `bun run typecheck` из сервиса. Snapshot/reopen тест проверяет новую схему вместе с прежними данными.
- [ ] **Step 6: Commit.** `feat(webhooks): persist release delivery guards and keyboards` в `.github`.

### Task 3: События GitHub, формат release-карточек и независимый быстрый путь

**Files:**
- Create: `services/webhook-alerts/src/release-api.ts`, `src/releases.ts`, `tests/releases.test.ts`, `tests/release-api.test.ts`, `tests/release-worker.test.ts`.
- Modify: `src/store.ts`, `src/worker.ts`, `src/main.ts`, `src/config.ts`.
- Test: `tests/http.test.ts`, `tests/main.test.ts`, `tests/github.test.ts`, существующие review/Apidog tests.
- Docs: `services/webhook-alerts/README.md`.

**Interfaces:**
- `createReleaseApi({token,fetch?,timeoutMs?}): ReleaseApi` — отдельный узкий boundary с безопасными ошибками, AbortSignal, проверкой GitHub origin/path при пагинации. Не расширять полномочия существующего GitHubApi для обычных сообщений.
- В `release-api.ts` определить: `ReleaseStep = {name:string;outcome:'success'|'failure'|'cancelled'|'skipped'|'pending'}`, `VerifiedRun = {id:number;attempt:number;workflow:'CI'|'CD'|'Rollback';event:'push'|'workflow_dispatch';headSha:string;actor:string;url:string;steps:ReleaseStep[]|null}`.
- `VerifiedOperation = {id:number;kind:'publish'|'deploy'|'rollback';sha:string;state:'pending'|'queued'|'in_progress'|'success'|'failure'|'error'|'inactive';everSucceeded:boolean;createdAt:string;imageRef:string;notification:{base_sha:string|null;report_url:string|null;run_attempt:number};run:VerifiedRun}`.
- `VerifiedProduction = {id:number;kind:'deploy'|'rollback';sha:string;imageRef:string;everSucceeded:boolean;createdAt:string;runId:number}`. История проверяется по действующему контракту image_ref/assets/action/run, наличие новой notification в исторической записи не требуется: она не становится кандидатом рассылки.
- `VerifiedJob = {id:number;name:string;conclusion:'success'|'failure'|'cancelled'|'skipped';run:VerifiedRun;operation:VerifiedOperation|null;failedStep:string|null}`. Service ChangeReport/LinkedIssue повторяют поля Task 1 локально, без импорта другого checkout или нового пакета.
- `ReleaseApi.queue(prNumber): Promise<{merged:boolean;closed:boolean;entry:null|{id:string;enqueuer:string}}>`, repo фиксирован allowlist.
- `ReleaseApi.operation(deploymentId): Promise<VerifiedOperation>`: task, SHA, state/history, imageRef, notification из Task 1, verified run с id/attempt/actor, step outcomes. Верификация допускает in_progress run.
- `ReleaseApi.changes(baseSha,headSha): Promise<ChangeReport>` — контракт Task 1; `ReleaseApi.job(jobId): Promise<VerifiedJob>`; `ReleaseApi.production(): Promise<VerifiedProduction[]>` — история, включая прошлые успешные состояния до rollback.
- `projectRelease(delivery, api, {topic,siteUrl,userMap}): Promise<OutgoingMessage[]>`, `checkReleaseNotice(notice, api): Promise<'send'|'skip'|'retry'>` — source validation и guard перед отправкой.
- `prepareOnce({store,project,now,lane}): Promise<void>`, `deliverOnce({store,send,beforeReleaseSend,now}): Promise<number>`; существующий `runOnce` для обычных тестов вызывает эти же функции, без второго sender в production.
- `startWorker` запускает независимые preparation loops ordinary/release-queue/release-operation и один общий delivery loop; существующий review grouping и Apidog polling остаются в ordinary-проходе. Интервал 1000 ms, общий AbortSignal, stop ждёт завершения всех loops.
- Новая конфигурация: `TELEGRAM_RELEASES_TOPIC_ID` и фиксированный `https://cellestial.ru`; при наличии activation topic и GITHUB_API_TOKEN обязательны. Пустая activation означает выключенную release-рассылку; обычная рассылка работает как раньше.

- [ ] **Step 1: Написать RED-тесты источника и устаревания.**
  `signed_enqueue_needs_only_target_pr_and_rechecks_before_send`: HMAC-valid HTTP → SQLite → send; PR уже merged на втором запросе → send не вызывается.
  `dequeued_merge_is_silent`, `reenqueued_entry_gets_new_notice`, `old_entry_retry_is_skipped`, `stale_dequeued_after_reenqueue_is_skipped`.
  `ready_uses_success_record_while_ci_running`, `cd_target_sha_can_differ_from_run_head`, `foreign_repo_or_forged_run_is_rejected`, `release_automation_cannot_recurse`.
- [ ] **Step 2: Написать RED-тесты порядка и формата.**
  Переставить job/status события: до записи операции → один fallback; terminal failure есть → один result; success + failed Retention → success и отдельное предупреждение, без «выкатка не удалась». Запоздавший status попытки 1 после rerun попытки 2 проверяется по attempt 1 и не дедуплицирует attempt 2.
  Проверить cancelled, отсутствие metadata до cutoff, неправильный digest/assets/run URL, конфликтующие состояния и все страницы диапазона.
  Сравнить содержательные fixtures прежних frontend notify tests: PR titles вместо SHA в start, task hyperlinks, Health Check ✅/❌/⚪, PR/PR #N 1/6/7, полный Summary, кнопки prod/rollback/deploy/logs, HTML escaping/4096 visible chars, неполный состав с честным fallback.
- [ ] **Step 3: Проверить RED.** `bun test tests/releases.test.ts tests/release-api.test.ts tests/release-worker.test.ts`; ожидается отсутствие новых обработчиков/поведения.
- [ ] **Step 4: Реализовать ReleaseApi и проектор.**
  Source: `.github/workflows/ci.yml` push/main, cd.yml и rollback.yml workflow_dispatch/main; creator записи — github-actions[bot], для production task/action совпадают, целевой SHA/digest/assets валидируются отдельно. При недоступном источнике повторить проверку без ложного успеха; при недоступном только составе/steps — честная ограниченная карточка.
  Keys с repo-prefix: queue entry ID, dequeue delivery ID, ready SHA, start deployment ID, retention run/attempt. Result и job fallback используют один `result:<repo>:<publish|deploy|rollback>:<runId>:<attempt>`; проверять запись операции через API, даже если её webhook ещё не пришёл. Предварительный fallback при временной невидимости записи не порождает второй terminal result при её появлении.
  Queue сообщение создаётся из подтверждённой текущей entry, прежние delivery той же entry дедуплицируются. Перед send повторить guard; API error даёт retry, merged/entry change — skip. Ready проверяет ever-success production; start — terminal status собственной операции.
- [ ] **Step 5: Подключить loops и доказать отсутствие ожидания.**
  В `queue_sends_while_release_enrichment_waits` использовать управляемый незавершённый Promise release-api, принять enqueue позже, дождаться fake Telegram send, затем освободить Promise. Нельзя считать тестом только разные имена jobs или отсутствие needs.
  Ordinary loop не должен claim release deliveries; review verdict до group deadline по-прежнему отменяет промежуточный commented alert. Sender один; shutdown и lease не разрешают двойную отправку.
- [ ] **Step 6: Проверить GREEN.** Targeted-тесты, затем все `bun test` и `bun run typecheck` сервиса; `docker build -t webhook-alerts:release-webhooks services/webhook-alerts` из `.github`, `bash tests/webhook-alerts-docker.sh webhook-alerts:release-webhooks`. Синтетические API/TG, никаких реальных сообщений.
- [ ] **Step 7: Commit.** `feat(webhooks): notify frontend releases from operation events`.

### Task 4: Удалить старого sender, сохранить Board и подготовить конфигурацию

**Files:**
- Modify: `frontend:.github/workflows/{ci,cd,rollback,release-status}.yml`, `scripts/release/index.ts`, `sync.test.ts`, `workflows.test.ts`, `docs/release.md`.
- Delete: `frontend:scripts/release/notification-sync.ts`, `notification-sync.test.ts`, `journal.ts`, `journal.test.ts`, `notify.ts`, `notify.test.ts` после переноса полезных format/report assertions в Tasks 1 и 3.
- Preserve: `frontend:scripts/release/board.ts`, `source.ts`, `catalog.ts` и их проверки Board/источника; удалять только неиспользуемые notification-ветки, не проверки доверия Board.
- Modify: `infra:ansible/roles/hooks/tasks/validate.yml`, `ansible/tests/test_hooks.py`, `RUNBOOK.md`.

**Interfaces:**
- Frontend CLI сохраняет report и все команды сборки/выкатки/retention/Board; notify, prepare-notifications и notify-pending удаляются из help и dispatch.
- Release status сохраняет workflow_run CI/CD/Rollback и workflow_dispatch, только job Board, concurrency release-board и ADD_TO_PROJECT_PAT; enqueued trigger и Telegram env удаляются.
- Infra preflight требует корректный TELEGRAM_RELEASES_TOPIC_ID и GITHUB_API_TOKEN при включении нового потребителя; activation хранится в SQLite и задаётся адресной CLI, не отдельным sender-флагом.

- [ ] **Step 1: Добавить RED-регрессии удаления и Board.**
  Workflow tests: нет Notifications, release-automation writer, Telegram credentials и enqueued trigger; Board/ручной запуск/доверенный main сохранены. CD/Rollback всё ещё завершают production после Health check, register всё ещё после image/assets checks.
  `sync_uses_project_without_telegram_or_release_journal`, `manual_status_and_reopened_issue_stay_untouched`; отсутствие ссылок на удалённые CLI/модули в исполняемом коде.
  Infra `test_release_topic_and_token_are_required_for_configured_release_notifications`: синтетические env, invalid numeric topic и пустой token отклоняются без вывода секретов.
- [ ] **Step 2: Проверить RED.** Frontend `bun test scripts/release/workflows.test.ts scripts/release/sync.test.ts`; infra `python3 -m unittest discover -s ansible/tests -p test_hooks.py`. Новые assertions должны падать до удаления/валидации.
- [ ] **Step 3: Удалить старый путь.**
  Сохранить report и его защиту от унаследованного Summary из Task 1; форматные проверки живут в сервисе. Старые readPRChanges/PRChanges удалить после проверки всех callers и переноса нужных assertions в report.test.ts. Исторические Deployments не удалять. Другие общие Telegram-алерты организации и course-sync sender не менять.
  В infra валидировать topic/token только при наличии TELEGRAM_RELEASES_TOPIC_ID; это позволяет подготовить image до cutover без отключения остальных GitHub/Apidog сообщений. При созданной activation service startup требует эти значения, даже если infra конфигурация ошибочна.
- [ ] **Step 4: Проверить GREEN.** Frontend check/test/build, actionlint четырёх workflow; infra targeted unittest, Ansible syntax/lint роли по README, без применения playbook. Повторно полный suite сервиса и проверки `.github` из README, обязательные в CI этого репозитория.
- [ ] **Step 5: Commit отдельно по репозиториям.** `refactor(release): keep only board reconciliation in Actions` и `feat(hooks): validate frontend release notification settings`.

### Task 5: Общая проверка, PR и разовое переключение

**Files:**
- Modify: `infra:ansible/roles/hooks/defaults/main.yml` — только реальный digest и source tag опубликованного image; до публикации не ставить выдуманный digest.
- Modify: `services/webhook-alerts/README.md`, `frontend:docs/release.md`, `infra:RUNBOOK.md` — проверенный порядок переключения/восстановления.
- Secret config: существующий `infra:ansible/inventory/group_vars/all/vault.yml` только через Vault, не читать/выводить plaintext в tool outputs.

**Interfaces:**
- CLI release-activate из Task 2; activate отсутствует до единственного cutover, обычные алерты работают.
- Org hook 702764072 получает прежние events плюс deployment_status/workflow_job; URL, secret, SSL verification и остальные events сохраняются.
- Успешное завершение означает раздельно проверенные merge/CI/course-sync, image, webhook acceptance, Telegram message_id и отсутствие старого sender.

- [ ] **Step 1: Интеграционный тест без внешних сообщений.**
  Реальный локальный HTTP сервис, HMAC synthetic deliveries и fake GitHub/TG server: activation → enqueue → merged skip при retry → release-artifacts success → production start/result. Повтор и обратный порядок событий не создают дубли; Board недоступен, сообщения доставляются.
  Проверить SQLite snapshot/reopen и неизвестную доставку; это тест границы компонентов, а не повтор private helpers.
- [ ] **Step 2: Выполнить обязательные проверки изменённых репозиториев.**
  Использовать команды README/AGENTS и проверки предыдущих tasks; git diff --check. Зафиксировать точные heads и результаты. По выбранному способу выполнения пройти требуемые review gates; незавершённый review не заменять словами «тесты зелёные».
- [ ] **Step 3: Подготовить reviewable PR.**
  Реальные task links и Closes/Part of; в описании порядок: `.github` code → frontend producers/removal → published webhook digest/infra config → activation. До внешнего применения пользователь видит код, CI и конкретный runbook. Эта стадия сама по себе не разрешает merge/deploy.
- [ ] **Step 4: После поручения на merge проверить каждый exact head и post-merge.**
  Для frontend проверить CI push/main merge SHA, Publish release, course-sync и совпадение team/course main. Для `.github` проверить CI и Webhook alerts image; получить digest анонимно и закрепить infra PR. Перед обновлением вспомогательной VPS применить только проверенный image/config; CD фронта автоматически не запускать.
- [ ] **Step 5: Выполнить согласованное переключение одним sender.**
  Снять проверенный SQLite snapshot. Проверить завершение старых notification jobs и CD/Rollback старой ревизии; если они ещё идут, сначала дождаться/адресно остановить их отправку, не убивать неизвестную доставку.
  На сервисе с новой конфигурацией и отключённой activation включить дополнительные события org hook. После остановки прежнего sender зафиксировать текущую UTC-границу командой release-activate. До activation raw события сохраняются, release-lanes их не отправляют; после activation события до границы пропускаются.
  События промежутка между удалением старого sender и activation сверить адресно по ID/run и журналу. Восстанавливать только после подтверждения отсутствия прежней доставки командой release-recover для конкретных raw delivery IDs; новая metadata и guards обязательны, сброса всей очереди нет.
- [ ] **Step 6: Проверить реальную доставку и записать доказательства.**
  По разрешённому контрольному событию сверить GitHub delivery time/HTTP 202, source PR/run/deployment, outbox key, Telegram message_id и время отправки; повтор той же delivery не шлёт второе сообщение. Для контроля, требующего реального CD фронта, получить отдельное поручение; без него честно оставить этот пункт непроверенным.
  Board должен по-прежнему сработать отдельно, восстановить Ready for release/Done по тем же правилам и не иметь доступа к Telegram token. Не обещать фиксированную задержку доставки.
- [ ] **Step 7: Commit фактических infra pins и результата проверки.**
  Закрыть родительскую задачу после выполнения согласованной приёмки, не только после мержа первого PR. Worktrees, принадлежащие пользователю, не удалять автоматически.

## Самопроверка плана

- Spec coverage: источники/формат/guards → Task 3; отчёт/metadata → Task 1; unknown delivery/дедупликация/SQLite → Task 2; Board и удаление → Task 4; переключение/проверка → Task 5.
- Review Focus: каждый из пяти случаев имеет конкретный тест в Tasks 2–3.
- Межрепозиторный контракт один: notification.base_sha/report_url/run_attempt и ChangeReport; producer и consumer проверяются на одинаковых synthetic fixtures. Имена интерфейсов выше являются контрактом плана.
- Не выполняются миграция Projects, оптимизация Board, новый UI отчётов или деплой фронта без поручения.
