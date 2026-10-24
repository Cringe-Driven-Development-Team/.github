# Webhook Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить событийные уведомления Actions службой GitHub/Apidog → SQLite → Telegram и безопасно включить её на auxiliary VPS.

**Architecture:** Hono проверяет подписи по исходным байтам и сохраняет доставки в SQLite. Отдельный worker транзакционно готовит сообщения и отправляет их с повторами. CLI создаёт согласованный снимок SQLite; Restic сохраняет только готовый снимок. Старый событийный workflow выключается организационным флагом при переключении.

**Tech Stack:** TypeScript, Bun 1.4.4, Hono, `bun:sqlite`, `bun test`, Docker/Compose, Ansible/Restic.

**Spec:** `docs/superpowers/specs/2026-10-24-webhook-alerts-design.md`.

## Global Constraints

- Рабочая БД: `/data/queue.sqlite`; готовый снимок: `/data/snapshots/queue.sqlite`.
- GitHub: `X-Hub-Signature-256` по исходным байтам; `(source, delivery_id)` уникален.
- Apidog: HMAC SHA-1 `sha1=`, имя заголовка из `APIDOG_SIGNATURE_HEADER` после реальной тестовой доставки.
- Ограничение тела: 1 МиБ; GitHub HTTP 2xx после сохранения и в пределах 10 секунд.
- Telegram: чат `-1003713420351`, темы GitHub `26`, Code Review `1513`, Apidog из конфигурации; 700 символов на цитату, сообщение короче 4096; 180 секунд тишины для серии ревью.
- Существующие `reminders.yml`, `add-to-project.yml`, `course-sync` и release workflow не переводятся на сервис.
- При недоступности GitHub API отправлять базовое сообщение и безопасное предупреждение; при недоступности SQLite не подтверждать webhook.
- Подписи, токены и payload не выводить целиком в логи; `.env` только из Ansible Vault.
- До переключения старый `telegram.yml` остаётся рабочим; до испытания восстановления live worker остаётся выключенным.

## Review Focus

- Нет `Content-Length`, но поток превышает 1 МиБ: Task 1 проверяет фактический размер и отвечает 413 до JSON parse.
- Верный delivery ID с изменённым телом: Task 2 возвращает конфликт и не заменяет сохранённый payload.
- Процесс умер с leased сообщением: Task 3 проверяет возврат строки в работу после срока lease.
- Telegram 429 прислал отсутствующий или некорректный `retry_after`: Task 3 применяет ограниченный backoff без горячего цикла.
- Имя подписи Apidog не совпало с настроенным: Task 6 отклоняет доставку и не создаёт строк в очереди.

---

### Task 1: Каркас сервиса и проверка входящих запросов

**Files:** Create `services/webhook-alerts/package.json`, `bun.lock`, `tsconfig.json`, `Dockerfile`, `.dockerignore`, `src/config.ts`, `src/auth.ts`, `src/http.ts`, `src/main.ts`, `tests/http.test.ts`; modify `.github/workflows/checks.yml` to run `bun test`, `bunx tsc --noEmit`, Docker build.

**Interfaces:** `loadConfig(env: Record<string,string|undefined>): Config`; `verifyGithub(raw: Uint8Array, signature: string, secret: string): boolean`; `verifyApidog(raw: Uint8Array, signature: string, secret: string): boolean` (only HMAC primitive here; Task 6 wires the Apidog route and configurable header); `createApp(deps: {config: Config; accept: AcceptDelivery}): Hono`. `AcceptDelivery` accepts `{source, deliveryId, event, raw}` and returns `accepted | duplicate | conflict`.

- [ ] Write `tests/http.test.ts`: GitHub's official `Hello, World!` HMAC vector verifies at `verifyGithub`; a separately signed valid JSON request reaches `accept` with exact raw bytes; wrong/malformed signature returns 401; missing `X-GitHub-Delivery` returns 400; invalid JSON returns 400; duplicate ID with altered body returns 409; unknown path returns 404; both `Content-Length` and streamed oversize cases return 413; SQLite error maps to 503; `/health` checks DB callback.
- [ ] Run `bun test tests/http.test.ts`; expect failures for missing modules.
- [ ] Implement configuration validation, bounded raw body reader, constant time HMAC comparison and Hono routes; `main.ts` starts listener, worker disabled by default via config. Docker image must include Bun and a working `wget` for current infra healthcheck.
- [ ] Run `bun test tests/http.test.ts && bunx tsc --noEmit && docker build -t webhook-alerts:test services/webhook-alerts`; expect success. Adjust Docker context in CI consistently.
- [ ] Commit task files with `feat: add authenticated webhook ingress`.

