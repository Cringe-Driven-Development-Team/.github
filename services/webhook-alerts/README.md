# Webhook alerts: текущий runbook

Сервис принимает `POST /webhooks/github` и `POST /webhooks/apidog`, проверяет
подпись по исходным байтам и подтверждает запрос после транзакционной записи
SQLite. При `WEBHOOK_ALERTS_SEND_ENABLED=false` (по умолчанию) worker не запускается:
приём и `/health` работают без Telegram, payload остаётся для последующей обработки.

Apidog отправляет только события MR: открытие, закрытие без слияния и слияние.
Подписанные raw webhooks сохраняются, но не создают Telegram-сообщений, включая
изменения API, схем и веток. При включённом sender сервис перед первым API-запросом
сохраняет постоянную границу начала мониторинга в SQLite. Более ранние события
остаются только базовой историей; перезапуск не сбрасывает границу. Полный список
MR целевой ветки читается с пагинацией и атомарно сохраняется перед обработкой
очереди. Следующий опрос начинается через 30 секунд после завершения предыдущего,
без пересечения запросов. При сбое список не сохраняется частично; следующий опрос
повторяет чтение, лог содержит только `apidog_mr_poll_failed`. Остановка прекращает
новые опросы и ожидает текущий ограниченный таймаутом запрос. Apidog использует
отдельного бота `TELEGRAM_APIDOG_BOT_TOKEN` и тему `TELEGRAM_APIDOG_TOPIC_ID`.
При старте включённого sender старые raw Apidog outbox со статусом `pending`,
`leased` или `failed` становятся `failed` с кодом `APIDOG_RAW_SUPPRESSED` и без
возможности ручного retry; `sent`, GitHub и синтетические `mr-poll:` MR не меняются.

Необязательный `TELEGRAM_PROXY_URL` задаёт HTTP/HTTPS-прокси только для отправки
Telegram (`sendMessage`), например `http://proxy.internal:2080`. `TELEGRAM_PROXY_URL` не применяется к GitHub API. Без этой настройки Telegram отправляется напрямую; пустой URL,
некорректный адрес и другие схемы (включая SOCKS) останавливают запуск с ошибкой.
Для настроенного прокси `NO_PROXY` не обходит этот маршрут.
Используется параметр отдельного запроса Bun `fetch`, а не глобальные переменные
окружения прокси. Локальному прокси нужен удалённый выход, с которого доступен
Telegram Bot API: сам по себе локальный listener проблему маршрута не решает.

## Образ, CI и порядок интеграции

`checks.yml` проверяет `bun test`, `bunx tsc --noEmit`, сборку Docker и настоящий
контейнер: `/health`, сохранность доставки в `/data` после пересоздания и snapshot
CLI. Локально из корня репозитория:

```sh
(cd services/webhook-alerts && bun install --frozen-lockfile && bun test && bunx tsc --noEmit)
docker build -t webhook-alerts:test services/webhook-alerts
bash tests/webhook-alerts-docker.sh webhook-alerts:test
bash tests/telegram.sh
bash tests/reminders.sh
bash tests/close.sh
bash tests/lint.sh
```

