# Webhook alerts: текущий runbook

Сервис принимает `POST /webhooks/github`, проверяет
подпись по исходным байтам и подтверждает запрос после транзакционной записи
SQLite. При `WEBHOOK_ALERTS_SEND_ENABLED=false` (по умолчанию) worker не запускается:
приём и `/health` работают без Telegram, payload остаётся для последующей обработки.

Новая очередь создаётся на схеме v8. Базы v6 и v7 обновляются до v8 перед
запуском worker. Миграция сохраняет доставки GitHub, группы ревью, релизные
карточки и их связи.

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
| `WEBHOOK_ALERTS_SEND_ENABLED` | `false` или `true`, по умолчанию `false` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Обязательны при отправке; chat ID — целое число |
| `TELEGRAM_TOPIC_ID`, `TELEGRAM_REVIEW_TOPIC_ID` | По умолчанию `26` и `1513` |
| `TELEGRAM_USER_MAP` | Необязательный JSON GitHub login → Telegram user ID |
| `GITHUB_API_TOKEN` | Необязательный read-only токен дополнений GitHub |
| `DATABASE_PATH`, `PORT` | По умолчанию `/data/queue.sqlite`, `8080` |

При неверной конфигурации процесс завершается с именем переменной без её значения.
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
- Secret совпадает с `GITHUB_WEBHOOK_SECRET`;
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
тестовая БД не становится боевой очередью. Живые доставки GitHub, права токенов,
доступность образа и восстановление фиксируются в журнале ниже.

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

Для восстановления подходят снимки с `user_version` 6, 7 или 8. Проверка
готового файла из каталога `services/webhook-alerts`:

```sh
restore_dir=$(mktemp -d)
cp /path/to/restored/snapshots/queue.sqlite "$restore_dir/queue.sqlite"
bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.argv[1], { readonly: true });
  try {
    console.log(db.query("PRAGMA integrity_check").all());
    console.log(db.query("SELECT id, source, delivery_id, body_hash FROM deliveries ORDER BY id").all());
    console.log(db.query("SELECT id, origin_id, status, telegram_message_id FROM outbox ORDER BY id").all());
  } finally { db.close(); }
' "$restore_dir/queue.sqlite"
bun -e '
  import { Database } from "bun:sqlite";
  import { openStore } from "./src/store";
  const path = process.argv[1];
  const db = new Database(path, { readonly: true });
  let row;
  try { row = db.query("SELECT delivery_id, event, raw FROM deliveries WHERE source = ? LIMIT 1").get("github"); }
  finally { db.close(); }
  if (!row) throw new Error("restored snapshot needs a stable-ID delivery for duplicate check");
  const store = openStore(path);
  try {
    if (store.accept({ source: "github", deliveryId: row.delivery_id, event: row.event, raw: row.raw }) !== "duplicate") throw new Error("restored delivery was not deduplicated");
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
ID и повторную доставку GitHub, затем проверяет `/health` и отсутствие
сетевых вызовов при отключённой отправке. Живое восстановление из Restic на VPS выполнено в Task 9 с синтетическими
строками и выключенным sender; результат и ограничения записаны в журнале ниже.

## Переключение без двойной отправки

Этот порядок нужен при первом переключении и при повторном включении после
отката; фактические результаты Task 10 записаны ниже. Перед новым переходом
проверить подписанные live-доставки GitHub, snapshot → Restic →
изолированное restore и границу прежней отправки. Пока сверка очереди не
завершена, оставить `WEBHOOK_ALERTS_SEND_ENABLED=false`.

1. Сохранить в журнале UTC-время начала, SHA/digest образа, прежнее значение и
   visibility `TELEGRAM_EVENTS_SOURCE`, ID hook, GitHub delivery GUID, Actions
   run/job URLs и Telegram message IDs. Список подключённых callers проверить
   по репозиториям, включая локальные overrides variable.
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
   старым sender, остаются unprepared для worker.
   Не применять этот рецепт к очереди, где worker уже работал: подготовленные
   outbox/группы требуют сверки каждого сообщения, не только delivery.
5. Повторно проверить пограничные доставки, пришедшие во время сверки. Сохранить
   журнал соответствий и новый snapshot. Через Ansible Vault выставить
   `WEBHOOK_ALERTS_SEND_ENABLED=true`, применить роль `hooks` и пересоздать сервис
   с обновлённым `.env`. Изменение env-файла без пересоздания недостаточно.
6. Создать новое событие GitHub. Проверить ожидаемое число карточек в темах
   GitHub `26` и Code Review `1513` для соответствующих событий и записи
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

Для GitHub в organization hook → Recent Deliveries открыть нужную доставку и
нажать Redeliver после устранения ошибки. GitHub не повторяет неудачные webhook
автоматически; GUID redelivery сохраняется, правила — в
[GitHub best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
Уже сохранённый GUID вернёт `200`, он не сбрасывает `prepared` и `sent`.
`409` требует разбирательства с отличающимся телом, не удаления dedupe-ключа.

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

Исторический раздел описывает состояние сервиса на момент проверок в октябре 2026 года.

Инфраструктурная приёмка Task 9 выполнена без сообщений в Telegram. Результаты
Task 10 ниже фиксируют фактические доставки, переключение и оставшиеся проверки.
Указаны UTC-время, SHA/digest, идентификаторы доставок/строк и результат без
ключей, подписей и полного payload. Pending нельзя считать проверкой.

| Проверка | Фактический результат |
| --- | --- |
| Публикация SHA в GHCR, pull с VPS | Первый образ: SHA `08e7968fa0d39dd5f25fe8495c58d78006a26653`, digest `sha256:30718ed06926bff66627502361185c2ca6ebca78b20b044ce4d8bba92f12e858`. Текущий образ: `.github/main` `722ee9db38957a160b3bd1f2a5f92b0e3c576bcc`, digest `sha256:8ca5549293a571ae2de60c638bc9cd9a67f59aa158df1d2f8b0d2ce5ddbe6901`; anonymous pull с auxiliary VPS успешен |
| Infra sub-issue #20 и API-проверка связи | infra#70 подтверждена через sub_issues API, закрыта после merge PR #73 |
| GitHub signed delivery, health, duplicate | Task 9: health 200; синтетические GitHub: неверная подпись 401, первая доставка 202, повтор 200; конфликт GitHub ID 409. Task 10: настоящий ping/push 202, redelivery push 200; issue_comment GUID `ff6fbf10-d084-11f1-94f3-973750d5f14b` после исходного 502 принят при повторе 202, следующий повтор 200, в SQLite одна delivery `140` и одна отправка `7512` |
| Snapshot → Restic → isolated restore, integrity, pending/sent, dedupe | Task 9: синтетические pending/sent проверены. Task 10: snapshot `8be495bf…` от `2026-10-25T14:39:40Z` восстановлен без сети: integrity ok, 130 deliveries, pending `129/130`, стабильный GitHub GUID распознан как duplicate |
| Репетиция отката и отсутствие двойной отправки | В `2026-10-25T15:05–15:20Z` новый worker остановлен через временный Vault override и Ansible, затем восстановлен. При выключенном worker старый Actions отправил тестовый comment как `7513` в тему `26`; его SQLite ID `141` закрыт с нулём сообщений после сверки и Restic. После возврата org variable старый `notify` skipped, новый worker отправил следующий comment ID `142` ровно один раз как `7514`. Финал: sender=true, pending=0, integrity ok, Restic `15:20:08Z` |
| Граница Actions/worker, GitHub в боевых темах | Org variable `TELEGRAM_EVENTS_SOURCE=webhook` видна только `.github`, `backend`, `frontend`, `infra`; старый `notify` skipped. Новый worker отправил GitHub `133/136` как `7509/7510` в тему `26`; очередь обработана без дублей |
| Code Review в теме `1513` | Подписанный синтетический `pull_request.review_requested` отправлен на живой localhost-маршрут: HTTP `202`, SQLite delivery `147`, outbox `11 sent`, Telegram `7519` в теме `1513`; повтор того же GUID — `200` без дубля. Это проверка боевого маршрута/отправки, а не настоящего GitHub review от участника |
| Board, close, reminders после переключения и отката | [Тестовая .github issue #33](https://github.com/Cringe-Driven-Development-Team/.github/issues/33) открыта: [run 40206555327](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40206555327) выполнил `board / add-to-project`, карточка появилась в Scrumban/Backlog. После закрытия issue как completed карточка в Scrumban/Done; GitHub ID `143/144` дали Telegram `7515/7516` в теме `26`, старый `notify` skipped. `board / close` в [infra run 40204386040](https://github.com/Cringe-Driven-Development-Team/infra/actions/runs/40204386040) и ручной [reminders run 40205201295](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40205201295) также успешны |

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
Указанные исторические снимки использовались для проверки восстановления в октябре 2026 года.

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
Контроллер read-only подтвердил темы GitHub `26` и Code Review `1513`
в чате `-1003713420351`. #20 закрывается только после финальной приёмки.

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
после ID `67` требовали отдельной сверки. Отправка нового сервиса в Telegram
и rollback на этом этапе ещё не проверялись.

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
`200`. На этом этапе `WEBHOOK_ALERTS_SEND_ENABLED=false`. Последующий
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
outbox `0`, `integrity_check=ok`. Новые ID `>86` на этом этапе ещё
требовали отдельной сверки перед переключением.

Следующая граница GitHub shadow-очереди ID `87–102` также сверена независимо:
`10 already sent`, `6 intentionally silent`, `0 unresolved`. После snapshot и
Restic backup (`2026-10-25T14:15:40Z`, success) выполнен `Store.prepare(id, [])`
только для этих 16 строк при совпадающих GUID, sender `false`, пустых
outbox/review_groups и отсутствии leases. Второй snapshot/backup в
`14:16:01Z` успешен. На момент проверки: `110` доставок, `102 prepared`,
outbox `0`, `integrity_check=ok`; ID `103+` на тот момент ещё не
были сверены.

### Исправленный образ и переключение — 2026-10-25 UTC

[`.github` PR #32](https://github.com/Cringe-Driven-Development-Team/.github/pull/32)
влит как `722ee9db38957a160b3bd1f2a5f92b0e3c576bcc`. Тесты сервиса
`158 pass`, typecheck успешен. [Image workflow 40201716631](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40201716631) опубликовал digest
`sha256:8ca5549293a571ae2de60c638bc9cd9a67f59aa158df1d2f8b0d2ce5ddbe6901`;
анонимная проверка manifest с auxiliary VPS прошла. [Infra PR #79](https://github.com/Cringe-Driven-Development-Team/infra/pull/79)
закрепил этот digest; [post-merge run 40202494750](https://github.com/Cringe-Driven-Development-Team/infra/actions/runs/40202494750)
завершился успешно. Контейнер `hooks` работал с новым образом и `sender=false`.

Границы GitHub SQLite ID `103–128`, `129` и `131–132` сверены с Actions и
фактическими сообщениями прежнего бота.
Для `103–128`: `13 already sent`, `13 intentionally silent`, `0 unresolved`;
для `129`: `already sent` как Telegram `7506`; для `131–132`: push ветки
infra PR #80 отправлен старым ботом как `7507`, открытый draft PR намеренно
пропущен. Независимые ревью подтвердили фиксированные границы. Каждый набор
подготовлен через `Store.prepare(id, [])` только при `sender=false`, совпадении
GUID, пустых outbox/review_groups и отсутствии leases. Снимки SQLite и Restic
до и после подготовки успешны: последние post-change backup в `14:39:40Z`,
`14:42:06Z`, `14:48:46Z`. Итого `131` GitHub shadow-доставка закрыта без
повторной отправки.

Restic snapshot `8be495bf9a8ad826bb13b5016559bfb17eee9f86ca2ebed1042f0c41588ef892`
от `14:39:40Z` восстановлен в отдельный каталог и проверен без сети на текущем
образе. SQLite вернула `integrity_check=ok`. Из `129` доставок GitHub `128`
были подготовлены. Повтор GitHub GUID вернул `duplicate`. Живая очередь
и Telegram этим тестом не менялись, временный restore-каталог удалён.

На auxiliary команда восстановления завершилась с кодом `0`:

```sh
sudo bash -c 'set -a; . /etc/restic/env; restic restore 8be495bf9a8ad826bb13b5016559bfb17eee9f86ca2ebed1042f0c41588ef892 --host auxiliary --target /var/tmp/hooks-restore-task10.FLzi3s --include /var/lib/docker/volumes/hooks_hooks_data/_data/snapshots/queue.sqlite'
```

Проверка запускала закреплённый image через `docker run --network none` с
read-only mount каталога snapshot и `WEBHOOK_ALERTS_SEND_ENABLED=false`.
`PRAGMA integrity_check`, подсчёт строк и повторные `Store.accept` выполнялись
на отдельной `/tmp`-копии восстановленного файла.

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
GitHub ID `133` → `7509` и ID `136` → `7510` в тему `26`. Для bot comments,
push в main и удаления ветки действующие фильтры пропустили отправку.

Тестовый [issue_comment в .github#20](https://github.com/Cringe-Driven-Development-Team/.github/issues/20#issuecomment-6399231793)
совпал с концом infra-выкладки: исходная GitHub delivery GUID
`ff6fbf10-d084-11f1-94f3-973750d5f14b` получила `502` и не попала в SQLite;
[старый Actions `notify` был skipped](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40204989634).
Ручная redelivery после успешного infra run получила `202`: одна SQLite delivery
ID `140`, одна outbox `sent`, Telegram `7512` в тему `26`. Следующая redelivery
того же GUID получила `200`, не создала второй delivery/outbox и сообщение.
Отдельный ручной [reminders run 40205201295](https://github.com/Cringe-Driven-Development-Team/.github/actions/runs/40205201295)
успешен; `board / close` в automation run PR #80 также завершился успешно.
Проверка отправки в тему Code Review `1513` описана ниже.

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

### Завершение охвата GitHub callers — 2026-10-31 UTC

В `17:36:11.152Z` worker уже включён и healthy, `integrity_check=ok`:
785 подготовленных доставок GitHub, 378 `sent` outbox;
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
797 подготовленных доставок GitHub, 382 `sent`; unprepared,
unsent и незавершённые review groups — `0`. После очистки все четыре
контрольных события по-прежнему имеют ровно один outbox и тот же message ID.
Main SHA и blob SHA всех workflow во всех девяти репозиториях совпали до/после;
board/close/reminders/course-sync/release/deploy не менялись.
Deploy/release вручную не запускались.

Проверки: `bun test tests/webhook-workflows.test.ts` — 15 pass;
`bash tests/telegram.sh` — 134 ok; `bash tests/reminders.sh` — 121 ok;
`bash tests/close.sh` — 22 ok; `bash tests/lint.sh` — lint ok.
Исторические дубли остались в чате. При потере ответа Telegram абсолютная
exactly-once доставка не гарантируется; проверены четыре контрольных события.

## Выпуски frontend через GitHub webhook

Новый потребитель ограничен `Cringe-Driven-Development-Team/frontend/main`.
`pull_request.enqueued/dequeued` формируют сообщения о текущей merge queue;
`release.published` — о готовности выпуска; `deployment_status` окружения
`production` — о начале и результате выкатки/отката. `workflow_job.completed`
покрывает ошибку до записи операции; результат и fallback имеют один ключ попытки.
Каталог `release-artifacts` в штатном пути не читается; его `deployment_status`
игнорируются без запросов к API.
`dequeued` с причиной MERGE не создаёт тревогу. Board остаётся в Actions.

Сообщение «PR поставлен в очередь» содержит связанные задачи из
`closingIssuesReferences` этого PR со ссылками; если задач нет — название PR.
При длинном списке выводится «Состав изменений показан не полностью».
Кнопка «Открыть PR» и упоминание поставившего PR в очередь сохраняются.
Сбой чтения задач повторяет подготовку сообщения, а не превращается в пустой список.
Проверка очереди перед отправкой не загружает задачи повторно.

Подготовка и проверки перед отправкой идут независимо для обычных событий,
очереди и операций. Медленное чтение истории выпусков не занимает очередь отправки
Telegram; сами HTTP-отправки остаются последовательными. Актуальность merge queue
проверяется в своей очереди отправки непосредственно перед HTTP-запросом.
После подтверждённого 429 разрешён повтор; неизвестный результат остаётся ручным.
Ready сохраняет дедупликацию по SHA и дополнительный ключ попытки операции,
общий с job fallback. Успешная публикация заменяет ещё не отправленный fallback;
уже начатая HTTP-доставка автоматически не повторяется и не переписывается.

Упоминания используют `TELEGRAM_USER_MAP` (GitHub login → числовой Telegram ID).
Карта организации в GitHub Actions не передаётся контейнеру автоматически:
её проверенное значение нужно хранить в `vault_hooks_env.TELEGRAM_USER_MAP`
и применять ролью hooks. Для проверки сравнивают Vault, `/opt/hooks/.env` и
окружение контейнера без вывода значений. Неизвестный аккаунт остаётся обычным
экранированным ником; очередь упоминает enqueuer, результат выкатки — run.actor.

Для включения нужны `TELEGRAM_RELEASES_TOPIC_ID` и читающий `GITHUB_API_TOKEN`,
действующие GitHub-бот, чат и proxy сохраняются. В SQLite первоначально нет
release-activation, поэтому новый sender выключен независимо от обычных алертов.
После подготовки producer и остановки прежних отправок оператор запускает в
контейнере `bun run src/cli.ts release-activate <UTC-ISO>` с фактической UTC-границей.
Она сохраняется и повторно не изменяется. Подписка org hook дополнительно включает
`deployment_status`, `workflow_job` и Releases (`release`), остальные события сохраняются.

Готовность проверяется по конкретному Actions run и `notification.run_attempt`;
завершения всего workflow ждать не нужно. Payload producer содержит
`notification.base_sha`, `notification.report_url`, `notification.run_attempt`.
Результаты выкатки показывают короткую версию, задачи, Health Check и инициатора;
при сбое остаются этап и сведения о состоянии прода. Полный SHA отдельной строкой,
digest BFF и пояснение к левой версии в результатах выкатки не выводятся.
Полный отчёт остаётся в Summary CI/CD. Сервис проверяет SHA/digest/source и читает
только PR/задачи конкретного диапазона, без Project API.

Подготовка обычных алертов, очереди и операций идёт независимо, отправитель один.
Перед enqueue/retry проверяются актуальная main-ветка и ID entry. Устаревшие
queue/start/ready пропускаются. Telegram timeout/5xx или сбой записи после принятия
оставляет release-сообщение с `release_uncertain`, без автоматического повтора;
429 допускает retry. Обычные сообщения GitHub сохраняют прежнюю политику.

При пропуске события оператор сверяет Telegram и исходный run/delivery, затем
может адресно вызвать `release-recover <raw-delivery-id>`. Это разрешает только
выбранную delivery до границы; верификация источника, актуальность и semantic
дедупликация сохраняются. Для uncertain после ручной проверки доступен прежний
`retry <outbox-id>`; он не создаёт нового source event. Не сбрасывайте всю очередь.
Перед переключением и ручными исправлениями используйте существующий snapshot.

## Backend / Releases (.github#59)

Backend использует тот же worker и outbox, отдельный топик
`TELEGRAM_BACKEND_RELEASES_TOPIC_ID` (ожидаемый ID `3377`; перед применением
сверьте существующий Backend / Releases). `TELEGRAM_RELEASES_TOPIC_ID` и
сохранённая frontend activation не меняются. Значение backend topic и существующий
`GITHUB_API_TOKEN` передаются через `vault_hooks_env`: роль hooks уже передаёт весь
словарь в `/opt/hooks/.env` и контейнер. Новый GHCR token для sender не нужен.

Разрешён только `Cringe-Driven-Development-Team/backend`, `production`,
`task/payload.action=deploy|rollback`, полный совпадающий `ref/sha`, образ
`ghcr.io/cringe-driven-development-team/backend@sha256:<64 hex>`.
`payload.run` указывает на текущую операцию; `notification` содержит положительный
`run_attempt`, `base_sha` (полный SHA или null), `report_url=<run>#summary`.
Публикация backend не создаёт frontend `release-artifacts`, поля assets не нужны.
Источник каждого результата проверяется повторным чтением GitHub API:

- deploy: `.github/workflows/ci.yml`, `push/main`, job **`deploy / deploy`**
  (reusable `.github/workflows/cd.yml` в исходном CI run);
- rollback: `.github/workflows/rollback.yml`, `workflow_dispatch/main`, job
  **`rollback / deploy`** согласно целевому контракту backend#42. Имя необходимо
  подтвердить Jobs API первого разрешённого запуска; пробный rollback для этого
  не выполняется. SHA цели может отличаться от head SHA workflow; digest/SHA
  подтверждаются прежним успешным production Deployment.

Карточки начала/результата строятся по `deployment_status`. При ошибке/отмене
production job до итогового status используется `workflow_job.completed`.
`lint/test/docker/course-sync` не считаются выкаткой. Общий semantic key
`result:<repository>:<action>:<run_id>:<run_attempt>` не смешивает reruns.
Терминальный результат заменяет ещё не отправленный fallback. После начала
доставки/неопределённого ответа Telegram автоматической повторной отправки нет.

Карточка оформлена по образцу фронта: результат выкатки/отката, сайт, короткая строка
«Версия: до → после», до трёх задач, Health Check и Telegram-упоминание инициатора.
Для одной записи заголовок «Задача», для нескольких — «Задачи»;
при откате — «Отменённая задача» или «Отменённые задачи» соответственно.
Упоминание строится из существующей `TELEGRAM_USER_MAP` (GitHub login → Telegram
user ID), как у фронта; без записи в карте остаётся экранированный GitHub login.
Слева в строке версий — последний подтверждённый выпуск из GitHub; справа — выпуск,
подтверждённый переключением или Health Check. При неподтверждённом результате
справа показывается «неизвестна». В карточке начала операции строка версий отсутствует.
Полные SHA, GHCR image ref и digest доступны в Actions Summary по кнопке «Полный отчёт».
Кнопки идут в порядке: сайт/rollback, PR, полный отчёт/изменения, логи.
При сбое дополнительно показывается этап и известный результат операции.
Проверки источника и версий выполняются перед отправкой.
История Deployments не доказывает состояние VPS сейчас.
`Switch backend` подтверждает переключение на соответствующем этапе;
`Health check` успешен только после всех обязательных проверок infra#69:
образ и контейнер, внутренний Go с gateway, внешний отрицательный login через
BFF, закрытость публичных Go-маршрутов. Sender читает эти шаги, не запускает probes.
Без результата проверки состояние неизвестно; fallback без подробных свидетельств
не придумывает target или отрицательный результат. Успешный Health check и поздний
сбой Summary/cleanup отделяются от результата выкатки. Это не подтверждение
успешной пользовательской сессии, Redis или runtime-VPS.

