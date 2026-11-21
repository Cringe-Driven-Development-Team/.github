# Очистка следов прежней интеграции вебхуков — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель.** Убрать следы выведенной из эксплуатации интеграции из `.github`, `infra`, опубликованной OpenWiki и рабочей схемы SQLite.

**Архитектура.** Сервис создаёт новые базы v8 и обновляет v6 или v7 через транзакционную замену `deliveries`. OpenWiki генерируется отдельной веткой после мержа исходников `infra`.

**Стек.** Bun 1.4.4, `bun:sqlite`, Docker Compose, Ansible 2.19.7, GitHub Actions и OpenWiki.

**Спецификация.** [Очистка следов прежней интеграции вебхуков](../specs/2026-11-21-retired-webhook-cleanup-design.md).

## Общие ограничения

- Рабочие GitHub-доставки, outbox, связи ревью и релизов, все границы активации и release contract сохраняются. Рабочая схема принимает `source = 'github'`. `dedupe_kind` удаляется, `body_hash` сохраняется.
- Пустая база создаётся на v8. Базы v6 и v7 обновляются до v8 до запуска HTTP и worker. Версии 1–5 исключены из поддерживаемого восстановления. Более новые неизвестные версии отклоняются.
- Критерий очистки применяется к именам и содержимому отслеживаемых файлов обоих `main`. Для проверок передать прежнее название из поручения во внешней переменной `RETIRED_WEBHOOK_PROVIDER`.
- Использовать актуальный `origin/main` и worktrees под `.worktrees/` соответствующего репозитория. v7 занята миграцией алертов `infra` из `.github#80`. Свежую базу и путь с v6 инициализировать с этой таблицей.

## Что особенно проверить

1. При переходе с v7 сохраняется заданный cutoff `infra`, при переходе с v6 появляется пустая таблица `infra_release_activation`.
2. `review_group_deliveries` и `release_recovery` по-прежнему ссылаются на исходные ID даже при наличии подготовленной и арендованной доставок.
3. На повреждённой входной базе проверка внешних ключей отменяет замену таблицы и изменение версии.
4. Новый запуск и повторное открытие дают одну схему v8. Вставка доставки неизвестного источника отвергается, идентичный GitHub redelivery возвращает `duplicate`, конфликт тела возвращает `conflict`.
5. Поиск проверяет также имена документов и Claims OpenWiki. Свежесть Wiki подтверждается относительно `main` после мержа исходников.

---

### Task 1. Перестроить очередь и очистить `.github`

**Файлы.** `services/webhook-alerts/src/{store.ts,schema.sql,release-schema.sql}`, новый `src/deliveries-schema.sql` в каталоге сервиса, тесты и `services/webhook-alerts/README.md`, документация в `docs/migrations/` и `docs/superpowers/`.

**Интерфейсы.** `openStore(path: string): Store`, `Store.accept(input: DeliveryInput): AcceptResult`. `Store.releaseActivation(repository?)` сохраняет текущие результаты для frontend, backend и `Cringe-Driven-Development-Team/infra`.

