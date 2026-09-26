# Смена спринта — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В первый день спринта (понедельник, 10:00 МСК) бот переносит незакрытые задачи прошлого спринта в текущий на доске Scrumban и пишет в Telegram итоги, перенесённые задачи с пингами исполнителей и план нового спринта.

**Architecture:** Новый скрипт `scripts/sprint.sh` (bash + jq + `gh api graphql`) читает поле-итерацию `Sprint` и задачи доски одним пагинированным GraphQL-запросом, сам по датам (Москва) находит прошлую и текущую итерацию, переносит хвосты мутацией `updateProjectV2ItemFieldValue` и шлёт одно сообщение. Скрипт — отдельный шаг утреннего запуска `.github/workflows/reminders.yml`; `scripts/reminders.sh` не меняется.

**Tech Stack:** bash, jq, GNU date, `gh` CLI (GraphQL), GitHub Actions, Telegram Bot API; тесты — bash-харнесс `tests/lib.sh` с заглушками `gh` и `curl`.

**Spec:** `docs/superpowers/specs/2026-09-26-sprint-alerts-design.md` — читать целиком, это источник требований; план ниже говорит, как.

## Global Constraints

- Доска: владелец `Cringe-Driven-Development-Team`, номер `1`, поле `Sprint`, статус «сделано» — `Done`; порядок хвостов: `In review`, `In progress`, `Ready`, `Backlog`, без статуса.
- «Сегодня» — `TZ=Europe/Moscow date +%F`; для тестов env `TODAY=YYYY-MM-DD`.
- Итерация занимает дни `startDate … startDate + duration − 1`; текущая и прошлая считаются по датам из `iterations` + `completedIterations`, не по признаку GitHub.
- Сделано: `Status = Done` или `Issue.state = CLOSED` или `PullRequest.state ∈ {CLOSED, MERGED}`. Архивные и `content: null` не считаются и не переносятся.
- Токен доски — env `PAT` (`secrets.ADD_TO_PROJECT_PAT`); пустой — `::warning::ADD_TO_PROJECT_PAT недоступен — смена спринта не проверена`, код 0. Все `gh` скрипта — с `GH_TOKEN="$PAT"`.
- Сообщение — в `TOPIC` (общий топик, `vars.TELEGRAM_TOPIC_ID`), `parse_mode=HTML`, кнопка «Открыть доску» → `project.url`; в списке хвостов до 20 строк, дальше `…и ещё N`; всё GitHub-содержимое экранируется (`&`, `<`, `>`).
- Пинг исполнителя: `<a href="tg://user?id=ID">логин</a>` по `MAP` (JSON `{"логин":"id"}`), нет в карте — текстом; пинг владельца при «нет текущего спринта» — `OPS_PING=YarikMix`.
- Сторона: `frontend-park-mail-ru/*` → `frontend`, `go-park-mail-ru/*` → `backend`, иначе имя репозитория — как в `telegram.yml` и `reminders.sh`.
- Доска не прочиталась — `::error::`, код 1, сообщений нет. Сбой одной мутации — `::warning::`, остальные переносятся, в строке задачи `⚠️ не перенесена`.
- `jq.exe` под Windows отдаёт CRLF: всё, что читается из `jq` и `gh`, чистится от `\r`.
- В тестах только ненастоящие ID: чат `-100`, топик `26`, карта `{"YarikMix":"111","blackHATred":"222"}`.
- Стиль — как в `scripts/reminders.sh`: `set -euo pipefail`, короткие русские комментарии «зачем», функции `plural`, `side`, `send` — по его образцу (копировать, не импортировать).
- Коммиты: `<тип>: <что сделано>` по-русски со строчной буквы; последней строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Не вставлять код через `python - <<'EOF'` в Git Bash (съедает `\\` и `\n`) — только Write/Edit.
- Клон — `/f/Github/2026_H2/.github`, ветка `feature/sprint-alerts`. Тесты медленные на Windows: таймаут 600000 мс.

## Review Focus

- Спринт с задачами больше 100 — пагинация (`gh api graphql --paginate` склеивает страницы; итерации повторяются в каждой — брать из первой) (Task 1: фикстура из двух страниц).
- Задача с двумя исполнителями — в строке хвоста оба, в плане считается у каждого (Task 1).
- Запуск в воскресенье (последний день спринта) — тишина, ничего не переносится (Task 1).
- Итерация длиннее недели (`duration` 14) — границы по `duration`, не по 7 (Task 1).
- Заголовок задачи с `<`, `&` и логин с `-` — экранирование и пинг не ломают HTML (Task 1).

