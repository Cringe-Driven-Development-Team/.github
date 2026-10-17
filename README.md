# .github

## Синхронизация учебных копий

`sync-to-course.yml` подключён к frontend CI после переноса фронтенда.
Backend пока работает по прежней схеме; его caller подготовлен к отдельному окну.
Дизайн и границы переключения — в [спецификации](docs/superpowers/specs/2026-10-17-team-repositories-migration-design.md).

Workflow принимает полный SHA проверенного коммита (`sha`), его push CI run
(`ci_run_id`) и полный SHA общей автоматики (`automation_ref`). В caller нужно
закрепить один и тот же reviewed commit `.github` в `uses` и `automation_ref`.
Проверки берутся из `CI` самого основного репозитория; успех deploy не требуется.
Назначение выбирается только из фиксированной карты frontend/backend.

Для включения нужен `COURSE_SYNC_ENABLED` со строкой `true`, отдельный
`COURSE_SYNC_SSH_KEY` данного назначения и предусмотренное правилами исключение
для обновления учебного `main`. Секреты production в эту job не передаются.
GitHub Ed25519 host key закреплён в workflow; при его ротации нужно обновить
shared commit и оба caller ref после проверки по официальному источнику.

Ошибки оставляют job красным и отправляют одно сообщение через
`TELEGRAM_BOT_TOKEN` в `TELEGRAM_CHAT_ID` / `TELEGRAM_TOPIC_ID`. Если Telegram
недоступен, ошибка остаётся в Actions; повторной отправки внутри запуска нет.
Временный ключ удаляется после завершения push, в том числе после ошибки.

Повторять только sync можно через отдельный ручной workflow основного
репозитория с исходным CI run id. Это не запускает deploy. Файлы workflow
копируются вместе с кодом, а Actions в учебных копиях отключаются настройкой
репозитория в согласованное окно миграции.

Порядок импорта, сверки задач, включения и отката — в
[runbook](docs/migrations/team-repositories-runbook.md). Подготовка не меняет
действующие места работы до приёмки соответствующей пары.

Monitoring переключается независимо: repository var `COURSE_MIGRATED_REPOS`
в `.github` — `[]` (по умолчанию), `["frontend"]`, затем `["frontend","backend"]`.
После приёмки области reminders исключает её учебную копию и проверяет
`automation.yml`, `ci.yml` и ручной `sync-to-course.yml` командного репозитория.
Некорректная phase даёт warning и сохраняет прежний monitoring. После обеих
миграций PAT обновляют только в organization secret; общий job `close`
сохраняется для остальных межрепозиторных PR.