- [ ] **Добавить RED в `store.test.ts`.** Собрать v6 и v7 независимой SQLite-фикстурой со старым `dedupe_kind` и синтетическим альтернативным значением CHECK. Вставить GitHub-строки с известными ID, байтами, SHA, обычным и релизным `lane`, pending и leased. Добавить outbox `sent` и `pending`, `review_group_deliveries`, `release_recovery`, `release_notices` и cutoff frontend/backend/contract, для v7 также cutoff `infra`. Для обоих входов после `openStore` проверить `user_version=8`, полное равенство сохранённых полей и связей, отсутствие `dedupe_kind`, ожидаемый cutoff `infra`, `foreign_key_check` без строк и открытие второй раз без изменений. Для v6 отдельно проверить возможность активировать `infra` по существующему CLI после обновления.
- [ ] **Добавить RED для ошибочной и пустой базы.** В v7-фикстуре с выключенными FK создать ссылку на отсутствующую доставку. `openStore` должен выбросить ошибку, а `sqlite_schema`, `user_version` и данные должны совпасть с входом. На пустой базе проверить v8, `CHECK` с `source = 'github'`, сохранение загруженного GitHub ID на `duplicate` и `conflict`. Открытие старой v5 и неизвестной v9 должно завершиться ошибкой. Сравнить столбцы и индексы новой и обновлённой v8.
- [ ] **Запустить RED.** `bun install --frozen-lockfile --cwd services/webhook-alerts`, затем `bun test services/webhook-alerts/tests/store.test.ts`. Ожидать отказ новых сценариев из-за отсутствия v8.
- [ ] **Реализовать DDL и переход в `openStore`.** Одна декларация `CREATE TABLE deliveries_next` в `deliveries-schema.sql` используется при создании и обновлении. Поля таблицы v8 идут явно, включая `prepared`, `lease_until` и `lane`. Для v6/v7 выполнить явный `INSERT INTO deliveries_next (...) SELECT ... FROM deliveries` с сохранением ID, удалить старую таблицу, переименовать новую и создать `deliveries_unprepared`. Для v6 в той же транзакции добавить `infra_release_activation`; v7 использует существующую таблицу. Для версии 0 развернуть итоговые outbox с `keyboard_json`, review и release таблицы плюс `release_contract`, backend и infra activation. Убрать старые `ALTER TABLE` из `release-schema.sql`, поскольку `lane` и `keyboard_json` уже есть в финальной схеме. `Store.accept` перестаёт записывать удалённое поле.
- [ ] **Сохранить атомарность.** Проверки FK временно выключаются на соединении до `.immediate()` транзакции. Текущий `user_version` читается под её блокировкой. Внутри той же транзакции после замены таблицы выполнить `PRAGMA foreign_key_check`; при наличии строки бросить ошибку, иначе выставить v8. После успешной транзакции включить FK до возврата `Store`. Обработчик ошибок закрывает соединение. Версия 8 открывается без изменения таблиц.
- [ ] **Обновить тесты и runbook.** Удалить проверку миграций v1–v5 из `review-groups`, `releases-store`, `backend-release-store` и старых сценариев `store`. Перенести существенные утверждения о статусе uncertain и release contract в проверку поддерживаемого перехода. В `infra-releases` сохранить проверку CLI и cutoff. В `snapshot` проверять сохранение GitHub ID и хеша. В `http` и `main` оставить тест `404` для `/webhooks/unknown`. В сервисном README сохранить текущий алгоритм snapshot и описать совместимость v6/v7/v8; убрать относящиеся к бывшей интеграции части исторического журнала.
- [ ] **Очистить остальные документы `.github`.** Найти файлы по фиксированному шаблону в `RETIRED_WEBHOOK_PROVIDER` в путях и содержимом. Удалить посвящённые интеграции планы и спеки, в остальных убрать только соответствующие фрагменты и битые ссылки. Сохранить применимые инструкции по GitHub, Telegram и миграции учебных репозиториев. Проверить отсутствие совпадений по обоим видам поиска.
- [ ] **Запустить GREEN и закоммитить.** `bun test services/webhook-alerts/tests tests/webhook-workflows.test.ts tests/auxiliary-publish.test.ts`, `bun run --cwd services/webhook-alerts typecheck`, `docker build -t webhook-alerts:test services/webhook-alerts`, `bash tests/webhook-alerts-docker.sh webhook-alerts:test`, `git diff --check`. Команды завершаются с кодом 0.

### Task 2. Очистить исходники `infra`

**Файлы.** `RUNBOOK.md` и `ansible/tests/test_hooks.py`. Правки Wiki делает Task 4.

**Интерфейсы.** Прежние `vault_hooks_env`, `env.j2`, `auxiliary.yml` и набор полей `hooks_env`. Тест `test_compose_uses_image_entrypoint_and_preserves_webhook_secrets` проверяет рендер существующего шаблона и Compose.

