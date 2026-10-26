# Apidog Merge Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Для `BRANCH_MERGED` присылать в Telegram упоминания создателя и слившего MR, кнопку на MR и кнопку на опубликованный контракт.

**Architecture:** Worker обогащает уже сохранённую доставку чтением Apidog API; HTTP-приём webhook не ждёт Apidog. Точное совпадение проекта, исходной/целевой веток и времени `closedAt` определяет MR. Транспорт Telegram хранит и отправляет две кнопки в одной строке; при неудаче обогащения остаётся исходная карточка с кнопкой контракта.

**Tech Stack:** Bun/TypeScript, `fetch`, SQLite, Telegram Bot API, Ansible/Vault, GHCR.

**Spec:** [2026-10-26-apidog-merge-mentions-design.md](../specs/2026-10-26-apidog-merge-mentions-design.md)

## Global Constraints

- Обогащать только `BRANCH_MERGED`; остальные Apidog и GitHub события не меняют смысл.
- Проект `1382426`, целевая ветка `1388508` (`main`), контракт `https://vb78fyael1.apidog.io/`.
- Подтверждённый формат merge payload: строковые `event`, `title`, `content`, без `appLink`; в `content` отдельные `Merge Sprint Branch:`, `Project:`, `Updated at:`. Время наблюдаемого события совпало с `closedAt` UTC до секунды.
- Точная ссылка MR: `https://app.apidog.com/project/{projectId}/branch/{targetBranchId}/merge-request/{mrId}`. Два Telegram упоминания по числовым ID в прежнем топике; личные сообщения не отправлять.
- Токен Apidog и карта Apidog ID → имя/Telegram ID хранятся только в `vault_hooks_env`; не выводить токен, карту, raw payload или тело ответа Apidog в журнал/PR.
- Ошибка/неоднозначность Apidog даёт одну исходную карточку с кнопкой контракта, без ложных пингов и кнопки MR.
- Фактический `--from` в Apidog CLI вернул чужие MR. Прямой API фильтр `sourceBranchId` проверен на MR `39834`, но ответ всё равно проверять локально.

## Review Focus

1. Неизвестный формат даты, часовой пояс или имя проекта: обычный merge-алерт с одной кнопкой контракта, без чужого MR (Task 3 test).
2. Повторно использованная ветка или проигнорированный API фильтр: выбрать только один MR с точными `sourceBranchId`, `targetBranchId`, `status` и `closedAt` (Task 2 test).
3. Недоступный/ошибочный API и содержащий секрет текст ошибки: карточка отправляется, журнал содержит только код ошибки (Task 2 and 3 tests).
4. Отложенная очередь после рестарта: обе кнопки остаются в одном Telegram сообщении; старые одиночные кнопки GitHub читаются (Task 1 test).
5. Один человек в двух ролях или неизвестный Apidog ID: не отправлять два пинга одному человеку и не угадывать Telegram ID (Task 3 test).

## File Map

| File | Responsibility |
| --- | --- |
| `services/webhook-alerts/src/store.ts` | Модель второй кнопки и кодирование в существующей `outbox.button_json` |
| `services/webhook-alerts/src/telegram.ts` | Одна строка `inline_keyboard` из одной или двух кнопок |
| `services/webhook-alerts/src/apidog-api.ts` | Только чтение веток и MR Apidog, строгий поиск одного кандидата |
| `services/webhook-alerts/src/apidog-merge.ts` | Разбор `BRANCH_MERGED`, упоминания, ссылки, fallback |
| `services/webhook-alerts/src/config.ts`, `src/worker.ts`, `src/main.ts` | Проверка env и включение Apidog клиента в worker |
| `services/webhook-alerts/tests/{store,worker,apidog-api,apidog-merge,main,http}.test.ts` | Пиннинг важных результатов и границ ошибки |
| `services/webhook-alerts/README.md` | Настройка Apidog доступа и карт участников |
| `infra/ansible/roles/hooks/{defaults/main.yml,tasks/validate.yml}` | Публичные параметры и preflight секретных переменных |
| `infra/ansible/tests/test_hooks.py`, `infra/RUNBOOK.md` | Ansible проверка и инструкция эксплуатации |
| `infra/ansible/inventory/group_vars/all/vault.yml` | Только зашифрованные токен и карта участников |

---

### Task 1: Две кнопки в Telegram и SQLite

