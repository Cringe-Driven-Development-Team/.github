# Топик Code Review и напоминания о ревью — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сообщения о ревью — в отдельный топик «Code Review»; три раза в день напоминать ревьюверам о PR, которые ждут ответа 4 часа и дольше.

**Architecture:** `telegram.yml` читает новую переменную `TELEGRAM_REVIEW_TOPIC_ID` и шлёт туда «👀 Запрошено ревью», апрувы и правки; при открытии PR с ревьюверами один запуск шлёт два сообщения — в общий топик и в топик ревью. Напоминания — отдельный workflow `reminders.yml` по расписанию в `.github`: `scripts/reminders.sh` одним GraphQL-запросом собирает открытые PR семи репозиториев, отбирает ревьюверов, ждущих дольше порога, и шлёт дайджест. Тесты обоих скриптов делят заглушку `curl` и хелперы в `tests/lib.sh`.

**Tech Stack:** GitHub Actions (reusable + scheduled workflows), bash, jq, GNU date/awk, perl, `gh` CLI (GraphQL), actionlint, shellcheck. Рабочая машина — Windows, Git Bash.

**Spec:** `docs/superpowers/specs/2026-09-18-review-topic-and-reminders-design.md` (в этом же репозитории).

## Global Constraints

- Имя новой переменной: `TELEGRAM_REVIEW_TOPIC_ID`; пустая — всё в `TELEGRAM_TOPIC_ID`.
- В Code Review ссылку-упоминание получает только тот, кому действовать: ревьювер на запросе и напоминании, автор PR на апруве и правках. Остальные логины — текстом.
- Расписание: `0 7,12,17 * * *` (10:00, 15:00, 20:00 МСК). Порог по умолчанию — 4 часа. В дайджесте не больше 20 PR.
- Порог предупреждения об отключении cron — 50 дней без коммитов в `.github`; отключение — 60 дней.
- В публичный репозиторий не попадают настоящие ID: в тестах чат `-100`, топики `26` (общий) и `77` (ревью), карта `{"YarikMix":"111","blackHATred":"222"}`.
- Сообщения живых проверок идут в боевые топики — это ожидаемо.
- Коммиты: `<тип>: <что сделано>` по-русски со строчной буквы; последней строкой `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Описание PR заканчивается `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- PR мержатся merge-коммитом: `gh pr merge <N> --merge`.
- `actionlint` — только с `-shellcheck= -pyflakes=`: встроенный вызов shellcheck на этой машине зависает.
- Клон — `/f/Github/2026_H2/.github` (Git Bash), `core.autocrlf=true`, но `.gitattributes` держит LF. Инструменты `jq`, `shellcheck`, `actionlint`, `gh` в PATH.

## Карта файлов

| Файл | Что делает |
|---|---|
| `tests/stub-curl.sh` (новый) | заглушка curl: сохраняет каждое сообщение в `$SENT/<n>` — строка `topic=…`, дальше текст |
| `tests/lib.sh` (новый) | общие хелперы тестов: `when`, `sent`, `sent_to`, `only`, `before`, `silent`, `error`, `summary` |
| `tests/telegram.sh` | переходит на `lib.sh`; новые случаи раскладки по топикам |
| `.github/workflows/telegram.yml` | маршрутизация в топик ревью; функции `card`, `send`, `asked`; `mentions … plain` |
| `scripts/reminders.sh` (новый) | сбор ждущих ревью и отправка дайджеста |
| `tests/reminders.sh` (новый) | тесты напоминаний на фикстурах GraphQL |
| `.github/workflows/reminders.yml` (новый) | расписание и ручной запуск с `min_hours` |
| `tests/lint.sh` | shellcheck ещё и по `scripts/*.sh`, `tests/*.sh` |
| `README.md` | новые файлы, переменная, ручной запуск |

---

### Task 1: Общие хелперы тестов

Рефакторинг без изменения поведения: `tests/telegram.sh` переходит на заглушку, которая сохраняет все сообщения с топиком. Итог — те же 27 случаев зелёные.

**Files:**
- Create: `tests/stub-curl.sh`, `tests/lib.sh`
- Modify: `tests/telegram.sh` (шапка до `# --- задачи` и три последние строки)

**Interfaces:**
- Produces (`tests/lib.sh`, подключается `source` после того, как заданы `ROOT`; `SCRIPT` и `DEFAULTS` задаются до первого `when`):
  - `$TMP` — временная папка, `$TMP/bin` первым в PATH, в нём `curl`;
  - `when "<название>" VAR=значение…` — запускает `bash -e "$SCRIPT"` с `DEFAULTS` и переопределениями, выставляет `CODE`; сообщения — `$TMP/sent/1`, `$TMP/sent/2`…;
  - `sent "есть" "!нет"…` — первое сообщение; `sent_to <n> <топик|""> "есть" "!нет"…` — n-е сообщение в этом топике; `only <n>` — ровно n сообщений; `before "<a>" "<b>"` — в первом сообщении a выше b; `silent`; `error "<текст>"`; `summary` — итог и код выхода;
  - `pass` / `fail "<причина>"` — для своих проверок.

- [ ] **Step 1: Ветка**

```bash
cd /f/Github/2026_H2/.github
git switch main && git pull --ff-only
git switch -c feature/review-topic-and-reminders
```

- [ ] **Step 2: Заглушка curl**

Create `tests/stub-curl.sh`:

```bash
#!/usr/bin/env bash
# Заглушка curl для тестов: вместо отправки в Telegram сохраняет сообщение
# в $SENT/<номер> — первая строка topic=<message_thread_id>, дальше текст.
topic=""
text=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) case "$2" in message_thread_id=*) topic=${2#message_thread_id=} ;; esac; shift 2 ;;
    --data-urlencode) case "$2" in text=*) text=${2#text=} ;; esac; shift 2 ;;
    *) shift ;;
  esac
done
n=$(( $(find "$SENT" -type f | wc -l) + 1 ))
printf 'topic=%s\n%s' "$topic" "$text" > "$SENT/$n"
echo '{"ok":true}'
```

- [ ] **Step 3: Хелперы**

Create `tests/lib.sh`:

```bash
# Общее для тестов скриптов уведомлений: подключается через source.
# Перед подключением задать ROOT, SCRIPT (что запускать) и массив DEFAULTS (env по умолчанию).
# curl подменён заглушкой tests/stub-curl.sh: сообщения не уходят, а складываются в $TMP/sent.

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir "$TMP/bin"
cp "$ROOT/tests/stub-curl.sh" "$TMP/bin/curl"
chmod +x "$TMP/bin/curl"

PASS=0
FAIL=0

# when "название" VAR=значение ... — прогнать $SCRIPT с этим env
when() {
  NAME=$1
  shift
  rm -rf "$TMP/sent"
  mkdir "$TMP/sent"
  env PATH="$TMP/bin:$PATH" SENT="$TMP/sent" "${DEFAULTS[@]}" "$@" \
    bash -e "$SCRIPT" > "$TMP/out" 2>&1
  CODE=$?
}

pass() { PASS=$((PASS + 1)); echo "ok   $NAME"; }

fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL $NAME: $1"
  for f in "$TMP/sent"/*; do
    [ -f "$f" ] || continue
    sed 's/^/     | /' "$f"
    echo
  done
  sed 's/^/     > /' "$TMP/out"
}

sent_count() { find "$TMP/sent" -type f | wc -l; }

# sent_to <n> <топик> "есть" "!нет" ... — n-е сообщение ушло в этот топик (пустой — не проверяем),
# в нём есть одни куски и нет других
sent_to() {
  local n=$1 topic=$2 f="$TMP/sent/$1" s
  shift 2
  [ "$CODE" -eq 0 ] || { fail "код выхода $CODE"; return; }
  [ -f "$f" ] || { fail "сообщение $n не отправлено"; return; }
  [ -z "$topic" ] || [ "$(head -1 "$f")" = "topic=$topic" ] ||
    { fail "сообщение $n ушло в $(head -1 "$f"), ожидали topic=$topic"; return; }
  for s in "$@"; do
    case "$s" in
      !*) ! grep -qF -- "${s#!}" "$f" || { fail "лишнее «${s#!}» в сообщении $n"; return; } ;;
      *) grep -qF -- "$s" "$f" || { fail "нет «$s» в сообщении $n"; return; } ;;
    esac
  done
  pass
}

# sent "есть" "!нет" ... — первое сообщение, топик не важен
sent() { sent_to 1 "" "$@"; }

# only <n> — отправлено ровно n сообщений
only() {
  [ "$(sent_count)" -eq "$1" ] || { fail "отправлено $(sent_count), ожидали $1"; return; }
  pass
}

# before "раньше" "позже" — в первом сообщении первый кусок стоит выше второго
before() {
  local a b
  a=$(grep -nF -- "$1" "$TMP/sent/1" | head -1 | cut -d: -f1)
  b=$(grep -nF -- "$2" "$TMP/sent/1" | head -1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] || { fail "«$1» не выше «$2»"; return; }
  pass
}

# silent — отработал без ошибки и ничего не отправил
silent() {
  [ "$CODE" -eq 0 ] || { fail "код выхода $CODE"; return; }
  [ "$(sent_count)" -eq 0 ] || { fail "отправлено сообщений: $(sent_count)"; return; }
  pass
}

# error "текст" — упал до отправки и сказал почему
error() {
  [ "$CODE" -ne 0 ] || { fail "код выхода 0"; return; }
  [ "$(sent_count)" -eq 0 ] || { fail "отправлено сообщений: $(sent_count)"; return; }
  grep -qF -- "$1" "$TMP/out" || { fail "нет «$1» в выводе"; return; }
  pass
}

summary() {
  echo
  echo "итого: $PASS ok, $FAIL fail"
  [ "$FAIL" -eq 0 ]
}
```

- [ ] **Step 4: Шапка `tests/telegram.sh` на хелперах**

Заменить в `tests/telegram.sh` всё от первой строки до строки перед `# --- задачи` на:

```bash
#!/usr/bin/env bash
# Прогоняет скрипт из .github/workflows/telegram.yml на подставных событиях.
# Нужны bash, jq, perl, GNU date и awk. Запуск: bash tests/telegram.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/tests/lib.sh"

SCRIPT="$TMP/script.sh"
awk -f "$ROOT/tests/extract-run.awk" "$ROOT/.github/workflows/telegram.yml" > "$SCRIPT"
[ -s "$SCRIPT" ] || { echo "в telegram.yml не найден блок run: |"; exit 1; }

# так GitHub заполняет env: отсутствующее поле события — пустая строка, toJSON(null) — null.
# ID в карте и топиках ненастоящие: репозиторий публичный.
DEFAULTS=(
  TOKEN=test-token CHAT=-100 TOPIC=26 REVIEW_TOPIC=77 MAP='{"YarikMix":"111","blackHATred":"222"}'
  EVENT= ACTION= MERGED= DRAFT= BASE= REVIEW= REVIEWER= PR_AUTHOR=
  ACTOR=YarikMix REPO=Cringe-Driven-Development-Team/react
  NUMBER= TITLE= URL= BRANCH= COMMITS=null COMPARE= FORCED=
  BODY= ASSIGNEES=null CREATED= UPDATED= CHG_BODY=null
  REVIEWERS=null PR_CREATED=
)

# когда создан PR: ревьювер из формы создания приходит отдельным событием сразу после opened
LONG_AGO=$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ)
JUST_NOW=$(date -u -d '-5 seconds' +%Y-%m-%dT%H:%M:%SZ)

```

и заменить три последние строки

```bash
echo
echo "итого: $PASS ok, $FAIL fail"
[ "$FAIL" -eq 0 ]
```

на

```bash
summary
```

- [ ] **Step 5: Поведение не изменилось**

Run: `bash tests/telegram.sh | tail -1`
Expected: `итого: 27 ok, 0 fail`

- [ ] **Step 6: Commit**

```bash
git add tests/stub-curl.sh tests/lib.sh tests/telegram.sh
git commit -F - <<'EOF'
test: общие хелперы и заглушка curl, которая помнит топик каждого сообщения

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Раскладка сообщений по топикам в `telegram.yml`

**Files:**
- Modify: `.github/workflows/telegram.yml`
- Modify: `tests/telegram.sh`

**Interfaces:**
- Consumes: `sent_to`, `only` из `tests/lib.sh` (Task 1).
- Produces: env `REVIEW_TOPIC` в `telegram.yml`; внутри скрипта — `RTOPIC`, `DEST`, `KIND` (`opened` | `requested` | пусто), функции `mentions "<логины>" [plain]`, `asked`, `card "<заголовок>" "<строка>"`, `send "<топик>" "<текст>"`.

- [ ] **Step 1: Тесты раскладки**

В `tests/telegram.sh` заменить

```bash
sent "🔀 Открыт pull request" "WEB-5: Вход" 'автор: <a href="tg://user?id=111">YarikMix</a>' "!ревьювер"

when "review requested позже: автор и ревьювер" \
  EVENT=pull_request ACTION=review_requested DRAFT=false REVIEWER=blackHATred PR_AUTHOR=YarikMix \
  PR_CREATED="$LONG_AGO" NUMBER=7 TITLE=t URL=u
sent "👀 Запрошено ревью" \
  'автор: <a href="tg://user?id=111">YarikMix</a> · ревьювер: <a href="tg://user?id=222">blackHATred</a>'
