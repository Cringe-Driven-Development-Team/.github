# GitHub webhook callers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Способ уже выбран владельцем. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Отключить дублирующий Actions sender для четырёх оставшихся caller и подтвердить реальную webhook-отправку каждого.

**Architecture:** Существующий org webhook и worker уже работают для всех репозиториев. Добавляем четыре repository ID в selected repositories существующей organization variable, затем сверяем новые GitHub события, Actions и SQLite outbox. Код сервиса не меняется.

**Tech Stack:** GitHub REST API/gh, Git, SSH, Bun SQLite readonly, Markdown, существующие shell/Bun tests.

**Spec:** `docs/superpowers/specs/2026-10-31-github-webhook-callers-design.md`

## Global Constraints

- Использовать существующую organization variable `TELEGRAM_EVENTS_SOURCE=webhook` с `visibility=selected`.
- Добавить `docs` (1369785278), `frontend-packages` (1403014726), `figma` (1375950508), `static` (1374136555), сохранив прежние selected repositories.
- Worker остаётся включённым; рабочая очередь не редактируется, старые сообщения не воспроизводятся и не удаляются.
- Код отправителей, формат карточек, Apidog, board/close, reminders, course-sync, release/deploy notifications не меняются.
- Не выводить secrets, полный webhook payload, токены или содержимое `.env`; сохранять только необходимые метаданные сверки.
- Не изменять пользовательские checkout; работа в `/home/oleg/2026_H2/.github-webhook-callers`, актуальный base `515352beac1a5a3ae98140121ca40e25f9551707`.
- Мерж PR выполняется при отдельном поручении владельца; переключение variable входит в текущее поручение.

## Review Focus

- Параллельное изменение selected repositories: читать перед каждой мутацией, добавлять по одному ID; не заменять список.
- Старые in-progress/queued notify: дождаться завершения, сверить фактические отправки и сохранить границу; не отменять jobs с неизвестным результатом.
- Scope/overrides: проверить все репозитории организации и environment variables, включая отсутствие caller у agent-plugins.
- HTTP 202 и Actions success недостаточны: сверить repo/ref/after SHA/GUID и ровно один sent outbox/message ID для каждого нового события.
- Тестовые ветки и независимая автоматика: main и файлы не менять, удалить только свои ветки; защитить board/close/reminders/release проверками и неизменностью workflow.

---

### Task 1: Завершить переключение и записать проверенный результат

**Files:**
- Modify: `services/webhook-alerts/README.md` — порядок расширения охвата при работающем worker и фактический журнал.
- Modify: `README.md` — актуальный статус webhook и подключение нового caller.
- Test: существующие `tests/webhook-workflows.test.ts`, `tests/telegram.sh`, `tests/reminders.sh`, `tests/close.sh`, `tests/lint.sh`.
- External config: selected repositories `TELEGRAM_EVENTS_SOURCE` в `Cringe-Driven-Development-Team`.
- Evidence: task report в выделенном SDD workspace; без secrets/payload.

**Interfaces:**
- Consumes: существующий `notify.if: vars.TELEGRAM_EVENTS_SOURCE != 'webhook'`, org hook 702764072, SQLite schema в `services/webhook-alerts/src/schema.sql`, SSH `deploy@hooks.cellestial.ru` с `/home/oleg/.ssh/selectel_release`, Compose `/opt/hooks/compose.yml`, readonly Bun SQLite.
- Produces: четыре новых selected repository; подтверждённые GUID/Actions run/job/message IDs по каждому; commit документации и полный report для task review.

- [ ] **Step 1: Зафиксировать исходную проверку и ожидаемый провал охвата.** Повторно прочитать org variable и selected repos, все repository/environment overrides, callers на актуальном main, состояние org hook и SQLite. Assert: полный набор восьми caller сейчас не покрыт variable. Сохранить результат и UTC; если настройку уже исправил другой агент, не создавать лишнюю мутацию, проверить её.
- [ ] **Step 2: Сверить границу отправителей.** Для четырёх новых caller проверить queued/in-progress automation runs и их notify jobs, дождаться завершения без отмены. Прочитать логи только с безопасным извлечением результата Telegram, без вывода всего лога. Сверить известный docs merge GUID `c2619620-d53e-11f1-9aeb-5eefc9b4b647`, outbox 374/message 8501 и job 124576022152; второй Telegram ID указывать только при доказанном результате. Если на границе есть pending/unprepared/review groups, разрешить каждое по событию, не редактируя очередь; unresolved отметить и не объявлять переключение проверенным.
- [ ] **Step 3: Добавить четыре selected repositories.** Перед каждым добавлением повторно читать variable, удостовериться в `value=webhook`, `visibility=selected`, затем `PUT /orgs/Cringe-Driven-Development-Team/actions/variables/TELEGRAM_EVENTS_SOURCE/repositories/{repository_id}` для отсутствующих ID. После каждого проверить API. Итог содержит прежние четыре и новые четыре, overrides отсутствуют. Не выполнять PATCH значения/visibility и не заменять весь список.
- [ ] **Step 4: Провести четыре живые проверки.** Для каждого нового caller использовать временную ветку с уникальным префиксом `webhook-cutover-20261031-`, от текущего main, затем push одного пустого коммита. Зафиксировать parent/after SHA; дождаться завершения automation run для after SHA. Проверить `telegram / notify=skipped`; найти org delivery push с соответствующими repo/ref/after SHA, HTTP 202; в readonly SQLite проверить единственную запись этого события, `prepared=1`, ровно один outbox `sent`, topic 26, ненулевой Telegram message ID. После завершения run и worker повторно проверить число сообщений. Без необходимости не создавать issue и не запускать deploy/release. Если создание ветки даёт отдельное событие, сверять его отдельно от контрольного push.
- [ ] **Step 5: Удалить свои временные ветки и проверить итог.** Перед удалением удостовериться в точном совпадении имени и ожидаемого head SHA. Delete push должен быть prepared без outbox. Повторно проверить selected repositories/overrides, здоровье сервиса, отсутствие неразрешённых GitHub outbox/review groups и неизменность независимых workflow во всех затронутых repos.
- [ ] **Step 6: Обновить две README.** В runbook добавить отдельный порядок расширения при включённом worker и журнал с UTC, before/after selected repos, образом, очередью, границей jobs, четырьмя live delivery GUID/run/job/message IDs и очисткой. Исправить корневое описание «пока готовится» и onboarding: org hook охватывает репозиторий, новый caller должен получить variable и пройти проверку skipped. Не переписывать исторический журнал первого переключения.
- [ ] **Step 7: Выполнить существующие проверки.** Из корня worktree: `bun test tests/webhook-workflows.test.ts`, `bash tests/telegram.sh`, `bash tests/reminders.sh`, `bash tests/close.sh`, `bash tests/lint.sh`, `git diff --check`. Если инструмент отсутствует, установить только уже требуемый проектом инструмент либо сообщить конкретную непроверенную команду; не добавлять зависимости в проект. Нового production-кода и новых зеркальных тестов не нужно.
- [ ] **Step 8: Self-review, commit и report.** Проверить diff и полноту матрицы четырёх событий. Коммит только двух README: `docs: завершить переключение GitHub callers на webhook`. Report: UTC и точные команды/результаты, безопасные метаданные внешних изменений, commit SHA, тесты, unresolved/ограничения. Вернуть controller только статус, SHA и краткий результат. Task reviewer проверяет spec compliance и task quality перед завершением; финальный whole-branch review выполняется отдельно.
