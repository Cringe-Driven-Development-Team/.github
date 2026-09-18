# Комментарии ревью, одобренные PR и служебные алерты — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подключить репозиторий `figma`; слать одно сообщение на серию комментариев ревью; напоминать об одобренных, но не влитых PR; сообщать о сбоях самих уведомлений и об истечении токена доски.

**Architecture:** Комментарии ревью склеиваются через `concurrency` у job в `telegram.yml`: запуск на `commented` ждёт 3 минуты, следующий комментарий того же ревьювера его отменяет; после ожидания скрипт считает серию через REST API. Блок «✅ Одобрены» и служебные проверки живут в `scripts/reminders.sh`: вердикты берутся из того же GraphQL-запроса (`latestOpinionatedReviews`), упавшие запуски — из REST по каждому репозиторию, срок токена — из заголовка ответа `gh api -i`. Служебные проверки идут первыми и не валят job.

**Tech Stack:** GitHub Actions (reusable + scheduled workflows, job-level concurrency), bash, jq, GNU date, `gh` CLI (REST + GraphQL), actionlint, shellcheck.

**Spec:** `docs/superpowers/specs/2026-09-18-review-comments-approved-ops-design.md`

**Патчи:** код плана лежит рядом, в `docs/superpowers/plans/2026-09-18-review-comments-approved-ops/`. Все пять проверены на чистом клоне `main` (`3ad9f3d` + коммит плана) в том порядке, в каком применяются ниже; ожидаемые числа в шагах — из этого прогона.

## Global Constraints

