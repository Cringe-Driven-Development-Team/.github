# Board status flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Пользователь должен выбрать способ выполнения этого плана до реализации.

**Goal:** Убрать ложный Done после мержа frontend и сохранить Done при закрытии остальных задач общей доски.

**Architecture:** Общий reusable workflow обрабатывает issues.closed и задаёт Ready for build либо Done. Frontend Board сверяет опубликованные/выкаченные выпуски. Оба писателя фронтовых карточек выполняются в одной concurrency-группе release-board с queue: max; встроенный Item closed отключается после подготовки замены.

**Tech Stack:** GitHub Actions/Projects GraphQL, Bun 1.4.4, TypeScript, существующие shell-тесты, actionlint 1.7.12. Новых зависимостей нет.

**Spec:** [2026-11-04-board-status-flow-design.md](../specs/2026-11-04-board-status-flow-design.md), согласована пользователем.

## Global Constraints

- Проект: Cringe-Driven-Development-Team/Scrumban №1; frontend: Cringe-Driven-Development-Team/frontend, независимо от заголовка issue.
- Merge в default branch → Ready for build; проверенные S3 + GHCR → Ready for release; успешный production → Done.
- Manual close / not planned во frontend и закрытие задач других репозиториев → Done.
- Issue вне проекта не добавлять; PR-карточки и другие проекты не менять. Переоткрытые задачи не продвигать.
- Успешные прошлые выкатки сохраняют Done после rollback. Ошибки API не маскировать.
- Telegram, webhook-сервис, CI/CD, merge queue, спринты и права мержа не менять. Полный обход Board не ускорять.
- Не добавлять новые колонки, зависимости, сервисы, миграционные флаги и legacy-режимы.
- После реализации — локальные проверки и ревью выбранного процесса; merge/изменение настройки только в разрешённой пользователем области действий.

## Review Focus

1. Старое closed-событие после reopen/new close не пишет статус нового цикла — тесты задачи 1.
2. Несколько закрытий подряд и поздний close после Board не теряются и не регрессируют — задачи 2–4.
3. Отсутствующий caller, scope токена или выключенные Actions не скрываются успешной локальной проверкой — задачи 2 и 5.
4. Неполная пагинация timeline/projectItems/fields, ошибки GraphQL и чужой node ID не превращаются в ручное закрытие — задача 1.
5. Title rename, нулевое значение Status, старый Done и закрытие PR не в default branch дают согласованный результат — задачи 1 и 3.

## Рабочие копии и файлы

План и общий код: `/home/oleg/2026_H2/.github-board-status-flow`, ветка `docs/board-status-flow`.
При реализации создать отдельный worktree frontend от актуального origin/main; не писать в занятый основной checkout.
Пути далее относительны соответствующему репозиторию. Записать реальные пути и SHA в журнал выбранного execution skill.

| Репозиторий | Файлы | Ответственность |
| --- | --- | --- |
| .github | scripts/issue-status.ts, tests/issue-status.test.ts | Адресная обработка закрытой issue |
| .github | .github/workflows/add-to-project.yml | Новый job issue-status |
| .github | tests/issue-status-workflow.test.ts, tests/lint.sh, .github/workflows/checks.yml | Проверки подключения, линтер и CI |
| frontend | scripts/release/board.ts, board.test.ts, test/fixture.ts | Новый вход в релизные статусы |
| frontend | .github/workflows/release-status.yml, scripts/release/workflows.test.ts | Общая очередь писателей |
| .github | tests/board-status-integration.test.ts | Обе реализации на одной модели карточек |
| .github / frontend | README.md, CONTRIBUTING.md / docs/release.md | Правила и восстановление |
| agent-plugins / agent-plugins-private | .github/workflows/issue-status.yml | Недостающие callers только закрытия |

## Проверенные предпосылки и выбранный механизм

Восемь callers уже имеют issues.closed и используют общий workflow: `.github` (локальный uses), frontend, backend, docs, infra, figma, static, frontend-packages (`@main`).
У agent-plugins и agent-plugins-private есть задачи на доске, но отсутствует каталог .github/workflows. Actions включены; для сохранения Done нужны два небольших callers. Учебные копии содержат исторические карточки, рабочие задачи туда больше не заводятся; их Actions не включать. При проверке учесть все страницы Project items.

GitHub поддерживает `concurrency.queue: max`, до 100 ожидающих jobs. Одинаковая группа у reusable job и Board относится к вызывающему frontend-репозиторию. FIFO по началу ожидания не является порядком событий — обработчик всё равно читает актуальную issue.
Источник: [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), проверено 2026-11-04.