```

на

```bash
sent_to 1 26 "🔀 Открыт pull request" "WEB-5: Вход" 'автор: <a href="tg://user?id=111">YarikMix</a>' "!ревьювер"
only 1

when "review requested позже: в Code Review, пинг ревьювера" \
  EVENT=pull_request ACTION=review_requested DRAFT=false REVIEWER=blackHATred PR_AUTHOR=YarikMix \
  PR_CREATED="$LONG_AGO" NUMBER=7 TITLE=t URL=u
sent_to 1 77 "👀 Запрошено ревью" \
  'автор: YarikMix · ревьювер: <a href="tg://user?id=222">blackHATred</a>'
only 1
```

заменить

```bash
sent "🎉 Влито в main"
```

(в случае `"pr влит в main"`) на

```bash
sent_to 1 26 "🎉 Влито в main"
```

заменить

```bash
when "review approved: упомянут автор PR" \
  EVENT=pull_request_review ACTION=submitted REVIEW=approved PR_AUTHOR=blackHATred NUMBER=7 TITLE=t URL=u
sent "👍 Апрув" 'tg://user?id=222'
```

на

```bash
when "review approved: в Code Review, пинг автора PR" \
  EVENT=pull_request_review ACTION=submitted REVIEW=approved PR_AUTHOR=blackHATred NUMBER=7 TITLE=t URL=u
sent_to 1 77 "👍 Апрув" 'tg://user?id=222'

when "review changes requested: в Code Review, пинг автора PR" \
  EVENT=pull_request_review ACTION=submitted REVIEW=changes_requested PR_AUTHOR=blackHATred NUMBER=7 TITLE=t URL=u
sent_to 1 77 "✋ Запрошены правки" 'tg://user?id=222'
```

и заменить

```bash
sent "🔀 Открыт pull request" \
  'автор: <a href="tg://user?id=111">YarikMix</a> · ревьювер: <a href="tg://user?id=222">blackHATred</a>, iRedTea'

when "ready: ревьюверы, выбранные в черновике" \
  EVENT=pull_request ACTION=ready_for_review DRAFT=false NUMBER=7 TITLE=t URL=u ACTOR=iRedTea \
  PR_AUTHOR=YarikMix REVIEWERS='[{"login":"blackHATred"}]'
sent "🔀 Открыт pull request" \
  'автор: <a href="tg://user?id=111">YarikMix</a> · ревьювер: <a href="tg://user?id=222">blackHATred</a>'
```

на

```bash
sent_to 1 26 "🔀 Открыт pull request" \
  'автор: <a href="tg://user?id=111">YarikMix</a> · ревьювер: blackHATred, iRedTea' "!tg://user?id=222"
sent_to 2 77 "👀 Запрошено ревью" \
  'автор: YarikMix · ревьювер: <a href="tg://user?id=222">blackHATred</a>, iRedTea' "!tg://user?id=111"
only 2

when "ready: ревьюверы, выбранные в черновике" \
  EVENT=pull_request ACTION=ready_for_review DRAFT=false NUMBER=7 TITLE=t URL=u ACTOR=iRedTea \
  PR_AUTHOR=YarikMix REVIEWERS='[{"login":"blackHATred"}]'
sent_to 1 26 "🔀 Открыт pull request" \
  'автор: <a href="tg://user?id=111">YarikMix</a> · ревьювер: blackHATred' "!tg://user?id=222"
sent_to 2 77 "👀 Запрошено ревью" \
  'автор: YarikMix · ревьювер: <a href="tg://user?id=222">blackHATred</a>'
only 2

when "без TELEGRAM_REVIEW_TOPIC_ID: оба сообщения в обычный топик" \
  REVIEW_TOPIC= EVENT=pull_request ACTION=opened DRAFT=false NUMBER=7 TITLE=t URL=u PR_AUTHOR=YarikMix \
  REVIEWERS='[{"login":"blackHATred"}]'
sent_to 1 26 "🔀 Открыт pull request"
sent_to 2 26 "👀 Запрошено ревью"

when "без TELEGRAM_REVIEW_TOPIC_ID: апрув в обычный топик" \
  REVIEW_TOPIC= EVENT=pull_request_review ACTION=submitted REVIEW=approved PR_AUTHOR=blackHATred NUMBER=7 TITLE=t URL=u
sent_to 1 26 "👍 Апрув"
```

- [ ] **Step 2: Новые проверки падают**

Run: `bash tests/telegram.sh | grep -E '^(FAIL|итого)'`
Expected: `итого: 27 ok, 10 fail`; падают «review requested позже», «review approved», «review changes requested» (топик 26 вместо 77), «pr opened с ревьюверами из формы» и «ready» (нет второго сообщения, ревьюверы со ссылками), «без TELEGRAM_REVIEW_TOPIC_ID: оба сообщения» (нет второго).

- [ ] **Step 3: Переменная топика ревью**

В `.github/workflows/telegram.yml` заменить

```yaml
          TOPIC:     ${{ vars.TELEGRAM_TOPIC_ID }}
```

на

```yaml
          TOPIC:     ${{ vars.TELEGRAM_TOPIC_ID }}
          REVIEW_TOPIC: ${{ vars.TELEGRAM_REVIEW_TOPIC_ID }}
```

и заменить

```bash
          # у открытия PR и запроса ревью вместо одного логина — автор и ревьюверы
          ROLES=""
          REVS=""
```

на

```bash
          # всё про ревью — в отдельный топик; не задан — в обычный
          RTOPIC="${REVIEW_TOPIC:-$TOPIC}"
          DEST="$TOPIC"
          # opened — открытие PR, requested — запрос ревью: вместо одного логина автор и ревьюверы
          KIND=""
          REVS=""
```

- [ ] **Step 4: Куда идут события**

Заменить

```bash
              REVS=$(printf '%s' "$REVIEWERS" | jq -r '[.[]?.login] | join(" ")')
              ROLES=1
              HEAD="🔀 Открыт pull request" ;;
```

на

```bash
              REVS=$(printf '%s' "$REVIEWERS" | jq -r '[.[]?.login] | join(" ")')
              KIND=opened
              HEAD="🔀 Открыт pull request" ;;
```

заменить

```bash
              REVS="$REVIEWER"
              ROLES=1
              HEAD="👀 Запрошено ревью" ;;
```

на

```bash
              REVS="$REVIEWER"
              KIND=requested
              DEST="$RTOPIC"
              HEAD="👀 Запрошено ревью" ;;
```

и заменить

```bash
            pull_request_review:submitted)
              case "$REVIEW" in
```

на

```bash
            pull_request_review:submitted)
              DEST="$RTOPIC"
              case "$REVIEW" in
```

- [ ] **Step 5: Хелперы сообщений**

Заменить

```bash
          # "a b" → упоминания через запятую
          mentions () {
            ML=""
            for N in $1; do
              [ -n "$ML" ] && ML="$ML, "
              ML="$ML$(mention "$N")"
            done
            printf '%s' "$ML"
          }