- Ожидание серии комментариев — 180 секунд (`REVIEW_WAIT`), пауза, разрывающая серию, — те же 180 секунд.
- Порог напоминаний — `MIN_HOURS` (4); блок — до 20 PR; токен доски — предупреждение за 7 дней и меньше, раз в день.
- Пингуется тот, кому действовать: автор PR в «💬», «👍», «✋» и «✅»; ревьювер — в «👀», «🔁», «⏰»; владелец (`OPS_PING=YarikMix`) — в «🚨».
- Сбоем считается только `failure`; отменённые запуски (склейка) — нет.
- В публичный репозиторий не попадают настоящие ID: в тестах чат `-100`, топики `26` (общий) и `77` (ревью), карта `{"YarikMix":"111","blackHATred":"222"}`.
- Сообщения живых проверок идут в боевые топики — это ожидаемо.
- Коммиты: `<тип>: <что сделано>` по-русски со строчной буквы; последней строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Описание PR заканчивается `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. PR мержатся merge-коммитом.
- `actionlint` — только с `-shellcheck= -pyflakes=` (так делает `tests/lint.sh`).
- `jq.exe` под Windows отдаёт CRLF: всё, что скрипты читают из `jq` и заглушек, чистится от `\r`. На раннере это ничего не меняет.
- Клон — `/f/Github/2026_H2/.github` (Git Bash). Shell-функции не переживают отдельный вызов Bash — объявлять в той же команде.

## Карта файлов

| Файл | Что меняется |
|---|---|
| `figma: .github/workflows/automation.yml` (новый) | файл-вызов, как в остальных репозиториях |
| `.github/workflows/telegram.yml` | `concurrency` у job; env `REVIEW_BY`, `REVIEW_BY_TYPE`, `REVIEW_URL`; `plural` с формами слова + `commits`; функция `series`; ветка `pull_request_review` с `commented`; строка `KIND=reviewed` |
| `tests/telegram.sh` | заглушка `gh` отдаёт `/comments`; хелперы `rv`, `inline`; 12 случаев про ревью с комментариями |
| `scripts/reminders.sh` | `figma` в `REPOS`; служебные проверки (упавшие запуски, срок `PAT`); блок «✅ Одобрены»; общие `plural`, `side`, `send`, jq-определения `DEFS` |
| `tests/reminders.sh` | заглушка `gh` с маршрутизацией (GraphQL, запуски, `rate_limit`) и журналом вызовов; `pr` понимает `author:`, `ok:`, `no:`; 37 новых проверок |
| `tests/lib.sh` | `when` сбрасывает журнал вызовов `$TMP/calls` |
| `.github/workflows/reminders.yml` | два cron-выражения; env `OPS_TOPIC`, `PAT`, `DAILY`; `actions: read` |
| `README.md`, `profile/README.md` | новое поведение; строка `figma` в таблице репозиториев |

---

### Task 1: Подключить `figma`

**Files (в `/f/Github/2026_H2/figma`):**
- Create: `.github/workflows/automation.yml`

**Interfaces:**
- Consumes: `telegram.yml@main`, `add-to-project.yml@main` из `.github`; секреты и переменные организации (видны репозиторию — проверено).
- Produces: в `figma` есть workflow `automation.yml` — служебные проверки Task 3 перестают получать 404.

Хелперы:

```bash
R=Cringe-Driven-Development-Team/figma
last_run() { gh run list -R "$R" --workflow automation.yml --event "$1" --limit 1 --json databaseId,conclusion --jq '.[0]'; }
tg_sent() { gh run view "$1" -R "$R" --log | grep -o '{"ok":true.*' | jq -r '"topic=\(.result.message_thread_id) | \(.result.text | split("\n")[0])"'; }
```

- [ ] **Step 1: Клон, ветка, файл-вызов**

```bash
[ -d /f/Github/2026_H2/figma ] || git clone git@github.com:Cringe-Driven-Development-Team/figma.git /f/Github/2026_H2/figma
cd /f/Github/2026_H2/figma
git switch main && git pull --ff-only
git switch -c chore/reusable-workflows
mkdir -p .github/workflows
cp ../react/.github/workflows/automation.yml .github/workflows/automation.yml
sed -i 's/\r$//' .github/workflows/automation.yml
diff <(sed 's/\r$//' ../react/.github/workflows/automation.yml) .github/workflows/automation.yml && echo same
actionlint -no-color -oneline -shellcheck= -pyflakes= .github/workflows/automation.yml && echo ok
```

Expected: `same`, `ok`. Файл — тот же, что в README `.github`, раздел «Как подключить репозиторий».

- [ ] **Step 2: Commit, push, PR**

```bash
git add .github/workflows/automation.yml
git commit -F - <<'EOF'
chore: подключить общие workflow из .github

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
git push -u origin chore/reusable-workflows
gh pr create -R "$R" --base main --head chore/reusable-workflows --title "Подключить общие workflow из .github" --body-file - <<'EOF'
Уведомления в Telegram и добавление issue на доску: `automation.yml` с триггерами и вызовом общих workflow из Cringe-Driven-Development-Team/.github.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Expected: `last_run push` — success, `tg_sent` — `topic=26 | ⚒️ 1 коммит · figma · chore/reusable-workflows`; `last_run pull_request` — success, `topic=26 | 🔀 Открыт pull request · figma`.

- [ ] **Step 3: Мерж**

```bash
PR=$(gh pr view chore/reusable-workflows -R "$R" --json number --jq .number)
gh pr merge "$PR" -R "$R" --merge
git switch main && git pull --ff-only && ls .github/workflows
```

Expected: `automation.yml`; `last_run pull_request` — `topic=26 | 🎉 Влито в main · figma`.

---

### Task 2: Ревью с комментариями (`telegram.yml`)

**Files:**
- Modify: `tests/telegram.sh` — патч `01-telegram-tests.patch`
- Modify: `.github/workflows/telegram.yml` — патч `02-telegram-series.patch`