До трёх изменений со ссылками показываются в карточке; полный отчёт — Summary
текущей попытки, логи — URL конкретного attempt. При rollback это **снимаемые**
изменения. Недоступное GitHub enrichment помечается как неполные данные и не
блокирует основной результат. «↩️ Откатить» открывает backend Rollback workflow,
не содержит старую цель и не выполняет переключение через Telegram.

### Подготовка и включение backend sender

1. Подготовьте producer backend#42 и infra#69; удалите прямой backend Telegram
   sender до включения нового. Backend-events старого формата не восстанавливаются.
2. Дайте **существующему** service `GITHUB_API_TOKEN` read-доступ к backend:
   Actions runs/jobs/attempts, Contents/compare, Deployments/statuses, Issues,
   Pull requests и Metadata. Сохраните frontend-доступ; write sender не нужен.
   Секрет редактируется через Vault, без вывода в shell/логи.
3. Сохраните backend topic в `vault_hooks_env`, соберите/опубликуйте image после
   review и укажите полученный **реальный digest** через существующий hooks path
   infra. Не подставляйте synthetic digest из tests и не сбрасывайте SQLite.
4. В обновлённом контейнере выполните `bun run src/cli.ts backend-release-check`.
   Это read-only проверка topic-конфигурации и GitHub endpoints, без Telegram API.
   Она не доказывает принадлежность topic чату, доставку org webhook и возможность
   отправки Telegram. Если rollback.yml ещё нет на main, preflight ожидаемо не готов.
   Отдельно проверьте org hook: backend охвачен, `deployment_status` и
   `workflow_job` включены; сохраните остальные subscriptions.