Для frontend использовать одинаковые `group: release-board`, `cancel-in-progress: false`, `queue: max` на уровне jobs. В других репозиториях job issue-status получает `issue-status-${{ github.event.issue.node_id }}` и те же queue/cancel. Не блокировать вызывающий workflow целиком и не добавлять повторную блокировку вокруг reusable job: вложенная блокировка может ждать сама себя.

Так Board и close не пересекаются между чтением и mutation. Поздний close сохраняет Ready for release/Done, если updatedAt этого статуса не старше текущего закрытия. Старое значение предыдущего цикла разрешено заменить. Доказательства выпуска остаются в Board; новый close не скачивает историю Deployments. Прямой запуск функций вне Actions не получает блокировку автоматически и не является способом эксплуатации.

Новый job читает доверенный `.github/main` через checkout в `automation/`, `persist-credentials: false`, токен `ADD_TO_PROJECT_PAT`; не checkout PR/head пользователя. Тот же PAT выполняет GraphQL. Это не требует расширять `permissions: {}` восьми callers. В workflow используются только env/файл события, без подстановки названий задач в shell.

Установленный actionlint 1.7.12 отклоняет queue; воспроизведено минимальным YAML через stdin. В tests/lint.sh разрешить только точную диагностику `^unexpected key "queue" for "concurrency" section\.` с `-ignore`. Новые тесты разбирают YAML и проверяют queue/cancel во всех concurrency-блоках; прочие ошибки линтера остаются ошибками. Комментарий shortcut со ссылкой на [upstream #657](https://github.com/rhysd/actionlint/issues/657): удалить исключение после поддержки queue линтером.

---

### Task 1: Адресный обработчик закрытия в .github

**Files:** Create `scripts/issue-status.ts`, `tests/issue-status.test.ts`.

**Interfaces:** Export `reconcileClosedIssue(input: { repository: string; issueId: string; closedAt: string }, token: string): Promise<'changed' | 'unchanged' | 'skipped'>`. При `import.meta.main` читать GITHUB_EVENT_PATH, GITHUB_EVENT_NAME, GITHUB_REPOSITORY и ADD_TO_PROJECT_PAT; принимать только issues.closed собственной организации, сверять repo/node/closed_at. Импорт не выполняет CLI. HTTP-хелпер внутренний, GraphQL через fetch с timeout 20 секунд; ошибки HTTP, data/errors и структуры ответа явные. Тесты подменяют globalThis.fetch и восстанавливают окружение.

- [x] **1. Написать RED-тесты классификации и идемпотентности.** Табличные cases: frontend merged/default → Ready for build; backend/infra → Done; frontend manual/NOT_PLANNED/PR чужого repo либо не default → Done. Один и тот же input второй раз не вызывает mutation. Заголовок произвольный; карточка с null Status обновляется.

```ts
expect(await reconcileClosedIssue(event, 'test-token')).toBe('changed');
expect(writes).toEqual([{ item: 'card-119', status: 'Ready for build' }]);
expect(await reconcileClosedIssue(event, 'test-token')).toBe('unchanged');
expect(writes).toHaveLength(1);
```

- [x] **2. Выполнить RED:** `bun test tests/issue-status.test.ts`; ожидается ошибка отсутствующего модуля/экспорта.
- [x] **3. Реализовать функцию и CLI.** Читать точный project №1/Status/options с пагинацией. Прочитать текущую issue, closedAt/stateReason, актуальный ClosedEvent.closer (merged, baseRefName, repository/defaultBranchRef) и projectItems. Не считать отсутствие данных API отсутствием PR. Нет карточки — skipped; нет права записи/option при существующей карточке — ошибка. Latest close должен соответствовать event.closedAt; открытая или закрытая заново issue — skipped. Перед mutation повторить чтение состояния и отменить устаревшую запись. Для frontend merge оставить уже Ready for release/Done с updatedAt >= closedAt; проверить валидность дат. Старое значение с updatedAt < closedAt заменить на Ready for build. Для ручного/not planned закрытия выставить Done.
- [x] **4. Добавить edge RED→GREEN:** reopened, новый ClosedEvent, поздний close после ready/done, старый Done прошлого цикла, отсутствующая карточка, другой проект, чужой node, PR вместо issue, несколько страниц timeline/items/fields, HTTP 403/503, GraphQL errors, missing data, mutation failure. CLI с чужим repo/событием не пишет; импорт не запускает main. Токен не попадает в ошибку.
- [x] **5. Проверить:** `bun test tests/issue-status.test.ts` → PASS; тесты гонки здесь проверяют последовательные состояния, блокировку проверит task 4.
- [x] **6. Commit:** `feat: set closed issue status by repository and closing reason`.

### Task 2: Подключение обработчика и сохранение охвата доски

**Files:** Modify `.github/workflows/add-to-project.yml`, `.github/workflows/checks.yml`, `tests/lint.sh`, `README.md`, `CONTRIBUTING.md`; Create `tests/issue-status-workflow.test.ts`. Create `.github/workflows/issue-status.yml` в agent-plugins и agent-plugins-private.

**Interfaces:** Новый job `issue-status` после существующих jobs вызывает `bun automation/scripts/issue-status.ts`. Env ADD_TO_PROJECT_PAT; события и контекст — штатные GITHUB_*. Checkout `.github/main` и setup-bun 1.4.4, без bun install. Существующие jobs add-to-project/close не меняют поведение. Callers двух plugins слушают только issues.closed и вызывают add-to-project.yml@main, без Telegram job.

- [x] **1. Написать RED-тест YAML:** issues.closed разрешён; opened/reopened/PR/чужая org запрещены; webhook-переключатель не влияет; trusted checkout фиксирован; PAT не сохраняется в Git; у frontend совпадает release-board, у остальных разные node IDs дают разные группы; queue=max и cancel=false. Проверить, что новые steps не сдвинули второй run-блок, извлекаемый tests/close.sh.
- [x] **2. Выполнить RED:** `bun test tests/issue-status-workflow.test.ts` → FAIL на отсутствующем job.
- [x] **3. Подключить job и тесты в Checks.** Добавить запуск `bun test tests/issue-status.test.ts tests/issue-status-workflow.test.ts` и `bash tests/close.sh` в существующий Bun job Checks. В tests/lint.sh добавить точечное исключение actionlint и запуск YAML-теста queue. Не добавлять отдельный линтер/зависимость или wrapper-скрипт.
- [x] **4. Дописать тест проверки queue:** все workflow/root и job concurrency-блоки разрешают только single/max; max требует явного cancel=false; отрицательная fixture с queue=typo или cancel=true падает. Отдельная опечатка другого YAML-key должна по-прежнему проваливать actionlint.
- [x] **5. Подготовить два plugin callers в отдельных worktrees.** До записи прочитать их AGENTS.md. Проверить существование repo и доступ к org secret ADD_TO_PROJECT_PAT без чтения значения; если visibility=selected, включение недостающих repo входит в подключение, без копирования секрета. Проверить их YAML через actionlint. Зафиксировать inventory всех действующих callers в README и отсутствие активации учебных копий.
- [x] **6. Обновить README/CONTRIBUTING:** договорённая таблица, ручные закрытия, повтор failed job, предел очереди 100 и отменённый сверх лимита job требует rerun. Не обещать мгновенный статус; ускорение не входит.
- [x] **7. Проверить:** `bun test tests/issue-status.test.ts tests/issue-status-workflow.test.ts tests/webhook-workflows.test.ts`, `bash tests/close.sh`, `bash tests/lint.sh` → PASS. Существующая межрепозиторная страховка и Telegram-switch проходят.
- [x] **8. Commit в каждом затронутом repo:** `feat: route closed issue statuses through shared automation`.

### Task 3: Frontend Board без зависимости от встроенного Done

**Files:** Modify `scripts/release/board.ts`, `scripts/release/board.test.ts`, `scripts/release/test/fixture.ts` при необходимости, `.github/workflows/release-status.yml`, `scripts/release/workflows.test.ts`, `docs/release.md`.

**Interfaces:** Сохранить `syncBoard(snapshot: ReleaseSnapshot, repoDir: string): Promise<BoardResult>` и readReleaseSnapshot. Дополнить внутренний Event.closer полями merged/baseRefName/repository.defaultBranchRef; query читает их. Закрытие классифицируется по той же семантике, что task 1; общий пакет между репозиториями не создавать.

- [x] **1. Обновить RED-тесты:** опубликованная задача из Ready for build/In review/Ready for test/In testing/null/старого Done → Ready for release; успешная выкатка → Done; произвольное название не препятствует переходу. Старые тесты ожидания Done и сохранения ручного рабочего статуса заменить тестами нового контракта. Сохранить защиты ручного закрытия, not planned, чужого repo, reopening и ошибки Project API.

```ts
states.get(2)!.status = 'Ready for build';
expect((await syncBoard(await readReleaseSnapshot(f.dir), f.dir)).errors).toEqual([]);
expect(writes).toEqual([{ issue: 2, status: 'Ready for release' }]);
```

- [x] **2. Выполнить RED:** `bun test scripts/release/board.test.ts` → FAIL на прежнем пропуске статуса.
- [x] **3. Изменить Board:** убрать regex по title, пропуск рабочих статусов и deadline/sleep ожидания автоматического Done. Открытые задачи пропускать, не ждать закрытия. Использовать актуальное закрытие PR в default branch; PR-linked/manual, not planned и чужой repo не считать релизной задачей. Пагинацию, Git-граф, проверку Deployments, повторную проверку перед записью и пересчёт после CD сохранить. Полный каталог и его refresh в этой работе не оптимизировать.
- [x] **4. Дополнить регрессии:** PR не в default branch не продвигает карточку; nested PR остаются в составе каталога, но определение закрывающего PR не подменяется. Новый закрывающий PR после reopen относится к новому циклу; failed publish/CD не продвигают; rollback сохраняет Done. Существующие тесты CD между двумя карточками остаются зелёными.
- [x] **5. Добавить queue:max в job Board.** Обновить тип и assertion Workflow.concurrency в workflows.test.ts; `expect(board.concurrency).toEqual({group:'release-board', queue:'max', 'cancel-in-progress':false})`. Разбирать остальные concurrency-блоки и валидировать queue так же, как в task 2. Триггеры, права и токены Board не расширять.
- [x] **6. Обновить docs/release.md:** Ready for build — автоматический этап после мержа; убрать ожидание Done/пять минут и сохранение рабочих статусов закрытых мержем задач; сохранить описание manual close/reopen, rollback и ручной сверки. Указать общий lock и задержки Actions.
- [x] **7. Проверить:** `bun test scripts/release`, `bun run check`, `bun run test`, `bun run build` → PASS. Проверить Actions YAML через `actionlint -ignore '^unexpected key "queue" for "concurrency" section\.'`; queue отдельно покрыт тестом. У каждого изменённого экспорта сохранить требуемый JSDoc.
- [x] **8. Commit:** `fix: reconcile frontend releases without automatic Done`.

### Task 4: Совместная проверка двух писателей

**Files:** Create `.github/tests/board-status-integration.test.ts`; fixture-тесты task 1/3 минимально дополнить, не менять продуктовые интерфейсы ради harness. В обоих README указать команду.

**Interfaces:** `FRONTEND_DIR=/absolute/worktree` указывает тесту frontend-источник. Dynamic import syncBoard/readReleaseSnapshot/fixture из этого checkout и reconcileClosedIssue из .github. Без FRONTEND_DIR этот отдельный интеграционный файл должен завершиться понятной ошибкой, не успешным skip; в обычный независимый CI одного repo его не включать.

- [x] **1. Написать интеграционные тесты на одной модели issue/Status и общем HTTP stub.** Использовать реальные функции обоих репозиториев и настоящий временный Git-граф frontend fixture. Внутренний harness сериализует только согласно прочитанным YAML concurrency-группам; не добавлять lock в продуктовый код и не выдавать harness за проверку платформы GitHub.
- [x] **2. Воспроизвести опасный порядок:** остановить close перед mutation, запросить запуск Board; с одинаковой группой Board не входит в функцию, пока close не завершён. После завершения обоих итог Ready for release/Done. Второй порядок: Board завершился, затем старый close — нет регрессии. Изменение группы одного писателя в тестовой YAML-fixture должно обнаружить пересечение.
- [x] **3. Проверить очередь и cycles:** три closed-события разных issue завершаются; новые закрытия не вытесняются при queue=max; после reopen/new close старый input не пишет; ручное закрытие → Done и Board не меняет; на rerun нет лишних mutations. Ошибку API видно как rejection, повтор после восстановления работает.
- [x] **4. Запустить:** `FRONTEND_DIR=/absolute/frontend-worktree bun test tests/board-status-integration.test.ts` → PASS. Не использовать настоящие токены, Project mutation и Telegram в тестах; GITHUB_STEP_SUMMARY направлять в temp и очищать окружение после теста.
- [x] **5. Commit:** `test: cover shared close and release board ordering`.

### Уточнение по итоговому ревью

Если Board подтвердил выпуск, но соответствующий Status имеет updatedAt до
текущего закрытия, no-op недостаточен: поздний close вернул бы Ready for build.
Board выполняет clear → set того же target последовательными полями mutation
и перечитывает время/значение. Same-option update не считается доказательством
обновления timestamp. Ошибка второй операции видна, пустое значение восстанавливает
rerun. Это уточнение реализации не добавляет хранилища и не меняет таблицу статусов.

### Task 5: Ревью, PR и подключение

**Files:** Modify `.github/docs/superpowers/plans/2026-11-04-board-status-flow.md` (отметки выполнения); Create `.github/docs/board-status-flow-runbook.md` (конкретные ссылки/результаты подключения).

**Interfaces:** Проверенные ветки tasks 1–4; org Project workflow №7; штатные CI и права пользователя. Исполнитель следует выбранному execution skill: итоговое ревью не заменяет ревью каждой задачи в subagent-driven-development.

- [x] **1. Повторно проверить scope:** фактические main SHA, callers и доступ PAT, независимые required checks. Оформить родительскую задачу в .github и frontend sub-issue по cdd-tasks; небольшие plugin callers — сопутствующие PR с Part of. Никаких комментариев/уведомлений вне явно порученных действий или разрешённых cdd-tasks операций. В описании каждого PR объяснить конечный контракт и приложить результаты тестов.
- [x] **2. Выполнить ревью и необходимые проверки выбранного процесса.** Review Focus из этого плана обязателен. Не повторять полные тесты без новых изменений; исправления проверять релевантным прогоном. Все PR до внешнего подключения должны быть конкретными и проверяемыми.
- [ ] **3. При разрешённом мерже:** влить frontend Board, общий обработчик и два plugin callers, проверить актуальные head/CI/конфликты и post-merge. Время отключения встроенного правила согласовать с фактической готовностью всей замены; не добавлять флаги/legacy-режим. Родительская .github задача закрывается последней либо PR использует Part of до завершения остальных частей. Frontend course-sync и совпадение main учебной копии проверить.
- [ ] **4. Проверить встроенные workflows в UI Projects:** Item closed №7, Pull request merged, Item reopened, Pull request linked to issue, Auto-close issue. Проверить, какие касаются issue, а какие только PR-карточек. Если другое правило тоже даёт ложный Done issue, уточнить его конфигурацию и убрать конфликт в рамках согласованной цели; не менять независимые правила вслепую. GraphQL показывает enabled/name, но не конфигурацию; update workflow в доступной Mutation schema отсутствует, поэтому нужен UI. Не удалять workflow вместо выключения.
- [ ] **5. Выключить Item closed и прочитать enabled через API.** Убедиться, что остальные нужные правила сохранились. Если авторизованного UI нет, сообщить именно об этом и дать точное действие пользователю; не объявлять переключение выполненным. До завершения этого шага задача остаётся незавершённой.
- [ ] **6. Живая приёмка без искусственных сообщений:** использовать закрытия рабочих PR этой задачи и следующие естественные события. Проверить backend/другой repo → Done, frontend merge → Ready for build, публикация → Ready for release. Собрать временные метки, run URLs и GraphQL Status. Проверить совместную группу через Actions UI/API и отсутствие отмены независимых close jobs. Не создавать фиктивные issue/PR и не запускать CD лишь ради приёмки без поручения. Если нужного естественного события пока не было, явно оставить эту часть приёмки ожидающей; его отсутствие не маскировать локальным тестом.
- [ ] **7. Ручной replay:** rerun конкретного failed issues.closed job безопасен, frontend release-status workflow_dispatch восстанавливает опубликованные/выкаченные карточки. Переполненный queue (>100) даёт отменённый job — адресный rerun. Не возвращать Item closed как тихий fallback, он снова создаст ложный Done.
- [ ] **8. Записать фактический результат в runbook:** commits/PR, enabled=false, примеры статусов, оставшиеся живые проверки. Новая логика Done после production должна пройти локально; живой CD — только по отдельному поручению/следующей согласованной выкатке.

## Self-review плана

- Контракт и исключения спецификации покрывают tasks 1 и 3; широкая доска/callers — task 2; гонка и cycles — task 4; переключение — task 5.
- Имена интерфейсов task 1/3 совпадают с интеграционным тестом. Обработка frontend идёт по repo, а не title.
- Конкурирующие продуктовые writers сериализованы платформой; reread не представлен как атомарная защита. Внешние ручные изменения всё равно перечитываются перед mutation.
- Дополнительные два callers — предусмотренное спецификацией восстановление охвата, без изменений webhook-сервиса.
- Поддержка queue подтверждена документацией; ограничение линтера воспроизведено. Не обходить прочие проверки.
- Пользователь выбрал executing-plans. Tasks 1–4 реализованы и проверены; Task 5 выполняется, внешнее подключение ещё не завершено.
