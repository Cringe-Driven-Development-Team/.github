# Frontend Release Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить задачи в алерт очереди frontend, сократить результаты выкатки и восстановить Telegram-пинги инициаторов по существующей карте ID.

**Architecture:** Сохраняем `webhook-alerts`, его API GitHub, форматтер HTML и очередь отправки. Выносим существующее чтение `closingIssuesReferences` в метод для одного PR, который используют и очередь, и состав выпуска. Причину отсутствия пингов устанавливаем по конфигурации работающего сервиса, затем исправляем её в источнике.

**Tech Stack:** TypeScript, Bun 1.4.4 (как в CI), GitHub GraphQL/REST, Telegram Bot API; действующие Ansible Vault и Compose для настроек сервиса.

**Spec:** `docs/superpowers/specs/2026-11-07-frontend-release-alerts-design.md` (подтверждена 2026-11-07).

## Global Constraints

- Новые зависимости и отдельный справочник пользователей не нужны.
- В очереди получатель — `mergeQueueEntry.enqueuer`, в результате — существующий `run.actor`.
- Сохраняем экранирование HTML, ограничение длины сообщений, дедупликацию, проверку актуальности очереди перед отправкой и существующие повторные попытки.
- Не раскрываем токены и содержимое секретных настроек в логах или документации.
- Не переделываем уведомления о публикации артефактов, начале выкатки и откате; не редактируем старые сообщения.
- Переход на `@username` — отдельная задача `.github#62`, не зависимость этого плана.
- До реализации пользователь выбирает executing-plans или subagent-driven-development; выбор ещё не сделан.

## Review Focus

- PR поставил в очередь ментор, автор другой: пингуется enqueuer (Task 1).
- Связанные задачи занимают несколько страниц и содержат HTML: все страницы прочитаны, текст экранирован и укладывается в лимит (Task 1).
- GitHub не ответил или PR уже слит к повторной отправке: не выдаём сбой за пустой список и не отправляем устаревший алерт (Task 1).
- Общий шаблон обслуживает deploy и rollback: удаляем технику только из результатов deploy (Task 2).
- Карта в источнике верна, но контейнер использует другую: проверяем фактическое окружение, неизвестный аккаунт остаётся без пинга (Task 3).

## Файлы и границы

- `services/webhook-alerts/src/release-api.ts`: чтение названия PR и его задач; повторное использование в `changes`.
- `services/webhook-alerts/src/releases.ts`: содержимое очереди и результатов deploy.
- `services/webhook-alerts/tests/helpers/release.ts`: единая фикстура нового метода API.
- `services/webhook-alerts/tests/release-api.test.ts`, `releases.test.ts`, `release-integration.test.ts`: API, тексты, полный путь от события до отправки.
- `services/webhook-alerts/README.md`: новое содержимое очереди и настройка существующей карты.
- `src/config.ts`, `src/main.ts`, `src/format.ts` сервиса: сначала диагностика, изменения только при воспроизведённом дефекте.
- Соседний `infra`: проверить актуальный main, `RUNBOOK.md`, `ansible/roles/hooks/{defaults/main.yml,templates/env.j2,tasks/main.yml}` и источник `vault_hooks_env`. Секретные значения не копировать в план и коммиты.

### Task 1: Задачи PR в сообщении об очереди

**Files:** `release-api.ts`, `releases.ts`, три тестовых файла и фикстура выше; `services/webhook-alerts/README.md`.

**Interfaces:** Добавить `ReleaseApi.pullRequest(number: number): Promise<{ title: string; issues: LinkedIssue[] }>`; `LinkedIssue` остаётся существующим типом с `prNumbers: [number]`. `queue(number)` и `checkReleaseNotice` сохраняют интерфейсы. Метод `changes(base, head)` использует `api.pullRequest(pr.number).issues` и сохраняет дедупликацию по issue ID и все `prNumbers`.

- [ ] Добавить тесты API: `pull_request_reads_title_and_all_issue_pages`, `changes_deduplicates_shared_issues`, `pull_request_failure_is_not_empty_issues`. Фикстура GraphQL принимает `init` в перехватчике для чтения query/variables, возвращает `title` и две страницы задач; на второй странице сбоя возвращает 503. Проверки:

  ```ts
  expect(result.title).toBe('Human readable PR');
  expect(result.issues.map(i => i.number)).toEqual([27, 28]);
  expect(result.issues.every(i => i.prNumbers.includes(125))).toBe(true);
  expect(shared.prNumbers).toEqual([125, 126]);
  await expect(f.api.pullRequest(125)).rejects.toThrow();
  ```

