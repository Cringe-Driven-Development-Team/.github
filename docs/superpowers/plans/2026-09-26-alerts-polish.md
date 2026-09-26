# Доработка алертов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Чистые описания в алертах, честный force-push, алерт о PR, закрытом GitHub, комментарии под задачами и в PR, кнопки под всеми алертами, дайджест ревью раз в сутки и алерт о новом репозитории организации.

**Architecture:** Всё про события — inline-скрипт `telegram.yml` (reusable workflow, его вызывают `automation.yml` всех подключённых репозиториев): новые функции `button`, `quote`, `rewritten`, проверка автозакрытого PR после force-push и ветка `issue_comment:created`. Всё по расписанию — `scripts/reminders.sh`: дайджест только при `DAILY=true`, в служебных проверках — новые репозитории организации. Тесты — прогон скриптов на подставных событиях с заглушками `curl` и `gh`.

**Tech Stack:** GitHub Actions (reusable + scheduled workflows), bash, perl (`-CS -Mutf8`), jq, GNU date, `gh` CLI (REST), actionlint, shellcheck.

**Spec:** `docs/superpowers/specs/2026-09-26-alerts-polish-design.md`

**Патчи:** код плана лежит рядом, в `docs/superpowers/plans/2026-09-26-alerts-polish/`: у каждой задачи патч тестов (`NN-…-tests.patch`) и патч реализации (`NN-….patch`). Все четырнадцать проверены на чистом клоне ветки `feature/alerts-polish` (коммит спеки `c47094b`; спеку и план патчи не трогают) в том порядке, в каком применяются ниже; ожидаемые числа в шагах — из этого прогона.

## Global Constraints