5. После готовности producer запустите
   `bun run src/cli.ts backend-release-activate <UTC-ISO>` с фактической UTC-границей.
   Это отдельная неизменяемая activation. Frontend `release-activate` повторять
   и менять не нужно. События backend до границы автоматически не отправляются.
6. На штатной выкатке проверьте digest → Deployment → webhook → одну итоговую
   карточку в Backend / Releases, кнопки/отсутствие link preview/старого сообщения.
   В эксплуатационном отчёте запишите run/attempt, Deployment и delivery/outbox ID.
   До этой проверки задача не считается полностью принятой.

### Диагностика и локальная проверка

Результат операции смотрите в backend Actions/Deployments/Summary. Доставку —
в SQLite outbox и worker logs: `releaseKey`, repository, run/attempt, outbox/origin
ID, result/errorCode. Deployment ID есть в `release_notices.metadata_json`;
`origin_id` связывает outbox с raw delivery. Telegram failure не меняет Deployment
и не обязан появляться в Actions. Подтверждённый 429 повторяется по штатной политике;
`release_uncertain` требует ручной сверки чата перед `retry <outbox-id>`.
Не сбрасывайте очередь/activation ради одного сообщения. Адресный `release-recover`
сохраняет source verification и дедупликацию; legacy backend payload всё равно
отклоняется.