**Files:**
- Modify: `services/webhook-alerts/src/store.ts`
- Modify: `services/webhook-alerts/src/telegram.ts`
- Test: `services/webhook-alerts/tests/store.test.ts`
- Test: `services/webhook-alerts/tests/worker.test.ts`

**Interfaces:**
- Produces: `OutgoingMessage.secondaryButton?: { text: string; url: string }`; прежнее `button` остаётся основной кнопкой.
- `button_json` хранит основной `{text,url}` и необязательное поле `secondaryButton`; изменение схемы SQLite не требуется. Чтение прежнего объекта `{text,url}` возвращает только основную кнопку.

- [ ] **Step 1: Write failing tests.** В `store.test.ts`: `prepare` двухкнопочной карточки → закрыть/открыть SQLite → `claimDue` возвращает обе ссылки в прежнем порядке; однокнопочная запись читается как прежде. В `worker.test.ts`: Telegram `sendMessage` получает `reply_markup.inline_keyboard: [[{text:'Открыть MR',url:'https://app.apidog.com/...'},{text:'Контракт API',url:'https://vb78fyael1.apidog.io/'}]]`; существующий тест одной кнопки остаётся зелёным.
- [ ] **Step 2: Confirm red.** Run: `cd services/webhook-alerts && bun test tests/store.test.ts tests/worker.test.ts`. Expected: новые assertions FAIL на отсутствующей второй кнопке.
- [ ] **Step 3: Implement.** Добавить `secondaryButton` в `OutgoingMessage`/`DueMessage`, кодировать его внутри `button_json` в обоих путях вставки outbox и восстанавливать при чтении. `sendMessage` строит ряд из основной и дополнительной кнопок; при одной основной оставляет нынешний JSON.
- [ ] **Step 4: Confirm green.** Run: `cd services/webhook-alerts && bun test tests/store.test.ts tests/worker.test.ts && bunx tsc --noEmit`. Expected: PASS, exit 0.
- [ ] **Step 5: Commit.** `git add services/webhook-alerts/src/{store,telegram}.ts services/webhook-alerts/tests/{store,worker}.test.ts && git commit -m "feat: две кнопки в карточке Telegram"`.

### Task 2: Поиск слитого MR в Apidog

**Files:**
- Create: `services/webhook-alerts/src/apidog-api.ts`
- Test: `services/webhook-alerts/tests/apidog-api.test.ts`

**Interfaces:**
- Produces: `ApidogMergedRequest = { id: number; sourceBranchId: number; targetBranchId: number; createdById: number; closedById: number; closedAt: string; status: 'MERGED' }`.
- Produces: `ApidogApi.findMergedRequest(input: { projectId: number; targetBranchId: number; sourceBranchName: string; mergedAtIso: string }): Promise<ApidogMergedRequest | undefined>` and `createApidogApi(options: { token: string; fetch?: typeof fetch; timeoutMs?: number }): ApidogApi`.
- Errors: `ApidogApiError.code` contains a fixed classification (`http_NNN`, `timeout`, `invalid_response`, `pagination_limit`, `network`); never response text.

- [ ] **Step 1: Write failing tests.** Mock `fetch` for `GET /api/v1/projects/1382426/sprint-branches`, filtered `GET /sprint-branches/1388508/merge-requests?sourceBranchId=1413082&status=MERGED...`, and details `GET .../39834`. Assert MR `39834` with IDs `1066826`/`1067537`, `closedAt=2026-10-26T10:28:47.000Z`; `Authorization: Bearer` in header, `X-Apidog-Api-Version: 2026-05-28`, no token in URL, `redirect: 'error'`. Add ignored-filter/unrelated-row, `meta.nextPage`, ambiguous exact match, wrong timestamp, malformed response, HTTP 5xx/network/timeout tests; error/log assertion excludes token/response body.
- [ ] **Step 2: Confirm red.** Run: `cd services/webhook-alerts && bun test tests/apidog-api.test.ts`. Expected: import/signature FAIL.
- [ ] **Step 3: Implement.** Use fixed origin `https://api.apidog.com`; read `/api/v1/projects/{projectId}/sprint-branches`, select one exact branch name, then list merged MRs under target branch with numeric `sourceBranchId`, `status=MERGED`, `page`, `perPage=100`. Follow `meta.nextPage` with a bounded page count; still check every returned candidate locally, fetch details, and accept only one with exact branch IDs/status and `closedAt` equal to `mergedAtIso` to the second. Use a 5 s overall timeout and classify errors without exposing body/token. No CLI dependency or subprocess.
- [ ] **Step 4: Confirm green.** Run: `cd services/webhook-alerts && bun test tests/apidog-api.test.ts && bunx tsc --noEmit`. Expected: PASS, exit 0. Read-only live check with locally authenticated Apidog token returns MR `39834` and the expected IDs; print only status/IDs.
- [ ] **Step 5: Commit.** `git add services/webhook-alerts/src/apidog-api.ts services/webhook-alerts/tests/apidog-api.test.ts && git commit -m "feat: находить слитый Apidog MR"`.