**Interfaces:**
- Consumes: `when`, `sent`, `sent_to`, `only`, `silent`, `pass`, `fail` из `tests/lib.sh`; заглушка `gh` в `tests/telegram.sh` (env `GH_REVIEWS`, `GH_COMPARE`).
- Produces: в скрипте `telegram.yml` — `plural <n> <1> <2–4> <5+>`, `commits <n>`, `series` (выставляет `NOTES` — число комментариев серии или пусто, `FIRST_URL` — первое ревью серии), `KIND=reviewed`; env `REVIEW_BY`, `REVIEW_BY_TYPE`, `REVIEW_URL`, необязательный `REVIEW_WAIT`. В тестах — `rv <id> <логин> <состояние> <время> [текст]`, `inline <id ревью>…`, env заглушки `GH_COMMENTS`, `GH_COMMENTS_FAIL`.

- [ ] **Step 1: Ветка**

```bash
cd /f/Github/2026_H2/.github
git switch main && git pull --ff-only
git switch -c feature/review-comments-approved-ops
PATCHES=docs/superpowers/plans/2026-09-18-review-comments-approved-ops
```

- [ ] **Step 2: Тесты**

```bash
git apply "$PATCHES/01-telegram-tests.patch"
```

Что в патче: заглушка `gh` отвечает на `*/comments`; в `DEFAULTS` — `REVIEW_BY= REVIEW_BY_TYPE=User REVIEW_URL= REVIEW_WAIT=0 GH_COMMENTS='[]' GH_COMMENTS_FAIL=`; тест апрува проверяет строку `автор: <пинг> · ревьювер: <текст>`; «review commented молчит» заменён на «review неизвестного вида молчит» (`REVIEW=dismissed`); новый раздел «ревью с комментариями»: один комментарий (топик 77, пинг автора, кнопка «Открыть ревью»), серия из трёх ревью (4 комментария, кнопка на первое), пауза 3 минуты разрывает серию, общий текст ревью считается, чужие ревью не считаются, апрув после серии, правки с inline-комментариями, апрув без комментариев — без строки и кнопки, автор PR и бот — тишина, API не отдал ревью / комментарии — сообщение без числа и `::warning::`.

- [ ] **Step 3: Новые проверки падают**

Run: `bash tests/telegram.sh | tail -1`
Expected: `итого: 53 ok, 12 fail`

- [ ] **Step 4: Реализация**

```bash
git apply "$PATCHES/02-telegram-series.patch"
```

Что в патче:

- у job `notify` — `concurrency` с `cancel-in-progress: true`; группа `tg-review-<репозиторий>-<PR>-<ревьювер>` для `pull_request_review`, иначе `tg-<run_id>`;
- env `REVIEW_BY`, `REVIEW_BY_TYPE`, `REVIEW_URL` из `github.event.review`;
- `plural` принимает формы слова, `commits` — обёртка для коммитов (три вызова переведены на неё);
- `series`: `GET /pulls/N/reviews` → отправленные ревью `REVIEW_BY` → идущие подряд с конца с паузами короче 180 секунд; `GET /pulls/N/comments` → inline-комментарии этих ревью + ревью с общим текстом = `NOTES`; любой сбой API — `::warning::` и `NOTES` пусто;
- ветка `pull_request_review:submitted`: автор PR и бот — `exit 0`; `commented` — `sleep "${REVIEW_WAIT:-180}"` и заголовок «💬 Комментарии к PR»; затем `KIND=reviewed`, `series`, кнопка «Открыть ревью» (для `commented` — всегда, для апрува и правок — если `NOTES > 0`);
- строка для `KIND=reviewed`: `автор: <пинг> · ревьювер: <текст>` и, если `NOTES > 0`, вторая — `N комментариев`.

- [ ] **Step 5: Всё проходит**

Run: `bash tests/telegram.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 65 ok, 0 fail`, `lint ok` (actionlint принимает `concurrency` с выражением).

- [ ] **Step 6: Commit**