```

на

```bash
          # "a b" → упоминания через запятую; mentions "a b" plain — логины без ссылок
          mentions () {
            ML=""
            for N in $1; do
              [ -n "$ML" ] && ML="$ML, "
              if [ "${2:-}" = "plain" ]; then
                ML="$ML$(esc "$N")"
              else
                ML="$ML$(mention "$N")"
              fi
            done
            printf '%s' "$ML"
          }

          # строка запроса ревью: пингуем тех, кого ждут, автор — текстом
          asked () { printf 'автор: %s · ревьювер: %s' "$(esc "$PR_AUTHOR")" "$(mentions "$REVS")"; }

          # карточка задачи или PR: заголовок · сторона, ссылка, строка с людьми
          card () {
            printf '<b>%s</b> · %s\n<a href="%s">%s%s</a>\n%s%s' \
              "$1" "$SIDE" "$URL" "$REF" "$(esc "$TITLE")" "$2" "$EXTRA"
          }

          # send <топик> <текст> — отправить в Telegram; отказ валит job
          send () {
            RESP=$(curl -sS -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
              -d chat_id="$CHAT" \
              -d message_thread_id="$1" \
              -d parse_mode=HTML \
              -d disable_web_page_preview=true \
              --data-urlencode reply_markup="$MARKUP" \
              --data-urlencode text="$2")
            echo "$RESP"
            case "$RESP" in
              *'"ok":true'*) ;;
              *) echo "::error::Telegram отклонил сообщение"; exit 1 ;;
            esac
          }
```

- [ ] **Step 6: Сборка и отправка**

Заменить конец скрипта — от `            elif [ -n "$ROLES" ]; then` до последней строки файла:

```bash
            elif [ -n "$ROLES" ]; then
              REF=""
              LINE="автор: $(mention "$PR_AUTHOR")"
              [ -n "$REVS" ] && LINE="$LINE · ревьювер: $(mentions "$REVS")"
            else
              REF=""
              LINE=$(mention "$WHO")
            fi

            TEXT=$(printf '<b>%s</b> · %s\n<a href="%s">%s%s</a>\n%s%s' \
              "$HEAD" "$SIDE" "$URL" "$REF" "$(esc "$TITLE")" "$LINE" "$EXTRA")
          fi

          RESP=$(curl -sS -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
            -d chat_id="$CHAT" \
            -d message_thread_id="$TOPIC" \
            -d parse_mode=HTML \
            -d disable_web_page_preview=true \
            --data-urlencode reply_markup="$MARKUP" \
            --data-urlencode text="$TEXT")

          echo "$RESP"

          case "$RESP" in
            *'"ok":true'*) ;;
            *) echo "::error::Telegram отклонил сообщение"; exit 1 ;;
          esac
```

на

```bash
            else
              REF=""
              case "$KIND" in
                # в общем топике ревьюверы текстом: пинг им уйдёт в топик ревью
                opened)
                  LINE="автор: $(mention "$PR_AUTHOR")"
                  [ -n "$REVS" ] && LINE="$LINE · ревьювер: $(mentions "$REVS" plain)" ;;
                requested) LINE=$(asked) ;;
                *)         LINE=$(mention "$WHO") ;;
              esac
            fi

            TEXT=$(card "$HEAD" "$LINE")
          fi

          send "$DEST" "$TEXT"

          # ревьюверы, выбранные при создании PR или в черновике, — запрос ревью в топик ревью
          if [ "$KIND" = "opened" ] && [ -n "$REVS" ]; then
            send "$RTOPIC" "$(card "👀 Запрошено ревью" "$(asked)")"
          fi
```

- [ ] **Step 7: Всё проходит**

Run: `bash tests/telegram.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 37 ok, 0 fail`, затем `lint ok`.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/telegram.yml tests/telegram.sh
git commit -F - <<'EOF'
feat: сообщения о ревью — в топик Code Review

- «👀 Запрошено ревью», апрув и правки идут в TELEGRAM_REVIEW_TOPIC_ID (без неё — в общий топик)
- при открытии PR с ревьюверами: «Открыт pull request» в общий топик с ревьюверами текстом
  и «👀 Запрошено ревью» с их пингом в топик ревью
- в «👀» автор текстом: пингуем только тех, кого ждут

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Скрипт напоминаний

**Files:**
- Create: `tests/reminders.sh`
- Create: `scripts/reminders.sh`

**Interfaces:**
- Consumes: `tests/lib.sh` (Task 1).
- Produces: `scripts/reminders.sh` — env `TOKEN`, `CHAT`, `TOPIC`, `MAP`, `MIN_HOURS` (по умолчанию 4), `GH_TOKEN` (для `gh`); для тестов `NOW` (unix-время) и `LAST_COMMIT` (ISO-дата). Выход 0 — отправил дайджест или нечего слать; 1 — нет токена/чата, ошибка `gh` или отказ Telegram.

- [ ] **Step 1: Тесты**

Create `tests/reminders.sh`:

```bash
#!/usr/bin/env bash
# Прогоняет scripts/reminders.sh на подставных ответах GitHub.
# gh подменён заглушкой: отдаёт $TMP/fixture.json, запрос сохраняет в $TMP/query.
# Нужны bash, jq и GNU date. Запуск: bash tests/reminders.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/tests/lib.sh"
SCRIPT="$ROOT/scripts/reminders.sh"

cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
# заглушка gh api graphql: запомнить запрос, отдать фикстуру или упасть
for a in "$@"; do case "$a" in query=*) printf '%s' "${a#query=}" > "$QUERY_FILE" ;; esac; done
[ -z "${GH_FAIL:-}" ] || { echo "gh: HTTP 502" >&2; exit 1; }
cat "$FIXTURE"
STUB
chmod +x "$TMP/bin/gh"

# «сейчас» во всех случаях — 2026-09-20 12:00 UTC. ID в карте и топике ненастоящие.
DEFAULTS=(
  TOKEN=test-token CHAT=-100 TOPIC=77 MAP='{"YarikMix":"111","blackHATred":"222"}'
  MIN_HOURS=4 NOW="$(date -u -d 2026-09-20T12:00:00Z +%s)" LAST_COMMIT=2026-09-19T12:00:00Z
  FIXTURE="$TMP/fixture.json" QUERY_FILE="$TMP/query"
)

FRONT=frontend-park-mail-ru/2026_2_Cringe_Driven_Development
BACK=go-park-mail-ru/2026_2_Cringe_Driven_Development