Контрактные fixtures находятся в `tests/fixtures/github/backend-release-contract.json`;
они предназначены для совместного использования producer backend#42. Пока producer
не реализован, совпадение обеих сторон и реальная интеграция не заявляются.
Локальные tests используют fake GitHub/Telegram и настоящую временную SQLite:

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
```

PR до готовности producer/config/общей приёмки пишет
`Part of https://github.com/Cringe-Driven-Development-Team/.github/issues/59`;
после полной приёмки сервисный PR может закрыть #59. Небольшой infra PR пишет
`Part of` на #59. Родитель backend#42 закрывается после sub-issues и интеграции.

### Каталог GitHub Releases (frontend#176)

Готовность выпуска — только опубликованный GitHub Release `release-<40 hex>` в
`Cringe-Driven-Development-Team/frontend`. Событие `release` с action `published`
попадает в lane `release-operation` и не задерживает очередь PR и обычные алерты.
JSON из webhook и Markdown-описание Release доказательством не считаются: сервис
перечитывает Release через API и проверяет:

- `draft=false`, `prerelease=false`, `immutable=true`, автор `github-actions[bot]`,
  `html_url` ожидаемого репозитория; фактический commit тега (`/git/ref/tags`,
  для annotated — `/git/tags`) равен SHA из имени тега;