```bash
git add tests/telegram.sh .github/workflows/telegram.yml
git commit -F - <<'EOF'
feat: одно сообщение на серию комментариев ревью

- «💬 Комментарии к PR» в топик ревью: пинг автора, число комментариев, кнопка на первое ревью серии
- одиночные комментарии склеиваются: запуск ждёт 3 минуты, следующий комментарий того же ревьювера его отменяет (concurrency)
- апрув и запрос правок показывают ревьювера и число комментариев
- ответы автора PR и ревью ботов не алертятся

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 3: Одобренные PR и служебные алерты (`reminders.sh`)

Обе части меняют один скрипт и одну заглушку `gh`, поэтому идут одним циклом.

**Files:**
- Modify: `tests/lib.sh`, `tests/reminders.sh` — патч `03-reminders-tests.patch`
- Modify: `scripts/reminders.sh` — патч `04-reminders-script.patch`

**Interfaces:**
- Consumes: `tests/lib.sh`.
- Produces: `scripts/reminders.sh` читает env `OPS_TOPIC` (по умолчанию = `TOPIC`), `PAT`, `DAILY` (`true` — проверить срок токена; по умолчанию `true`) — их передаёт workflow в Task 4. Порядок сообщений: сначала «🚨» в `OPS_TOPIC`, затем дайджест в `TOPIC`. В тестах — env заглушки `RUNS` (`{"<репозиторий>:<workflow>": N}`), `RUNS_404`, `RUNS_FAIL`, `PREV_RUN`, `PAT_HEADERS`; журнал вызовов `$TMP/calls` (строки `<GH_TOKEN>\t<аргументы gh>`).

- [ ] **Step 1: Тесты**

```bash
git apply "$PATCHES/03-reminders-tests.patch"
```

Что в патче: `when` в `lib.sh` сбрасывает `$TMP/calls`; заглушка `gh` маршрутизирует запросы (`api graphql` — фикстура; `…/runs?status=success` — `PREV_RUN`; `…/runs?status=failure` — `RUNS`, для `RUNS_404` — ошибка; `api -i rate_limit` — `PAT_HEADERS`, код выхода 1 при не-200) и пишет журнал; `pr` понимает `author:`, `ok:<логин>@<время>`, `no:<логин>@<время>`; покрытие — восемь репозиториев; разделы «одобрены, ждут мержа» (8 случаев), «служебные алерты» (8), «срок токена доски» (8).

- [ ] **Step 2: Новые проверки падают**

Run: `bash tests/reminders.sh 2>/dev/null | tail -1`
Expected: `итого: 38 ok, 24 fail`

- [ ] **Step 3: Реализация**

```bash
git apply "$PATCHES/04-reminders-script.patch"
```

Что в патче:

- `figma` в `REPOS`; константы `SELF`, `PAT_WARN_DAYS=7`, `OPS_PING=YarikMix`;
- общие `plural`, `days`, `side`, `send <топик> <текст>`;
- служебные проверки — первыми: окно `SINCE` = `created_at` предыдущего успешного запуска `reminders.yml` или 24 часа назад; по каждому репозиторию `runs?status=failure&created=%3E$SINCE` для `automation.yml` (у `.github` ещё `reminders.yml`); ошибка API — `::warning::` и дальше; при `DAILY=true` — `GH_TOKEN="$PAT" gh api -i rate_limit`: 401 — «не работает», 200 с заголовком `github-authentication-token-expiration` и остатком ≤ 7 дней — «истекает через N дней (дата)» / «сегодня»; сообщение «🚨 Сбои уведомлений · <пинг>» в `OPS_TOPIC`, только если есть строки;
- GraphQL: добавлены `author { login }` и `latestOpinionatedReviews`;
- jq: общие определения в `DEFS` (`esc`, `who`, `dur`, `side`, `prline`, `block`, `prs`), функция `digest`; `WAITING` — прежняя логика; `APPROVED` — в Reviewers пусто, есть `APPROVED`, нет `CHANGES_REQUESTED`, последний апрув старше порога;
- сборка текста: «⏰», «✅», предупреждение о 60 днях — через пустую строку; ничего нет — выход 0.

- [ ] **Step 4: Всё проходит**

Run: `bash tests/reminders.sh | tail -1`
Expected: `итого: 62 ok, 0 fail`

- [ ] **Step 5: Тесты ловят ошибки**

```bash
cp scripts/reminders.sh /tmp/rem.bak
for m in 's/any(.state == "CHANGES_REQUESTED") | not/any(.state == "CHANGES_REQUESTED")/' \
         's/select((.reviewRequests.nodes | length) == 0)/select(true)/' \
         's/-le "\$PAT_WARN_DAYS"/-le 30/' \
         's/created=%3E\$SINCE/created=%3E2000-01-01T00:00:00Z/'; do
  cp /tmp/rem.bak scripts/reminders.sh; sed -i "$m" scripts/reminders.sh
  echo "== $m"; bash tests/reminders.sh 2>/dev/null | tail -1
