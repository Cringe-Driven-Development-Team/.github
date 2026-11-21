# Удаление алертов Apidog — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель.** Убрать алерты Apidog из сервиса и с VPS3, включая записи Apidog в рабочей очереди.

**Архитектура.** `webhook-alerts` принимает и отправляет события GitHub. При открытии SQLite миграция v6 удаляет связанные строки Apidog. Auxiliary CD выкатывает образ, после чего обычный `auxiliary.yml` применяет очищенное окружение.

**Стек.** Bun 1.4.4, Hono, `bun:sqlite`, Docker Compose, GitHub Actions и Ansible.

**Спецификация.** [Удаление алертов Apidog](../specs/2026-11-21-remove-apidog-alerts-design.md).

## Общие ограничения

- Удаление данных ограничено рабочей SQLite. Контракт API, остальные интеграции Apidog, сообщения Telegram и существующие резервные копии за пределами задачи.
- Миграция выполняется до запуска worker в одной транзакции с включёнными внешними ключами. Граница удаления определяется по `deliveries.source = 'apidog'`.
- `POST /webhooks/apidog` возвращает `404`. Подпись, лимит тела, идентификатор и дедупликация GitHub webhook проверяются как прежде.
- Работа идёт в двух репозиториях от актуального `origin/main`. Относительные пути в задачах даны от корня соответствующего репозитория. Использовать worktrees под `.worktrees/`.

## Что особенно проверить

1. Совпадающие ID доставки Apidog и группы ревью. Миграция сохраняет outbox группы и её связи (задача 1).
2. Ошибка второго `DELETE`. Оба набора записей и `user_version` остаются на v5, успешное повторное открытие применяет v6 (задача 1).
3. Повторное открытие и старый снимок. Базы v2 и v5 обновляются до v6, GitHub redelivery сохраняет дедупликацию, удалённый outbox ID не подлежит `retry` (задача 1).
4. Включённый worker без переменных Apidog. Единственная карточка тестового GitHub-ревью уходит через заданные бот, тему и proxy, а сетевые вызовы ограничены GitHub и Telegram (задача 1).
5. Режимы отправки в Ansible. Выключенный и включённый worker работают без переменных Apidog. Включённый режим требует настройки основного бота, конфигурация релизного топика по-прежнему требует GitHub API token (задача 2).

---

### Задача 1. Удалить Apidog из сервиса и рабочей SQLite

**Файлы.** `services/webhook-alerts/src/{auth,config,http,main,store,telegram,worker}.ts`, `src/schema.sql` в каталоге сервиса, пять `src/apidog*.ts`, тесты и фикстуры в `services/webhook-alerts/tests/`, `tests/webhook-alerts-docker.sh`, `README.md`, `services/webhook-alerts/README.md`.

**Интерфейсы.** Существующие `openStore(path: string): Store`, `loadConfig(env): Config` и `startService(config, options?)`. `DeliveryInput` и `IncomingDelivery` принимают `source: 'github'` и обязательный `deliveryId: string`. Для форматирования используется существующий `createGithubProjector(api, config)`.