## Карта файлов

| Файл | Что |
|---|---|
| `scripts/sprint.sh` (новый) | вся логика смены спринта |
| `tests/sprint.sh` (новый) | тесты; заглушка `gh` (запрос → фикстура, мутация → журнал), общая `tests/stub-curl.sh` |
| `.github/workflows/reminders.yml` | вход `sprint`, шаг «Смена спринта» перед напоминаниями, `if` у обоих шагов |
| `tests/lint.sh` | ничего (уже проверяет `scripts/*.sh` и `tests/*.sh`) |
| `README.md` | строка в таблице файлов, раздел «Смена спринта» |

---

### Task 1: `scripts/sprint.sh` и его тесты

**Files:**
- Create: `scripts/sprint.sh`
- Create: `tests/sprint.sh`

**Interfaces:**
- Consumes: `tests/lib.sh` (`when`, `sent`, `sent_to`, `only`, `silent`, `error`, `before`, `pass`, `fail`, `summary`; `when` сбрасывает `$TMP/sent` и `$TMP/calls`; `DEFAULTS` — массив env), `tests/stub-curl.sh` (сохраняет сообщение как `topic=…`, `markup=…`, текст).
- Produces: `scripts/sprint.sh` с env `PAT`, `TOKEN`, `CHAT`, `TOPIC`, `MAP`, необязательный `TODAY`; код 0 — всё хорошо или нечего делать, код 1 — не прочиталась доска или Telegram отклонил сообщение. Task 2 вызывает `bash scripts/sprint.sh` из шага workflow.

**Как устроено (реализовать так):**

1. Проверки: пустой `PAT` → warning и `exit 0`; пустые `TOKEN`/`CHAT` → `::error::` как в `reminders.sh`.
2. Чтение — один запрос с пагинацией:

```bash
QUERY='query($endCursor: String) { organization(login: "Cringe-Driven-Development-Team") { projectV2(number: 1) {
  id url
  field(name: "Sprint") { ... on ProjectV2IterationField { id configuration {
    iterations { id title startDate duration } completedIterations { id title startDate duration } } } }
  items(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes {
    id isArchived
    content { __typename
      ... on Issue { number title url state repository { nameWithOwner } assignees(first: 10) { nodes { login } } }
      ... on PullRequest { number title url state repository { nameWithOwner } assignees(first: 10) { nodes { login } } }
      ... on DraftIssue { title assignees(first: 10) { nodes { login } } } }
    sprint: fieldValueByName(name: "Sprint") { ... on ProjectV2ItemFieldIterationValue { iterationId } }
    status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }'
PAGES=$(GH_TOKEN="$PAT" gh api graphql --paginate -f query="$QUERY") || { echo "::error::Не прочитал доску"; exit 1; }
```

`--paginate` печатает JSON-документы страниц подряд: `jq -s` → массив; проект/поле/итерации — из первой страницы, `items.nodes` — из всех. Нет `field.id` → `::error::`, код 1.

3. Итерации → даты: для каждой `end = startDate + duration − 1` (GNU `date -d "$start + $((d-1)) days" +%F`). Сравнение дат `YYYY-MM-DD` — строками. Текущая: `start ≤ TODAY ≤ end`; прошлая: максимум по `end` среди `end < TODAY`.
4. Решение — строго по разделу спеки «Решение» (нет прошлой → выход; хвосты прошлой; нет текущей → предупреждение, если есть хвосты; первый день текущей или есть хвосты → перенос + сообщение; иначе выход).
5. Перенос — по одной мутации на хвост:

```bash
MUTATION='mutation($project: ID!, $item: ID!, $field: ID!, $iteration: String!) {
  updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {iterationId: $iteration}}) { projectV2Item { id } } }'
GH_TOKEN="$PAT" gh api graphql -f query="$MUTATION" -f project="$PROJECT_ID" -f item="$ITEM" -f field="$FIELD_ID" -f iteration="$CUR_ID" >/dev/null
```