- [ ] Добавить тесты сообщений `enqueue_lists_issues_and_mentions_enqueuer`, `enqueue_without_issues_uses_pr_title`, `enqueue_api_failure_retries`, `enqueue_escapes_and_bounds_many_issues`. Использовать `releaseFixture`, `enqueue`, `delivery`; в payload автор `ManInTheCoat`, enqueuer `YarikMix`, карта `{ YarikMix: '111', ManInTheCoat: '222' }`. Проверять:

  ```ts
  expect(message.html).toContain('tg://user?id=111');
  expect(message.html).not.toContain('tg://user?id=222');
  expect(message.html).toContain('/issues/27');
  expect(message.html).toContain('/issues/28');
  expect(emptyMessage.html).toContain('Human readable PR');
  expect(message.keyboard).toEqual([[{ text: 'Открыть PR', url: `https://github.com/${REPO}/pull/125` }]]);
  await expect(projectRelease(enqueue(), failing.api, config)).rejects.toThrow();
  expect(longMessage.html.length).toBeLessThanOrEqual(4095);
  expect(longMessage.html).toContain('&lt;script&gt;');
  expect(longMessage.html).toContain('tg://user?id=111');
  ```

- [ ] Запустить из `services/webhook-alerts`: `bun test tests/release-api.test.ts tests/releases.test.ts`. Новые сценарии должны падать из-за отсутствующего метода/содержимого.
- [ ] Реализовать `pullRequest` на основе существующего запроса `ReleaseIssues`, добавив `title`, сохранив валидацию и пагинацию. Использовать его в `changes` вместо копии обхода. В `projectRelease` вызывать его только после проверки актуального `enqueued`; для `dequeued` и проверки перед отправкой задачи не загружать.
- [ ] Собирать очередь через имеющиеся `title` и `bounded`: заголовок `PR #N поставлен в очередь`, пустая строка, `<b>Задачи</b>`, ссылки на задачи или название PR, затем enqueuer. Для переполнения передавать `report = null`: честный текст «Состав изменений показан не полностью», кнопка PR остаётся. Ошибка API выходит в существующий retry подготовки сообщения, а не превращается в отсутствие задач.
- [ ] Обновить фикстуры API и HTTP интеграции (в ответах задач добавить `title`) и ожидание вызовов `['queue', 'pullRequest']`. В интеграции сохранить сценарий 429 → PR слит → устаревшая отправка пропущена; отдельно проверить, что `checkReleaseNotice` делает только `queue`. В README описать задачи и fallback на название PR.
- [ ] Запустить `bun test tests/release-api.test.ts tests/releases.test.ts tests/release-integration.test.ts tests/release-worker.test.ts` и `bun run typecheck` из сервиса. Ожидаются PASS и exit 0.
- [ ] Закоммитить только файлы Task 1: `feat: show linked tasks in frontend queue alerts`.

### Task 2: Короткие результаты успешной и неуспешной выкатки

**Files:** `services/webhook-alerts/src/releases.ts`, `tests/releases.test.ts`, `README.md`.

**Interfaces:** `operationMessage(op: VerifiedOperation, api: ReleaseApi, config: Config): Promise<OutgoingMessage>` сохраняется; изменения только для результатов `op.kind === 'deploy'`.

- [ ] Добавить параметризованный тест `deploy_result_omits_technical_details` для `success`, `failure`, `error`. В `releaseFixture` задать `run.actor = 'iRedTea'`, карту `{ iRedTea: '222' }`; проверить текст и кнопки:

  ```ts
  expect(message.html).not.toContain('Слева —');
  expect(message.html).not.toContain(`Релиз <code>${B}</code>`);
  expect(message.html).not.toContain('Образ BFF');
  expect(message.html).not.toContain('sha256:');
  expect(message.html).toContain('<b>Версия:</b>');
  expect(message.html).toContain('/issues/27');
  expect(message.html).toContain('Health Check');
  expect(message.html).toContain('Запустил: <a href="tg://user?id=222">iRedTea</a>');
  expect(message.keyboard!.flat().map(b => b.text)).toEqual(['🌐 Открыть прод', '↩️ Откатить', 'PR', 'Логи выкатки']);
  ```

- [ ] Добавить `rollback_result_keeps_existing_details` и проверки существующих publish/start сценариев: rollback сохраняет пояснение и digest; publish сохраняет полный SHA и digest; start сохраняет заголовок, инициатора и кнопку логов. Для failure оставить проверки `Этап сбоя: Switch BFF` и сообщения о неподтверждённом состоянии прода.
- [ ] Запустить `bun test tests/releases.test.ts`: новые проверки отсутствия технических строк должны падать.
- [ ] Удалить указанные блоки только для deploy с минимальными условиями в общих массивах header/footer; сохранить короткие SHA-ссылки и формат диагностики. Обновить описание результата в README.
- [ ] Запустить `bun test tests/releases.test.ts tests/release-integration.test.ts` и `bun run typecheck`. Ожидаются PASS и exit 0.
- [ ] Закоммитить: `fix: simplify frontend deployment result alerts`.