done
cp /tmp/rem.bak scripts/reminders.sh; bash tests/reminders.sh | tail -1
```

Expected: четыре раза `fail` больше нуля (8, 1, 1, 2), в конце `итого: 62 ok, 0 fail`.

- [ ] **Step 6: Прогон на живом API**

```bash
mkdir -p /tmp/rbin /tmp/rsent && rm -f /tmp/rsent/*
cp tests/stub-curl.sh /tmp/rbin/curl && chmod +x /tmp/rbin/curl
env PATH="/tmp/rbin:$PATH" SENT=/tmp/rsent TOKEN=x CHAT=-100 TOPIC=77 OPS_TOPIC=26 MAP='{}' MIN_HOURS=0 DAILY=true PAT="$(gh auth token)" bash scripts/reminders.sh
echo "exit=$?"; cat /tmp/rsent/* 2>/dev/null
```

Expected: `exit=0`, без `::warning::` (после Task 1 у `figma` есть workflow). Сообщения — только если в репозиториях есть ждущие или одобренные PR либо упавшие запуски.

- [ ] **Step 7: Commit**

```bash
git add tests/lib.sh tests/reminders.sh scripts/reminders.sh
git commit -F - <<'EOF'
feat: одобренные PR в напоминаниях и служебные алерты

- блок «✅ Одобрены, ждут мержа»: апрув есть, правок не просят, ревью больше не ждут — пинг автора
- «🚨 Сбои уведомлений» в общий топик: упавшие запуски «Автоматизации» и «Напоминаний» с прошлого успешного запуска
- срок ADD_TO_PROJECT_PAT из заголовка ответа GitHub: предупреждение за неделю, раз в день
- figma в списке репозиториев

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 4: Workflow напоминаний и документация

**Files:**
- Modify: `.github/workflows/reminders.yml`, `README.md`, `profile/README.md` — патч `05-workflow-and-docs.patch`

**Interfaces:**
- Consumes: env `OPS_TOPIC`, `PAT`, `DAILY` скрипта (Task 3).

- [ ] **Step 1: Патч**

```bash
git apply "$PATCHES/05-workflow-and-docs.patch"
```

Что в патче: `reminders.yml` — cron разделён на `0 7 * * *` и `0 12,17 * * *`; `permissions` + `actions: read`; env `OPS_TOPIC: ${{ vars.TELEGRAM_TOPIC_ID }}`, `PAT: ${{ secrets.ADD_TO_PROJECT_PAT }}`, `DAILY: ${{ github.event_name == 'workflow_dispatch' || github.event.schedule == '0 7 * * *' }}`. `README.md` — описание `reminders.yml` и `reminders.sh`, абзацы про список `REPOS`, «🚨», склейку комментариев и серые запуски. `profile/README.md` — строка `figma`.

- [ ] **Step 2: Проверки**

Run: `bash tests/telegram.sh | tail -1 && bash tests/reminders.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 65 ok, 0 fail`, `итого: 62 ok, 0 fail`, `lint ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/reminders.yml README.md profile/README.md
git commit -F - <<'EOF'
feat: проверка токена доски по утреннему расписанию, figma в README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 5: PR и живые проверки

Хелперы:

```bash
R=Cringe-Driven-Development-Team/.github
last_run() { gh run list -R "$R" --workflow "$1" --event "$2" --limit 1 --json databaseId,conclusion --jq '.[0]'; }
tg_sent() { gh run view "$1" -R "$R" --log | grep -o '{"ok":true.*' | jq -r '"topic=\(.result.message_thread_id)\n\(.result.text)\n---"'; }
```

- [ ] **Step 1: Push и PR**

```bash
git push -u origin feature/review-comments-approved-ops
gh pr create -R "$R" --base main --head feature/review-comments-approved-ops \
  --title "Комментарии ревью, одобренные PR и служебные алерты" --body-file - <<'EOF'
- «💬 Комментарии к PR»: одно сообщение на серию комментариев ревьювера
- «✅ Одобрены, ждут мержа» в напоминаниях
- «🚨 Сбои уведомлений»: упавшие запуски и срок токена доски
- figma в списке репозиториев

Спека: docs/superpowers/specs/2026-09-18-review-comments-approved-ops-design.md
План: docs/superpowers/plans/2026-09-18-review-comments-approved-ops.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Expected: `last_run automation.yml pull_request` — success, «🔀 Открыт pull request · .github» в общем топике.

- [ ] **Step 2: Склейка комментариев — нужен второй человек**

Автор PR — владелец аккаунта, его собственные комментарии не алертятся. Попросить пользователя: пусть второй ментор или студент оставит в этом PR два одиночных комментария к коду («Add single comment») с паузой меньше 3 минут.

```bash
gh run list -R "$R" --workflow automation.yml --event pull_request_review --limit 3 --json databaseId,conclusion,createdAt --jq '.[] | "\(.createdAt) \(.conclusion) \(.databaseId)"'
```

Expected: первый запуск — `cancelled`, второй — `success` примерно через 3 минуты после второго комментария; `tg_sent <id второго>` — `topic=1513`, «💬 Комментарии к PR · .github», пинг автора, `2 комментария`.
Второго человека нет — шаг пропускается, сценарий проверится на первом настоящем ревью; сказать об этом в итоге.

- [ ] **Step 3: Мерж**

```bash
PR=$(gh pr view feature/review-comments-approved-ops -R "$R" --json number --jq .number)
gh pr merge "$PR" -R "$R" --merge
git switch main && git pull --ff-only
```

- [ ] **Step 4: Ручной запуск напоминаний**

```bash
gh workflow run reminders.yml -R "$R" -f min_hours=0
```

Дождаться `last_run reminders.yml workflow_dispatch`, `gh run watch <id> -R "$R" --exit-status`.

```bash
gh run view <id> -R "$R" --log | grep -E '##\[warning\]|##\[error\]'
tg_sent <id>
```

Expected: success; предупреждений нет — значит, `GITHUB_TOKEN` читает запуски всех восьми репозиториев, а `ADD_TO_PROJECT_PAT` доступен и проверен. «🚨» приходит, только если есть упавшие запуски или токену осталось ≤ 7 дней; «✅» — только если есть одобренный PR. Предупреждение `Не проверил запуски …` для frontend или backend — токену не хватает доступа: остановиться и обсудить с пользователем.

- [ ] **Step 5: Статус спеки**

```bash
sed -i 's/^Статус: дизайн согласован в чате, ждёт вычитки спеки$/Статус: реализовано 2026-09-18/' docs/superpowers/specs/2026-09-18-review-comments-approved-ops-design.md
grep -n '^Статус:' docs/superpowers/specs/2026-09-18-review-comments-approved-ops-design.md
git commit -am "docs: спека комментариев ревью и служебных алертов реализована" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 6: Итог пользователю**

Что проверено вживую, что только тестами; что показал запуск про срок `ADD_TO_PROJECT_PAT`; напомнить про описание `figma` в README организации (сейчас — нейтральная заглушка).