Сбой → `::warning::Не перенёс <сторона> #N` и отметка у этой задачи.
6. Сообщение — формат из спеки, раздел «Сообщение», буква в букву (заголовки `🏁 <title> закрыт · ДД.ММ–ДД.ММ`, `сделано X из Y`, `перенесено в <title> — N:` / `всё сделано 🎉`, строки хвостов, пустая строка, `🚀 <title> · ДД.ММ–ДД.ММ`, `N задач: логин K · … · без исполнителя K`; склонение «задача/задачи/задач» через `plural`). Список хвостов и план удобно собрать одним `jq` по образцу `DEFS`/`digest` в `reminders.sh` (там есть `esc`, `who`, `side`, `block`).
7. Предупреждение без текущей итерации: `<b>⚠️ <title> закончился</b>, а следующего спринта на доске нет: N <задача/задачи/задач> не перенесены · <пинг OPS_PING>` и кнопка на доску.

**Тесты (`tests/sprint.sh`)** — по образцу `tests/reminders.sh`: `SCRIPT="$ROOT/scripts/sprint.sh"`, `source tests/lib.sh`, своя заглушка `gh` в `$TMP/bin/gh`:
- `api graphql … query=mutation…` → записать `item iteration` в `$TMP/moves`; `itemId` из env `MOVE_FAIL` (через пробел) → `exit 1`;
- иначе (чтение): `GH_FAIL` → `exit 1`; иначе `cat "$FIXTURE"` (одна или несколько JSON-страниц подряд).

Хелперы фикстуры (формат выбрать самому, главное — читаемые тесты): итерация `<id> <title> <start> [duration=7]`; задача `<id> <sprint-id|-> <status|-> <вид issue|pr|draft|null> <state> <repo> <номер> <заголовок> [логины…]`, флаг архива. `DEFAULTS`: `TOKEN=test-token CHAT=-100 TOPIC=26 MAP='{"YarikMix":"111","blackHATred":"222"}' PAT=test-pat TODAY=2026-09-28 GH_FAIL= MOVE_FAIL=` и путь фикстуры. Итерации фикстуры по умолчанию: Sprint 1 (`2026-09-14`), Sprint 2 (`2026-09-21`), Sprint 3 (`2026-09-28`), Sprint 4 (`2026-10-05`).

Случаи — список из спеки «Тесты» плюс Review Focus, каждый своим `when`:
1. 28.09, в Sprint 2 — 2 сделанных и 3 хвоста (In review, Backlog, In progress, разные исполнители), в Sprint 3 — 1 задача: мутации ровно для 3 хвостов на id Sprint 3; сообщение в `26`: `🏁 Sprint 2 закрыт · 21.09–27.09`, `сделано 2 из 5`, `перенесено в Sprint 3 — 3:`, пинги по карте, порядок In review → In progress → Backlog (`before`), `🚀 Sprint 3 · 28.09–04.10`, `4 задачи:`, кнопка `"text":"Открыть доску"`; `only 1`.
2. 28.09, хвостов нет: `всё сделано 🎉`, мутаций нет.
3. Закрытая задача в статусе In progress и смерженный PR в Ready — сделаны: не в списке, не переносятся, входят в «сделано».
4. Архивная и `content: null` в Sprint 2 — не в «из Y», не переносятся.
5. Черновик-хвост: строка `черновик · <заголовок>` без ссылки, мутация есть.
6. 29.09, хвосты есть: перенос и сообщение.
7. 29.09, хвостов нет: `silent`, журнал мутаций пуст.
8. 27.09 (воскресенье, последний день Sprint 2): `silent`, мутаций нет.
9. Нет текущей (итерации только Sprint 1 и 2, `TODAY=2026-09-28`), хвосты есть: `⚠️ Sprint 2 закончился` с пингом `tg://user?id=111`, мутаций нет.
10. Нет прошлой (`TODAY=2026-09-14`): `silent`.
11. `MOVE_FAIL` у одного хвоста: остальные в журнале, у него `⚠️ не перенесена`, `::warning::` в выводе, код 0.
12. 22 хвоста: 20 строк `• ` в блоке хвостов и `…и ещё 2`.
13. `PAT=`: `silent`, `::warning::ADD_TO_PROJECT_PAT недоступен`.
14. `GH_FAIL=1`: `error "Не прочитал доску"`.
15. Заголовок `Фикс <b> & ко`, логин не из карты — `Фикс &lt;b&gt; &amp; ко`, логин текстом.
16. Две страницы (Review Focus): задачи Sprint 2 разнесены по двум JSON-страницам — все учтены.
17. Два исполнителя у хвоста: оба пинга в строке, в плане у каждого +1.
18. `duration` 14 (Review Focus): Sprint 2 `2026-09-14`…`2026-09-27` при `TODAY=2026-09-21` — `silent` (середина спринта).

