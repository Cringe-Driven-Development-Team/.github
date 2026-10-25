# Webhook alerts: текущий runbook

Сервис принимает `POST /webhooks/github` и `POST /webhooks/apidog`, проверяет
подпись по исходным байтам и подтверждает запрос после транзакционной записи
SQLite. При `WEBHOOK_ALERTS_SEND_ENABLED=false` (по умолчанию) worker не запускается:
приём и `/health` работают без Telegram, payload остаётся для последующей обработки.

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
| `TELEGRAM_APIDOG_TOPIC_ID` | Обязателен при отправке, положительный ID темы Apidog |
| `TELEGRAM_TOPIC_ID`, `TELEGRAM_REVIEW_TOPIC_ID` | По умолчанию `26` и `1513` |
| `TELEGRAM_USER_MAP` | Необязательный JSON GitHub login → Telegram user ID |
| `GITHUB_API_TOKEN` | Необязательный read-only токен дополнений GitHub |
| `DATABASE_PATH`, `PORT` | По умолчанию `/data/queue.sqlite`, `8080` |

При неверной конфигурации процесс завершается с именем переменной без её значения.
При отправке работает единый projector GitHub/Apidog с сохранением группировки ревью.
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

## Apidog: приём и незавершённая live-проверка

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

**Live-приёмка исправления ожидает redeploy и повторной доставки.** Старая версия
ответила 401 на base64-подпись; это наблюдение ещё не подтверждает успешный приём
исправленной версией. Контроллер должен повторить событие, проверить дедупликацию
и доставку в изолированный чат. Отправитель остаётся выключенным до live-приёмки.
Raw JSON сохраняется целиком, без вывода тела и ключей в лог.

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

Эти действия выполняются в Task 10 после infra Task 9. До них обязательны
подписанные live-доставки обоих источников, тестовый чат, snapshot → Restic →
изолированное restore и репетиция отката. Пока любая проверка pending, оставить
`WEBHOOK_ALERTS_SEND_ENABLED=false` и старую отправку включённой.

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

Инфраструктурная приёмка выполнена в Task 9 (подробности ниже), без сообщений
в Telegram. Настоящий GitHub intake проверен ниже; Apidog и переключение ещё
не приняты. Для каждого пункта ниже
вписать UTC-время, SHA/digest, идентификаторы доставок/строк, команды и результат
без ключей, подписей и полного payload. Pending нельзя считать проверкой.

| Проверка | Фактический результат |
| --- | --- |
| Публикация SHA в GHCR, pull с VPS | SHA `08e7968fa0d39dd5f25fe8495c58d78006a26653`, digest `sha256:30718ed06926bff66627502361185c2ca6ebca78b20b044ce4d8bba92f12e858`; anonymous pull с VPS успешен |
| Infra sub-issue #20 и API-проверка связи | infra#70 подтверждена через sub_issues API, закрыта после merge PR #73 |
| GitHub signed delivery, health, duplicate | Task 9: health 200; синтетические GitHub/Apidog: неверная подпись 401, первая доставка 202, повтор 200; конфликт GitHub ID 409. Task 10: настоящий ping/push 202, redelivery push 200; по одной строке на GUID |
| Apidog live header, fixture и тестовый чат | Pending — Task 10 |
| Snapshot → Restic → isolated restore, integrity, pending/sent, dedupe | Task 9: синтетические pending/sent проверены. Task 10: после сверки ID 1–58 финальный snapshot восстановлен без сети, integrity ok, duplicate rejected, pending/due нет; подробности ниже |
| Репетиция отката и отсутствие двойной отправки | Pending — до переключения Task 10 |
| Граница Actions/worker, GitHub/Apidog в боевых темах | Pending — Task 10 |
| Board, close, reminders после переключения и отката | Pending — Task 10 |

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
Sender остаётся `false`: эти результаты подтверждают intake, отправка worker ещё pending.
Пограничный push `adba7d2a-d004-11f1-8fad-583c490826f7` (`1e7de41`, ветка
`automation-20-webhooks-ghcr-fix`) классифицирован как `already sent` старым sender:
[Actions run 40143875584](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40143875584)
успешен, в теме `26` подтверждено сообщение `7370` от `2026-10-24T23:43:20Z`.
Эта доставка включена в завершённую сверку ID `1–67` ниже и не должна
воспроизводиться worker при переключении.
Прежний отказ чтения org hooks/variable из-за scope устранён контроллером;
прежнее состояние variable здесь не утверждается.
Контроллер read-only подтвердил существующие темы: Apidog `6033`, GitHub `26`,
Code Review `1513` в чате `-1003713420351`; отправка worker не проверялась.
Владелец настраивает Apidog target вручную: MCP не предоставляет Notifications.
Для Apidog остаются нужны настоящая доставка,
подтверждение signature header (в Vault provisional `X-Apidog-Signature`) и
обезличенная fixture. #20 пока не закрывать.

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
нет pending/due обработок. Sender остаётся `false`. Новые доставки после ID `67`
потребуют отдельной сверки перед включением worker. Настоящая отправка нового
сервиса в Telegram, Apidog и репетиция rollback по-прежнему pending.

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
10 исходных endpoints, smoke endpoint отсутствует. Поведение уведомлений для
изменений dev-ветки ещё исследуется; успешной доставки эта попытка не подтверждает.
Header, настоящая fixture и отправка Apidog по-прежнему pending.