- [ ] **Добавить RED миграции в `store.test.ts`.** Собрать v5 через SQL схемы и предыдущих миграций, затем вставить данные старого формата напрямую SQLite. Основа для сборки старой схемы есть в `releases-store.test.ts`. Добавить Apidog raw, `mr-poll:cutoff`, MR и связанные `sent`, `pending`, `leased`, `failed` outbox. Добавить GitHub-строки, релизную карточку с `release_notices`, группу ревью с `review_group_deliveries` и outbox группы с `origin_id`, совпадающим с удаляемой доставкой. После `openStore` сверить `user_version = 6`, ноль Apidog-строк и их outbox ID, неизменность GitHub-строк, ревью и релизных связей, `PRAGMA foreign_key_check` без строк и `retryFailed(удалённый_id, now) === false`. При повторном открытии сверить результат и `store.accept(исходная_GitHub_доставка) === 'duplicate'`.
- [ ] **Проверить атомарность в `store.test.ts`.** Создать на v5 временную тестовую БД с Apidog-доставкой и outbox. Добавить в неё триггер `BEFORE DELETE ON deliveries` с `RAISE(ABORT, ...)`. `openStore` должен бросить исключение, строки должны остаться целыми, версия должна остаться 5. Удалить триггер и проверить успешное обновление той же базы. В `releases-store.test.ts` сохранить реальный сценарий v2 → v6.
- [ ] **Добавить RED входа в `main.test.ts` и `http.test.ts`.** Запустить сервис без `APIDOG_*` и `TELEGRAM_APIDOG_*` с `WEBHOOK_ALERTS_SEND_ENABLED=true`. На `POST /webhooks/apidog` ожидать `404` и отсутствие записи. Существующий тест worker переделать на одну GitHub review-карточку в заданной теме и только GitHub/Telegram запросы. В smoke test убрать подставные значения Apidog.
- [ ] **Запустить RED.** Выполнить `bun install --frozen-lockfile --cwd services/webhook-alerts`, затем `bun test services/webhook-alerts/tests/store.test.ts services/webhook-alerts/tests/http.test.ts services/webhook-alerts/tests/main.test.ts`. Ожидать отказ на старом обязательном конфиге Apidog и отсутствие миграции v6.
- [ ] **Реализовать миграцию в `openStore`.** В существующей `immediate()` транзакции, после v5 и до `return new Store(db)`, добавить v6 и повысить поддерживаемый `user_version` до 6. Порядок SQL:

  ```sql
  DELETE FROM outbox
  WHERE origin_type = 'delivery'
    AND origin_id IN (SELECT id FROM deliveries WHERE source = 'apidog');
  DELETE FROM deliveries WHERE source = 'apidog';
  PRAGMA user_version = 6;
  ```

  Сохранить таблицы и ID, убрать окно дедупликации по хешу и его индекс из существующей и чистой схем. Сравнение хеша при повторе GitHub delivery ID остаётся, `dedupe_kind` в новых записях равен `id`. Удалить `startApidogMrMonitoring`, `recordApidogMergeRequests` и исключение `APIDOG_RAW_SUPPRESSED` из ручного retry. Сохранить защиту `release_skipped`.
- [ ] **Удалить runtime Apidog.** Зарегистрировать только `POST /webhooks/github`; сохранить `verifyGithub` с SHA-256 по исходным байтам. Убрать обязательные переменные Apidog, второго бота, `pollApidog` и `createProjector`. Использовать `createGithubProjector` и основной `sendMessage`. Удалить `apidog.ts`, `apidog-api.ts`, `apidog-branch.ts`, `apidog-merge.ts`, `apidog-notice.ts`. У `secondaryButton` единственным production-источником был Apidog. Убрать поле и оставить `button` и многострочный `keyboard` для текущих карточек.
- [ ] **Обновить тесты и документацию.** Удалить `tests/apidog*.test.ts` и `tests/fixtures/apidog/` внутри сервиса. Очистить Apidog-сценарии и env в `backend-config`, `backend-worker`, `github`, `http`, `main`, `release-integration`, `release-worker`, `snapshot`, `store` и `worker` тестах. Сохранить проверки GitHub подписи, retry, snapshot/restore, клавиатур релизов и группировки ревью. Замены в README ограничить текущими инструкциями, исторический журнал приёмки обозначить как историю.
- [ ] **Запустить GREEN из корня `.github`.**

  ```bash
  bun test services/webhook-alerts/tests tests/webhook-workflows.test.ts tests/auxiliary-publish.test.ts
  bun run --cwd services/webhook-alerts typecheck
  docker build -t webhook-alerts:test services/webhook-alerts
  bash tests/webhook-alerts-docker.sh webhook-alerts:test
  git diff --check
  ```

  Все команды завершаются с кодом 0. Зафиксировать сервис, тесты и README одним коммитом `refactor(webhooks): remove Apidog alerts`.

### Задача 2. Удалить конфигурацию из `infra`

**Файлы.** `ansible/roles/hooks/defaults/main.yml`, `ansible/roles/hooks/tasks/validate.yml`, `ansible/inventory/group_vars/all/vault.yml`, `ansible/tests/test_hooks.py`, `ansible/tests/test_githubbot.py`, `ansible/README.md`, `RUNBOOK.md`.

**Интерфейсы.** `vault_hooks_env` продолжает передаваться существующим `env.j2`. Отправка требует `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`. `GITHUB_WEBHOOK_SECRET` требуется в обоих режимах. `TELEGRAM_RELEASES_TOPIC_ID` и `TELEGRAM_BACKEND_RELEASES_TOPIC_ID` используют действующие правила проверки.

