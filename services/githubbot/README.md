# GitHubBot

Telegram-команды для Issues и Scrumban №1 организации `Cringe-Driven-Development-Team`. GitHub остаётся источником задач; SQLite хранит входящие команды, выбор репозитория, результаты и Telegram offset. Runtime-зависимостей кроме Bun нет.

## Локальный запуск

Нужен Bun 1.4.4. Из этого каталога:

```sh
bun install --frozen-lockfile
export TELEGRAM_BOT_TOKEN='...'
export GITHUB_TOKEN='...'
export GITHUBBOT_CONFIG_JSON="$(cat config.example.json)"
export DATABASE_PATH='./data/githubbot.sqlite'
bun run src/main.ts --check-config
bun run src/main.ts
```

`--check-config` проверяет только локальную конфигурацию, без сети и SQLite. `bun run src/main.ts --health` возвращает 0, когда `health.json` рядом с SQLite обновлялся не более 120 секунд назад, иначе 1. По умолчанию SQLite — `/data/githubbot.sqlite`, heartbeat — `/data/health.json`. Каталог данных должен быть доступен для записи и сохраняться между запусками. Одна база обслуживается одним процессом polling.

Перед первым poll процесс проверяет `getMe`, `getWebhookInfo` и GitHub `GET /user`. Существующий webhook останавливает запуск: бот не вызывает `deleteWebhook`. Проверка `/user` подтверждает токен, но не гарантирует доступ ко всем Issues и Projects. Отказ авторизации/прав HTTP 401/403 при работе останавливает процесс и удаляет heartbeat; явные rate limits остаются повторяемыми ошибками. После сбоя процесс должен перезапускаться системой запуска.

`TELEGRAM_PROXY_URL` необязателен, принимает HTTP/HTTPS proxy и применяется только к `api.telegram.org`. GitHub обращается напрямую к `api.github.com`. Poll timeout — 25 секунд, его сетевой timeout — 35 секунд; остальные запросы ограничены 15 секундами. SIGTERM/SIGINT отменяет polling, дожидается уже выданного запроса worker и сохраняет его результат, затем закрывает SQLite. Новые сетевые этапы после сигнала не запускаются; продолжение определяется сохранённой фазой при следующем старте.

## Конфигурация и доступ

Скопируйте [config.example.json](config.example.json), заменив примерные ID. `GITHUBBOT_CONFIG_JSON` содержит:

- `chatId`: отрицательный ID одной разрешённой группы, decimal string.
- `notificationBotIds`: положительные ID ботов с доверенными карточками, decimal strings.
- `repositories`: разрешённые имена repo с `defaultPrefix` и списком `prefixes`.
- `topics`: положительный числовой `threadId` и `repository`. Backend → `backend`, Frontend → `frontend`, UX → `figma`; в остальных топиках `/issue` предлагает кнопки.
- `users`: положительный `telegramId` как decimal string, актуальный Telegram `username` и `githubLogin`. Все настроенные участники имеют одинаковые права в разрешённой группе.

BotFather: отключите Group Privacy (`/setprivacy` → Disable) для GitHubBot и проверьте настройку после добавления в группу. Это нужно, чтобы команды ответом на карточки GitHub Monitoring доходили до бота; администраторские права только ради чтения не нужны. Проверка настоящих reply-карточек в группе остаётся частью приёмки при развёртывании.

Используйте отдельную сервисную учётную запись/PAT с доступом к Issues разрешённых репозиториев (чтение/запись) и organization Projects (чтение/запись), с одобрением/SSO организации, если оно требуется. Действия выполняются от сервисной учётки; назначаемые GitHub-пользователи должны иметь подходящий доступ к репозиторию. Не коммитьте токены и реальную карту пользователей. Логи содержат ID job/этап и обезличенные ошибки, без полного Telegram update и секретов. База содержит текст команд и идентификаторы участников: ограничьте доступ к тому и резервным копиям.

Авторизация привязана к Telegram ID. Alias используется только для `@username`: если сообщение известного ID обнаруживает сменившийся username, старый alias блокируется в SQLite, в том числе после перезапуска. Обновите карту `users` и перезапустите бот; `/assignme` продолжает работать по ID. Бот не может обнаружить смену имени до получения сообщения этого пользователя, поэтому владелец должен поддерживать конфигурацию актуальной. История уже принятых команд сохраняет alias на момент приёма.

## Команды