- Цитата описания или комментария — не длиннее 700 символов (символов, не байт), конец — `…` (U+2026).
- В цитату не попадают HTML-теги и комментарии; код (`` `…` ``, ```` ```…``` ````) не трогается; ссылками становятся только `http(s)://`.
- Force-push сравнивается с веткой по умолчанию репозитория (`github.event.repository.default_branch`), не с литералом `main`.
- PR «закрыл GitHub» — только если `closed` и `head_ref_force_pushed` у него в одну секунду и закрыт он не раньше 300 секунд назад.
- Комментарии: только `issue_comment: created`; боты (`user.type == Bot`) молчат; под задачей — общий топик, в PR — топик ревью.
- Дайджест ревью — только при `DAILY=true` (утренний cron `0 7 * * *` и ручной запуск); служебные проверки — в каждом запуске.
- Новые репозитории — с `created_at` позже `SINCE` (последний успешный запуск напоминаний), сообщение — в `OPS_TOPIC`.
- Сбой API в новых проверках не валит job: `::warning::` в лог и сообщение без этой части.
- В публичный репозиторий не попадают настоящие ID: в тестах чат `-100`, топики `26` (общий) и `77` (ревью), карта `{"YarikMix":"111","blackHATred":"222"}`. Боевые топики: GitHub — `26`, Code Review — `1513`.
- Коммиты: `<тип>: <что сделано>` по-русски со строчной буквы; последней строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Описание PR заканчивается `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. PR мержатся merge-коммитом.
- `jq.exe` под Windows отдаёт CRLF: всё, что скрипты читают из `jq`, `gh` и заглушек, чистится от `\r`. На раннере это ничего не меняет.
- Клон — `/f/Github/2026_H2/.github` (Git Bash). Не вставлять код через `python - <<'EOF'` в Git Bash: heredoc съедает `\\` и `\n`. Правки — только `git apply` патчей из плана или инструментом Edit.

## Review Focus

Входы, которые спека подразумевает, но не называет; тест на каждый — в задаче-владельце:

- Ветка со `/` в имени (`feature/web-5`) после force-push — ссылка на ветку, кнопка «Ветка целиком» и поиск закрытых PR работают с полным именем (Task 3, Task 4).
- Первый запуск напоминаний, когда успешных запусков ещё не было, — новыми считаются репозитории за последние 24 часа, а не вся организация (Task 7).
- Комментарий, от которого после очистки ничего не осталось (`<!-- … -->` из шаблона), — сообщение без пустой цитаты (Task 5).
- Ссылка `[x](javascript:…)` в описании не становится кликабельной (Task 1).
- Человек закрыл PR в пределах пяти минут до force-push — второго «🚫» нет, алерт о его закрытии уже пришёл (Task 4, «PR закрыл человек незадолго до пуша»).

## Карта файлов

| Файл | Что меняется |
|---|---|
| `.github/workflows/telegram.yml` | env события (`DELETED`, `BEFORE`, `AFTER`, `DEFAULT_BRANCH`, `OWNER`, `COMMENT_*`, `ISSUE_AUTHOR`, `IS_PR`); функции `button`, `quote`, `rewritten`; `send` с запасным текстом; кнопки у всех алертов; ветка `issue_comment:created`; проверка автозакрытого PR после force-push |
| `.github/workflows/automation.yml`, `README.md` (шаблон) | триггер `issue_comment: types: [created]` |
| `tests/stub-curl.sh` | `TG_REJECT` — изобразить отказ Telegram разобрать разметку |
| `tests/telegram.sh` | заглушка `gh`: сравнение со старой версией ветки, закрытые PR, события PR, PR, журнал путей `$CALLS`; разделы тестов на каждую задачу |
| `scripts/reminders.sh` | `esc`; `send` с кнопками; новые репозитории; дайджест только при `DAILY=true` |
| `tests/reminders.sh` | заглушка `gh`: репозитории организации, `automation.yml`; `DAILY=true` по умолчанию; разделы «дайджест раз в день», «новые репозитории» |
| `.github/workflows/reminders.yml`, `README.md` | описание нового расписания и алерта о репозиториях |

Хелпер для всех задач:

```bash
cd /f/Github/2026_H2/.github
PATCHES=docs/superpowers/plans/2026-09-26-alerts-polish
```

---

### Task 1: Описания без мусора и с разметкой, страховка от кривой разметки

**Files:**
- Modify: `tests/stub-curl.sh`, `tests/telegram.sh` — патч `01-descriptions-tests.patch`
- Modify: `.github/workflows/telegram.yml` — патч `01-descriptions.patch`

**Interfaces:**
- Consumes: `when`, `sent`, `sent_to`, `only`, `silent`, `error`, `pass`, `fail` из `tests/lib.sh`.
- Produces: в скрипте `telegram.yml` — `quote <текст>` (печатает HTML Telegram или пусто), `send <топик> <текст> [<текст без цитаты>]`, переменная `BARE`. В заглушке `curl` — env `TG_REJECT=<кусок текста>`: сообщение с этим куском получает `{"ok":false,…"can't parse entities"…}` и не сохраняется.

- [ ] **Step 1: Ветка**

```bash
git switch feature/alerts-polish && git status --short
```

Expected: ветка `feature/alerts-polish`, рабочее дерево чистое (спека и план закоммичены).

- [ ] **Step 2: Тесты**

```bash
git apply "$PATCHES/01-descriptions-tests.patch"
```

Что в патче: `stub-curl.sh` понимает `TG_REJECT`; ожидание в «issue opened» — `<blockquote expandable><b>Что сделать</b>`; раздел «описание: разметка»: markdown → разметка (жирный, код с `<id>` внутри, чекбоксы, пункты, зачёркнутый, `snake_case __init__` не тронут, ссылка с `&amp;`, блок кода с `<x>` и `**нет**`), картинки `<img>` и `![]()` ссылками, `<details>` — переводом строки, 900 символов кириллицы → `…</blockquote>` без `â`, обрезанный блок кода — без `<pre>`, описание из одного `<!-- -->` — без цитаты, `javascript:`-ссылка — текстом, отказ разметки — повтор без цитаты и `::warning::`, отказ без цитаты — `error`.

- [ ] **Step 3: Новые проверки падают**

Run: `bash tests/telegram.sh | tail -1`
Expected: `итого: 66 ok, 9 fail`

- [ ] **Step 4: Реализация**

```bash
git apply "$PATCHES/01-descriptions.patch"
```

Что в патче — функция `quote` вместо однострочного perl и запасная отправка:

```bash
          quote () {
            printf '%s' "$1" | perl -CS -Mutf8 -0777 -pe '
              my $code = qr/```.*?```|`[^`\n]+`/s;
              s/<!--.*?-->//gs; s/\r//g;
              s{($code)|<img\b[^>]*?\bsrc="([^"]+)"[^>]*>}{$1 // "[🖼 картинка]($2)"}gie;
              s{($code)|!\[[^\]\n]*\]\(([^)\s]+)[^)\n]*\)}{$1 // "[🖼 картинка]($2)"}ge;
              s{($code)|<br\s*/?>|</(?:p|div|summary|details|li|tr|h\d)>}{$1 // "\n"}gie;
              s{($code)|</?[A-Za-z][^<>]*>}{$1 // ""}ge;
              s/[ \t]+$//gm; s/\n{3,}/\n\n/g; s/^\s+|\s+$//g;
              $_ = substr($_, 0, 700) . "…" if length > 700;
              s/&/&amp;/g; s/</&lt;/g; s/>/&gt;/g;
              my @k;
              my $fences = () = /^```/mg;
              s/\A(.*)^```[^\n]*\n?/$1/sm if $fences % 2;
              s{^```[^\n]*\n(.*?)\n?^```[ \t]*$}{push @k, "<pre>$1</pre>"; "\x00$#k\x00"}gems;
              s{`([^`\n]+)`}{push @k, "<code>$1</code>"; "\x00$#k\x00"}ge;
              s{^#{1,6}[ \t]+(.+?)[ \t#]*$}{<b>$1</b>}gm;
              s{\*\*(?=\S)(.+?)(?<=\S)\*\*}{<b>$1</b>}g;
              s{~~(?=\S)(.+?)(?<=\S)~~}{<s>$1</s>}g;
              s{\[([^\]\n]+)\]\((https?://[^)\s"]+)\)}{<a href="$2">$1</a>}g;
              s/^([ \t]*)[-*+][ \t]+\[ \][ \t]+/$1☐ /gm;
              s/^([ \t]*)[-*+][ \t]+\[[xX]\][ \t]+/$1☑ /gm;
              s/^([ \t]*)[-*+][ \t]+/$1• /gm;
              s/\x00(\d+)\x00/$k[$1]/g;
            '
          }
```

`send` на ответ с `can't parse entities` при непустом третьем аргументе пишет `::warning::Telegram не разобрал разметку цитаты, отправляю без неё` и отправляет третий аргумент; без него — `::error::` и `exit 1`, как раньше. После `TEXT=$(card …)` — `if [ -n "$EXTRA" ]; then BARE=$(EXTRA=""; card "$HEAD" "$LINE"); fi`; вызов — `send "$DEST" "$TEXT" "$BARE"`.

- [ ] **Step 5: Всё проходит**

Run: `bash tests/telegram.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 75 ok, 0 fail`, `lint ok`.

- [ ] **Step 6: Commit**

```bash
git add tests/stub-curl.sh tests/telegram.sh .github/workflows/telegram.yml
git commit -F - <<'EOF'
fix: описания задач без мусора и с разметкой Telegram

- «…» в обрезанном описании вместо «â¦»: perl с -Mutf8
- markdown — разметкой (жирный, код, ссылки, заголовки, списки, чекбоксы), картинки — ссылками, HTML-теги сняты, код не тронут
- Telegram не разобрал разметку цитаты — сообщение уходит без неё

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Кнопки под всеми алертами

**Files:**
- Modify: `tests/telegram.sh` — патч `02-buttons-tests.patch`
- Modify: `.github/workflows/telegram.yml` — патч `02-buttons.patch`

**Interfaces:**
- Consumes: `send` из Task 1.
- Produces: `button <текст> <ссылка>` — выставляет `MARKUP` (одна кнопка-ссылка, JSON через `jq -nc`). Task 3, 4, 5 вызывают его.

- [ ] **Step 1: Тесты**

```bash
git apply "$PATCHES/02-buttons-tests.patch"
```

Что в патче: раздел «кнопки»: «Открыть задачу» у opened, closed, reopened и поздней правки описания; открытый PR с ревьювером — «Открыть PR» в `26` и «Начать ревью» (`/pull/7/files`) в `77`; «Открыть PR» у влитого и закрытого без мержа; «Начать ревью» у запроса ревью и у повторного ревью без новых коммитов.

- [ ] **Step 2: Новые проверки падают**

Run: `bash tests/telegram.sh | tail -1`
Expected: `итого: 75 ok, 10 fail`

- [ ] **Step 3: Реализация**

```bash
git apply "$PATCHES/02-buttons.patch"
```

Что в патче:

```bash
          # button <текст> <ссылка> — кнопка-ссылка под сообщением
          button () { MARKUP=$(jq -nc --arg t "$1" --arg u "$2" '{inline_keyboard: [[{text: $t, url: $u}]]}'); }
```

Вызовы: `pull_request:opened|ready_for_review` и `pull_request:closed` — `button "Открыть PR" "$URL"`; `review_requested` — `button "Начать ревью" "$URL/files"` до `last_review` (при новых коммитах её заменяет «Что изменилось»); задачи — `button "Открыть задачу" "$URL"` в ветке отрисовки issue; перед вторым сообщением «👀 Запрошено ревью» при открытии PR — `button "Начать ревью" "$URL/files"`. Три `MARKUP=$(printf '{"inline_keyboard":…}')` («Что изменилось», «Открыть ревью», «Открыть изменения») переведены на `button`.

- [ ] **Step 4: Всё проходит**

Run: `bash tests/telegram.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 85 ok, 0 fail`, `lint ok`.

- [ ] **Step 5: Commit**

```bash
git add tests/telegram.sh .github/workflows/telegram.yml
git commit -F - <<'EOF'
feat: кнопки под алертами о задачах, PR и запросах ревью

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Force-push через сравнение с веткой по умолчанию

**Files:**
- Modify: `tests/telegram.sh` — патч `03-force-push-tests.patch`
- Modify: `.github/workflows/telegram.yml` — патч `03-force-push.patch`

**Interfaces:**
- Consumes: `button` (Task 2), `esc`, `commits`.
- Produces: env `DELETED`, `BEFORE`, `AFTER`, `DEFAULT_BRANCH`; переменные `NOTE` (строка под заголовком пуша), `BR` (имя ветки, теперь выставляется в ветке `push:`), `BASE_BR` (ветка по умолчанию, выставляет `rewritten`) — Task 4 читает `BR` и `BASE_BR`. В тестах: хелпер `cmp <sha>:<заголовок>…`, массив `FP`, `INFRA`, env заглушки `GH_COMPARE_BEFORE`, `GH_COMPARE_BEFORE_FAIL` (ответ на `…/compare/…...$BEFORE`).

- [ ] **Step 1: Тесты**

```bash
git apply "$PATCHES/03-force-push-tests.patch"
```

Что в патче: заглушка `gh` отвечает на сравнение со старой версией ветки отдельно; в `DEFAULTS` — `DELETED=false BEFORE= AFTER= DEFAULT_BRANCH=main GH_COMPARE_BEFORE= GH_COMPARE_BEFORE_FAIL=`; «push: force-push помечен» заменён разделом «force-push»: после rebase — «ветка переписана: 3 коммита поверх main, новых — 1», в списке только новый, коммит из main не виден, кнопка «Ветка целиком»; чистый rebase — «новых коммитов нет»; сброс до main; старой версии нет — вся ветка; нет общей истории — «у ветки нет общей истории с main» и коммиты из события; сравнение недоступно — старый формат и `::warning::`; то же без новых коммитов в событии — тишина; ветка по умолчанию `develop`; ветка `feature/web-5`; удаление ветки — тишина.

- [ ] **Step 2: Новые проверки падают**

Run: `bash tests/telegram.sh | tail -1`
Expected: `итого: 88 ok, 9 fail`

- [ ] **Step 3: Реализация**

```bash
git apply "$PATCHES/03-force-push.patch"
```

Что в патче — функция перед `case "$EVENT:$ACTION"`:

```bash
          rewritten () {
            BASE_BR="${DEFAULT_BRANCH:-main}"
            ERR="${RUNNER_TEMP:-/tmp}/gh-compare.err"
            if ! NOW_LIST=$(gh api "repos/$REPO/compare/$BASE_BR...$AFTER?per_page=100" --paginate \
                --jq '.commits[] | {id: .sha, message: .commit.message}' 2>"$ERR"); then
              if grep -qF "No common ancestor" "$ERR"; then
                HEAD="⚠️ force-push"
                NOTE="у ветки нет общей истории с $(esc "$BASE_BR")"
              else
                echo "::warning::Не сравнил ветку с $BASE_BR, коммиты из события: $(head -c 200 "$ERR")"
                [ "$COUNT" -eq 0 ] && exit 0
                HEAD="⚠️ $COUNT $(commits "$COUNT") (force-push)"
              fi
              return 0
            fi
            ALL=$(printf '%s' "$NOW_LIST" | jq -sc '.')
            TOTAL=$(printf '%s' "$ALL" | jq 'length')
            HEAD="⚠️ force-push"
            button "Ветка целиком" "https://github.com/$REPO/compare/$BASE_BR...$BR"
            if [ "$TOTAL" -eq 0 ]; then
              NOTE="ветка сброшена до $(esc "$BASE_BR")"
              COMMITS='[]'
              COUNT=0
              return 0
            fi
            NOTE="ветка переписана: $TOTAL $(commits "$TOTAL") поверх $(esc "$BASE_BR")"
            # старой версии ветки может уже не быть — тогда все коммиты ветки
            if OLD=$(gh api "repos/$REPO/compare/$BASE_BR...$BEFORE?per_page=100" --paginate \
                --jq '.commits[].commit.message | split("\n")[0]' 2>/dev/null); then
              COMMITS=$(printf '%s' "$ALL" | jq -c --arg old "$(printf '%s' "$OLD" | tr -d '\r')" '
                ($old | split("\n")) as $o | map(select((.message | split("\n")[0]) as $t | $o | any(. == $t) | not))')
              COUNT=$(printf '%s' "$COMMITS" | jq 'length')
              if [ "$COUNT" -eq 0 ]; then
                NOTE="$NOTE, новых коммитов нет"
              else
                NOTE="$NOTE, новых — $COUNT"
              fi
            else
              COMMITS="$ALL"
              COUNT="$TOTAL"
            fi
          }
```

Ветка `push:`: удаление ветки — `exit 0`; `BR` и кнопка «Открыть изменения» выставляются здесь; при `FORCED=true` — `rewritten`, иначе прежняя логика. Отрисовка пуша: заголовок, затем непустые строки `NOTE`, списка коммитов и автора.

- [ ] **Step 4: Всё проходит**

Run: `bash tests/telegram.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 97 ok, 0 fail`, `lint ok`.

- [ ] **Step 5: Commit**

```bash
git add tests/telegram.sh .github/workflows/telegram.yml
git commit -F - <<'EOF'
feat: force-push через сравнение с веткой по умолчанию

- «ветка переписана: N коммитов поверх main, новых — M»: в списке только новые, без коммитов из main
- сброс до main и ветка без общей истории с main — отдельной строкой
- кнопка «Ветка целиком» вместо сравнения до и после rebase

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: PR, закрытый GitHub после force-push

**Files:**
- Modify: `tests/telegram.sh` — патч `04-auto-closed-pr-tests.patch`
- Modify: `.github/workflows/telegram.yml` — патч `04-auto-closed-pr.patch`

**Interfaces:**
- Consumes: `BR`, `BASE_BR` (Task 3), `button`, `card`, `mention`, `send`.
- Produces: env `OWNER`. В тестах: хелперы `closed <номер> <когда закрыт> [<когда влит>]`, `ev <событие>@<время>…`; `CLOSED_AT`, `NO_ANCESTOR`; env заглушки `GH_CLOSED`, `GH_CLOSED_FAIL`, `GH_EVENTS`, `GH_EVENTS_FAIL`; заглушка пишет пути запросов в `$CALLS` (`CALLS="$TMP/calls"` в `DEFAULTS`, `when` его сбрасывает).

- [ ] **Step 1: Тесты**

```bash
git apply "$PATCHES/04-auto-closed-pr-tests.patch"
```

Что в патче: раздел «PR, закрытый GitHub после force-push»: закрыт GitHub — второе сообщение в `26` («🚫 PR закрыт без мержа · infra», ссылка и кнопка «Открыть PR», «автор: iRedTea», пояснение), поиск по `head=Cringe-Driven-Development-Team:task-infra-1`; закрыл человек незадолго до пуша — одно сообщение; закрыт давно — одно; влитый — одно; список закрытых PR или события PR недоступны — одно сообщение и `::warning::`; ветка `feature/web-5` — поиск по полному имени; обычный пуш закрытые PR не проверяет.

- [ ] **Step 2: Новые проверки падают**

Run: `bash tests/telegram.sh | tail -1`
Expected: `итого: 105 ok, 6 fail`

- [ ] **Step 3: Реализация**

```bash
git apply "$PATCHES/04-auto-closed-pr.patch"
```

Что в патче — env `OWNER: ${{ github.repository_owner }}` и блок в конце скрипта:

```bash
          if [ "$EVENT" = "push" ] && [ "$FORCED" = "true" ]; then
            ERR="${RUNNER_TEMP:-/tmp}/gh-closed.err"
            if ! PRS=$(gh api "repos/$REPO/pulls?state=closed&head=$OWNER:$BR&sort=updated&direction=desc&per_page=5" \
                --jq '.[] | select(.merged_at == null) | [.number, .closed_at, .html_url, .user.login, .title] | @tsv' 2>"$ERR"); then
              echo "::warning::Не проверил, закрыл ли GitHub PR ветки: $(head -c 200 "$ERR")"
              PRS=""
            fi
            while IFS=$'\t' read -r N AT PURL AUTHOR PTITLE; do
              [ -n "$N" ] || continue
              # закрыт давно — не этим пушем
              [ $(( $(date +%s) - $(date -d "$AT" +%s) )) -lt 300 ] || continue
              if ! EV=$(gh api "repos/$REPO/issues/$N/events?per_page=100" --paginate \
                  --jq '.[] | select(.event == "closed" or .event == "head_ref_force_pushed") | "\(.event) \(.created_at)"' 2>"$ERR"); then
                echo "::warning::Не прочитал события PR #$N: $(head -c 200 "$ERR")"
                continue
              fi
              EV=$(printf '%s' "$EV" | tr -d '\r')
              if grep -qxF "closed $AT" <<< "$EV" && grep -qxF "head_ref_force_pushed $AT" <<< "$EV"; then
                URL="$PURL"
                TITLE="$PTITLE"
                REF=""
                EXTRA=""
                button "Открыть PR" "$PURL"
                LINE=$(printf 'автор: %s\nGitHub закрыл PR после force-push: у ветки не осталось изменений или общей истории с %s' \
                  "$(mention "$AUTHOR")" "$(esc "$BASE_BR")")
                send "$TOPIC" "$(card "🚫 PR закрыт без мержа" "$LINE")"
              fi
            done <<< "$(printf '%s' "$PRS" | tr -d '\r')"
          fi
```

- [ ] **Step 4: Всё проходит**

Run: `bash tests/telegram.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 111 ok, 0 fail`, `lint ok`.

- [ ] **Step 5: Commit**

```bash
git add tests/telegram.sh .github/workflows/telegram.yml
git commit -F - <<'EOF'
feat: алерт о PR, который GitHub закрыл после force-push

GitHub сам закрывает PR, когда force-push оставляет ветку без изменений или без общей
истории с main, и события pull_request об этом не шлёт. Такой PR узнаём по закрытию
в ту же секунду, что и force-push.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Комментарии под задачами и в обсуждении PR

**Files:**
- Modify: `tests/telegram.sh` — патч `05-comments-tests.patch`
- Modify: `.github/workflows/telegram.yml`, `.github/workflows/automation.yml`, `README.md` — патч `05-comments.patch`

**Interfaces:**
- Consumes: `quote`, `BARE` (Task 1), `button` (Task 2), `mentions`, `esc`.
- Produces: env `COMMENT_BODY`, `COMMENT_URL`, `COMMENT_BY`, `COMMENT_BY_TYPE`, `ISSUE_AUTHOR`, `IS_PR`; `KIND=comment`, `PING`. В тестах: массивы `IC` (задача) и `PC` (PR), env заглушки `GH_PR`, `GH_PR_FAIL` (ответ на `repos/R/pulls/N`).

- [ ] **Step 1: Тесты**

```bash
git apply "$PATCHES/05-comments-tests.patch"
```

Что в патче: раздел «комментарии»: под задачей — топик `26`, «💬 Комментарий · infra», ссылка на комментарий `#5 Bootstrap-стек`, `от: iRedTea · для: <пинг blackHATred>, <пинг YarikMix>`, цитата с разметкой, кнопка «Открыть комментарий»; исполнитель пишет — пинг только автора; единственный участник — без «для»; бот — тишина; картинка — ссылкой; шаблон `<!-- … -->` — без цитаты; в PR от ревьювера — топик `77`, «💬 Комментарий к PR · backend», без `#23`, пинг автора PR; автор PR отвечает — пинг запрошенных ревьюверов, их нет — без «для», API не отдал PR — без «для» и `::warning::`; без `TELEGRAM_REVIEW_TOPIC_ID` — в `26`.

- [ ] **Step 2: Новые проверки падают**

Run: `bash tests/telegram.sh | tail -1`
Expected: `итого: 112 ok, 13 fail`

- [ ] **Step 3: Реализация**

```bash
git apply "$PATCHES/05-comments.patch"
```

Что в патче: env из `github.event.comment` и `github.event.issue` (`IS_PR: ${{ github.event.issue.pull_request != null }}`); ветка события:

```bash
            issue_comment:created)
              # комментарии ботов — не новость
              [ "$COMMENT_BY_TYPE" = "Bot" ] && exit 0
              KIND=comment
              button "Открыть комментарий" "$COMMENT_URL"
              if [ "$IS_PR" = "true" ]; then
                # обсуждение PR — в топик ревью: пишет не автор — действовать автору,
                # автор отвечает — ревьюверам
                DEST="$RTOPIC"
                HEAD="💬 Комментарий к PR"
                if [ "$COMMENT_BY" = "$ISSUE_AUTHOR" ]; then
                  ERR="${RUNNER_TEMP:-/tmp}/gh-pr.err"
                  if ! PING=$(gh api "repos/$REPO/pulls/$NUMBER" --jq '[.requested_reviewers[].login] | join(" ")' 2>"$ERR"); then
                    echo "::warning::Не прочитал ревьюверов PR, комментарий без пинга: $(head -c 200 "$ERR")"
                    PING=""
                  fi
                else
                  PING="$ISSUE_AUTHOR"
                fi
              else
                # под задачей — исполнителям и автору задачи, кроме того, кто пишет
                HEAD="💬 Комментарий"
                PING=$(printf '%s' "$ASSIGNEES" | jq -r --arg me "$COMMENT_BY" --arg author "$ISSUE_AUTHOR" '
                  [(.[]?.login), $author] | map(select(. != "" and . != $me))
                  | reduce .[] as $x ([]; if any(.[]; . == $x) then . else . + [$x] end) | join(" ")')
              fi
              PING=$(printf '%s' "$PING" | tr -d '\r') ;;
```

и отрисовка (перед веткой `issues`): ссылка в заголовке — на комментарий, `#N` только у задачи, строка `от: <текст> · для: <пинги>`, цитата через `quote "$COMMENT_BODY"`. В `automation.yml` и шаблоне README — триггер `issue_comment: types: [created]`; в README «задачи, комментарии, PR и ревью» и «события `issues` и `issue_comment` всегда берут workflow из `main`».

- [ ] **Step 4: Всё проходит**

Run: `bash tests/telegram.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 125 ok, 0 fail`, `lint ok` (actionlint принимает `issue_comment` и выражение `!= null`).

- [ ] **Step 5: Commit**

```bash
git add tests/telegram.sh .github/workflows/telegram.yml .github/workflows/automation.yml README.md
git commit -F - <<'EOF'
feat: алерты о комментариях под задачами и в обсуждении PR

- под задачей — в общий топик, пинг исполнителей и автора задачи
- в обсуждении PR — в топик ревью: пинг автора PR, а на ответ автора — запрошенных ревьюверов
- цитата комментария с разметкой и кнопка «Открыть комментарий»; комментарии ботов молчат

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Дайджест ревью раз в сутки

**Files:**
- Modify: `tests/reminders.sh` — патч `06-daily-digest-tests.patch`
- Modify: `scripts/reminders.sh`, `.github/workflows/reminders.yml`, `README.md` — патч `06-daily-digest.patch`

**Interfaces:**
- Consumes: `DAILY` из `reminders.yml` (`github.event_name == 'workflow_dispatch' || github.event.schedule == '0 7 * * *'` — не меняется).
- Produces: при `DAILY != true` скрипт завершается после служебных проверок. В тестах `DAILY=true` по умолчанию.

- [ ] **Step 1: Тесты**

```bash
git apply "$PATCHES/06-daily-digest-tests.patch"
```

Что в патче: `DAILY=true` в `DEFAULTS`; «сбоев нет, токен не проверяется» — с `DAILY=false`; раздел «дайджест раз в день»: дневной запуск — тишина и GraphQL не запрашивался, сбои всё равно приходят, утренний — дайджест есть; перед разделом «срок токена доски» — пустая `fixture`, чтобы проверки токена не получили дайджест.

- [ ] **Step 2: Новые проверки падают**

Run: `bash tests/reminders.sh | tail -1`
Expected: `итого: 64 ok, 3 fail`

- [ ] **Step 3: Реализация**

```bash
git apply "$PATCHES/06-daily-digest.patch"
```

Что в патче: перед дайджестом в `reminders.sh`

```bash
# ---------- дайджест ревью — раз в день, утром: чаще ментор просил не напоминать

[ "$DAILY" = "true" ] || exit 0
```

шапка скрипта и описание `DAILY`; комментарий к cron в `reminders.yml`; README — таблица и раздел «Напоминания о ревью» (дайджест в 10:00, сбои в 10:00, 15:00 и 20:00, ручной запуск всегда шлёт дайджест).

- [ ] **Step 4: Всё проходит**

Run: `bash tests/reminders.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 67 ok, 0 fail`, `lint ok`.

- [ ] **Step 5: Commit**

```bash
git add tests/reminders.sh scripts/reminders.sh .github/workflows/reminders.yml README.md
git commit -F - <<'EOF'
feat: дайджест ревью раз в сутки, в 10:00

Сбои уведомлений по-прежнему проверяются в 10:00, 15:00 и 20:00.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Алерт о новом репозитории организации

**Files:**
- Modify: `tests/reminders.sh` — патч `07-new-repos-tests.patch`
- Modify: `scripts/reminders.sh`, `.github/workflows/reminders.yml`, `README.md` — патч `07-new-repos.patch`

**Interfaces:**
- Consumes: `SINCE`, `SELF`, `REPOS`, `OPS_TOPIC` из `reminders.sh`.
- Produces: `esc <текст>`; `send <топик> <текст> [<reply_markup>]` (без третьего аргумента — пустая клавиатура). В тестах: хелпер `repo <имя> <создан> [описание]`, `ORG_URL`; env заглушки `ORG_REPOS`, `ORG_FAIL`, `NO_AUTOMATION` (репозитории без `automation.yml`, через пробел).

- [ ] **Step 1: Тесты**

```bash
git apply "$PATCHES/07-new-repos-tests.patch"
```

Что в патче: заглушка `gh` отвечает на `orgs/…/repos` и `repos/R/contents/.github/workflows/automation.yml` (404 для `NO_AUTOMATION`); раздел «новые репозитории»: неподключённый — `26`, «🆕 Новый репозиторий · claude-plugins» ссылкой, описание экранировано, «⚠️ не подключён: нет automation.yml, нет в REPOS (scripts/reminders.sh)», кнопка «Открыть репозиторий», старый `infra` не упомянут; есть `automation.yml`, но нет в `REPOS`; подключённый `figma` — без предупреждения; два новых — два сообщения; успешных запусков ещё не было — новые за 24 часа; созданные до прошлого запуска — тишина; список недоступен — `::warning::`; новый репозиторий и дайджест — два сообщения в разные топики.

- [ ] **Step 2: Новые проверки падают**

Run: `bash tests/reminders.sh | tail -1`
Expected: `итого: 69 ok, 13 fail`

- [ ] **Step 3: Реализация**

```bash
git apply "$PATCHES/07-new-repos.patch"
```

Что в патче — после сообщения «🚨 Сбои уведомлений», до дайджеста:

```bash
ORG=${SELF%%/*}
if NEW=$(gh api "orgs/$ORG/repos?per_page=100" --paginate \
    --jq ".[] | select(.created_at > \"$SINCE\") | [.full_name, .html_url, (.description // \"\")] | @tsv" 2>/dev/null); then
  while IFS=$'\t' read -r FULL HTML DESC; do
    [ -n "$FULL" ] || continue
    MISSING=""
    if ! ERRMSG=$(gh api "repos/$FULL/contents/.github/workflows/automation.yml" --jq .name 2>&1 >/dev/null); then
      case "$ERRMSG" in
        *"HTTP 404"*) MISSING="нет automation.yml" ;;
        *) echo "::warning::Не проверил automation.yml в $FULL" ;;
      esac
    fi
    case " ${REPOS[*]} " in
      *" $FULL "*) ;;
      *) MISSING="${MISSING:+$MISSING, }нет в REPOS (scripts/reminders.sh)" ;;
    esac
    TEXT=$(printf '<b>🆕 Новый репозиторий</b> · <a href="%s">%s</a>' "$HTML" "$(esc "${FULL#*/}")")
    [ -z "$DESC" ] || TEXT=$(printf '%s\n%s' "$TEXT" "$(esc "$DESC")")
    [ -z "$MISSING" ] || TEXT=$(printf '%s\n⚠️ не подключён: %s' "$TEXT" "$MISSING")
    send "$OPS_TOPIC" "$TEXT" "$(jq -nc --arg u "$HTML" '{inline_keyboard: [[{text: "Открыть репозиторий", url: $u}]]}')"
  done <<< "${NEW//$'\r'/}"
else
  echo "::warning::Не проверил новые репозитории $ORG"
fi
```

плюс `esc`, третий аргумент `send` (`local markup=${3:-'{"inline_keyboard":[]}'}`), шапка скрипта, комментарий к cron и README (таблица, абзац про `REPOS`).

- [ ] **Step 4: Всё проходит**

Run: `bash tests/telegram.sh | tail -1 && bash tests/reminders.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 125 ok, 0 fail`, `итого: 82 ok, 0 fail`, `lint ok`.

- [ ] **Step 5: Commit**

```bash
git add tests/reminders.sh scripts/reminders.sh .github/workflows/reminders.yml README.md
git commit -F - <<'EOF'
feat: алерт о новом репозитории организации

В каждом запуске напоминаний: репозитории, созданные после предыдущего успешного
запуска, — отдельным сообщением в общий топик, с подсказкой, чего не хватает
для подключения (automation.yml, список REPOS).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: PR и живые проверки

Хелперы:

```bash
R=Cringe-Driven-Development-Team/.github
last_run() { gh run list -R "$R" --workflow "$1" --event "$2" --limit 1 --json databaseId,conclusion --jq '.[0]'; }
tg_sent() { gh run view "$1" -R "$R" --log | grep -o '{"ok":true.*' | jq -r '"topic=\(.result.message_thread_id)\n\(.result.text)\n---"'; }
```

- [ ] **Step 1: Push и PR**

```bash
git push -u origin feature/alerts-polish
gh pr create -R "$R" --base main --head feature/alerts-polish \
  --title "Доработка алертов: описания, force-push, комментарии, кнопки, новые репозитории" --body-file - <<'EOF'
- описания задач без «â¦», markdown — разметкой Telegram, картинки ссылками
- force-push: коммиты поверх main и только новые; алерт о PR, который GitHub закрыл после force-push
- алерты о комментариях под задачами и в обсуждении PR
- кнопки под алертами о задачах, PR и запросах ревью
- дайджест ревью раз в сутки (10:00), сбои — как раньше, 3 раза в день
- алерт о новом репозитории организации

Спека: docs/superpowers/specs/2026-09-26-alerts-polish-design.md
План: docs/superpowers/plans/2026-09-26-alerts-polish.md

После мержа в каждый подключённый репозиторий нужно добавить в automation.yml триггер issue_comment — отдельными PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Expected: `last_run automation.yml pull_request` — success; `tg_sent <id>` — `topic=26`, «🔀 Открыт pull request · .github», кнопка «Открыть PR» видна в чате.

- [ ] **Step 2: Force-push вживую**

Этот репозиторий вызывает `telegram.yml` из своей ветки, поэтому force-push в ветку PR проходит через новую версию. Переписать последний коммит без изменений и запушить:

```bash
git commit --amend --no-edit && git push --force-with-lease origin feature/alerts-polish
```

Expected: `last_run automation.yml push` — success; `tg_sent <id>` — `topic=26`, «⚠️ force-push · .github · feature/alerts-polish», «ветка переписана: N коммитов поверх main, новых коммитов нет»; второго сообщения нет (PR открыт).

- [ ] **Step 3: Мерж**

```bash
PR=$(gh pr view feature/alerts-polish -R "$R" --json number --jq .number)
gh pr merge "$PR" -R "$R" --merge
git switch main && git pull --ff-only
```

Expected: `last_run automation.yml pull_request` — «🎉 Влито в main · .github» с кнопкой «Открыть PR».

- [ ] **Step 4: Ручной запуск напоминаний**

```bash
gh workflow run reminders.yml -R "$R" -f min_hours=0
```

Дождаться `last_run reminders.yml workflow_dispatch`, `gh run watch <id> -R "$R" --exit-status`.

```bash
gh run view <id> -R "$R" --log | grep -E '##\[warning\]|##\[error\]'
tg_sent <id>
```

Expected: success; предупреждений нет — значит, `GITHUB_TOKEN` читает список репозиториев организации и их `automation.yml`. Дайджест уходит (ручной запуск). «🆕 Новый репозиторий» приходит, только если после предыдущего успешного запуска создан репозиторий: `claude-plugins` (создан 2026-09-26 12:47 UTC) попадёт, лишь если с тех пор не было успешного запуска напоминаний, — иначе сообщений о репозиториях нет, и это не ошибка.

- [ ] **Step 5: Комментарий под задачей вживую**

`issue_comment` берёт workflow из `main`, а в `automation.yml` триггер пока есть только у `.github`. Оставить комментарий в любой открытой задаче `.github` (или создать задачу-песочницу и закрыть её после проверки — спросить пользователя, какую):

```bash
gh issue comment <номер> -R "$R" --body 'Проверка алерта: **жирный**, `код`'
```

Expected: `last_run automation.yml issue_comment` — success; `tg_sent <id>` — `topic=26`, «💬 Комментарий · .github», цитата `<b>жирный</b>, <code>код</code>`, кнопка «Открыть комментарий».

- [ ] **Step 6: Статус спеки**

```bash
sed -i 's/^Статус: спека$/Статус: реализовано 2026-09-26/' docs/superpowers/specs/2026-09-26-alerts-polish-design.md
grep -n '^Статус:' docs/superpowers/specs/2026-09-26-alerts-polish-design.md
git commit -am "docs: спека доработки алертов реализована" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 9: Триггер `issue_comment` в подключённых репозиториях

**Только после явного подтверждения пользователя**: PR уходят в репозитории команды, frontend и backend — в чужие организации.

Репозитории: `Cringe-Driven-Development-Team/{docs,static,infra,react,figma}`, `frontend-park-mail-ru/2026_2_Cringe_Driven_Development`, `go-park-mail-ru/2026_2_Cringe_Driven_Development`.

- [ ] **Step 1: Подтверждение**

Показать пользователю список и правку (две строки после `issues:`), спросить: открывать ли PR во все семь, в какие ветки (у frontend и backend — по их правилам, ветка `chore/issue-comment-alerts`), кого ставить ревьювером.

- [ ] **Step 2: PR в каждый репозиторий**

Для каждого `REPO` из подтверждённого списка:

```bash
REPO=<владелец/имя>
DIR=$(mktemp -d) && gh repo clone "$REPO" "$DIR" -- -q && cd "$DIR"
git switch -c chore/issue-comment-alerts
perl -0pi -e 's/(    types: \[opened, closed, reopened, edited\]\n)/$1  issue_comment:\n    types: [created]\n/' .github/workflows/automation.yml
git diff --stat
git commit -am "chore: алерты о комментариях в Telegram" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin chore/issue-comment-alerts
gh pr create --fill --body 'Добавляет триггер issue_comment: комментарии под задачами и в обсуждении PR приходят в Telegram. Подробности — https://github.com/Cringe-Driven-Development-Team/.github/blob/main/docs/superpowers/specs/2026-09-26-alerts-polish-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)'
cd - && rm -rf "${DIR:?}"
```

Expected: `git diff --stat` — `1 file changed, 2 insertions(+)`; если `0 files` — в репозитории свой `automation.yml` другой формы: остановиться и показать файл пользователю.

- [ ] **Step 3: Итог пользователю**

Что проверено вживую (force-push, открытие и мерж PR, кнопки, комментарий, ручной запуск напоминаний), что только тестами (PR, закрытый GitHub; комментарий в обсуждении PR; «🆕 Новый репозиторий», если не пришёл); ссылки на PR из Task 9 и что после их мержа комментарии пойдут и из этих репозиториев.