### Task 3: Подтверждённая причина отсутствия Telegram-пингов

**Files:** `services/webhook-alerts/tests/release-integration.test.ts`, `README.md`; при подтверждённом дефекте соответствующий `src/{config,main,format}.ts`. Конфигурация: существующий `vault_hooks_env.TELEGRAM_USER_MAP` в infra, доставка в `/opt/hooks/.env` и окружение сервиса Compose.

**Interfaces:** существующие `loadConfig(env)`, `projectRelease(delivery, api, config)`, `mention(login, map)`; формат карты GitHub login → числовой Telegram ID не меняется.

- [ ] До исправления использовать systematic-debugging; для SSH — cellestial-ops, для изменений Ansible — применимые ansible skills. Проверить origin и актуальность infra. Не считать локальный digest образом, реально работающим на VPS.
- [ ] Провести read-only диагностику: сопоставить карту организации `TELEGRAM_USER_MAP`, `vault_hooks_env`, сгенерированный `.env` и фактическое окружение контейнера. Для `ManInTheCoat`, `iRedTea`, `YarikMix` вывести только наличие, валидность ID и совпадение между источниками, без значений. Проверить версию работающего сервиса и передачу `config.userMap` в `projectRelease`.
- [ ] Записать подтверждённую причину и место исправления в журнал выполнения. Если карта корректна и код формирует ссылку, проверить сериализованное сообщение, HTML parse mode и доступные данные Telegram; не объявлять причину установленной по одному скриншоту.
- [ ] Дополнить HTTP интеграцию: в `loadConfig` передать `TELEGRAM_USER_MAP: JSON.stringify({ YarikMix: '111' })`; сохранять запросы очереди даже при 429. Проверить в отправляемом `text` `tg://user?id=111` для очереди и результата и `parse_mode === 'HTML'`. Сценарий неизвестного инициатора проверяет обычный экранированный ник без `tg://user?id=`. Если эти проверки уже проходят, сохранить их как регрессионные; не изобретать дефект исходников.
- [ ] Исправить установленный источник: при расхождении настроек обновить существующую карту из проверенного источника и применить её через текущий runbook infra; при дефекте кода сначала добавить воспроизводящий падающий тест, затем минимально исправить общий путь. Не ограничиваться ручной правкой `.env`, которую затрёт Ansible. Не включать отправку тестового сообщения в командный чат.
- [ ] Проверить после применения совпадение карты источника и окружения, успешную загрузку конфигурации и `https://hooks.cellestial.ru/health`; диагностическое формирование HTML проводить без вызова `sendMessage`. Проверку настоящего пинга отмечать выполненной только после наблюдения следующего штатного события.
- [ ] Обновить README об источнике карты и записать результаты диагностики без секретов. Коммитить только реальные изменения кода/документации; секретную карту не включать в git diff.

## Итоговая проверка и завершение

- [ ] Из `services/webhook-alerts`: `bun install --frozen-lockfile`, `bun test`, `bun run typecheck`. Ожидаются все тесты PASS и exit 0.
- [ ] Из корня `.github`: `bun test tests/webhook-workflows.test.ts`, `docker build -t webhook-alerts:test services/webhook-alerts`, `bash tests/webhook-alerts-docker.sh webhook-alerts:test`. Ожидаются PASS, успешная сборка и smoke-проверка; недоступность Docker явно зафиксировать.
- [ ] Выполнить review и вести журнал согласно выбранному способу исполнения; в subagent-driven-development review каждой задачи обязателен до следующей. Проверить `git diff --check` и чистоту коммитов.
- [ ] Отдельно сообщить результаты локальных проверок, изменения конфигурации прода и статус фактического пинга. Публикацию и выкатку нового образа выполнять через штатный процесс после разрешения на merge/deploy; до этого не выдавать локальные шаблоны за уже работающие на проде.

## Самопроверка плана

Все пункты спеки покрыты Tasks 1–3; пять Review Focus привязаны к проверкам. `queue` и отправочная защита не расширяются запросами задач. Новый `pullRequest` использует существующий `LinkedIssue`, все прямые фикстуры `ReleaseApi` обновляются. `@username` и переделка остальных видов алертов исключены. Причина конфигурационного сбоя не выдумана: диагностическая часть заканчивается исправлением доказанного источника.