| Команда | Действие |
| --- | --- |
| `/issue Заголовок` | Создать issue; описание со следующей строки. Префикс добавляется по repo. |
| `/close [URL]` | Закрыть issue. |
| `/assign @username [URL]` | Добавить исполнителя, сохранив остальных. |
| `/assignme [URL]` | Назначить автора команды по Telegram ID. |
| `/unassign @username [URL]` | Снять только указанного исполнителя. |
| `/tosprint [URL]` | Обеспечить членство в Scrumban и записать текущий Sprint, не менять Status. |
| `/sprint [@username]` | Показать неархивированные Issues текущего Sprint, включая закрытые. |

Вместо URL ответьте на оригинальную карточку GitHubBot или доверенного notification bot в том же топике. Ответ и явный URL одновременно запрещены, даже если ведут к одной задаче. Принимаются полные HTTPS-ссылки `https://github.com/Cringe-Driven-Development-Team/<repo>/issues/<number>`; PR и чужие repo не поддерживаются. В группе можно адресовать команду как `/issue@<актуальное_имя_бота>`.

Кнопку repo принимает только автор исходной команды, из того же сообщения и топика; срок — 24 часа. Первое подтверждение кнопки означает только получение команды: выбор проверяет worker. Ожидание кнопки не останавливает приём следующих команд.

Созданная задача добавляется в Scrumban с `Backlog`, пустым `Sprint` и без автоматического assignee. Текущий Sprint определяется по полю `Sprint` в `Europe/Moscow`; задачи без исполнителя показываются отдельно. Если создание issue прошло, а настройка Projects не подтверждена, бот отправит ссылку с предупреждением.

Если ответ POST создания потерялся, неизвестно, создал ли GitHub issue. Бот сохраняет `uncertain`, предупреждает и **не повторяет POST**: сначала проверьте repo вручную. Доставка Telegram может повториться после сбоя между отправкой и записью результата; это не повторяет GitHub-мутацию. Перезапуск продолжает сохранённые команды и ответы; не удаляйте SQLite ради повтора.

## Проверки

```sh
bun test
bun run typecheck
```

Тесты используют временные SQLite и fake fetch. Runtime smoke запускает настоящий CLI и отправляет SIGTERM без живых токенов и сообщений в группе. Живые API, реальные reply-карточки и инфраструктура проверяются отдельно при развёртывании.

## Контейнер и CI

Из корня репозитория:

```sh
bun install --frozen-lockfile --cwd services/githubbot
bun test services/githubbot/tests tests/githubbot-workflows.test.ts
bun run --cwd services/githubbot typecheck
docker build -f services/githubbot/Dockerfile -t githubbot:test .
bash tests/githubbot-docker.sh githubbot:test
bash tests/lint.sh
```

Контекст сборки — корень: сервис импортирует только чистый `services/webhook-alerts/src/format.ts`.
`Dockerfile.dockerignore` допускает package/lock, исходники GitHubBot и этот файл;
`.env`, SQLite, пользовательские конфигурации и остальной репозиторий в контекст не входят.
Образ использует Bun 1.4.4 Alpine, пользователя `bun`, рабочий каталог
`/app/services/githubbot` и постоянный том `/data`. Портов и HTTP listener нет.
Docker healthcheck вызывает `bun run src/main.ts --health`.
Smoke работает с `--network none`, synthetic config и новым временным томом:
проверяет CLI, свежий/устаревший heartbeat и SQLite между двумя контейнерами.
Он не запускает живой polling и удаляет только собственный тестовый том.

Job `githubbot` в `checks.yml` проверяет PR без публикации. Publisher
`githubbot-image.yml` запускается только на доверенный push/main этого репозитория:
install → tests → typecheck → build → offline smoke → login → push полного SHA.
После push он получает тег из registry и записывает проверенный digest и исходный SHA
в Actions summary. Ошибка проверок запрещает push; ошибка remote digest делает job красным.

## Передача образа в infra

**Пока не выполнено:** публикация реального image, проверка публичности без credentials,
развёртывание и живая приёмка. Локальный image ID не является registry digest.
Кодовый PR содержит `Part of Cringe-Driven-Development-Team/.github#60`;
merge кода не закрывает родительскую задачу.

После merge владелец проверяет зелёные `Checks / githubbot` и `GitHubBot image`
для одного полного SHA. Run ID и digest берутся из успешного Actions run:

```sh
SOURCE_SHA='<full-source-SHA>'
gh run list -R Cringe-Driven-Development-Team/.github --commit "$SOURCE_SHA" --workflow githubbot-image.yml
gh run view '<publisher-run-ID>' -R Cringe-Driven-Development-Team/.github --log
```