# pr <репозиторий> <заголовок> <создан> <черновик: true|false> <что было…>
#   wait:<логин>        — логин сейчас в Reviewers
#   team                — в Reviewers команда (логина нет)
#   req:<логин>@<время> — у логина запрошено ревью
#   ready@<время>       — PR переведён из черновика в Ready
pr() {
  local repo=$1 title=$2 created=$3 draft=$4
  shift 4
  jq -nc --arg repo "$repo" --arg title "$title" --arg created "$created" --argjson draft "$draft" '
    {repo: $repo, title: $title, url: "https://github.com/\($repo)/pull/1", isDraft: $draft, createdAt: $created,
     reviewRequests: {nodes: [$ARGS.positional[]
       | (select(startswith("wait:")) | {requestedReviewer: {login: .[5:]}}),
         (select(. == "team") | {requestedReviewer: {}})]},
     timelineItems: {nodes: [$ARGS.positional[]
       | (select(startswith("req:")) | .[4:] | split("@")
          | {__typename: "ReviewRequestedEvent", createdAt: .[1], requestedReviewer: {login: .[0]}}),
         (select(startswith("ready@")) | {__typename: "ReadyForReviewEvent", createdAt: .[6:]})]}}' \
    --args "$@"
}

# fixture <pr>… — ответ GraphQL: PR разложены по своим репозиториям
fixture() {
  printf '%s\n' "$@" | jq -s '{data: (group_by(.repo) | to_entries
    | map({key: "r\(.key)", value: {nameWithOwner: .value[0].repo, pullRequests: {nodes: (.value | map(del(.repo)))}}})
    | from_entries)}' > "$TMP/fixture.json"
}

# --- кого показываем

fixture
when "нет открытых PR — тишина"
silent

when "запрос покрывает все семь репозиториев"
missing=""
for r in Cringe-Driven-Development-Team/.github Cringe-Driven-Development-Team/docs \
  Cringe-Driven-Development-Team/static Cringe-Driven-Development-Team/infra \
  Cringe-Driven-Development-Team/react "$FRONT" "$BACK"; do
  grep -qF "owner: \"${r%%/*}\", name: \"${r#*/}\"" "$TMP/query" || missing="$missing $r"
done
if [ -z "$missing" ]; then pass; else fail "в запросе нет:$missing"; fi

fixture "$(pr "$BACK" "API-3: Черновик" 2026-09-18T12:00:00Z true wait:blackHATred req:blackHATred@2026-09-18T12:00:00Z)"
when "черновик пропущен"
silent

fixture "$(pr "$BACK" "API-3: Рано" 2026-09-20T08:00:00Z false wait:blackHATred req:blackHATred@2026-09-20T08:01:00Z)"
when "3 ч 59 мин — ещё рано"
silent

fixture "$(pr "$BACK" "API-3: Порог" 2026-09-20T08:00:00Z false wait:blackHATred req:blackHATred@2026-09-20T08:00:00Z)"
when "ровно 4 ч — в дайджесте"
sent_to 1 77 "<b>⏰ Ждут ревью</b>" \
  "• backend · <a href=\"https://github.com/$BACK/pull/1\">API-3: Порог</a>" \
  '  <a href="tg://user?id=222">blackHATred</a> · ждёт 4 ч'
only 1

fixture "$(pr "$BACK" "API-3: Ready" 2026-09-18T12:00:00Z false wait:blackHATred req:blackHATred@2026-09-18T12:00:00Z ready@2026-09-20T06:00:00Z)"
when "переведён в Ready позже запроса — счёт от Ready"
sent "blackHATred</a> · ждёт 6 ч"

fixture "$(pr "$BACK" "API-3: Старый" 2026-09-19T06:00:00Z false wait:blackHATred)"
when "запроса нет в истории — счёт от создания PR"
sent "blackHATred</a> · ждёт 1 д 6 ч"

fixture "$(pr "$BACK" "API-3: Двое суток" 2026-09-18T12:00:00Z false wait:blackHATred req:blackHATred@2026-09-18T12:00:00Z)"
when "ровно двое суток — без часов"
sent "· ждёт 2 д" "!2 д 0 ч"

fixture "$(pr "$BACK" "API-3: Команда" 2026-09-18T12:00:00Z false team)"
when "запрос у команды пропущен"
silent

fixture "$(pr "$BACK" "API-3: Только что" 2026-09-20T11:55:00Z false wait:blackHATred req:blackHATred@2026-09-20T11:55:00Z)"
when "MIN_HOURS=0 — все, кто висит" MIN_HOURS=0
sent "blackHATred</a> · ждёт 0 ч"

# --- порядок и формат

fixture \
  "$(pr "$BACK" "API-3: Два ревьювера" 2026-09-19T10:00:00Z false \
     wait:YarikMix wait:blackHATred req:blackHATred@2026-09-19T10:00:00Z req:YarikMix@2026-09-20T07:00:00Z)" \
  "$(pr "$FRONT" "WEB-9: Дольше всех" 2026-09-18T12:00:00Z false wait:iRedTea req:iRedTea@2026-09-18T12:00:00Z)"
when "два ревьювера — две строки, сверху кто ждёт дольше"
sent "• frontend · " "  iRedTea · ждёт 2 д" \
  '  <a href="tg://user?id=222">blackHATred</a> · ждёт 1 д 2 ч' \
  '  <a href="tg://user?id=111">YarikMix</a> · ждёт 5 ч'
before "WEB-9: Дольше всех" "API-3: Два ревьювера"
before "blackHATred" "YarikMix"

fixture "$(pr "$BACK" "API-3: Фикс <b> & ко" 2026-09-18T12:00:00Z false wait:blackHATred)"
when "заголовок экранирован"
sent "API-3: Фикс &lt;b&gt; &amp; ко"

prs=()
for i in $(seq 1 22); do
  prs+=("$(pr "$BACK" "API-$i: PR" 2026-09-18T12:00:00Z false wait:blackHATred)")
done
fixture "${prs[@]}"
when "больше 20 PR — «…и ещё N»"
sent "…и ещё 2"
if [ "$(grep -c '^• ' "$TMP/sent/1")" -eq 20 ]; then pass; else fail "строк PR не 20"; fi

# --- предупреждение об отключении cron

fixture "$(pr "$BACK" "API-3: PR" 2026-09-18T12:00:00Z false wait:blackHATred)"
when "52 дня без коммитов — предупреждение в конце дайджеста" LAST_COMMIT=2026-07-30T12:00:00Z
sent "⏰ Ждут ревью" "⚠️ Напоминания отключатся примерно через 8 дней без коммитов в .github" \
  "gh workflow enable reminders.yml -R Cringe-Driven-Development-Team/.github"
before "API-3: PR" "⚠️"

fixture
when "59 дней без коммитов и нет PR — предупреждение отдельно" LAST_COMMIT=2026-07-23T12:00:00Z
sent_to 1 77 "примерно через 1 день" "!Ждут ревью"
only 1

fixture
when "61 день без коммитов — «в любой момент»" LAST_COMMIT=2026-07-21T12:00:00Z
sent "могут отключиться в любой момент"