- ровно четыре asset `frontend-dist.tar.gz`, `bff-image.tar.gz`, `release.json`,
  `SHA256SUMS` в состоянии `uploaded`, размер больше 0 и меньше 2 GiB, `digest` GitHub;
- скачиваются только `release.json` и `SHA256SUMS` (до 64 KiB): redirect на
  `*.githubusercontent.com` идёт без токена; байты сверяются с digest GitHub,
  SHA256SUMS — с digest трёх остальных файлов. Архивы не скачиваются;
- manifest: `sha`, `image_ref` только `ghcr.io/cringe-driven-development-team/bff@sha256:…`,
  `image_id` = `sha256:<64 hex>`, `assets=releases/<sha>/`; `ci_run`/`ci_run_attempt`
  — push/main CI этого SHA; `publication_run`/`notification.run_attempt` —
  push/main CI этого SHA (штатно) или разовый `release-import.yml`
  (`workflow_dispatch` из main); `notification.report_url` — только
  `<publication_run>#summary` или `null`.

Нарушение любого пункта — тихий отказ (`untrusted_*`), сбой API — повтор подготовки.
Опубликованный immutable Release позже не меняется, поэтому неполный выпуск
диагностируется по его странице и логам `Publish release`, а не повтором доставки.

Ready-карточка: состав PR/задач по `notification.base_sha`, тег для обязательного
input `release` ручного CD, digest BFF, ссылка на CI публикации, инициатор, кнопки
«Выкатить» (открывает `cd.yml`, ничего не запускает) и «Релиз и файлы».
Ключи: ready — по SHA, результат — `repo + publish + publication_run + attempt`.
Fallback `workflow_job.completed` для `Publish release` ищет Release по SHA и
засчитывает его, только если `publication_run`/`notification.run_attempt`
совпадают с попыткой job. Draft attempt 1 и публикация attempt 2 дают разные ключи;
поздний сбой board после publish ошибкой выпуска не становится.