Пакет GHCR должен иметь public visibility (первую публикацию владелец проверяет
в настройках пакета `githubbot`). Для независимой проверки анонимного доступа
подставьте **реальный** digest из summary и выполните:

```sh
DIGEST='ghcr.io/cringe-driven-development-team/githubbot@sha256:<registry-digest>'
anonymous_config=$(mktemp -d)
docker --config "$anonymous_config" pull "$DIGEST"
rm -rf "$anonymous_config"
bash tests/githubbot-docker.sh "$DIGEST"
```

Передайте в [infra#111](https://github.com/Cringe-Driven-Development-Team/infra/issues/111)
digest, полный исходный SHA, ссылки на оба зелёных CI runs и результат анонимного pull.
Infra запускает один процесс из этого digest с writable persistent volume `/data`
и env `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `GITHUBBOT_CONFIG_JSON`,
`DATABASE_PATH=/data/githubbot.sqlite`; `TELEGRAM_PROXY_URL` необязателен.
Секреты передаются при запуске, без build args; bind mount требует владельца,
соответствующего `bun` в образе (`docker run --rm --network none "$DIGEST" id`).
CLI внутри контейнера: `bun run src/main.ts --check-config` и
`bun run src/main.ts --health`; обычный CMD запускает polling/worker.
Подготовленные infra env/Compose проверяются по отдельному infra-плану.
Infra PR содержит `Closes #111`; #60 закрывается после общей приёмки.

## Живая приёмка после image и infra#111

До публикации доступны только offline/fake API проверки. Следующий checklist
**ожидает выполнения человеком** после развёртывания. Для проверочных сообщений,
команд и GitHub-мутаций нужно явное разрешение владельца. Реальные chat/topic/user IDs,
токены и BotFather-настройки берутся из конфигурации развёртывания; примерные ID
из `config.example.json` в группе не используются.

После разрешения создайте временные задачи с заметным заголовком `Проверка GitHubBot`.
`<URL>` ниже — ссылка на созданную задачу, `@username` — настроенный участник:

1. В Backend, Frontend и UX отправьте `/issue Проверка GitHubBot`, включая вариант
   с описанием на следующей строке. Проверьте repo `backend`, `frontend`, `figma`,
   префикс, отсутствие assignee, членство в Scrumban, `Backlog` и пустой `Sprint`.
   В другом топике проверьте кнопки выбора; чужой автор не может подтвердить выбор.
   Два запроса одного автора независимы; повторная кнопка не создаёт ещё одну задачу.
2. Ответьте `/assignme` и `/tosprint` на настоящую карточку GitHub Monitoring
   и на карточку GitHubBot в том же топике. Проверьте доставку reply при выключенном
   Group Privacy; ссылка и кнопка карточки должны вести к нужной задаче.
3. Выполните `/assign @username <URL>`, `/unassign @username <URL>`,
   `/assignme <URL>`, `/tosprint <URL>` и `/close <URL>`. Повторите все пять
   команд ответом на обе разновидности карточек, убрав URL из команды.
   Проверьте сохранение других assignees, текущий Sprint и неизменный Status при `/tosprint`.
4. Проверьте `/sprint` и `/sprint @username`: закрытые неархивированные Issues
   текущего Sprint включены, PR/drafts исключены, неназначенные задачи выделены,
   пустая личная сводка понятна. Сверьте поля и assignees через GitHub API/доску,
   не только текст Telegram; для URL задачи можно читать `gh api repos/Cringe-Driven-Development-Team/<repo>/issues/<number>`.
5. Проверьте отказы: команда без цели; reply вместе с URL (включая одинаковую цель);
   несколько целей; ссылка только в цитате; чужой repo/организация; URL PR;
   неизвестный username и сообщение неразрешённого Telegram ID. Они не должны менять GitHub.
   При согласованной проверке смены username убедитесь, что обнаруженный старый alias
   заблокирован после рестарта, а `/assignme` по ID работает. Затем обновите карту владельца.
6. Перезапустите сервис штатно через infra Compose, сохранив том: проверьте health,
   продолжение очереди и ожидающей кнопки, отсутствие повторного создания после повторного update/callback.
   Не удаляйте SQLite. Неопределённый POST и транспортные сбои уже моделируются fake API тестами;
   реальные fault injection требуют отдельного согласования.

Зафиксируйте дату, image digest, исходный SHA, результаты каждого пункта и ссылки
на тестовые Issues. Обезличьте Telegram fixtures перед сохранением.
Только после фактического выполнения отметьте живую приёмку пройденной;
документация и зелёный fake smoke её не заменяют.
