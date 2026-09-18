# Общие workflow в репозитории `.github`

Дата: 2026-09-18
Статус: дизайн согласован в чате, ждёт вычитки спеки

## Зачем

Одинаковые `telegram.yml` и `add-to-project.yml` лежат копиями в шести репозиториях:

| Репозиторий | Организация |
|---|---|
| `docs`, `static`, `infra`, `react` | Cringe-Driven-Development-Team |
| `2026_2_Cringe_Driven_Development` (frontend) | frontend-park-mail-ru |
| `2026_2_Cringe_Driven_Development` (backend) | go-park-mail-ru |

Каждая правка скрипта уведомлений превращается в шесть PR: WEB-14/17/19 и API-6/8/10 были ровно такими синхронизациями. Цель — держать логику в одном месте, а в репозиториях оставить короткий файл-вызов.

## Решение

Переиспользуемые workflow (`on: workflow_call`) в публичном репозитории `Cringe-Driven-Development-Team/.github`. Каждый из шести репозиториев вызывает их по ссылке `@main`, поэтому мерж в `.github` сразу действует везде.

Отвергнутые варианты:

- **Composite action.** Внутри нет контекстов `vars` и `secrets`: чат, топик, карту логинов и оба токена пришлось бы передавать через `with:`, а `runs-on` остался бы в каждом репозитории.
- **Копии + бот-синхронизатор.** Нужен токен с правом записи в репозитории чужих организаций, и шесть PR на правку никуда не деваются.
- **Ссылка на тег `@v1`.** Стабильнее, но добавляет ручной шаг на каждую правку. Риск сломать все репо сразу закрываем проверкой PR в самом `.github` (см. «Проверка»).

### Ограничения GitHub, на которых построен дизайн

- Блок `on:` вынести нельзя — триггеры остаются в файле-вызове каждого репозитория.
- В вызванном workflow контекст `github` (событие, репозиторий, актор) принадлежит вызывающему.
- `vars` в вызванном workflow берутся из вызывающего репозитория и его организации.
- `secrets: inherit` работает только внутри одной организации. Преподские репозитории лежат в других, поэтому секреты передаются явно — во всех семи файлах-вызовах одинаково.
- Публичный reusable workflow можно вызывать из публичных репозиториев других организаций, если их политика это разрешает. В обоих преподских репозиториях `allowed_actions: all`.

## Репозиторий `.github`

```
Cringe-Driven-Development-Team/.github   (публичный)
├── README.md                — что здесь, как подключить репозиторий, как вносить правки
├── .gitattributes           — LF в рабочей копии: bash и awk не работают с CRLF
├── docs/superpowers/        — спека и план
├── tests/
│   ├── telegram.sh          — скрипт уведомлений на подставных событиях, curl — заглушка
│   ├── lint.sh              — actionlint + shellcheck
│   └── extract-run.awk      — достаёт скрипт из блока run: |
└── .github/workflows/
    ├── telegram.yml         — on: workflow_call
    ├── add-to-project.yml   — on: workflow_call
    └── automation.yml       — файл-вызов для самого .github, ссылки через ./
```

- **Доступ.** Базовые права в организации — `read`: студенты читают, пишут админы организации (менторы).
- **Самопроверка.** `automation.yml` в `.github` ссылается на `./.github/workflows/…`, то есть на файлы из того же коммита. Для событий `pull_request` и push в ветку это даёт проверку правки на настоящих событиях до мержа в `main`. События `issues` всегда берут workflow из `main` и проверяются только после мержа.
- **Секреты и переменные.** Секреты `TELEGRAM_BOT_TOKEN`, `ADD_TO_PROJECT_PAT` и переменные `TELEGRAM_*` на уровне организации имеют видимость `all` (проверено 2026-09-18) — `.github` получает их без настройки.
- **Защита `main`** не включается: писать могут только менторы. Договорённость — правки workflow только через PR, чтобы работала самопроверка.
- Уведомления из самого `.github` идут в боевой топик, как и из остальных репозиториев. Отдельной песочницы нет — так решено.

## Контракт подключаемого репозитория

Секреты: `TELEGRAM_BOT_TOKEN`, `ADD_TO_PROJECT_PAT`.
Переменные: `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ID`, `TELEGRAM_USER_MAP` (необязательная, JSON `{"логин": "telegram id"}`).

Для репозиториев организации всё приходит с уровня организации. В преподских репозиториях те же значения заведены на уровне репозитория.

Файл-вызов `.github/workflows/automation.yml`, одинаковый в шести репозиториях:

```yaml
name: Автоматизация

on:
  push:
    branches-ignore: [main]
  issues:
    types: [opened, closed, reopened, edited]
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

В самом `.github` отличаются только строки `uses:` — `./.github/workflows/add-to-project.yml` и `./.github/workflows/telegram.yml`.

- Логики в файле-вызове нет. Какие события обрабатывать, решает центральный workflow.
- Одно событие — один запуск в Actions (раньше два: по файлу на каждую автоматизацию).
- `permissions: {}` отключает права `GITHUB_TOKEN`: оба workflow работают только со своими токенами. Важно для преподских репозиториев, где выполняется код из чужой организации.

## Центральные workflow

### `add-to-project.yml`

```yaml
on:
  workflow_call:
    secrets:
      ADD_TO_PROJECT_PAT:
        required: true

jobs:
  add-to-project:
    if: github.event_name == 'issues' && (github.event.action == 'opened' || github.event.action == 'reopened')
    runs-on: ubuntu-latest