- [ ] **Добавить RED в `test_hooks.py`.** Убрать Apidog из базовой фикстуры и проверить `validate.yml` в обоих режимах через существующий `self.play(...)`. Ожидать `returncode == 0` на валидных данных и отказ при отсутствии `GITHUB_WEBHOOK_SECRET` либо настроек основного Telegram при включённой отправке. В тесте рендера проверить отсутствие ключей Apidog в `.env`. Удалить подставные Apidog-поля из фикстуры `test_githubbot.py`.
- [ ] **Запустить RED из `infra/ansible`.** Установить штатные Ansible requirements и коллекции. Выполнить `COMPOSE_CLI='docker compose' python -m unittest discover -s tests -p test_hooks.py -v`. Ожидать отказ роли на отсутствующих Apidog-полях в положительных сценариях.
- [ ] **Убрать Apidog из роли и Vault.** Снять четыре публичных defaults `APIDOG_PROJECT_ID`, `APIDOG_TARGET_BRANCH_ID`, `APIDOG_PROJECT_NAME`, `APIDOG_CONTRACT_URL`. Из `vault_hooks_env` убрать все `APIDOG_*` и `TELEGRAM_APIDOG_*` штатным редактированием Ansible Vault. Значения проверять без раскрытия. Удалить относящиеся к ним проверки из `validate.yml` и обновить текущие инструкции в двух README/runbook. `env.j2` уже рендерит словарь, дополнительных фильтров ему не требуется.
- [ ] **Запустить GREEN из `infra/ansible`.** Выполнить `COMPOSE_CLI='docker compose' python -m unittest discover -s tests -v`, `ansible-playbook -i inventory/ci.yml --syntax-check auxiliary.yml deploy-auxiliary.yml` и `git diff --check`. Все команды завершаются с кодом 0. Зафиксировать изменения коммитом `refactor(hooks): remove Apidog configuration`.

### Задача 3. Выкатить и проверить VPS3

**Входы.** PR сервиса с зелёным CI, PR `infra` с зелёными тестами и preview, текущие `hooks` и Apidog project `1382426`. `Webhook alerts image` запускает `Auxiliary CD`, который ждёт результата `infra/.github/workflows/auxiliary-deploy.yml`. Очистку `.env` применяет `auxiliary.yml` из workflow `Инфраструктура`.

- [ ] **Подготовить рабочую очередь.** На VPS3 выполнить `docker compose -f /opt/hooks/compose.yml exec -T hooks bun run src/cli.ts snapshot --output /data/snapshots/queue.sqlite`. На снимке read-only проверить `PRAGMA integrity_check` и `user_version`. Записать число строк Apidog, ID связанных outbox, выборку последних GitHub delivery ID и значения обеих release activation. В журнал проверки записывать агрегаты, ID и время активации без payload и env. Снимок сделать до слияния PR сервиса, которое запускает автодеплой.
- [ ] **Отключить target в Apidog.** В настройках проекта `1382426` найти target с URL `https://hooks.cellestial.ru/webhooks/apidog` (в журнале приёмки был ID `302418`), отключить его и перечитать настройки, чтобы подтвердить состояние.
- [ ] **Влить сервис и дождаться CD.** Проверить актуальный head, обязательные CI и отсутствие конфликтов. После мержа дождаться `Webhook alerts image` и `Auxiliary CD`. На VPS подтвердить соответствие `.github` merge SHA и digest в `services["webhook-alerts"].confirmed` файла `/opt/hooks/releases.json` опубликованному release artifact, а также `GET /health` → `200`.
- [ ] **Проверить миграцию на VPS.** Убедиться read-only запросами, что `PRAGMA user_version` равно 6, `PRAGMA foreign_key_check` пуст, `SELECT COUNT(*) FROM deliveries WHERE source = 'apidog'` равно 0, сохранённая GitHub-выборка со снимка и обе границы release activation на месте. Проверить отсутствие outbox с `origin_type = 'delivery'` без связанной delivery. Выполнить `curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://hooks.cellestial.ru/webhooks/apidog` и получить `404`.
- [ ] **Влить `infra` и дождаться применения Vault.** В workflow `Инфраструктура` проверить успешные `auxiliary.yml` и `verify.yml`. Сверить, что `hooks` работает на том же digest. Проверить отсутствие имён `APIDOG_*` и `TELEGRAM_APIDOG_*` в `.env` и окружении контейнера без вывода значений. Повторно проверить `GET /health`.
- [ ] **Подтвердить доставку.** По новой контрольной GitHub-доставке сопоставить delivery GUID и `sent` outbox с Telegram message ID в рабочей теме. По новому ревью проверить рабочую тему ревью. Для release-путей сверить конфигурацию и activation, выполнить read-only `bun run src/cli.ts backend-release-check` в `hooks` и сверить релизные карточки frontend и backend с фактическими post-deploy доставками. Зафиксировать версии, запуски CI/CD и наблюдения.