Дополнительная проверка `BRANCH_CREATED` также не подтвердила HTTP-доставку:
временное правило `43506` удалено (в списке снова только `43505`). Пустая
стандартная sprint-ветка `webhook-alerts-smoke-20261025` (`1413097`) остаётся
активной: CLI archive по имени/ID завершился ошибкой, delete требует archive.
Это отдельная ветка, её очистка остаётся владельцу/контроллеру.

Перед проверкой маршрута Telegram создан Restic pre-route snapshot
`8728497eda7fdaf1513a698d4d6a0971524c71507947578cf4c068d079edc6ec`
в `2026-10-25T12:30:34Z`. Временный `extra_hosts` из infra PR `75` не решил
доступ к Telegram: `getMe` с валидным токеном через `149.154.167.220` с auxiliary
VPS завершался timeout, тогда как локально возвращал `200`. Прежний no-token
`404` оказался ложноположительной проверкой и не подтверждает рабочий Bot API.

Контроллер повторно применил роль из main: `extra_hosts=[]`, PR `75` закрыт
(`CLOSED`), контейнер healthy, sender `false`. Нужен прокси с удалённым выходом,
как в частном `TP-Prepare/vk-monitoring`; реальная отправка по-прежнему pending.

Последний проверенный Restic snapshot после подготовки ID `1–65` имеет префикс
`f25294…`, время `2026-10-25T12:40:03Z`; изолированное восстановление для этой
границы прошло. Snapshot после подготовки ID `67` здесь не подтверждён.
После подготовки ID `1–67` live-очередь содержит `71` delivery, `67 prepared`,
ID `68–71` pending, outbox `0`, sender `false`. Эти новые строки требуют
отдельного аудита перед включением worker.

### Telegram proxy и следующая граница shadow-очереди — 2026-10-25

[`.github` PR #31](https://github.com/Cringe-Driven-Development-Team/.github/pull/31)
добавил явный proxy только для Telegram API;
[infra PR #77](https://github.com/Cringe-Driven-Development-Team/infra/pull/77)
развернул Xray sidecar на auxiliary VPS. Используется вторая рабочая VLESS Reality
ссылка владельца, сохранённая в Ansible Vault; исходную ссылку можно подставить
позже через тот же Vault и повторное применение роли. Образ сервиса закреплён
digest `sha256:4424881b11af1f32a690831d5c9b87351852b4767e182e28f8703e68a90d7622`.
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
outbox `0`, `integrity_check=ok`, Apidog `0`. Новые ID `>86` нужно сверить отдельно
перед переключением.

Ни одного подлинного Apidog HTTP webhook пока не получено. Подпись, имя header и
реальный формат payload ещё не подтверждены; организация по-прежнему использует
старый Actions sender. Не включать worker и не задавать
`TELEGRAM_EVENTS_SOURCE=webhook` до live-проверки Apidog и репетиции отката.
