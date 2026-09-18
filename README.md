# .github

Общие workflow организации Cringe-Driven-Development-Team: уведомления в Telegram и добавление issue на доску [Sprint Board](https://github.com/orgs/Cringe-Driven-Development-Team/projects/1).

| Файл | Что делает |
|---|---|
| `.github/workflows/telegram.yml` | шлёт в Telegram пуши в ветки, задачи, PR и ревью |
| `.github/workflows/add-to-project.yml` | добавляет новые и переоткрытые issue на доску |
| `.github/workflows/automation.yml` | подключает оба workflow к этому репозиторию |
| `tests/` | тесты скрипта уведомлений и линтер |

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
- переменные `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ID` и, по желанию, `TELEGRAM_USER_MAP` — JSON `{"github-логин": "telegram id"}`: логины из карты упоминаются кликабельно.

Репозитории этой организации получают их с уровня организации. Репозиториям других организаций их нужно завести в настройках самого репозитория.

## Как вносить правки

Все подключённые репозитории ссылаются на `@main`: мерж сюда сразу действует везде. Поэтому правки — только через PR.

1. Прогнать тесты и линтер — оба должны пройти:
   ```bash
   bash tests/telegram.sh
   bash tests/lint.sh
   ```
   Нужны `bash`, `jq`, `perl`, GNU `date` и `awk` (всё, кроме `jq`, есть в Git Bash), а также `shellcheck` и `actionlint`.
2. Открыть PR. Этот репозиторий вызывает свои workflow из той же ветки: открытие PR, пуши и ревью сразу проходят через новую версию, сообщения приходят в боевой топик.
3. События `issues` всегда берут workflow из `main` — их видно только после мержа.

Если после мержа что-то сломалось — revert здесь, исправление сразу дойдёт до всех.