- [ ] **Step 1:** Написать `tests/sprint.sh` (заглушка, хелперы, все 18 случаев) и пустой исполняемый `scripts/sprint.sh` с `set -euo pipefail` и `exit 0`.
- [ ] **Step 2:** `bash tests/sprint.sh | tail -1` — ожидаемо много `fail` (все случаи, кроме тишины); записать число в отчёт как RED.
- [ ] **Step 3:** Реализовать `scripts/sprint.sh` по разделу «Как устроено» и спеке.
- [ ] **Step 4:** `bash tests/sprint.sh | tail -1` → `итого: N ok, 0 fail`; `bash tests/lint.sh` → `lint ok` (shellcheck проверит оба новых файла).
- [ ] **Step 5:** Commit.

```bash
git add scripts/sprint.sh tests/sprint.sh
git commit -F - <<'EOF'
feat: перенос хвостов и сообщение о смене спринта

В первый день спринта незакрытые задачи прошлого спринта переносятся в текущий,
в чат уходят итоги, перенесённые задачи с пингами исполнителей и план.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: шаг в `reminders.yml` и README

**Files:**
- Modify: `.github/workflows/reminders.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `scripts/sprint.sh` (Task 1) — env `PAT`, `TOKEN`, `CHAT`, `TOPIC`, `MAP`.
- Produces: вход `workflow_dispatch` `sprint` (boolean, по умолчанию `false`), шаг «Смена спринта».

- [ ] **Step 1: workflow.** В `reminders.yml`:
  - в `workflow_dispatch.inputs` добавить
    ```yaml
          sprint:
            description: Проверить смену спринта (перенос хвостов и сообщение), как в утреннем запуске
            type: boolean
            default: false
    ```
  - после `actions/checkout@v4`, перед шагом напоминаний, — шаг:
    ```yaml
          - name: Смена спринта
            if: ${{ !cancelled() && (github.event.schedule == '0 7 * * *' || inputs.sprint) }}
            env:
              PAT:   ${{ secrets.ADD_TO_PROJECT_PAT }}
              TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
              CHAT:  ${{ vars.TELEGRAM_CHAT_ID }}
              TOPIC: ${{ vars.TELEGRAM_TOPIC_ID }}
              MAP:   ${{ vars.TELEGRAM_USER_MAP }}
            run: bash scripts/sprint.sh
    ```
  - шагу напоминаний добавить `if: ${{ !cancelled() }}` — падение смены спринта не отменяет напоминания;
  - комментарий к cron: утренний запуск ещё и проверяет смену спринта.
- [ ] **Step 2: README.** В таблицу файлов — строка `scripts/sprint.sh` («смена спринта: перенос незакрытых задач и сообщение в чат»); после раздела «Напоминания о ревью» — раздел «Смена спринта»: что делает (по спеке, 3–5 предложений), когда (понедельник 10:00, или следующее утро, если хвосты остались), что бот меняет поле Sprint у задач на доске, как проверить вручную:
  ```bash
  gh workflow run reminders.yml -R Cringe-Driven-Development-Team/.github -f sprint=true
  ```
  и что `ADD_TO_PROJECT_PAT` должен уметь писать в доску (он и сейчас добавляет на неё задачи).
- [ ] **Step 3:** `bash tests/lint.sh` → `lint ok`; `bash tests/sprint.sh | tail -1` и `bash tests/reminders.sh | tail -1` — без `fail` (не изменились).
- [ ] **Step 4:** Commit.

```bash
git add .github/workflows/reminders.yml README.md
git commit -F - <<'EOF'
feat: смена спринта в утреннем запуске напоминаний

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: PR и живая проверка — выполняет контроллер после финального ревью, с подтверждением пользователя

Push ветки, PR в `.github`; после мержа — `gh workflow run reminders.yml -R Cringe-Driven-Development-Team/.github -f sprint=true`: до 28.09 ожидается тишина (Sprint 2 текущий) и отсутствие предупреждений в логе; 28.09 в 10:00 — настоящая смена. Статус спеки — «реализовано» после смены 28.09.