### Task 3: Merge-карточка и настройки сервиса

**Files:**
- Create: `services/webhook-alerts/src/apidog-merge.ts`
- Modify: `services/webhook-alerts/src/config.ts`
- Modify: `services/webhook-alerts/src/worker.ts`
- Modify: `services/webhook-alerts/src/main.ts`
- Modify: `services/webhook-alerts/README.md`
- Test: `services/webhook-alerts/tests/apidog-merge.test.ts`
- Test: `services/webhook-alerts/tests/main.test.ts`
- Test: `services/webhook-alerts/tests/http.test.ts`

**Interfaces:**
- Consumes: `ApidogApi.findMergedRequest(...)` (Task 2) and `OutgoingMessage.secondaryButton` (Task 1).
- Produces: `parseMergeNotice(payload: unknown, projectName: string): { sourceBranchName: string; mergedAtIso: string } | undefined`; `formatApidogMerge(delivery: Delivery, base: OutgoingMessage, api: ApidogApi, config: ApidogMergeConfig): Promise<OutgoingMessage>`.
- `ApidogMergeConfig`: `{ projectId, targetBranchId, projectName, contractUrl, peopleMap }`, where `peopleMap: Record<string, { name: string; telegramId: string }>`.
- Env: `APIDOG_PROJECT_ID`, `APIDOG_TARGET_BRANCH_ID`, `APIDOG_PROJECT_NAME`, `APIDOG_CONTRACT_URL`, `APIDOG_ACCESS_TOKEN`, `APIDOG_TELEGRAM_USER_MAP`; required/validated when sender enabled.

- [ ] **Step 1: Write failing tests.** Synthetic `BRANCH_MERGED` body has anchored lines `Merge Sprint Branch:`, `Project:`, `Updated at: 2026-10-26 10:28:47`, with optional trailing spaces. Assert two HTML `tg://user?id=` mentions, labels `Создатель MR`/`Слил MR`, direct button URL ending `/branch/1388508/merge-request/39834`, second button exact `https://vb78fyael1.apidog.io/`. Add malformed/missing project/date (including impossible dates), unknown user ID, same user in both roles, client failure/ambiguous result, escaping/length and unrelated event tests. `main.test.ts` and `http.test.ts` reject missing token/map or malformed IDs and wire a fake API/fetch without leaking secrets.
- [ ] **Step 2: Confirm red.** Run: `cd services/webhook-alerts && bun test tests/apidog-merge.test.ts tests/main.test.ts tests/http.test.ts`. Expected: new merge assertions/import FAIL.
- [ ] **Step 3: Implement.** Parse only line-anchored exact fields; treat `Updated at` as UTC at second precision only for the observed `YYYY-MM-DD HH:mm:ss` form. Build base via existing `formatApidog`; for merge always put contract URL in a button. On one exact MR, add role lines using HTML escaping and mapped numeric Telegram IDs, make MR the primary and contract the secondary button. Unknown identity is plain text; if two roles share one ID, only first role gets a mention. Catch Apidog lookup errors and record only fixed codes. Connect `createApidogApi`/merge projector in worker, while other event paths remain the same. Document env and maintenance of people map in README.
- [ ] **Step 4: Confirm green.** Run: `cd services/webhook-alerts && bun test && bunx tsc --noEmit`. Expected: all tests PASS and typecheck exit 0.
- [ ] **Step 5: Commit.** `git add services/webhook-alerts/src services/webhook-alerts/tests services/webhook-alerts/README.md && git commit -m "feat: пинги и ссылки Apidog MR"`.

### Task 4: Ansible и Vault для новых параметров