### Task 2: Постоянная очередь и дедупликация

**Files:** Create `services/webhook-alerts/src/store.ts`, `src/schema.sql`, `tests/store.test.ts`; modify `src/main.ts`, `src/http.ts`.

**Interfaces:** `openStore(path: string): Store`; `Store.accept(delivery: Delivery): AcceptResult`; `Store.claimUnprepared(now: number, leaseMs: number): Delivery[]`; `Store.prepare(id: number, messages: OutgoingMessage[]): void`; `Store.claimDue(now: number, leaseMs: number): DueMessage[]`. `Delivery` carries raw bytes and SHA-256 hash; `OutgoingMessage` carries topic, HTML, button and optional fallback HTML. `prepare` marks even a zero-message delivery complete.

- [ ] Write `tests/store.test.ts`: reopening file preserves pending/completed rows; exact GitHub redelivery does not add a row; same ID with different body returns conflict; preparing 0 and 2 messages twice yields 0 and 2 stable outbox rows; independent Apidog deliveries obey payload ID or five minute hash window.
- [ ] Run `bun test tests/store.test.ts`; expect failure for missing store.
- [ ] Implement migrations, uniqueness, WAL, transactions and store interface; wire HTTP accept to it. Keep payload for replay and debugging without logging it.
- [ ] Run `bun test tests/store.test.ts tests/http.test.ts`; expect success.
- [ ] Commit with `feat: persist webhook deliveries and outbox`.

### Task 3: Отправка Telegram и повторы

**Files:** Create `services/webhook-alerts/src/telegram.ts`, `src/worker.ts`, `src/cli.ts`, `tests/worker.test.ts`; modify `src/store.ts`, `src/main.ts`.

**Interfaces:** `sendMessage(message: OutgoingMessage, config: TelegramConfig, fetcher: typeof fetch): Promise<SendResult>`; `runOnce(deps: {store: Store; project: (delivery: Delivery) => Promise<OutgoingMessage[]>; send: (message: OutgoingMessage) => Promise<SendResult>; now: number}): Promise<number>`; `Store.markSent(id, telegramMessageId)`; `Store.markRetry(id, dueAt, errorCode)`; `Store.markFailed(id, errorCode)`.

- [ ] Write `tests/worker.test.ts`: success stores Telegram `message_id`; 500/network error retries; 429 respects `retry_after`; bad or absent `retry_after` uses bounded backoff; permanent 400 fails; expiry of lease after simulated crash resumes sending; `retry` CLI requeues failed row without new delivery.
- [ ] Run `bun test tests/worker.test.ts`; expect failure.
- [ ] Implement worker polling and statuses; on Telegram entity parse error retry once using fallback card without quote. Use short timeouts and redact response bodies in logs.
- [ ] Run `bun test tests/worker.test.ts tests/store.test.ts`; expect success.
- [ ] Commit with `feat: deliver queued alerts with retries`.

### Task 4: Формат GitHub и API дополнения

**Files:** Create `services/webhook-alerts/src/github.ts`, `src/github-api.ts`, `src/format.ts`, `tests/github.test.ts`, `tests/fixtures/github/`; modify `src/worker.ts`; compare with `.github/workflows/telegram.yml` and `tests/telegram.sh`.

**Interfaces:** `formatGithub(delivery: Delivery, api: GithubApi, config: FormatConfig): Promise<OutgoingMessage[]>`; `GithubApi` exposes `compare`, `reviews`, `reviewComments`, `pullRequest`, `recentClosedPullRequests` as read-only operations returning typed minimal projections; `escapeHtml`, `quoteMarkdown`, `mention` live in `format.ts`.

- [ ] Write `tests/github.test.ts` from representative existing `tests/telegram.sh` cases: normal/force push, zero distinct commits, issue opened/edited/closed, PR draft/opened/review requested/closed, issue vs PR comments, bots/`<!-- auto -->`, HTML and URL escaping, 700/4096 limits, missing API fallback, routing and buttons. Use real anonymized or official GitHub payload fixtures.
- [ ] Run `bun test tests/github.test.ts`; expect failure.
- [ ] Implement event selection and formatting; GitHub REST calls only for missing context, with token read-only and bounded timeout. Unsupported events/actions return `[]`.
- [ ] Run `bun test tests/github.test.ts tests/worker.test.ts`; expect success. Compare expected cases against `bash tests/telegram.sh` without changing old cases.
- [ ] Commit with `feat: format GitHub webhook alerts`.