Workflow `webhook-alerts-image.yml` публикует только push в `main` основного
репозитория. Контракт имени: `ghcr.io/cringe-driven-development-team/webhook-alerts:sha-<40-символьный SHA main>`.
Повторные публикации одного SHA сериализуются и сохраняют существующий тег:
перед сборкой workflow проверяет registry, а при ошибке доступа/сети прекращает
работу. Только подтверждённое отсутствие manifest разрешает build/push.
Нет плавающего `latest`: SHA-тег служит для связи с коммитом, а в infra
`hooks_image` закрепляется по digest успешной публикации:
`ghcr.io/cringe-driven-development-team/webhook-alerts@sha256:<64 hex>`.
Проверить его через `docker buildx imagetools inspect <полный SHA-тег>`;
SHA-тег и registry digest записать в infra issue/PR. Локальный Docker image ID
не заменяет registry manifest digest. Сборка использует контекст
`services/webhook-alerts`; доступ к GHCR — `GITHUB_TOKEN` с `packages: write`.
Dockerfile явно задаёт `org.opencontainers.image.source` на
`https://github.com/Cringe-Driven-Development-Team/.github`, переопределяя source
базового образа Bun. Docker smoke проверяет label в собранном образе.
[GitHub рекомендует этот label для связи package с репозиторием и доступа workflow](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
Если финализация manifest всё ещё отвечает `denied`, проверить в package settings
связь с `.github`, `Manage Actions access` для этого репозитория и разрешённое
создание packages в организации; успешный login и загрузка слоёв сами по себе
не подтверждают право опубликовать manifest. До успешной публикации digest pending.
Перед deploy проверить доступность pull с VPS; приватному package нужны отдельные
read credentials на VPS. Образ работает пользователем `bun`, слушает `8080`,
содержит `wget`; постоянный том монтируется в `/data` с правом записи пользователя
образа. В infra задать `hooks_image` этим digest reference, `hooks_command: []`,
`hooks_port: 8080`, `hooks_data_path: /data`.

Порядок: создать infra sub-issue родителя #20 и проверить связь через API →
открыть и влить PR Task 8 с
`Part of https://github.com/Cringe-Driven-Development-Team/.github/issues/20` →
успешная публикация SHA-тега и запись registry digest в обеих issues →
PR Task 9 (образ по digest, snapshot → Restic → restore) → живая приёмка и
переключение Task 10 → финальный PR, закрывающий #20.
Связь infra issue должна быть именно GitHub sub-issue, проверенной через API,
а договор образа/снимка и порядок merge записываются в обеих issues. До этих
внешних действий Task 8 полностью не завершена. Публикация и merge этого кода
сами по себе не меняют отправителя.

## Настройки

Все значения поступают из окружения процесса. В infra они задаются словарём
`vault_hooks_env` в Ansible Vault; роль `hooks` рендерит `/opt/hooks/.env` с правами
`0600`. Не коммитить открытый `.env`, ключи, подписи или необезличенный payload.

| Переменная | Требование |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | Обязательный ключ GitHub HMAC SHA-256 |
| `APIDOG_SIGNATURE_KEY` | Обязательный отдельный ключ Apidog HMAC SHA-1 |
| `APIDOG_SIGNATURE_HEADER` | Обязательное имя HTTP-заголовка, сверить с реальной доставкой |
| `WEBHOOK_ALERTS_SEND_ENABLED` | `false` или `true`, по умолчанию `false` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Обязательны при отправке; chat ID — целое число |
| `TELEGRAM_APIDOG_BOT_TOKEN` | Обязателен при отправке; бот для уведомлений Apidog в том же чате и теме Apidog |
| `TELEGRAM_APIDOG_TOPIC_ID` | Обязателен при отправке, положительный ID темы Apidog |
| `TELEGRAM_TOPIC_ID`, `TELEGRAM_REVIEW_TOPIC_ID` | По умолчанию `26` и `1513` |
| `TELEGRAM_USER_MAP` | Необязательный JSON GitHub login → Telegram user ID |
| `GITHUB_API_TOKEN` | Необязательный read-only токен дополнений GitHub |
| `DATABASE_PATH`, `PORT` | По умолчанию `/data/queue.sqlite`, `8080` |

При неверной конфигурации процесс завершается с именем переменной без её значения.
GitHub и сгруппированные ревью отправляет `TELEGRAM_BOT_TOKEN`, события Apidog —
`TELEGRAM_APIDOG_BOT_TOKEN`. Оба бота используют общий chat ID и Telegram proxy.
Источник сообщения хранится в очереди, поэтому повторная отправка после перезапуска
сохраняет выбор бота. Группировка ревью сохраняется.
`SIGTERM`/`SIGINT` прекращает приём, дожидается worker и закрывает SQLite.

Организационная Actions variable `TELEGRAM_EVENTS_SOURCE` — отдельная настройка
GitHub, не env сервиса. Строка `webhook` выключает только job `notify` reusable
`telegram.yml`; отсутствие или другое значение оставляет старую отправку.
Actions сравнивает строки без учёта регистра. Variable должна быть доступна всем
вызывающим репозиториям; проверить отсутствие repository/environment override.
Не отключать Actions, caller `automation.yml`, `board`, `close`, `reminders.yml`,
course-sync и workflow релизных уведомлений. Их секреты по-прежнему нужны.

## GitHub organization webhook и shadow intake

Владелец организации открывает Settings → Webhooks → Add webhook:

- Payload URL: `https://hooks.cellestial.ru/webhooks/github`;
- Content type: `application/json`, SSL verification включена;
- Secret совпадает с `GITHUB_WEBHOOK_SECRET`, ключ отдельный от Apidog;
- Individual events: Pushes, Issues, Issue comments, Pull requests, Pull request
  reviews (`push`, `issues`, `issue_comment`, `pull_request`, `pull_request_review`).

Это один webhook организации, дополнительных repository hooks для тех же событий
не создавать. Организационный hook охватывает все её репозитории; до включения
подтвердить, что такой охват нужен, включая репозитории без старого caller.
Входящие `push` в default branch и теги сохраняются, но projector не отправляет
их в Telegram: уведомления получают только непустые `refs/heads/*` вне default
branch, чтобы сохранить фильтр старых callers. Этот фильтр и охват репозиториев
проверить при живой приёмке.
Шаги создания — в [GitHub Docs](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks).

Сначала развернуть с `WEBHOOK_ALERTS_SEND_ENABLED=false`. Проверить
`https://hooks.cellestial.ru/health`, затем включить hook и посмотреть `ping` и
тестовое событие в Recent Deliveries: 2xx после сохранения, ответ менее 10 секунд.
`ping` сохраняется, но не создаёт сообщения. Неверная подпись должна дать `401`.
Повторить доставку с тем же `X-GitHub-Delivery`: `200`, одна строка в SQLite.
SQLite недоступна — `503`, доставка подлежит повтору после восстановления.
Правила подписи и срок ответа — в
[GitHub best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

В shadow intake старый sender продолжает писать в рабочий чат; новый только
сохраняет. Не включать worker с боевым токеном для проверки shadow-очереди.
Формат и отправку проверять отдельным экземпляром/БД с тестовым чатом и темами;
тестовая БД не становится боевой очередью. Live GitHub/Apidog, права токенов,
доступность образа и восстановление фиксируются в журнале ниже.

## Apidog: приём и live-проверка

[Официальные настройки уведомлений Apidog](https://share.apidog.com/apidoc/docs-site/544525/notification-settings-616240m0)
описывают `Signature Auth` как HMAC SHA-1 с префиксом `sha1=`. Контроллер
подтвердил настоящую доставку обычного create/update endpoint: заголовок
`X-Apidog-Signature` содержит канонический base64 HMAC SHA-1 от исходных байтов
тела. Приёмник поддерживает обе кодировки и проверяет подпись до сохранения.

Наблюдаемая структура содержит строки `event`, `title`, `content`, `appLink`;
для обновления API получено `event=API_UPDATED`, `content` содержит переводы строк,
ссылка ведёт на `app.apidog.com`. Fixture `anonymized-live-structure.json` повторяет
эту структуру с вымышленными значениями, без сохранения настоящего payload.
Карточка экранирует и ограничивает title/content, сохраняет переводы строк и
показывает кнопку только для безопасного `appLink`, в настроенной теме Apidog.

Старая версия ответила `401` на настоящую base64-подпись. Исправление вошло в
[`.github` PR #32](https://github.com/Cringe-Driven-Development-Team/.github/pull/32),
образ с digest `sha256:8ca5549293a571ae2de60c638bc9cd9a67f59aa158df1d2f8b0d2ce5ddbe6901`
развёрнут через [infra PR #79](https://github.com/Cringe-Driven-Development-Team/infra/pull/79).
Повторное изменение временного endpoint `45845223` в sprint-ветке
`webhook-alerts-smoke-20261025` сохранено как `API_UPDATED`, delivery `130`.
После включения worker сообщение `7508` отправлено в тему `6033`; новое изменение
после переключения дало delivery `139` и сообщение `7511` в ту же тему.
Удаление временного endpoint после live-проверки дало `API_DELETED`, delivery
`145` и сообщение `7517` в теме `6033`. Main Apidog не менялась. Raw JSON
сохраняется целиком, без вывода тела и ключей в лог.

Если подтверждён устойчивый ID уведомления, дедупликация постоянная по
`(source, delivery_id)`. Без него HTTP не передаёт `deliveryId`, и SQLite использует
SHA-256 исходного тела в скользящем пятиминутном окне. Две легитимные дословно
одинаковые доставки в этом окне могут быть подавлены: это следует учитывать при
live-проверке. Generic object `id` ключом доставки не считается.

`401` — подпись отсутствует/неверна; `400` — неверный JSON/UTF-8; `415` — требуется
`application/json`; `413` — больше 1 МиБ; `503` — запись не выполнена; `409` — один
ID с разными телами; `202` — сохранено; `200` — дубликат. Payload без валидной
подписи не сохраняется.

## Согласованный снимок SQLite и изолированное восстановление

Снимок работающей WAL-базы создаётся без остановки сервиса:

```sh
docker compose -f /opt/hooks/compose.yml exec -T hooks bun run src/cli.ts snapshot --output /data/snapshots/queue.sqlite
```

CLI использует `DATABASE_PATH` (по умолчанию `/data/queue.sqlite`) и не требует
настроек Telegram или webhook-ключей. Он выполняет `VACUUM INTO` в уникальный
временный файл рядом с результатом, проверяет `PRAGMA integrity_check`, вызывает
`fsync` файла и каталога и атомарно заменяет готовый снимок. Файл имеет права
`0600`, новый каталог — `0700`. Выходной путь не может совпадать с работающей БД,
в том числе через symbolic/hard link. При обычной ошибке команда возвращает
ненулевой код, сохраняет предыдущий снимок и удаляет временные файлы. Прежний
снимок удерживается временной hard link до завершения синхронизации каталога;
катастрофический отказ файловой системы может помешать и откату.

Restic должен запускаться **только после успешного завершения CLI** и сохранять
только готовый `/data/snapshots/queue.sqlite` из тома сервиса. Работающие
`/data/queue.sqlite`, `queue.sqlite-wal`, `queue.sqlite-shm` и временные файлы
снимка в резервную копию очереди не входят. Интеграция unit Restic выполняется
отдельной задачей infra.

Проверка восстановления из готового файла (из каталога `services/webhook-alerts`):

```sh
restore_dir=$(mktemp -d)
cp /path/to/restored/snapshots/queue.sqlite "$restore_dir/queue.sqlite"
bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.argv[1], { readonly: true });
  try {
    console.log(db.query("PRAGMA integrity_check").all());
    console.log(db.query("SELECT id, source, delivery_id, dedupe_kind FROM deliveries ORDER BY id").all());
    console.log(db.query("SELECT id, origin_id, status, telegram_message_id FROM outbox ORDER BY id").all());
  } finally { db.close(); }
' "$restore_dir/queue.sqlite"
bun -e '
  import { Database } from "bun:sqlite";
  import { openStore } from "./src/store";
  const path = process.argv[1];
  const db = new Database(path, { readonly: true });
  let row;
  try { row = db.query("SELECT source, delivery_id, event, raw FROM deliveries WHERE dedupe_kind = ? LIMIT 1").get("id"); }
  finally { db.close(); }
  if (!row) throw new Error("restored snapshot needs a stable-ID delivery for duplicate check");
  const store = openStore(path);
  try {
    if (store.accept({ source: row.source, deliveryId: row.delivery_id, event: row.event, raw: row.raw }) !== "duplicate") throw new Error("restored delivery was not deduplicated");
  } finally { store.close(); }
  console.log("Restored stable-ID duplicate rejected");
' "$restore_dir/queue.sqlite"
```

Ожидается `integrity_check: ok`, сохранённые ID и состояния `pending`/`sent`.
Для проверки достаточно одного файла, WAL исходной БД не нужен. Проверять в
изолированном каталоге с остановленным worker; если запускается сервис,
обязательно установить `WEBHOOK_ALERTS_SEND_ENABLED=false`. Не воспроизводить
pending-доставки в боевой Telegram при проверке. Перед заменой рабочей базы
остановить сервис, сохранить текущую базу с её sidecar-файлами отдельно,
установить восстановленный файл с владельцем процесса и правами `0600`, затем
запустить с отключённой отправкой; проверить очередь и только потом включать worker.

Локальная автоматическая проверка `bun test tests/snapshot.test.ts` оставляет
исходную WAL-базу открытой, восстанавливает только снимок, сверяет `pending`/`sent`,
ID и повторную доставку GitHub/Apidog, затем проверяет `/health` и отсутствие
сетевых вызовов при отключённой отправке. Живое восстановление из Restic на VPS выполнено в Task 9 с синтетическими
строками и выключенным sender; результат и ограничения записаны в журнале ниже.

## Переключение без двойной отправки

Этот порядок нужен при первом переключении и при повторном включении после
отката; фактические результаты Task 10 записаны ниже. Перед новым переходом
проверить подписанные live-доставки обоих источников, snapshot → Restic →
изолированное restore и границу прежней отправки. Пока сверка очереди не
завершена, оставить `WEBHOOK_ALERTS_SEND_ENABLED=false`.

1. Сохранить в журнале UTC-время начала, SHA/digest образа, прежнее значение и
   visibility `TELEGRAM_EVENTS_SOURCE`, ID hook, GitHub delivery GUID, Actions
   run/job URLs и Telegram message IDs. Список подключённых callers проверить
   по репозиториям, включая локальные overrides variable. Для Apidog подтвердить
   отсутствие другого notification target, пишущего те же события в тот же чат.
2. Пока worker выключен, установить organization Actions variable
   `TELEGRAM_EVENTS_SOURCE=webhook` для всех нужных репозиториев. Дождаться конца
   всех уже начавшихся `notify`, включая трёхминутные серии ревью; не отменять
   jobs с неизвестным результатом. Новым тестовым событием убедиться, что
   `notify` skipped во всех callers, но `board`/`close` доступны. Зафиксировать
   UTC-время окончания старых jobs. Worker ещё не включать.
3. Снять snapshot. Сопоставить каждую shadow-доставку до и во время границы с
   Recent Deliveries, Actions и Telegram: источник, GUID, repository, объект,
   действие, SHA/review ID и фактический результат отправки. Один PR может дать
   две карточки в разные темы; серия ревью — одну на несколько доставок.
   Успешный Actions job сам по себе не доказывает отправку: отправитель также
   пропускает черновики, ботов и другие события. В журнале явно отметить
   `already sent`, `intentionally silent`, `new worker owns` или `unresolved`.
   Не выбирать все строки по одному `received_at`: отложенная доставка может
   относиться к старому событию. Не включать worker при `unresolved`.
4. Для строк `already sent` и подтверждённых `intentionally silent` записать
   завершение с нулём сообщений. Только первый переход из чистого shadow-режима
   (outbox и группы ревью пусты), явно проверенные внутренние SQLite ID вместо
   примера `[1,2]`:

   ```sh
   docker compose -f /opt/hooks/compose.yml exec -T hooks bun -e '
     import { Database } from "bun:sqlite";
     import { openStore } from "./src/store";
     if ((Bun.env.WEBHOOK_ALERTS_SEND_ENABLED ?? "false") !== "false") throw new Error("stop worker first");
     const ids = JSON.parse(process.argv[1]);
     if (!Array.isArray(ids) || !ids.length || !ids.every(Number.isSafeInteger)) throw new Error("explicit delivery IDs required");
     const path = Bun.env.DATABASE_PATH ?? "/data/queue.sqlite";
     const db = new Database(path, { readonly: true });
     try {
       if (db.query("SELECT count(*) AS n FROM outbox").get().n || db.query("SELECT count(*) AS n FROM review_groups").get().n) throw new Error("not a clean shadow queue: reconcile outbox/groups separately");
       for (const id of ids) {
         const row = db.query("SELECT source, lease_until FROM deliveries WHERE id = ?").get(id);
         if (!row || row.source !== "github" || row.lease_until !== null) throw new Error("invalid shadow delivery");
       }
     } finally { db.close(); }
     const store = openStore(path);
     try { for (const id of ids) store.prepare(id, []); }
     finally { store.close(); }
     console.log("Reconciled delivery IDs", ids);
   ' '[1,2]'
   ```

   Это сохраняет payload и `(source, delivery_id)`, поэтому повторная доставка
   уже сверенного события не создаёт рассылку. Новые события, недоставленные
   старым sender, и Apidog остаются unprepared для worker. Отдельно сверить
   изолированные тестовые Apidog события, чтобы они не стали боевой рассылкой.
   Не применять этот рецепт к очереди, где worker уже работал: подготовленные
   outbox/группы требуют сверки каждого сообщения, не только delivery.
5. Повторно проверить пограничные доставки, пришедшие во время сверки. Сохранить
   журнал соответствий и новый snapshot. Через Ansible Vault выставить
   `WEBHOOK_ALERTS_SEND_ENABLED=true`, применить роль `hooks` и пересоздать сервис
   с обновлённым `.env`. Изменение env-файла без пересоздания недостаточно.
6. Создать по одному новому GitHub и Apidog событию. Проверить ожидаемое число
   карточек, GitHub тему `26`, review `1513`, Apidog выбранную тему и записи
   `sent`/`telegram_message_id`. Redelivery того же GitHub GUID не добавляет
   карточку. Проверить добавление issue на доску, `close` и обычный запуск
   reminders. Только после этого записать приёмку; #20 пока не закрывать до
   фиксации всех live результатов в финальном PR.

## Расширение охвата при включённом worker

Этот порядок нужен для нового caller, когда сервис уже отправляет сообщения.
Worker остаётся включённым; рабочую очередь не редактировать, старые сообщения
не воспроизводить и не удалять. Порядок первого переключения выше здесь не применять.

1. Сохранить UTC, образ, health, `integrity_check`, состояние deliveries/outbox
   и незавершённых review groups. Прочитать org variable
   `TELEGRAM_EVENTS_SOURCE` и selected repositories, проверить callers на
   актуальном main и отсутствие repository/environment overrides. Org hook
   должен быть активен и охватывать репозиторий.
2. Проверить queued/in-progress automation runs новых callers и дождаться
   завершения их `notify`, включая серии ревью, без отмены. Сопоставить
   пограничные GUID/события и Telegram message IDs; успех job сам по себе
   отправку не доказывает. Неразрешённые deliveries/outbox/review groups сверять
   по событиям, не меняя очередь; при `unresolved` приёмку не объявлять.
3. Перед каждым добавлением перечитать variable: `value=webhook`,
   `visibility=selected`. Добавить только отсутствующий repository ID через
   `PUT /orgs/Cringe-Driven-Development-Team/actions/variables/TELEGRAM_EVENTS_SOURCE/repositories/{repository_id}`,
   после каждого проверить API. Не заменять весь список и не менять
   value/visibility; прежние selected repositories сохранить.
4. Для каждого нового caller создать временную ветку от текущего main и
   отправить один пустой коммит. Сверить repo/ref/before/after SHA и GUID:
   org delivery HTTP `202`, `telegram / notify=skipped`, одна prepared delivery,
   ровно один outbox `sent` с topic `26` и ненулевым Telegram message ID.
   После окончания Actions и worker повторить подсчёт. Событие создания ветки
   сверить отдельно: без новых коммитов оно не создаёт карточку.
5. Перед удалением своей ветки проверить точное имя и ожидаемый head SHA.
   Delete push должен стать prepared без outbox. Повторить selected repos,
   overrides, health и проверку незавершённой очереди; сверить неизменность
   независимых workflow. Записать UTC, GUID/run/job/message IDs и очистку.
   Deploy/release и новые issue для push-проверки не нужны.

## Откат и повтор доставки

Откат сначала отрепетировать в изолированном чате/экземпляре и проверить в живом
окне переключения. Сохранить время, результаты обеих отправок и отсутствие дублей:

1. Вернуть в Vault `WEBHOOK_ALERTS_SEND_ENABLED=false`, пересоздать `hooks` и
   дождаться завершения прежнего процесса/worker. Убедиться по очереди и чату,
   что больше ничего не отправляется; `/health` и durable intake остаются рабочими.
   Если штатная остановка невозможна, остановить контейнер и сверить неизвестный
   исход отправки до возобновления: Telegram мог принять сообщение до обрыва связи.
2. После остановки worker вернуть прежнее значение/отсутствие organization
   variable (любое значение, кроме `webhook`, включает старый sender), проверить
   visibility и overrides. Новое поддерживаемое событие должно дать ровно одну
   старую карточку. Проверить board и reminders; записать Actions run/job URL.
3. Очередь, snapshot и журнал не удалять. Старый workflow обрабатывает новые
   события и не умеет автоматически отправить накопленную очередь сервиса.
   Не перезапускать старые Actions runs уже отправленных worker событий.
   Сначала сверить GUID/объекты/message IDs для периода отката; перед повторным
   включением worker вновь разобрать outbox и группы, чтобы не повторить сообщения
   старого sender. Рецепт чистого shadow выше к такой очереди неприменим.
4. Apidog при выключенном worker накапливается до восстановления сервиса;
   отдельного старого Actions sender у него нет. После сверки возобновить его
   через worker. Не включать параллельный target в тот же Telegram чат.

Для GitHub в organization hook → Recent Deliveries открыть нужную доставку и
нажать Redeliver после устранения ошибки. GitHub не повторяет неудачные webhook
автоматически; GUID redelivery сохраняется, правила — в
[GitHub best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
Уже сохранённый GUID вернёт `200`, он не сбрасывает `prepared` и `sent`.
`409` требует разбирательства с отличающимся телом, не удаления dedupe-ключа.
Для Apidog способ live redelivery и наличие постоянного notification ID ещё
нужно подтвердить; без ID повтор спустя пять минут может стать новой доставкой.
Не переотправлять его без сверки с очередью.

Если исходная доставка сохранена, а её outbox-строка имеет `failed`, после
проверки фактической отправки в Telegram можно повторить именно эту строку:

```sh
docker compose -f /opt/hooks/compose.yml exec -T hooks bun run src/cli.ts retry 123
```

Здесь `123` — внутренний outbox ID, не GitHub GUID. Команда не создаёт новую
delivery и не повторяет `sent`; строка `pending`/`leased` уже обслуживается
worker. При сетевом обрыве или аварии после принятия Telegram, но до записи
`message_id`, исход может быть неизвестен: сверить чат до ручного retry.

## Журнал живой приёмки

Инфраструктурная приёмка Task 9 выполнена без сообщений в Telegram. Результаты
Task 10 ниже фиксируют фактические доставки, переключение и оставшиеся проверки.
Указаны UTC-время, SHA/digest, идентификаторы доставок/строк и результат без
ключей, подписей и полного payload. Pending нельзя считать проверкой.

| Проверка | Фактический результат |
| --- | --- |
| Публикация SHA в GHCR, pull с VPS | Первый образ: SHA `08e7968fa0d39dd5f25fe8495c58d78006a26653`, digest `sha256:30718ed06926bff66627502361185c2ca6ebca78b20b044ce4d8bba92f12e858`. Текущий образ: `.github/main` `722ee9db38957a160b3bd1f2a5f92b0e3c576bcc`, digest `sha256:8ca5549293a571ae2de60c638bc9cd9a67f59aa158df1d2f8b0d2ce5ddbe6901`; anonymous pull с auxiliary VPS успешен |
| Infra sub-issue #20 и API-проверка связи | infra#70 подтверждена через sub_issues API, закрыта после merge PR #73 |
| GitHub signed delivery, health, duplicate | Task 9: health 200; синтетические GitHub/Apidog: неверная подпись 401, первая доставка 202, повтор 200; конфликт GitHub ID 409. Task 10: настоящий ping/push 202, redelivery push 200; issue_comment GUID `ff6fbf10-d084-11f1-94f3-973750d5f14b` после исходного 502 принят при повторе 202, следующий повтор 200, в SQLite одна delivery `140` и одна отправка `7512` |
| Apidog live header, fixture и Telegram | Настоящий `X-Apidog-Signature` — base64 HMAC-SHA1; после исправления `API_UPDATED` принят как delivery `130`, сообщение `7508`; после переключения delivery `139`, сообщение `7511`; удаление endpoint — `API_DELETED`, delivery `145`, сообщение `7517`. Все в теме `6033` |
| Snapshot → Restic → isolated restore, integrity, pending/sent, dedupe | Task 9: синтетические pending/sent проверены. Task 10: snapshot `8be495bf…` от `2026-10-25T14:39:40Z` восстановлен без сети: integrity ok, 130 deliveries, pending `129/130`, стабильный GitHub GUID и Apidog body hash распознаны как duplicate; на отдельной копии mock worker отправил только Apidog один раз |
| Репетиция отката и отсутствие двойной отправки | В `2026-10-25T15:05–15:20Z` новый worker остановлен через временный Vault override и Ansible, затем восстановлен. При выключенном worker старый Actions отправил тестовый comment как `7513` в тему `26`; его SQLite ID `141` закрыт с нулём сообщений после сверки и Restic. После возврата org variable старый `notify` skipped, новый worker отправил следующий comment ID `142` ровно один раз как `7514`. Финал: sender=true, pending=0, integrity ok, Restic `15:20:08Z` |
| Граница Actions/worker, GitHub/Apidog в боевых темах | Org variable `TELEGRAM_EVENTS_SOURCE=webhook` видна только `.github`, `backend`, `frontend`, `infra`; старый `notify` skipped. Новый worker отправил GitHub `133/136` как `7509/7510` в тему `26`, Apidog `130/139` как `7508/7511` в тему `6033`; очередь обработана без дублей |
| Code Review в теме `1513` | Подписанный синтетический `pull_request.review_requested` отправлен на живой localhost-маршрут: HTTP `202`, SQLite delivery `147`, outbox `11 sent`, Telegram `7519` в теме `1513`; повтор того же GUID — `200` без дубля. Это проверка боевого маршрута/отправки, а не настоящего GitHub review от участника |
| Board, close, reminders после переключения и отката | [Тестовая .github issue #33](https://github.com/Cringe-Driven-Development-Team/.github/issues/33) открыта: [run 40206555327](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40206555327) выполнил `board / add-to-project`, карточка появилась в Scrumban/Backlog. После закрытия issue как completed карточка в Scrumban/Done; GitHub ID `143/144` дали Telegram `7515/7516` в теме `26`, старый `notify` skipped. `board / close` в [infra run 40204386040](https://github.com/Cringe-Driven-Development-Team/infra/actions/runs/40204386040) и ручной [reminders run 40205201295](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40205201295) также успешны |
| Временная ветка Apidog | Endpoint `45845223` удалён после проверки `API_DELETED`; sprint-ветка `webhook-alerts-smoke-20261025` (`1413097`) архивирована и удалена. Три тестовые AI-ветки `1412939/1413089/1413158` также удалены; связанный с `1413089` MR `39835` закрыт без слияния. `branch list --type all` не показывает веток `webhook-alerts`. Main Apidog не менялась |
| External AI Edit Permissions в Apidog | Владелец решил оставить права редактирования sprint- и AI-веток через CLI/MCP включёнными для студенческих агентов. Прямые изменения main и general-веток остаются выключенными: `main=false`, `sprint=true`, `general=false`, `ai=true`. Дополнительное действие в UI не требуется |

Источник инфраструктурных результатов — [infra RUNBOOK на проверенном main](https://github.com/Cringe-Driven-Development-Team/infra/blob/edc13058522c850c3cac5cfeb46ba278a74c5c10/RUNBOOK.md#фактическая-проверка-infra70-2026-10-24-utc).
`systemctl start restic-backup` завершился `Result=success`, `ExecMainStatus=0`.
Snapshot `d8b71852ca25c0c3bedd7faa0f4a47a20c41f20261972cf79785b99f75b8e20e`
создан `2026-10-24T21:33:58Z` и восстановлен командой:

```sh
restic restore d8b71852ca25c0c3bedd7faa0f4a47a20c41f20261972cf79785b99f75b8e20e --host auxiliary --target /var/tmp/hooks-restore.K7QIjA --include /var/lib/docker/volumes/hooks_hooks_data/_data/snapshots/queue.sqlite
```

Изолированная проверка в закреплённом образе с `--network none` без worker дала
`PRAGMA integrity_check=ok`, сохранённые pending/sent и stable-ID duplicate.
Синтетический статус sent и message ID были заданы скриптом и не доказывают
доставку в Telegram. После удаления тестовых строк создан и отдельно восстановлен
чистый snapshot `837743262111103e2929288a77b24cb46376c94ec3c71c4a55158abdfd7b1088`
(`2026-10-24T21:37:06Z`): integrity ok, ноль тестовых deliveries/outbox.
Обычное восстановление выполнять из этого или более позднего чистого snapshot:
первый тестовый архив содержит синтетическую pending-строку.

Infra PR #73 merged в `edc13058522c850c3cac5cfeb46ba278a74c5c10`;
[post-merge run 40139285195](https://github.com/Cringe-Driven-Development-Team/infra/actions/runs/40139285195)
успешен, включая production apply/verify. Sender оставлен false.

Владелец отдельно разрешил Task 10. После обновления GitHub scopes контроллер
создал organization hook `702764072`: active, TLS verification включена, URL
`https://hooks.cellestial.ru/webhooks/github`, события `push`, `issues`,
`issue_comment`, `pull_request`, `pull_request_review`. Secret взят из Vault.
Настоящий GitHub ping `a537a93e-d004-11f1-8716-24d99f5d0ff6` и push
`adba7d2a-d004-11f1-8fad-583c490826f7` получили `202`; повтор push — `200`.
Контроллер проверил SQLite на VPS: ровно одна строка для каждого GUID.
На этой проверке `2026-10-24` sender был `false`: результаты подтверждали только
intake; отправка worker тогда ещё не проверялась.
Пограничный push `adba7d2a-d004-11f1-8fad-583c490826f7` (`1e7de41`, ветка
`automation-20-webhooks-ghcr-fix`) классифицирован как `already sent` старым sender:
[Actions run 40143875584](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40143875584)
успешен, в теме `26` подтверждено сообщение `7370` от `2026-10-24T23:43:20Z`.
Эта доставка включена в завершённую сверку ID `1–67` ниже и не должна
воспроизводиться worker при переключении.
Прежний отказ чтения org hooks/variable из-за scope устранён контроллером;
прежнее состояние variable здесь не утверждается.
Контроллер read-only подтвердил существующие темы: Apidog `6033`, GitHub `26`,
Code Review `1513` в чате `-1003713420351`. Владелец настроил Apidog target
`302418` и notification event `43505`; последующая проверка настоящей доставки
и отправки приведена ниже. #20 закрывается только после финальной приёмки.

Сверка shadow-очереди завершена для фиксированной границы SQLite ID `1–67`:
`32 already sent`, `35 intentionally silent`, `0 unresolved`. Отправленные события
сопоставлены с фактическими сообщениями старого bot и Actions; тихие — с triggers
callers и фильтрами старого sender. Успешный Actions run сам по себе не считался
подтверждением сообщения. Это сверка старой отправки, не проверка отправки worker.

Контроллер применил `Store.prepare(id, [])` ко всем 67 строкам, сохранив исходные
доставки и dedupe-ключи; outbox и review_groups остались пустыми (`0`).
В том числе `Store.prepare(id, [])` применён к ID `66–67`: ID `66`
(`converted_to_draft`) исключён caller, ID `67` (backend `api-18` push)
подтверждён сообщением старого bot `7424`. Это завершает проверенные
shadow-доставки без сообщений нового сервиса.

После сверки прежней границы ID `1–58` создан Restic snapshot
`0102ab05f313c8c37f5af7f3a365b3b9f81784905565405027132b796cc10c93`
в `2026-10-25T11:56:28Z`. Его восстановление в изолированном контейнере без сети
дало `integrity_check=ok`, повтор стабильного delivery ID отвергнут как duplicate,
нет pending/due обработок. На `2026-10-25T11:56Z` sender был `false`; доставки
после ID `67` требовали отдельной сверки. Отправка нового сервиса в Telegram,
Apidog и rollback на этом этапе ещё не проверялись.

Проверка Apidog через CLI не дала доставку: прямое создание endpoint в защищённой
main отклонено (`403013`, ограничение external AI edits). Контроллер создал
изолированную AI-ветку, добавил и изменил тестовый endpoint; в 20-секундном окне
наблюдения VPS не получил HTTP-запросов Apidog, строк Apidog в очереди нет.
Первая тестовая AI-ветка архивирована, main не менялась.

Следующая попытка: из-за защиты main и невозможности создать endpoint через UI
контроллер подготовил AI-ветку
`ai/20261025-from-main-webhook-alerts-delivery` (`1413089`), endpoint
`45839509` (`GET /__webhook_alerts_smoke`) и MR `39835`, содержащий только этот
endpoint. CLI approve завершился `Invalid Parameter`. После возражения владельца
против добавления временного endpoint в main контроллер закрыл MR `39835`
(проверен статус `CLOSED`) и архивировал ветку `1413089`. В main проверены только
10 исходных endpoints, smoke endpoint отсутствует. Эта попытка не подтвердила
уведомления для dev-ветки. На тот момент header, настоящая fixture и отправка
Apidog оставались непроверенными; последующая проверка описана ниже.

Дополнительная проверка `BRANCH_CREATED` также не подтвердила HTTP-доставку:
временное правило `43506` удалено (в списке снова только `43505`). На момент
проверки стандартная sprint-ветка `webhook-alerts-smoke-20261025` (`1413097`)
была пустой и активной: CLI archive по имени/ID завершился ошибкой, delete
требовал archive. Позже в этой ветке появился временный endpoint `45845223`;
его очистка отмечается ниже.

Перед проверкой маршрута Telegram создан Restic pre-route snapshot
`8728497eda7fdaf1513a698d4d6a0971524c71507947578cf4c068d079edc6ec`
в `2026-10-25T12:30:34Z`. Временный `extra_hosts` из infra PR `75` не решил
доступ к Telegram: `getMe` с валидным токеном через `149.154.167.220` с auxiliary
VPS завершался timeout, тогда как локально возвращал `200`. Прежний no-token
`404` оказался ложноположительной проверкой и не подтверждает рабочий Bot API.

Контроллер повторно применил роль из main: `extra_hosts=[]`, PR `75` закрыт
(`CLOSED`); в этой проверке контейнер был healthy, sender `false`.
Тогда требовался прокси с удалённым выходом, как в частном
`TP-Prepare/vk-monitoring`; реальная отправка ещё не была проверена.

Последний проверенный Restic snapshot после подготовки ID `1–65` имеет префикс
`f25294…`, время `2026-10-25T12:40:03Z`; изолированное восстановление для этой
границы прошло. Snapshot после подготовки ID `67` здесь не подтверждён.
После подготовки ID `1–67` live-очередь на тот момент содержала `71` delivery,
`67 prepared`, ID `68–71` pending, outbox `0`, sender `false`. Новые строки
требовали отдельного аудита перед включением worker.

### Telegram proxy и следующая граница shadow-очереди — 2026-10-25

[`.github` PR #31](https://github.com/Cringe-Driven-Development-Team/.github/pull/31)
добавил явный proxy только для Telegram API;
[infra PR #77](https://github.com/Cringe-Driven-Development-Team/infra/pull/77)
развернул Xray sidecar на auxiliary VPS. Используется вторая рабочая VLESS Reality
ссылка владельца, сохранённая в Ansible Vault; исходную ссылку можно подставить
позже через тот же Vault и повторное применение роли. На этапе PR #77 образ
сервиса был закреплён digest
`sha256:4424881b11af1f32a690831d5c9b87351852b4767e182e28f8703e68a90d7622`;
текущий digest после PR #79 приведён ниже.
До и после повторной выкладки из `main` Telegram `getMe` через sidecar вернул
`200`; настоящий вызов `sendMessage` нового сервиса отправил только отмеченное
тестовое сообщение `7437` в тему Apidog `6033`. Другие события новый sender не
отправлял: `WEBHOOK_ALERTS_SEND_ENABLED=false`. Последующий
[infra run 40198443651](https://github.com/Cringe-Driven-Development-Team/infra/actions/runs/40198443651)
завершился успешно, включая `auxiliary.yml` и `verify.yml`; `/health` и контейнер
`hooks` healthy, `telegram-proxy` running.

Для границы SQLite ID `68–86` read-only сверка и независимое ревью подтвердили
`11 already sent`, `8 intentionally silent`, `0 unresolved`: карточки старого бота
сверены по событию, объекту, времени и Actions; для push совпали SHA. Перед
изменением очереди снят SQLite snapshot и выполнен Restic backup
(`2026-10-25T13:45:44Z`, `Result=success`, `ExecMainStatus=0`). При sender `false`,
пустых outbox/review_groups и совпадающих GUID выполнен `Store.prepare(id, [])`
только для ID `68–86`. Повторный snapshot и Restic backup
(`2026-10-25T13:46:29Z`) завершились успешно. Итог: `86` доставок, `86 prepared`,
outbox `0`, `integrity_check=ok`, Apidog `0`. Новые ID `>86` на этом этапе ещё
требовали отдельной сверки перед переключением.

После включения владельцем CLI-доступа к обычной sprint-ветке временный endpoint
`45845223` создан и обновлён только в `webhook-alerts-smoke-20261025`; `main`
Apidog не менялась. Настоящий POST достиг сервиса, но старая версия ответила
`401`: заголовок `X-Apidog-Signature` содержал корректный base64 HMAC-SHA1,
тогда как старая версия принимала только `sha1=hex`. Реальный payload имеет поля
`event`, `title`, `content`, `appLink` без устойчивого ID. На момент отказа
`2026-10-25` исправление и тесты в `c49429c` ещё ожидали выкладки;
в очереди Apidog было `0`, старый Actions sender оставался активным, worker
был выключен. Результат исправленной версии и переключения приведён ниже.

Следующая граница GitHub shadow-очереди ID `87–102` также сверена независимо:
`10 already sent`, `6 intentionally silent`, `0 unresolved`. После snapshot и
Restic backup (`2026-10-25T14:15:40Z`, success) выполнен `Store.prepare(id, [])`
только для этих 16 строк при совпадающих GUID, sender `false`, пустых
outbox/review_groups и отсутствии leases. Второй snapshot/backup в
`14:16:01Z` успешен. На момент проверки: `110` доставок, `102 prepared`,
outbox `0`, `integrity_check=ok`, Apidog `0`; ID `103+` на тот момент ещё не
были сверены.

### Исправленный образ и переключение — 2026-10-25 UTC

[`.github` PR #32](https://github.com/Cringe-Driven-Development-Team/.github/pull/32)
влит как `722ee9db38957a160b3bd1f2a5f92b0e3c576bcc`: приёмник проверяет
наблюдавшийся base64 HMAC-SHA1 по исходному телу Apidog, а форматтер использует
`event`, `title`, `content`, `appLink`. Тесты сервиса: `158 pass`, typecheck
успешен. [Image workflow 40201716631](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40201716631) опубликовал digest
`sha256:8ca5549293a571ae2de60c638bc9cd9a67f59aa158df1d2f8b0d2ce5ddbe6901`;
анонимная проверка manifest с auxiliary VPS прошла. [Infra PR #79](https://github.com/Cringe-Driven-Development-Team/infra/pull/79)
закрепил этот digest; [post-merge run 40202494750](https://github.com/Cringe-Driven-Development-Team/infra/actions/runs/40202494750)
завершился успешно. Контейнер `hooks` работал с новым образом и `sender=false`.
Настоящее изменение endpoint `45845223` в отдельной sprint-ветке Apidog
создало delivery `130` (`API_UPDATED`); неверная подпись на живой версии
получила `401` без записи в очередь.

Границы GitHub SQLite ID `103–128`, `129` и `131–132` сверены с Actions и
фактическими сообщениями прежнего бота; ID `130` относится к Apidog.
Для `103–128`: `13 already sent`, `13 intentionally silent`, `0 unresolved`;
для `129`: `already sent` как Telegram `7506`; для `131–132`: push ветки
infra PR #80 отправлен старым ботом как `7507`, открытый draft PR намеренно
пропущен. Независимые ревью подтвердили фиксированные границы. Каждый набор
подготовлен через `Store.prepare(id, [])` только при `sender=false`, совпадении
GUID, пустых outbox/review_groups и отсутствии leases. Снимки SQLite и Restic
до и после подготовки успешны: последние post-change backup в `14:39:40Z`,
`14:42:06Z`, `14:48:46Z`. Итого `131` GitHub shadow-доставка закрыта без
повторной отправки; тестовая Apidog delivery `130` оставлена ожидающей.

Restic snapshot `8be495bf9a8ad826bb13b5016559bfb17eee9f86ca2ebed1042f0c41588ef892`
от `14:39:40Z` восстановлен в отдельный каталог и проверен без сети на текущем
образе: `integrity_check=ok`, `130` deliveries, GitHub `129` (из них `128`
prepared), Apidog `1` pending, outbox/review_groups `0`. Повтор GitHub GUID и
Apidog body hash в пятиминутном окне дали `duplicate`, число строк осталось
`130`. На второй одноразовой копии mock worker отправил только Apidog ID `130`
один раз, сохранил `sent` и не отправил её при следующем запуске. Живая очередь
и Telegram этим тестом не менялись; временный restore-каталог удалён.

На auxiliary команда восстановления завершилась с кодом `0`:

```sh
sudo bash -c 'set -a; . /etc/restic/env; restic restore 8be495bf9a8ad826bb13b5016559bfb17eee9f86ca2ebed1042f0c41588ef892 --host auxiliary --target /var/tmp/hooks-restore-task10.FLzi3s --include /var/lib/docker/volumes/hooks_hooks_data/_data/snapshots/queue.sqlite'
```

Проверка запускала закреплённый image через `docker run --network none` с
read-only mount каталога snapshot и `WEBHOOK_ALERTS_SEND_ENABLED=false`.
`PRAGMA integrity_check`, подсчёт строк и повторные `Store.accept` выполнялись
на отдельной `/tmp`-копии восстановленного файла; проверка worker — на второй
копии с mock Telegram. Это не запускало worker против рабочей БД.

[Infra PR #80](https://github.com/Cringe-Driven-Development-Team/infra/pull/80)
изменил в Vault только `WEBHOOK_ALERTS_SEND_ENABLED: 'false' → 'true'` и влит как
`7437fc7e886b25960ed564caf4690a3c79807492`. Сначала organization variable
`TELEGRAM_EVENTS_SOURCE=webhook` стала видна ровно четырём callers:
`.github`, `backend`, `frontend`, `infra`. На `ready_for_review` PR #80
[старый `notify` был skipped](https://github.com/Cringe-Driven-Development-Team/infra/actions/runs/40204308664),
а webhook ответил `202` и сохранил GitHub ID `133`. На merge старый `notify`
также skipped; webhook сохранил ID `136`. [Post-merge run 40204385397](https://github.com/Cringe-Driven-Development-Team/infra/actions/runs/40204385397)
успешен, включая `auxiliary.yml` и `verify.yml`; после пересоздания `hooks`
фактический env показал `sender=true`, контейнер healthy. Worker отправил
Apidog ID `130` → Telegram `7508` (тема `6033`), GitHub ID `133` → `7509`
и ID `136` → `7510` (тема `26`). Для bot comments и push main/удаления ветки
карточек нет по действующим фильтрам; очередь без pending.

После переключения новое изменение того же временного endpoint Apidog стало
delivery `139`, подготовлено и отправлено один раз как Telegram `7511` в тему
`6033`. Тестовый [issue_comment в .github#20](https://github.com/Cringe-Driven-Development-Team/.github/issues/20#issuecomment-6399231793)
совпал с концом infra-выкладки: исходная GitHub delivery GUID
`ff6fbf10-d084-11f1-94f3-973750d5f14b` получила `502` и не попала в SQLite;
[старый Actions `notify` был skipped](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40204989634).
Ручная redelivery после успешного infra run получила `202`: одна SQLite delivery
ID `140`, одна outbox `sent`, Telegram `7512` в тему `26`. Следующая redelivery
того же GUID получила `200`, не создала второй delivery/outbox и сообщение.
Отдельный ручной [reminders run 40205201295](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40205201295)
успешен; `board / close` в automation run PR #80 также завершился успешно.
Проверка отправки в тему Code Review `1513` и очистка временной ветки Apidog
описаны ниже.

### Контролируемый откат и восстановление — 2026-10-25 UTC

Перед репетицией в `15:05:52Z` сделан Restic backup: worker работал, pending
было `0`, outbox содержал `5 sent`. В отдельном временном infra worktree
значение `WEBHOOK_ALERTS_SEND_ENABLED` в Vault изменено с `true` на `false`
без изменения других расшифрованных байтов; `auxiliary.yml` завершился с
`ok=51 changed=3 failed=0`, после пересоздания фактический sender был `false`.
Лишь затем organisation variable `TELEGRAM_EVENTS_SOURCE` удалена, вернув
старый Actions sender.

Первый тестовый [comment в .github#20](https://github.com/Cringe-Driven-Development-Team/.github/issues/20#issuecomment-6399338372)
обработал [Actions run 40205766363](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40205766363):
`notify=success`, фактическое Telegram сообщение `7513` в теме `26`. Webhook
сохранил тот же event GUID `5d4f4ff0-d086-11f1-80cd-1e069080d0ca` как
SQLite ID `141`, но выключенный worker ничего не отправил. После Restic backup
`15:12:22Z` точные GUID, URL, источник, lease и pending сверены; только ID
`141` закрыт через `Store.prepare(141, [])`. Outbox для неё остался пустым.
Повторный Restic backup в `15:12:54Z` успешен.

Organization variable возвращена как `webhook` с видимостью только для
`.github`, `backend`, `frontend`, `infra`. Второй тестовый
[comment в .github#20](https://github.com/Cringe-Driven-Development-Team/.github/issues/20#issuecomment-6399357256)
создал SQLite ID `142`; [Actions run 40205907818](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40205907818)
подтвердил `notify=skipped`. При выключенном worker ID `142` оставалась
pending; сделан Restic backup `15:13:47Z`. После возврата сохранённого
зашифрованного Vault `true` без изменений других значений второй прогон
`auxiliary.yml` завершился с `ok=51 changed=3 failed=0`. Живой sender стал
`true`, worker отправил ID `142` через outbox ID `6` ровно один раз: Telegram
`7514` в теме `26`, `attempts=1`. В `15:20:08Z` сделан финальный Restic backup;
SQLite `integrity_check=ok`, все `142` delivery подготовлены, pending `0`,
outbox `6 sent`, контейнер `hooks` healthy и proxy running. Временный infra
worktree после возврата Vault чистый; ни одна версия с отключённым worker не
коммитилась.

### Доска и событийный workflow после отката — 2026-10-25 UTC

Тестовая [.github issue #33](https://github.com/Cringe-Driven-Development-Team/.github/issues/33)
открыта после восстановления worker. В
[automation run 40206555327](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40206555327)
`board / add-to-project` завершился успешно, issue получила project item в
Scrumban/Backlog; старый `telegram / notify` был skipped. Webhook сохранил
GitHub delivery ID `143`, worker отправил Telegram `7515` в тему `26`.
После закрытия issue с причиной completed project item оказался в Scrumban/Done.
[Automation run 40206601013](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40206601013)
снова пропустил старый `notify`; новый worker отправил событие закрытия
SQLite ID `144` как Telegram `7516` в тему `26`. Отдельный workflow напоминаний
ранее завершился успешно в run `40205201295`.

### Очистка тестовых данных Apidog — 2026-10-25 UTC

Временный endpoint `45845223` находился только в sprint-ветке
`webhook-alerts-smoke-20261025` (`1413097`). После проверки `API_UPDATED`
он удалён через Apidog CLI; настоящая `API_DELETED` была принята как SQLite
delivery `145`, worker отправил Telegram `7517` в тему `6033` с `attempts=1`.
Sprint-ветка архивирована и удалена. Три тестовые AI-ветки `1412939`,
`1413089` и `1413158`, ранее архивированные, также удалены. Связанный с
`1413089` MR `39835` закрыт без слияния; `apidog branch list --type all`
не содержит веток `webhook-alerts`. Main Apidog за весь тест не менялась.
Владелец решил оставить **Allow AI to modify sprint branch content through CLI or MCP**
включённым для студенческих агентов. Проверенные значения разрешений:
`main=false`, `sprint=true`, `general=false`, `ai=true`. Изменений main/general
через CLI/MCP этот выбор не разрешает; дополнительных действий в UI нет.

### Отправка в тему Code Review — 2026-10-25 UTC

Подписанный синтетический GitHub payload с действием
`pull_request.review_requested` и явной пометкой `[ТЕСТ]` в заголовке отправлен
на рабочий localhost-маршрут сервиса; настоящий участник команды не назначался
ревьювером. Сервис ответил `202`, сохранил GUID
`2a72bd9b-ad7a-44ab-9adf-0610fe3af483` как SQLite delivery `147`,
подготовил outbox `11` и отправил Telegram `7519` в тему `1513` с
`status=sent`, `attempts=1`. Повтор тех же подписанных байтов и GUID получил
`200`: в SQLite остались ровно одна delivery и одна outbox-строка, повторного
сообщения не было. На момент проверки pending `0`, `integrity_check=ok`.
Тест подтверждает живую маршрутизацию и отправку, но не является настоящей
доставкой GitHub после пользовательского ревью.

Для включённого sender обязательны `APIDOG_PROJECT_ID` (положительный числовой
ID проекта), `APIDOG_TARGET_BRANCH_ID` (ID main), `APIDOG_PROJECT_NAME` (точное
имя проекта), `APIDOG_CONTRACT_URL` (публичный HTTP/HTTPS URL контракта),
`APIDOG_ACCESS_TOKEN` (токен чтения MR и sprint-веток), `APIDOG_TELEGRAM_USER_MAP`
и `APIDOG_MR_REVIEWERS`. Последняя настройка — JSON-массив ровно из двух объектов
с непустым `name` и разными положительными десятичными строками `telegramId`
(до 20 цифр, без ведущих нулей). Пример с синтетическими IDs:

```json
[{"name":"Reviewer One","telegramId":"333"},{"name":"Reviewer Two","telegramId":"444"}]
```

Храните `APIDOG_MR_REVIEWERS` в `vault_hooks_env`. При каждом `MR_OPENED`
после создателя появляется строка «Ревьюверы» в порядке настройки, независимо
от `reviewerIds` Apidog. Совпадение с создателем не вызывает повторный пинг.
В `MR_CLOSED` и `MR_MERGED` эта строка не добавляется.


Карта — JSON-объект: ключ — числовой Apidog user ID, значение — объект с
непустым `name` и строковым числовым `telegramId`. Токен и карту храните в
`vault_hooks_env`; Telegram IDs берите из проверенной карты организации,
дополняйте при появлении участников и обновляйте при смене IDs. Не публикуйте
реальные значения в репозитории или логах. Пустая карта `{}` допустима:
неизвестные участники отображаются без пинга. Карточка MR содержит кнопки
«Открыть MR» и «Контракт API»; данные MR берутся из полного снимка API.

### Завершение охвата GitHub callers — 2026-10-31 UTC

В `17:36:11.152Z` worker уже включён и healthy, `integrity_check=ok`:
853 prepared deliveries (GitHub 785, Apidog 68), 378 `sent` outbox;
unprepared, остальные статусы outbox и незавершённые review groups — `0`.
Образ до и после:
`ghcr.io/cringe-driven-development-team/webhook-alerts@sha256:09fd5908e8c90e246a1aaa61a773499cb44ced4b57bc4beeed5829b1448dd8db`.
Worker не останавливался; очередь не редактировалась, старые сообщения не
воспроизводились и не удалялись.

Исходный API-снимок `17:31:03.930267Z`: organization variable
`TELEGRAM_EVENTS_SOURCE=webhook`, `visibility=selected`, repositories `.github`
(1375675360), `backend` (1393814417), `frontend` (1393814114), `infra` (1374133166).
Добавлены только четыре ID штатными additive `PUT`, каждый ответил HTTP `204`:

| Repository | ID | Интервал PUT UTC |
| --- | --- | --- |
| docs | 1369785278 | 17:36:55.199614–17:37:03.836882 |
| frontend-packages | 1403014726 | 17:37:03.836882–17:37:55; точные времена запроса не сохранены после сбоя контрольного GET |
| figma | 1375950508 | 17:39:13.829228–17:39:18.899289 |
| static | 1374136555 | 17:39:34.595716–17:39:39.341154 |

После сбоя GET повторное чтение подтвердило `frontend-packages` в selected;
его PUT не повторялся. Итоговый снимок `17:42:30.095458Z`: ровно восемь
перечисленных callers, прежние четыре сохранены, value/visibility неизменны,
repository/environment overrides отсутствуют во всех девяти репозиториях.
Org hook `702764072` остался active, JSON, HTTPS/SSL verification, события
`push`, `issues`, `issue_comment`, `pull_request`, `pull_request_review`.

На границе выполняющихся automation runs четырёх callers не было; перед
добавлением проверено повторно. Последние завершённые `notify`: docs job
`124603715717` — `2026-10-31T17:17:54Z`, frontend-packages `124544506712` —
`2026-10-31T13:02:20Z`, figma `121898921152` — `2026-10-26T22:56:13Z`, static
`120879983698` — `2026-10-24T13:04:35Z`. Ничего не отменялось. Известный дубль
docs PR #113 подтверждён: GUID `c2619620-d53e-11f1-9aeb-5eefc9b4b647`,
delivery `846` / outbox `374` / worker message `8501`; Actions run
`41214480655`, job `124576022152` вернул Telegram `result.message_id=8502`,
topic `26`. Вложенный `reply_to_message.message_id=26` не является второй отправкой.

В каждом caller создана временная ветка от актуального main и отправлен один
пустой коммит; tree до/после совпадает, main не менялся. Все четыре контрольных
org deliveries получили HTTP `202`; `telegram / notify=skipped`, одна prepared
delivery и ровно один `sent` outbox, topic `26`, attempts `1`:

| Repository | GUID | Actions run / notify job | SQLite delivery / outbox | Telegram message |
| --- | --- | --- | --- | --- |
| docs | `1e5643d2-d552-11f1-8494-b5889a271c19` | [41225640915](https://github.com/Cringe-Driven-Development-Team/docs/actions/runs/41225640915) / `124609100410` | 855 / 379 | 8510 |
| frontend-packages | `35706a34-d552-11f1-9757-5a24a8a0c5cc` | [41225693887](https://github.com/Cringe-Driven-Development-Team/frontend-packages/actions/runs/41225693887) / `124609252325` | 857 / 380 | 8511 |
| figma | `4009c4fe-d552-11f1-8ec1-5ab1b636aa85` | [41225717491](https://github.com/Cringe-Driven-Development-Team/figma/actions/runs/41225717491) / `124609322446` | 859 / 381 | 8512 |
| static | `49269ecc-d552-11f1-99c8-68c6f7ed2f17` | [41225737723](https://github.com/Cringe-Driven-Development-Team/static/actions/runs/41225737723) / `124609403831` | 861 / 382 | 8513 |

| Repository | Временная ветка | Parent SHA → after SHA |
| --- | --- | --- |
| docs | `webhook-cutover-20261031-docs-173954` | `ad48546d5278240e6b09be10903f0a8fa8ab96d9` → `641ea7e6dfebc52b3addbede3c9df2f68b167f61` |
| frontend-packages | `webhook-cutover-20261031-frontend-packages-174016` | `fa65157b5f6957fbf30fa2ebd4b3b75af19cc955` → `a789adfe2e538cff271396376a6853003dda86d6` |
| figma | `webhook-cutover-20261031-figma-174053` | `30e87b67a4cab77c84dd9f0405f6320a207d3f18` → `b0b5699e70d5b6fb3a6db418f2d76035d9e4b3a6` |
| static | `webhook-cutover-20261031-static-174112` | `a0cea30d81d00f2e7d915b7fa0c92a25851b4e87` → `1784b7c7a3a08e8d18f7dcf9be437db50efcb98c` |

После завершения всех Actions уникальность проверена повторно, затем ветки
удалены только после точного совпадения имени/head SHA. Создание и удаление
каждой ветки сверены отдельно: HTTP `202`, prepared, без outbox.

| Repository | Создание: GUID / SQLite ID | Удаление: GUID / SQLite ID | Отсутствие ветки проверено UTC |
| --- | --- | --- | --- |
| docs | `1aed8048-d552-11f1-9361-efe224413147` / 854 | `66e46746-d552-11f1-902b-1e1e985550a4` / 862 | 17:42:12.180850 |
| frontend-packages | `32991dd8-d552-11f1-9f3d-6da1511cdb02` / 856 | `6923a616-d552-11f1-9573-4bd933706750` / 863 | 17:42:16.009559 |
| figma | `3d707b02-d552-11f1-9a54-e32e4b4c1957` / 858 | `6b7535d8-d552-11f1-9bba-cd2d7222dc87` / 864 | 17:42:19.840124 |
| static | `475a5336-d552-11f1-836d-8386cdcb65ed` / 860 | `6df9a37a-d552-11f1-8bb3-b449d36b1802` / 865 | 17:42:23.950825 |

Финальная readonly-проверка `17:42:54.612Z`: worker=true, health ok, integrity ok,
865 prepared deliveries (GitHub 797, Apidog 68), 382 `sent`; unprepared,
unsent и незавершённые review groups — `0`. После очистки все четыре
контрольных события по-прежнему имеют ровно один outbox и тот же message ID.
Main SHA и blob SHA всех workflow во всех девяти репозиториях совпали до/после;
board/close/reminders/course-sync/release/deploy и Apidog не менялись.
Deploy/release вручную не запускались.

Проверки: `bun test tests/webhook-workflows.test.ts` — 15 pass;
`bash tests/telegram.sh` — 134 ok; `bash tests/reminders.sh` — 121 ok;
`bash tests/close.sh` — 22 ok; `bash tests/lint.sh` — lint ok.
Исторические дубли остались в чате. При потере ответа Telegram абсолютная
exactly-once доставка не гарантируется; проверены четыре контрольных события.