**Files (in `infra` checkout/worktree):**
- Modify: `ansible/roles/hooks/defaults/main.yml`
- Modify: `ansible/roles/hooks/tasks/validate.yml`
- Modify: `ansible/tests/test_hooks.py`
- Modify: `ansible/inventory/group_vars/all/vault.yml` (зашифрованный файл)
- Modify: `RUNBOOK.md`

**Interfaces:**
- Consumes: names and JSON shape of six env variables from Task 3.
- Public values: project `1382426`, target branch `1388508`, name `2026_2_Cringe_Driven_Development`, contract URL `https://vb78fyael1.apidog.io/`.
- Vault values: `APIDOG_ACCESS_TOKEN`; `APIDOG_TELEGRAM_USER_MAP` maps `1066826` → Валентин Кунев/MrDuckVC Telegram ID and `1067537` → Александр Батовкин/blackHATred Telegram ID. Copy IDs from existing organization `TELEGRAM_USER_MAP` without printing them.

- [ ] **Step 1: Write failing Ansible test.** Extend `test_sender_preflight_requires_separate_apidog_bot_token`: enabled sender with new token/map succeeds, each missing token/map fails with variable name but no value; bad public project/branch/URL fails. No real secret in tests.
- [ ] **Step 2: Confirm red.** Run: `cd ansible && python -m unittest tests.test_hooks.HooksChecks.test_sender_preflight_requires_separate_apidog_bot_token -v`. Expected: new assertions FAIL.
- [ ] **Step 3: Implement.** Add public env defaults, sender preflight, and RUNBOOK instructions. Safely add only the new secret/map keys to existing encrypted Vault, retaining every current value; verify decrypted key names and semantic equality of old keys without printing values. Use existing local Apidog CLI credential already verified read-only against MR `39834`; never pass it in argv or GitHub comments.
- [ ] **Step 4: Confirm green.** Run: `cd ansible && python -m unittest discover -s tests -v && ansible-playbook -i inventory/ci.yml --syntax-check auxiliary.yml && ansible-lint auxiliary.yml roles/hooks`. Expected: tests/syntax pass; lint has no new errors. `ansible-vault view` verification prints only key names.
- [ ] **Step 5: Commit.** `git add ansible/roles/hooks/defaults/main.yml ansible/roles/hooks/tasks/validate.yml ansible/tests/test_hooks.py ansible/inventory/group_vars/all/vault.yml RUNBOOK.md && git commit -m "feat: настроить Apidog MR обогащение на VPS"`.

### Task 5: Публикация, выкладка и приёмка

**Files:** service/infra changes from Tasks 1–4; no extra product code expected.

**Interfaces:** output is deployed image digest, healthy service, and a sent two-button test card in an isolated Telegram topic.

- [ ] **Step 1: Track cross-repo work.** Per `CONTRIBUTING.md`, create DevOps parent issue in `infra` and `.github` sub-issue; PR references use `Closes`/`Part of` so the parent closes after both repositories are merged.
- [ ] **Step 2: Open `.github` PR and verify.** Push branch, open PR with spec/plan links; check current head, required CI, conflict status, then merge. Confirm post-merge checks and `webhook-alerts-image.yml` publication; obtain exact GHCR registry manifest digest from successful SHA tag.
- [ ] **Step 3: Open `infra` PR and verify.** Pin that digest and SHA source tag in `hooks` defaults, include Task 4 changes; check current head, CI, conflicts, then merge and verify post-merge `auxiliary.yml`/`verify.yml` success.
- [ ] **Step 4: Exercise real data without duplicate production alert.** In a separate DB/test Telegram topic, process an anonymized `BRANCH_MERGED` fixture pointing to MR `39834`; confirm one message from `@apidog_monitoring_bot`, two mentions, two working buttons. On production VPS verify the deployed image digest, `/health`, direct Apidog API access and no new queue errors. Do not replay MR `39834` into the production chat.
- [ ] **Step 5: Record evidence.** Update issues with commits, image digest, checks and test message result; report that the next natural merge is the remaining live event observation.

## Self-Review

- Spec coverage: Task 1 covers two buttons; Task 2 resolves a unique MR; Task 3 formats pings/fallback; Task 4 supplies secure config; Task 5 verifies deployment.
- The five Review Focus inputs are pinned to tests in the owning tasks. The original webhook schema and unrelated event routes are unchanged.
- Task boundaries each have a checkable deliverable and a review gate. The API client performs only reads; no Apidog project content changes are planned.