### Task 5: Серии ревью и несколько сообщений из одного события

**Files:** Create `services/webhook-alerts/src/review-groups.ts`, `tests/review-groups.test.ts`; modify `src/store.ts`, `src/worker.ts`, `src/github.ts`.

**Interfaces:** `ReviewGroups.record(delivery: Delivery, now: number): void`; `ReviewGroups.releaseDue(now: number, project: (deliveries: Delivery[]) => Promise<OutgoingMessage[]>): Promise<number>`; key `repository + PR number + reviewer login`; store keeps due time, source delivery IDs and review IDs. `releaseDue` projects the group, then inserts outbox rows transactionally under stable `(review_group, group_id, ordinal)` keys and returns the number released.

- [ ] Write `tests/review-groups.test.ts`: two `commented` deliveries within 180 seconds make one alert after last+180 seconds; restart preserves timer; approved/changes requested are immediate and do not duplicate already grouped comments; PR opened with reviewers creates two independently retryable outbox rows.
- [ ] Run `bun test tests/review-groups.test.ts`; expect failure.
- [ ] Implement SQLite-backed grouping and transactional release to outbox; use existing formatter and API projections.
- [ ] Run `bun test tests/review-groups.test.ts tests/github.test.ts`; expect success.
- [ ] Commit with `feat: aggregate review notifications`.

### Task 6: Уведомления Apidog

**Files:** Create `services/webhook-alerts/src/apidog.ts`, `tests/apidog.test.ts`, `tests/fixtures/apidog/`; modify `src/http.ts`, `src/config.ts`, `src/worker.ts`.

**Interfaces:** `formatApidog(delivery: Delivery, config: FormatConfig): OutgoingMessage[]`; `extractApidogDeliveryId(raw: Uint8Array, parsed: unknown, now: number): string`.

- [ ] Obtain one test notification from Apidog with Signature Auth enabled; record header name, anonymize payload, keep keys out of fixture. If project access is unavailable, implement with synthetic fixture and explicitly leave live fixture/acceptance pending in runbook.
- [ ] Write `tests/apidog.test.ts`: correct HMAC SHA-1 to configured header accepts; wrong/missing header rejects without storage; endpoint/schema/document/test results map to configured topic; missing object/URL stays readable; duplicate ID/body window is stable.
- [ ] Run `bun test tests/apidog.test.ts`; expect failure.
- [ ] Implement signature and robust payload projection based on observed fixture, keeping raw payload intact for replay.
- [ ] Run `bun test tests/apidog.test.ts tests/http.test.ts`; expect success.
- [ ] Commit with `feat: receive Apidog notifications`.

### Task 7: Согласованный снимок и восстановление

**Files:** Create `services/webhook-alerts/src/snapshot.ts`, `tests/snapshot.test.ts`; modify `src/cli.ts`, `Dockerfile`, `services/webhook-alerts/README.md`.

**Interfaces:** `createSnapshot(databasePath: string, outputPath: string): void`; CLI `snapshot --output /data/snapshots/queue.sqlite` exits nonzero on failure.

- [ ] Write `tests/snapshot.test.ts`: WAL DB containing pending and sent rows snapshots while first connection remains open; restored snapshot passes `PRAGMA integrity_check=ok`, preserves delivery IDs and duplicate rejection; failed snapshot leaves previous file intact; snapshot has no `-wal` dependency.
- [ ] Run `bun test tests/snapshot.test.ts`; expect failure.
- [ ] Implement `VACUUM INTO` unique temp path in same directory, integrity check, fsync and atomic rename; reject output path equal to live DB.
- [ ] Run `bun test tests/snapshot.test.ts` plus all service tests; expect success.
- [ ] Commit with `feat: create consistent SQLite snapshots`.

### Task 8: CI, образ и инструкция переключения

**Files:** Create `.github/workflows/webhook-alerts-image.yml`, `services/webhook-alerts/README.md`; modify `.github/workflows/telegram.yml`, `README.md`, relevant `tests/telegram.sh` and `tests/lint.sh`; keep `.github/workflows/reminders.yml` and `add-to-project.yml` behavior.

**Interfaces:** organization variable `TELEGRAM_EVENTS_SOURCE=webhook` disables only job `notify` in reusable `telegram.yml`; unset/other value enables it. `WEBHOOK_ALERTS_SEND_ENABLED=false` keeps worker paused while ingest runs; fixed GHCR SHA tag feeds infra Task 9.