```

Шаг с GraphQL-запросом и мутацией `addProjectV2ItemById` переносится без изменений, `PROJECT_OWNER` и `PROJECT_NUMBER` остаются в этом файле. Фильтр, который раньше задавал триггер `issues: [opened, reopened]`, переехал в `if:`; на остальные события job помечается как skipped.

### `telegram.yml`

`on: workflow_call` с обязательным секретом `TELEGRAM_BOT_TOKEN`. Скрипт остаётся в YAML и переносится с четырьмя правками:

1. **Черновики PR.** `pull_request: opened` при `pull_request.draft == true` — выход без сообщения. Уведомление придёт на `ready_for_review`. Сейчас на draft PR приходит два «Открыт pull request».
2. **Только свои коммиты.** Перед подсчётом: `COMMITS=$(printf '%s' "$COMMITS" | jq -c 'map(select(.distinct))')`. После `merge main` в ветку в сообщении только merge-коммит, без коммитов из `main`. Нет своих коммитов — нет сообщения.
3. **Целевая ветка из события.** «🎉 Влито в `<ветка>`» — имя из `github.event.pull_request.base.ref`, экранированное как остальной текст. Сейчас `main` захардкожен.
4. **Понятная ошибка на пустую настройку.** Пустой `TELEGRAM_BOT_TOKEN` или `TELEGRAM_CHAT_ID` — `::error::` с именем недостающей настройки и выход с кодом 1, до обращения к Telegram.

Без изменений: формат сообщений, упоминания по `TELEGRAM_USER_MAP`, пропуск правок заголовка и правок описания в первые 10 минут, лимит в 10 коммитов, `SIDE` (frontend / backend / имя репозитория; для `.github` это `.github`), проверка ответа Telegram.

## Порядок перехода

0. ~~Исправить `TELEGRAM_USER_MAP`: ключ `"blackHATred "` с пробелом.~~ Выполнено 2026-09-18 в трёх местах (организация, frontend, backend); значения приведены к строкам.
1. ~~Создать `Cringe-Driven-Development-Team/.github` с README.~~ Выполнено 2026-09-18.
2. **PR в `.github`** из ветки `feature/reusable-workflows`: три workflow и README. Проверки из таблицы ниже, затем мерж.
3. **Трекинг-issue в `.github`** «Подключить общие workflow во все репозитории» — создаётся после мержа, заодно проверяет `issues: opened` и доску. Закрывается в конце перехода — проверка `issues: closed`.
4. **По PR в каждом репозитории**: удалить `telegram.yml` и `add-to-project.yml`, добавить `automation.yml`. Для `pull_request` GitHub берёт workflow из ветки PR, поэтому уведомление об открытии PR уже идёт через новый вызов, а старые файлы в этой ветке удалены — дублей нет. Порядок и именование:

   | # | Репозиторий | Как |
   |---|---|---|
   | 1 | frontend | issue «Подключить общие workflow из .github» → ветка `web-N` → PR «WEB-N: Подключить общие workflow из .github». Первая проверка вызова из чужой организации. |
   | 2 | react | ветка `chore/reusable-workflows`, PR «Подключить общие workflow из .github» со ссылкой на трекинг-issue |
   | 3 | static | так же |
   | 4 | infra | так же |
   | 5 | docs | так же |
   | 6 | backend | issue → ветка `api-N` → PR «API-N: …». Последним: репозиторием владеет другой ментор, репозиторий начинает выполнять код нашей организации с его секретами — предупредить и дать ему апрувнуть PR. |

5. **Переходный период.** Непереведённый репозиторий работает на своих копиях. Старая и новая схема в одном репозитории одновременно не живут — двойных сообщений нет.

## Проверка

**Локально, до пуша:** `bash tests/telegram.sh` — скрипт уведомлений на подставных событиях с заглушкой `curl`; `bash tests/lint.sh` — `actionlint` (синтаксис, контексты `${{ }}`, вызовы reusable workflow) и `shellcheck -S warning` по скриптам из `run: |`. shellcheck запускается отдельно от actionlint: встроенный вызов на Windows зависает.

**На событиях.** Каждое событие — хотя бы один раз:

| Событие | Где | Ожидание |
|---|---|---|
| draft PR → ready | PR в `.github` открывается черновиком | на открытие сообщения нет, на ready — одно |
| push в ветку | PR в `.github` | «⚒️ N коммитов», только свои |
| merge `main` в ветку | PR в `.github`, после отдельного коммита в `main` | в списке один merge-коммит |
| merge PR | мерж PR в `.github` | «🎉 Влито в main» |
| issue opened | трекинг-issue | сообщение + карточка на доске |
| issue closed | закрытие трекинг-issue | сообщение «Задача закрыта» |
| вызов из чужой организации | PR во frontend | запуск зелёный, сообщение пришло |
| review requested / approve | первое настоящее ревью после перехода | упоминание ревьюера / автора |

Апрув себе поставить нельзя, поэтому ревью-события проверяются на первом настоящем ревью.

## Откат

- Проблема в одном репозитории — revert его PR возвращает копии.
- Ошибка в центральном workflow — revert в `.github`, исправление сразу доходит до всех.

## Вне рамок

- **`ADD_TO_PROJECT_PAT` — личный токен YarikMix.** Когда истечёт, карточки перестанут добавляться. Замена на GitHub App — отдельная задача.
- **Два сообщения при мерже PR с `Closes #N`** («Влито» + «Задача закрыта») остаются.
- **`TELEGRAM_USER_MAP` в трёх местах** (организация + два преподских репозитория). Переменные других организаций не общие, а класть карту в публичный репозиторий нельзя — это Telegram ID участников.
- Шаблоны issue/PR и `profile/README.md` в `.github`.