fixture
when "49 дней без коммитов — без предупреждения" LAST_COMMIT=2026-08-02T12:00:00Z
silent

# --- ошибки

fixture
when "ошибка gh — выход 1" GH_FAIL=1
error "HTTP 502"

when "нет токена" TOKEN=
error "TELEGRAM_BOT_TOKEN"

summary
```

- [ ] **Step 2: Тесты падают — скрипта ещё нет**

Run: `bash tests/reminders.sh 2>/dev/null | tail -1`
Expected: `итого: 0 ok, 25 fail` — каждый случай падает с кодом выхода 127 (`bash: …/scripts/reminders.sh: No such file or directory`). В stderr будут жалобы `grep` на отсутствующие файлы — это ожидаемо.

- [ ] **Step 3: Скрипт**

Create `scripts/reminders.sh`:

```bash
#!/usr/bin/env bash
# Напоминает в Telegram ревьюверам открытых PR, которые ждут ответа дольше MIN_HOURS часов.
# Env: GH_TOKEN, TOKEN (бот), CHAT, TOPIC, MAP (github-логин → telegram id), MIN_HOURS (по умолчанию 4).
# Для тестов: NOW — «сейчас» в unix-времени, LAST_COMMIT — дата последнего коммита .github.
set -euo pipefail

REPOS=(
  Cringe-Driven-Development-Team/.github
  Cringe-Driven-Development-Team/docs
  Cringe-Driven-Development-Team/static
  Cringe-Driven-Development-Team/infra
  Cringe-Driven-Development-Team/react
  frontend-park-mail-ru/2026_2_Cringe_Driven_Development
  go-park-mail-ru/2026_2_Cringe_Driven_Development
)
LIMIT=20        # больше PR в сообщение не влезет: у Telegram лимит 4096 символов
WARN_DAYS=50    # GitHub отключает cron в публичном репо после 60 дней без активности

[ -n "${TOKEN:-}" ] || { echo "::error::Не задан секрет TELEGRAM_BOT_TOKEN"; exit 1; }
[ -n "${CHAT:-}" ] || { echo "::error::Не задана переменная TELEGRAM_CHAT_ID"; exit 1; }

MIN_HOURS=${MIN_HOURS:-4}
NOW=${NOW:-$(date +%s)}
LAST_COMMIT=${LAST_COMMIT:-$(git log -1 --format=%cI)}
MAP=${MAP:-}
[ -n "$MAP" ] || MAP='{}'

# один запрос на все репозитории: открытые PR, кто в Reviewers, когда запрошено ревью и PR переведён в Ready
FIELDS='pullRequests(states: OPEN, first: 50) { nodes {
  title url isDraft createdAt
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  timelineItems(last: 100, itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT]) { nodes {
    __typename
    ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
    ... on ReadyForReviewEvent { createdAt }
  } }
} }'
QUERY="query {"
for i in "${!REPOS[@]}"; do
  QUERY="$QUERY r$i: repository(owner: \"${REPOS[$i]%%/*}\", name: \"${REPOS[$i]#*/}\") { nameWithOwner $FIELDS }"
done
QUERY="$QUERY }"

DATA=$(gh api graphql -f query="$QUERY")

# строки дайджеста: PR, где кто-то ждёт дольше порога; сверху те, кто ждёт дольше всех
BODY=$(printf '%s' "$DATA" | jq -r --argjson now "$NOW" --argjson min "$((MIN_HOURS * 3600))" \
  --argjson limit "$LIMIT" --argjson map "$MAP" '
  def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
  def who: if $map[.] then "<a href=\"tg://user?id=\($map[.])\">\(esc)</a>" else esc end;
  def dur: (. / 3600 | floor) as $h
    | if $h < 24 then "\($h) ч"
      elif $h % 24 == 0 then "\($h / 24 | floor) д"
      else "\($h / 24 | floor) д \($h % 24) ч" end;
  def side: if startswith("frontend-park-mail-ru/") then "frontend"
    elif startswith("go-park-mail-ru/") then "backend"
    else sub("^[^/]*/"; "") end;

  [ .data[] | .nameWithOwner as $repo | .pullRequests.nodes[] | select(.isDraft | not) | . as $pr
    | ([.timelineItems.nodes[] | select(.__typename == "ReadyForReviewEvent") | .createdAt] | max) as $ready
    | [ .reviewRequests.nodes[] | .requestedReviewer.login // empty | . as $login
        | ([$pr.timelineItems.nodes[]
            | select(.__typename == "ReviewRequestedEvent" and .requestedReviewer.login == $login)
            | .createdAt] | max // $pr.createdAt) as $asked
        | {login: $login, wait: ($now - ([$asked, $ready] | map(select(. != null)) | max | fromdateiso8601))}
        | select(.wait >= $min) ]
    | select(length > 0)
    | {repo: $repo, title: $pr.title, url: $pr.url, reviewers: sort_by(-.wait)} ]
  | sort_by(-.reviewers[0].wait)
  | (.[:$limit] | map(
        "• \(.repo | side) · <a href=\"\(.url)\">\(.title | esc)</a>\n"
        + (.reviewers | map("  \(.login | who) · ждёт \(.wait | dur)") | join("\n"))
      ) | join("\n"))
    + (if length > $limit then "\n…и ещё \(length - $limit)" else "" end)')

# 1 день / 2 дня / 5 дней
days () {
  case "$(($1 % 100))" in
    11|12|13|14) printf '%s дней' "$1" ;;
    *) case "$(($1 % 10))" in
         1)     printf '%s день' "$1" ;;
         2|3|4) printf '%s дня' "$1" ;;
         *)     printf '%s дней' "$1" ;;
       esac ;;
  esac
}

WARN=""
IDLE=$(( (NOW - $(date -d "$LAST_COMMIT" +%s)) / 86400 ))
if [ "$IDLE" -ge "$WARN_DAYS" ]; then
  LEFT=$((60 - IDLE))
  ENABLE='<code>gh workflow enable reminders.yml -R Cringe-Driven-Development-Team/.github</code>'
  if [ "$LEFT" -gt 0 ]; then
    WARN="⚠️ Напоминания отключатся примерно через $(days "$LEFT") без коммитов в .github."
  else
    WARN="⚠️ Напоминания могут отключиться в любой момент: в .github давно не было коммитов."
  fi
  WARN="$WARN Сделайте любой коммит или включите вручную: $ENABLE"
fi

TEXT=""
[ -n "$BODY" ] && TEXT=$(printf '<b>⏰ Ждут ревью</b>\n\n%s' "$BODY")
if [ -n "$WARN" ]; then
  if [ -n "$TEXT" ]; then TEXT=$(printf '%s\n\n%s' "$TEXT" "$WARN"); else TEXT="$WARN"; fi
fi
[ -n "$TEXT" ] || exit 0