- [ ] **Заменить проверку отдельного префикса в тесте.** Сравнить ключи `service["environment"]` с ключами заданного `vault_hooks_env` и defaults `DATABASE_PATH`, `PORT`, `WEBHOOK_ALERTS_SEND_ENABLED`, `TELEGRAM_PROXY_URL`, `TELEGRAM_INFRA_ALERTS_TOPIC_ID`. Сохранить проверки экранирования секрета, тем и использования entrypoint.
- [ ] **Очистить `RUNBOOK.md`.** В датированном отчёте оставить подтверждённые результаты GitHub, SQLite и бэкапа. Убрать фрагменты бывшей интеграции.
- [ ] **Запустить тесты и закоммитить.** Из `ansible/` выполнить `COMPOSE_CLI='docker compose' python -m unittest discover -s tests -v` на версии CI и `git diff --check`. Проверить поиск по имени прежнего поставщика в отслеживаемых файлах `infra` вне `openwiki/`. Тесты и проверка diff завершаются с кодом 0, поиск пуст.

### Task 3. Влить изменения и перестроить рабочую SQLite

**Входы.** Проверенные PR Tasks 1–2. Publisher `webhook-alerts-image.yml` и `auxiliary-cd.yml` в `.github`, исполнитель `auxiliary-deploy.yml` в `infra`.

- [ ] **Снять исходные метаданные на VPS3.** Read-only проверить `user_version` и записать GitHub ID до текущего максимума, число и SHA-256 упорядоченных троек `(id, delivery_id, body_hash)` или эквивалентную контрольную сумму, release activation и release contract. Сверить наличие `infra` activation только если она существует на входе. В журнал попадают метаданные, без payload и env.
- [ ] **Влить PR сервиса и проследить фактическую выкатку.** Перед мержем сверить актуальные head, CI и mergeability. После мержа проверить `Webhook alerts image`, `Auxiliary CD`, результат дочернего deployment и digest из publisher artifact в `/opt/hooks/releases.json` и Compose.
- [ ] **Проверить v8 на VPS3.** Read-only подтвердить `user_version=8`, итоговое ограничение на источник и отсутствие `dedupe_kind` через `sqlite_schema` и `PRAGMA table_info`, пустой `foreign_key_check`, неизменность контрольной суммы исходных GitHub записей и значений cutoff. Для исходной v6 новая таблица `infra` есть, её конфигурация применяется штатно. `/health` возвращает `200`. Сопоставить новое подлинное GitHub-событие с `sent` outbox и ID карточки Telegram.
- [ ] **Влить PR с исходниками `infra`.** Перед мержем сверить head, CI и preview. Дождаться штатного post-merge workflow. Сохранить его URL и подтвердить здоровый `hooks` на том же digest.

### Task 4. Обновить OpenWiki и проверить оба `main`

**Файлы.** Сгенерированные `infra/openwiki/operations/auxiliary.md`, `infra/openwiki/testing/verification.md` и управляемые OpenWiki метаданные. `openwiki-freshness.yml` проверяет wiki-only PR, `publish-docs-wiki.yml` запускает публикацию после мержа.

- [ ] **Обновить Wiki из `infra/main` после Task 3.** Хост с доступом к OpenWiki запускает `openwiki_begin` с mode `update` и последовательно обрабатывает назначенные jobs до `openwiki_finish`. В двух целевых страницах и Claims убрать устаревшие утверждения и сохранить текущую информацию о настройках и тестах. Sidecars и checkpoint формирует OpenWiki.
- [ ] **Проверить и влить wiki-only PR.** `bun scripts/openwiki-check.ts --against <полный SHA исходного main>` должен завершиться с кодом 0. Проверить свежесть в CI, влить PR и дождаться `Publish docs wiki` и вызванного workflow Pages в `docs`.
- [ ] **Подтвердить итог.** В каждом репозитории обновить `origin/main`. `git grep -i -F -e "$RETIRED_WEBHOOK_PROVIDER" origin/main --` и `git ls-tree -r --name-only origin/main | rg -i -F -- "$RETIRED_WEBHOOK_PROVIDER"` должны вернуть код 1 без совпадений. Проверить опубликованные страницы, живой `/health`, зафиксировать ссылки на PR, CI/CD и версию базы.