Общие workflow организации Cringe-Driven-Development-Team: уведомления в Telegram и добавление issue на доску [Sprint Board](https://github.com/orgs/Cringe-Driven-Development-Team/projects/1).

| Файл | Что делает |
|---|---|
| `.github/workflows/telegram.yml` | шлёт в Telegram пуши в ветки, задачи, комментарии, PR и ревью |
| `.github/workflows/add-to-project.yml` | добавляет новые и переоткрытые issue на доску; после мержа PR закрывает задачи организации, на которые он ссылается |
| `.github/workflows/automation.yml` | подключает оба workflow к этому репозиторию |
| `.github/workflows/reminders.yml` | в 10:00 МСК напоминает о PR, которые 4 часа и дольше ждут ревью или мержа после апрува; в 10:00, 15:00 и 20:00 сообщает о сбоях самих уведомлений и о новых репозиториях организации |
| `scripts/reminders.sh` | логика напоминаний и служебных проверок; здесь же список репозиториев |
| `scripts/sprint.sh` | смена спринта: перенос незакрытых задач и сообщение в чат |
| `tests/` | тесты скриптов и линтер |
| `CONTRIBUTING.md` | как заводить и закрывать задачи; GitHub показывает его во всех репозиториях организации |

Почему всё устроено так — [спека](docs/superpowers/specs/2026-09-18-central-workflows-design.md).

## Как подключить репозиторий

Положить в репозиторий `.github/workflows/automation.yml`:

```yaml
name: Автоматизация

on:
  push:
    branches-ignore: [main]
  issues:
    types: [opened, closed, reopened, edited]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, ready_for_review, closed, review_requested]
  pull_request_review:
    types: [submitted]

permissions: {}

jobs:
  board:
    uses: Cringe-Driven-Development-Team/.github/.github/workflows/add-to-project.yml@main
    secrets:
      ADD_TO_PROJECT_PAT: ${{ secrets.ADD_TO_PROJECT_PAT }}
  telegram:
    uses: Cringe-Driven-Development-Team/.github/.github/workflows/telegram.yml@main
    secrets:
      TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
```

Репозиторию должны быть доступны:

- секреты `TELEGRAM_BOT_TOKEN` и `ADD_TO_PROJECT_PAT`;
- переменные `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ID` и, по желанию:
  - `TELEGRAM_REVIEW_TOPIC_ID` — топик для сообщений о ревью: запросы, апрувы, правки, напоминания. Без неё всё идёт в `TELEGRAM_TOPIC_ID`;
  - `TELEGRAM_USER_MAP` — JSON `{"github-логин": "telegram id"}`: логины из карты упоминаются кликабельно.

Репозитории этой организации получают их с уровня организации. Репозиториям других организаций их нужно завести в настройках самого репозитория.

## Задачи фронта и бэка

Frontend код, issues и PR ведём вместе в [frontend](https://github.com/Cringe-Driven-Development-Team/frontend).
[Учебный frontend](https://github.com/frontend-park-mail-ru/2026_2_Cringe_Driven_Development)
получает те же коммиты main без Actions и новых рабочих PR.
Backend пока разрабатывается в [go-park](https://github.com/go-park-mail-ru/2026_2_Cringe_Driven_Development),
задачи — в [team/backend](https://github.com/Cringe-Driven-Development-Team/backend).

Как завести и закрыть задачу — в [CONTRIBUTING.md](CONTRIBUTING.md).
Frontend PR: `Closes #N`; backend PR пока: `Closes Cringe-Driven-Development-Team/backend#N`.
Review ментора остаётся обязательным в обоих направлениях.

Для межрепозиторных PR GitHub может не закрыть задачу сам из-за прав автора merge.
Job `close` в `add-to-project.yml` сохраняется: после мержа в default branch
закрывает задачи организации по closing keywords и оставляет «Закрыта мержем …».
Уже закрытые задачи не трогает. `ADD_TO_PROJECT_PAT` требует записи в Issues
организации; отказ завершает job ошибкой и попадает в ops.

Комментарии, которые начинаются с `<!-- auto -->`, бот в чат не пересылает: так помечены служебные комментарии автоматики.

История разделения задач и кода — [старая спека](docs/superpowers/specs/2026-09-29-tasks-in-org-design.md);
актуальная миграция — [новая схема](docs/superpowers/specs/2026-10-17-team-repositories-migration-design.md).

## Как вносить правки

Все подключённые репозитории ссылаются на `@main`: мерж сюда сразу действует везде. Поэтому правки — только через PR.

1. Прогнать тесты и линтер — оба должны пройти:
   ```bash
   bash tests/telegram.sh
   bash tests/reminders.sh
   bash tests/close.sh
   bash tests/lint.sh
   ```
   Нужны `bash`, `jq`, `perl`, GNU `date` и `awk` (всё, кроме `jq`, есть в Git Bash), а также `shellcheck` и `actionlint`.
2. Открыть PR. Этот репозиторий вызывает свои workflow из той же ветки: открытие PR, пуши и ревью сразу проходят через новую версию, сообщения приходят в боевой топик.
3. События `issues` и `issue_comment` всегда берут workflow из `main` — их видно только после мержа.

Если после мержа что-то сломалось — revert здесь, исправление сразу дойдёт до всех.

## Напоминания о ревью

Запускаются по расписанию из `main`: дайджест ревью — раз в день, в 10:00 МСК. Проверить вручную, не дожидаясь порога в 4 часа (ручной запуск всегда шлёт дайджест):

```bash
gh workflow run reminders.yml -R Cringe-Driven-Development-Team/.github -f min_hours=0
```

Новый репозиторий, кроме `automation.yml`, нужно добавить в список `REPOS` в `scripts/reminders.sh` — иначе напоминания и служебные проверки его не увидят. О новом репозитории организации бот сам напишет в общий топик («🆕 Новый репозиторий») и перечислит, чего не хватает.

В каждом запуске — 10:00, 15:00 и 20:00 — в общий топик уходит «🚨 Сбои уведомлений»: упавшие запуски «Автоматизации» в подключённых репозиториях и, раз в день, срок `ADD_TO_PROJECT_PAT` — за неделю до истечения. Кого звать на сбои — `OPS_PING` в начале скрипта.

Одиночные комментарии ревью склеиваются: сообщение «💬 Комментарии к PR» уходит, когда ревьювер молчит 3 минуты. Серые отменённые запуски «Автоматизации» в Actions — это они, а не сбой.

GitHub отключает расписание в публичном репозитории, если в нём 60 дней нет активности. За 10 дней до этого напоминания начинают предупреждать — предупреждение приходит вместе с утренним дайджестом в 10:00 или при ручном запуске; включить обратно: `gh workflow enable reminders.yml -R Cringe-Driven-Development-Team/.github`.

## Смена спринта

Спринты — итерации поля `Sprint` на доске. Когда спринт заканчивается, GitHub сам не переносит незакрытые задачи в новый спринт: они остаются в завершённом и пропадают из представления текущего. Бот в утреннем запуске в первый день новой итерации переносит такие задачи и пишет в чат итоги — что закрыто, что перенесено, кто за что отвечает. Если понедельничный запуск не состоялся, а хвосты остались, бот повторит перенос на следующее утро.

Срабатывает:
- в утреннем запуске напоминаний (10:00 МСК): в первый день спринта (понедельник) или в следующее утро, если хвосты остались в прошлом спринте; в остальные дни — ничего не делает;
- при ручной проверке с флагом `sprint=true`.

Проверить вручную, не дожидаясь понедельника:

```bash
gh workflow run reminders.yml -R Cringe-Driven-Development-Team/.github -f sprint=true
```

Бот пишет на доску — обновляет поле `Sprint` у незакрытых задач на новую итерацию. Для этого секрет `ADD_TO_PROJECT_PAT` должен иметь право записи на доску (он и сейчас добавляет на неё задачи). Ручной запуск и повтор упавшей попытки ничего не пишут в чат, если хвостов нет: сообщение «всё сделано» уходит только из планового утреннего запуска, первой попытки, — иначе оно постилось бы заново при каждой проверке.