RESP=$(curl -sS -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
  -d chat_id="$CHAT" \
  -d message_thread_id="${TOPIC:-}" \
  -d parse_mode=HTML \
  -d disable_web_page_preview=true \
  --data-urlencode text="$TEXT")
echo "$RESP"
case "$RESP" in
  *'"ok":true'*) ;;
  *) echo "::error::Telegram отклонил сообщение"; exit 1 ;;
esac
```

- [ ] **Step 4: Тесты проходят**

Run: `bash tests/reminders.sh | tail -1`
Expected: `итого: 25 ok, 0 fail`

- [ ] **Step 5: Тесты ловят ошибки**

По очереди испортить скрипт и убедиться, что тесты падают; после каждой проверки вернуть файл.

```bash
cp scripts/reminders.sh /tmp/rem.bak
for m in 's/select(.wait >= \$min)/select(.wait > $min)/' \
         's/select(.isDraft | not) | //' \
         's/reviewers: sort_by(-.wait)/reviewers: sort_by(.wait)/'; do
  cp /tmp/rem.bak scripts/reminders.sh
  sed -i "$m" scripts/reminders.sh
  echo "== $m"; bash tests/reminders.sh | grep -E '^(FAIL|итого)'
done
cp /tmp/rem.bak scripts/reminders.sh
bash tests/reminders.sh | tail -1
```

Expected: первая порча — падает «ровно 4 ч»; вторая — «черновик пропущен»; третья — «два ревьювера…»; в конце снова `итого: 25 ok, 0 fail`.

- [ ] **Step 6: Запрос к живому API**

Прогнать скрипт с настоящим `gh` (свой токен), но с заглушкой вместо Telegram:

```bash
mkdir -p /tmp/rbin /tmp/rsent && rm -f /tmp/rsent/*
cp tests/stub-curl.sh /tmp/rbin/curl && chmod +x /tmp/rbin/curl
env PATH="/tmp/rbin:$PATH" SENT=/tmp/rsent TOKEN=x CHAT=-100 TOPIC=77 MAP='{}' MIN_HOURS=0 bash scripts/reminders.sh
echo "exit=$?"; cat /tmp/rsent/* 2>/dev/null
```

Expected: `exit=0`; если в каком-то из семи репозиториев есть открытый PR с ревьювером — в `/tmp/rsent/1` дайджест с ним, иначе файлов нет. Ошибка GraphQL здесь означает опечатку в запросе.

- [ ] **Step 7: Commit**

```bash
git add scripts/reminders.sh tests/reminders.sh
git commit -F - <<'EOF'
feat: скрипт напоминаний ревьюверам

Один GraphQL-запрос на семь репозиториев, ревьюверы из Reviewers открытых PR (не черновиков),
ждущие дольше MIN_HOURS — от последнего запроса ревью или перевода в Ready. Дайджест до 20 PR,
предупреждение, если в .github 50+ дней нет коммитов и cron скоро отключится.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Расписание, линтер, README

**Files:**
- Create: `.github/workflows/reminders.yml`
- Modify: `tests/lint.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: `scripts/reminders.sh` и его env (Task 3).
- Produces: workflow `reminders.yml` с `workflow_dispatch` и входом `min_hours` — Task 5 запускает его вручную.

- [ ] **Step 1: Workflow**

Create `.github/workflows/reminders.yml`:

```yaml
name: Напоминания о ревью

on:
  schedule:
    # 10:00, 15:00, 20:00 по Москве; GitHub может запустить на 5–15 минут позже
    - cron: '0 7,12,17 * * *'
  workflow_dispatch:
    inputs:
      min_hours:
        description: Сколько часов ревью должно ждать, чтобы попасть в напоминание
        default: '4'

permissions:
  contents: read

jobs:
  remind:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Напомнить ревьюверам
        env:
          GH_TOKEN:  ${{ github.token }}
          TOKEN:     ${{ secrets.TELEGRAM_BOT_TOKEN }}
          CHAT:      ${{ vars.TELEGRAM_CHAT_ID }}
          TOPIC:     ${{ vars.TELEGRAM_REVIEW_TOPIC_ID || vars.TELEGRAM_TOPIC_ID }}
          MAP:       ${{ vars.TELEGRAM_USER_MAP }}
          MIN_HOURS: ${{ inputs.min_hours || '4' }}
        run: bash scripts/reminders.sh
```

- [ ] **Step 2: Линтер — скрипты и тесты файлами**

В `tests/lint.sh` заменить строку комментария

```bash
# shellcheck запускается отдельно: встроенный вызов из actionlint на Windows зависает.
```

на

```bash
# Встроенный в actionlint вызов shellcheck на Windows зависает, поэтому он запускается отдельно.
```

(строка, начинающаяся с `# shellcheck`, — директива для самого shellcheck, а lint.sh теперь проверяет и себя), и заменить

```bash
  shellcheck -s bash -S warning "$TMP/run.sh" || { echo "shellcheck: замечания в $wf"; exit 1; }
done
```

на

```bash
  shellcheck -s bash -S warning "$TMP/run.sh" || { echo "shellcheck: замечания в $wf"; exit 1; }
done

# скрипты и тесты лежат файлами — проверяются как есть
shellcheck -s bash -S warning -x scripts/*.sh tests/*.sh
```

Run: `bash tests/lint.sh`
Expected: `lint ok`

- [ ] **Step 3: README**

В `README.md` заменить

```markdown
| `.github/workflows/automation.yml` | подключает оба workflow к этому репозиторию |
| `tests/` | тесты скрипта уведомлений и линтер |
```

на

```markdown
| `.github/workflows/automation.yml` | подключает оба workflow к этому репозиторию |
| `.github/workflows/reminders.yml` | в 10:00, 15:00 и 20:00 МСК напоминает ревьюверам о PR, которые ждут ответа 4 часа и дольше |
| `scripts/reminders.sh` | логика напоминаний |
| `tests/` | тесты скриптов и линтер |
```

заменить

```markdown
- переменные `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ID` и, по желанию, `TELEGRAM_USER_MAP` — JSON `{"github-логин": "telegram id"}`: логины из карты упоминаются кликабельно.
```

на

```markdown
- переменные `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ID` и, по желанию:
  - `TELEGRAM_REVIEW_TOPIC_ID` — топик для сообщений о ревью: запросы, апрувы, правки, напоминания. Без неё всё идёт в `TELEGRAM_TOPIC_ID`;
  - `TELEGRAM_USER_MAP` — JSON `{"github-логин": "telegram id"}`: логины из карты упоминаются кликабельно.
```

заменить

```markdown
   bash tests/telegram.sh
   bash tests/lint.sh
```

на

```markdown
   bash tests/telegram.sh
   bash tests/reminders.sh
   bash tests/lint.sh
```

и добавить в конец файла:

````markdown

## Напоминания о ревью

Запускаются по расписанию из `main`. Проверить вручную, не дожидаясь порога в 4 часа:

```bash
gh workflow run reminders.yml -R Cringe-Driven-Development-Team/.github -f min_hours=0
```

GitHub отключает расписание в публичном репозитории, если в нём 60 дней нет активности. За 10 дней до этого напоминания начинают предупреждать; включить обратно: `gh workflow enable reminders.yml -R Cringe-Driven-Development-Team/.github`.
````

- [ ] **Step 4: Всё вместе**

Run: `bash tests/telegram.sh | tail -1 && bash tests/reminders.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: 37 ok, 0 fail`, `итого: 25 ok, 0 fail`, `lint ok`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/reminders.yml tests/lint.sh README.md
git commit -F - <<'EOF'
feat: напоминания о ревью по расписанию

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Переменная, PR и живая проверка

Каждый шаг ниже порождает события. Хелперы (объявлять в той же команде, где используются):

```bash
R=Cringe-Driven-Development-Team/.github
# последний запуск workflow по событию
last_run() { gh run list -R "$R" --workflow "$1" --event "$2" --limit 1 --json databaseId,conclusion,createdAt --jq '.[0]'; }
# топик и текст каждого ушедшего сообщения
tg_sent() { gh run view "$1" -R "$R" --log | grep -o '{"ok":true.*' | jq -r '"topic=\(.result.message_thread_id)\n\(.result.text)\n---"'; }
```

**Interfaces:**
- Consumes: ветка `feature/review-topic-and-reminders` из Task 1–4.

- [ ] **Step 1: Переменная `TELEGRAM_REVIEW_TOPIC_ID`**

Значение — ID топика «Code Review», который дал пользователь: `1513`.

```bash
gh api -X POST orgs/Cringe-Driven-Development-Team/actions/variables -f name=TELEGRAM_REVIEW_TOPIC_ID -f value=1513 -f visibility=all
for r in frontend-park-mail-ru/2026_2_Cringe_Driven_Development go-park-mail-ru/2026_2_Cringe_Driven_Development; do
  gh api -X POST "repos/$r/actions/variables" -f name=TELEGRAM_REVIEW_TOPIC_ID -f value=1513
done
gh api orgs/Cringe-Driven-Development-Team/actions/variables/TELEGRAM_REVIEW_TOPIC_ID --jq '"\(.name)=\(.value) visibility=\(.visibility)"'
for r in frontend-park-mail-ru/2026_2_Cringe_Driven_Development go-park-mail-ru/2026_2_Cringe_Driven_Development; do
  gh api "repos/$r/actions/variables/TELEGRAM_REVIEW_TOPIC_ID" --jq '"'"$r"': \(.value)"'
done
```

Expected: `TELEGRAM_REVIEW_TOPIC_ID=1513 visibility=all` и `1513` для обоих репозиториев. Пока `main` не обновлён, переменную никто не читает.

- [ ] **Step 2: Push ветки**

```bash
cd /f/Github/2026_H2/.github
git push -u origin feature/review-topic-and-reminders
```

Expected: запуск `automation.yml` по push — success; в общем топике «⚒️ 4 коммита · .github · feature/review-topic-and-reminders».

- [ ] **Step 3: PR через веб-форму — просит пользователя**

Дать пользователю ссылку `https://github.com/Cringe-Driven-Development-Team/.github/compare/main...feature/review-topic-and-reminders?expand=1` и попросить создать PR (не черновик) с одним ревьювером в Reviewers. Описание PR:

```
Сообщения о ревью — в отдельный топик «Code Review»; напоминания ревьюверам по расписанию.

Спека: docs/superpowers/specs/2026-09-18-review-topic-and-reminders-design.md
План: docs/superpowers/plans/2026-09-18-review-topic-and-reminders.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

После создания: `last_run automation.yml pull_request` (их будет два — opened и review_requested; смотреть оба `gh run list -R "$R" --workflow automation.yml --event pull_request --limit 2`), `tg_sent <id>` для каждого.
Expected: запуск opened — два сообщения: `topic=26` (общий топик) «🔀 Открыт pull request … ревьювер: <логин текстом>» и `topic=1513` «👀 Запрошено ревью … ревьювер: <ссылка-упоминание>»; запуск review_requested — без сообщений.

- [ ] **Step 4: Мерж**

```bash
PR=$(gh pr view feature/review-topic-and-reminders -R "$R" --json number --jq .number)
gh pr merge "$PR" -R "$R" --merge
git switch main && git pull --ff-only
```

Expected: `last_run automation.yml pull_request` — «🎉 Влито в main · .github» в общем топике.

- [ ] **Step 5: Ручной запуск напоминаний**

Нужен открытый PR с ревьювером в любом из семи репозиториев, иначе дайджест будет пустым и сообщения не будет. Проверить локально, с заглушкой вместо Telegram:

```bash
mkdir -p /tmp/rbin /tmp/rsent && rm -f /tmp/rsent/*
cp tests/stub-curl.sh /tmp/rbin/curl && chmod +x /tmp/rbin/curl
env PATH="/tmp/rbin:$PATH" SENT=/tmp/rsent TOKEN=x CHAT=-100 TOPIC=77 MAP='{}' MIN_HOURS=0 bash scripts/reminders.sh
ls /tmp/rsent
```

Файл `1` есть — ждущий PR есть. Файлов нет — попросить пользователя открыть в `.github` тестовый PR (не черновик) с ревьювером и закрыть его после проверки. Затем:

```bash
gh workflow run reminders.yml -R "$R" -f min_hours=0
```

Дождаться `last_run reminders.yml workflow_dispatch`, `gh run watch <id> -R "$R" --exit-status`.
Expected: success; `tg_sent <id>` — `topic=1513`, «⏰ Ждут ревью» с PR и ревьювером. Если запуск упал на `gh api graphql` с ошибкой доступа к репозиториям других организаций — `GITHUB_TOKEN` не читает их PR: остановиться и спросить пользователя про `ADD_TO_PROJECT_PAT` (спека, раздел «Токен»).

- [ ] **Step 6: Статус спеки**

```bash
sed -i 's/^Статус: дизайн согласован в чате, ждёт вычитки спеки$/Статус: реализовано 2026-09-18/' docs/superpowers/specs/2026-09-18-review-topic-and-reminders-design.md
grep -n '^Статус:' docs/superpowers/specs/2026-09-18-review-topic-and-reminders-design.md
git commit -am "docs: спека Code Review и напоминаний реализована" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 7: Итог пользователю**

Что проверено вживую (раскладка по топикам, дайджест, токен), что только тестами (апрув и правки в Code Review, предупреждение о 50 днях), когда первое плановое срабатывание (ближайшее из 10:00 / 15:00 / 20:00 МСК).