Production: `deployment_status` проверяется только при `payload.release_id`;
Release перечитывается и сверяется SHA/`image_ref` с deployment. SHA workflow CD
может отличаться от target SHA. Старые production без `release_id` остаются
историческими SHA/digest для проверки ready и не требуют Release.

Переход. Frontend разово импортирует два подтверждённых выпуска через
`release-import.yml` до переключения consumer. Импортированные Releases
доступны для проверки выкатки/отката, но ready не создают. После выкладки нового
образа оператор фиксирует границу нового контракта:

```sh
docker exec hooks bun run src/cli.ts release-contract <UTC-ISO>
```

До записи границы `release.published` ready не рассылает. Releases с
`published_at` раньше границы пропускаются; граница неизменяема, дедупликация
и outbox не очищаются. Пропущенное событие после проверки восстанавливается
адресно: `release-recover <delivery-id>`. Подписку org hook: Settings → Webhooks →
hook `hooks.cellestial.ru` → Individual events → добавить Releases, остальные
отметки сохранить; затем проверить Recent Deliveries `release` → 202.

## Infra / Alerts

Выставьте `TELEGRAM_INFRA_ALERTS_TOPIC_ID=14389` для `webhook-alerts` и проверьте,
что существующий `GITHUB_API_TOKEN` читает Actions (runs, attempts, jobs),
Deployments и их статусы в `Cringe-Driven-Development-Team/infra`, а также PR,
связанные с коммитами в `infra` и `.github`. Проверяйте HTTP-ответы без вывода
токена. Подписанный org webhook должен охватывать `infra` и доставлять
`deployment_status` и `workflow_job` в `/webhooks/github`.

После обновления контейнера и переключения workflow на события GitHub запишите
фактическую UTC-границу приёма.

```sh
infra_cutover_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sudo docker compose -f /opt/hooks/compose.yml exec -T hooks \
  bun run src/cli.ts infra-release-activate "$infra_cutover_utc"
```

Граница Infra неизменяема и отдельна от Frontend и Backend. До активации Infra
сохраняет доставки в SQLite. После активации старт и завершение до указанного
времени пропускаются, включая их запоздалую повторную доставку.
Пустая или отсутствующая тема приостанавливает подготовку и отправку карточек Infra.
При восстановлении темы обработка продолжится с той же границей и сохранёнными
записями SQLite. Остальные уведомления продолжают отправляться во время паузы.

Старт подтверждает `in_progress` явного Deployment с `task: infra-alerts` в
`production`. Результат подтверждает завершение production job конкретной
попытки `infra.yml` или `auxiliary-deploy.yml` из `main`. Если доставка результата
опередила старт, сервис восстанавливает старт по статусу этой попытки после
границы и ставит его в очередь первым. Результат ждёт отправки или окончательного
сбоя карточки старта той же попытки, в том числе после ответа Telegram 429.
Ключи двух карточек привязаны к `run_id` и `run_attempt` в `release_notices`.
Для VPS3 карточка выкатки использует SHA исходников образа, а карточка инициализации
— SHA infra. Обе фазы показывают кнопку PR при одном подтверждённом совпадении
по SHA. При известном исходе `verify.yml` выводится Health Check.

На штатных выкатках Infra и VPS3 проверьте обе карточки в теме `14389`, ссылки на
логи нужных попыток и записи outbox. Для диагностики сверяйте `run_id`,
`run_attempt`, Deployment и идентификаторы delivery/outbox. Действуют обычные
`release-recover <delivery-id>` и `retry <outbox-id>` после сверки Telegram.