- [ ] Write failing workflow test: org variable skips only event `notify`, while board and reminders remain available; test Docker image boots `/health`, persists `/data` and can run snapshot CLI.
- [ ] Run workflow/test checks; expect failure.
- [ ] Add image build/publish on main, operation guide for GitHub organization webhook and Apidog target, secret names, shadow ingest, cutover, boundary reconciliation, rollback and redelivery. Add job-level flag in `telegram.yml`; leave default as old sender.
- [ ] Run `bun test`, `bunx tsc --noEmit`, Docker build, `bash tests/telegram.sh`, `bash tests/reminders.sh`, `bash tests/close.sh`, `bash tests/lint.sh`; expect all green.
- [ ] Create infra sub-issue of .github#20 with the image/snapshot contract and merge order in both issues; confirm GitHub sub-issue relationship through API.
- [ ] Commit and open `.github` PR with `Part of https://github.com/Cringe-Driven-Development-Team/.github/issues/20`; merge to publish a fixed image tag, but leave old sender as default. Parent issue remains open.

### Task 9: VPS/Restic integration (separate infra sub-issue)

**Files in `infra`:** Modify `ansible/roles/restic_backup/templates/restic-backup.service.j2`, `ansible/inventory/group_vars/auxiliary/vars.yml`, `ansible/roles/hooks/defaults/main.yml` or only group vars for image settings, `RUNBOOK.md`, `ansible/README.md`; add a meaningful verification in `ansible/verify.yml` if the existing check cannot detect a missing snapshot. Put infra spec/plan beside these files if this task grows beyond a small integration.

**Interfaces:** `ExecStartPre` executes `docker compose -f /opt/hooks/compose.yml exec -T hooks bun run src/cli.ts snapshot --output /data/snapshots/queue.sqlite`; `ExecStart` backs up the snapshot, Caddy volumes and `/opt/hooks`, excluding the live SQLite file. `hooks_image` uses the fixed SHA tag built by Task 8.

- [ ] Recheck infra sub-issue relationship, image tag and snapshot contract from Task 8 before changing the VPS.
- [ ] Write a targeted test or check for rendered systemd unit and Restic path list: snapshot command precedes `restic backup`, live `queue.sqlite` is absent. Run it and observe failure.
- [ ] Implement unit/path changes and document restore. Keep existing auxiliary/prod separation and HTTPS healthcheck.
- [ ] Run Ansible syntax/check and targeted test; on VPS run snapshot → Restic → restore in isolated directory with Telegram disabled, verify integrity, pending/sent rows and duplicate key.
- [ ] Commit infra changes, open its PR with `Closes #<infra-subissue>`, merge after Task 8 and before Task 10. Record actual restoration evidence in PR/runbook.

### Task 10: Боевой переход и закрытие родительской задачи

**Files:** Modify `services/webhook-alerts/README.md` with actual delivery sample and restore result; keep `.github/workflows/reminders.yml` and `add-to-project.yml` behavior.

**Interfaces:** Uses the switch and image from Task 8 and the running VPS/Restic integration from Task 9. Final `.github` PR closes #20 only after both live checks pass.

- [ ] With Telegram sending disabled, configure GitHub and Apidog targets, verify signed test deliveries and record anonymized Apidog fixture; if fixture changes parser behavior, add a failing test, fix it, rerun `bun test` and commit.
- [ ] Run live snapshot → Restic → isolated restore with worker stopped; verify `PRAGMA integrity_check=ok`, pending/sent rows and duplicate keys. Record exact commands and result.
- [ ] Turn off only event notification job via `TELEGRAM_EVENTS_SOURCE=webhook`, let earlier jobs finish, reconcile boundary deliveries and enable worker. Verify one new GitHub event and one Apidog event in their topics, plus board and reminders jobs.
- [ ] Update runbook with observed results; rerun all service and legacy checks, commit and open final `.github` PR with `Closes #20`. Merge after required CI and review, then verify post-merge checks.

## Self-review

Tasks 1–2 cover authenticated durable intake; 3, 4, 5 and 6 cover Telegram, GitHub, review and Apidog behavior; 7 and 9 cover the issue's strict snapshot/Restic/restore acceptance; 8 publishes the image and prepares the default-off switch; 10 performs and verifies the cutover. The five review-focus cases appear in named task tests. All external mutations and live Telegram checks occur only after local implementation and verification, with actual credentials supplied through Vault.
