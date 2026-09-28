# Задачи фронта и бэка в организации: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** задачи фронта и бэка живут в `Cringe-Driven-Development-Team/frontend` и `/backend`, PR курсовых репозиториев закрывают их ссылкой `Closes Cringe-Driven-Development-Team/<repo>#N`, а доска, бот и спринты работают как раньше.

**Architecture:** в `.github` к `add-to-project.yml`, который курсовые репозитории уже вызывают с `ADD_TO_PROJECT_PAT`, добавляется job `close`, страховка закрытия. `telegram.yml` учится молчать о служебных комментариях с `<!-- auto -->`, `reminders.sh` узнаёт новые репозитории. Остальное — операции над GitHub: новые репозитории, одноразовый перенос задач скриптом, проверка, README курсовых репозиториев, выключение Issues.

**Tech Stack:** GitHub Actions (reusable workflows), bash, perl, jq, `gh` CLI, GraphQL Projects v2; тесты — самописные bash-скрипты в `tests/`, линт — actionlint и shellcheck.

**Spec:** `docs/superpowers/specs/2026-09-29-tasks-in-org-design.md`

## Global Constraints

- Рабочий каталог — `F:\Github\2026_H2\.github` (Git Bash на Windows), ветка `feature/tasks-in-org`.
- Коммиты: `<тип>: <что сделано>` по-русски со строчной буквы. Последняя строка — `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, отделённая пустой строкой. Описание PR заканчивается строкой `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Тексты PR, JSON-тела запросов и многострочные сообщения — только файлами (Write, `--body-file`, `--input`). Heredoc в Git Bash съедает `\\` и `\n`.
- `jq.exe` и `gh` на Windows отдают CRLF: всё, что прочитано из них в переменные, чистить от `\r` (`tr -d '\r'` или `${X//$'\r'/}`).
- В тестах только ненастоящие ID: чат `-100`, топики `26`/`77`, карта `{"YarikMix":"111","blackHATred":"222"}`.
- Тесты на Windows медленные: каждый прогон `bash tests/*.sh` запускать с таймаутом 600000 мс.
- Всё, что увидят люди (создание репозиториев, задач, PR, мерж, комментарии, закрытие задач, настройки курсовых репозиториев), — только после явного «да» пользователя на конкретный шаг. Задачи 6–11 начинаются со стоп-шага «спросить пользователя».
- PR во frontend и backend мержат менторы. Мы их не мержим.
- Локальную ветку `web-23` с незакоммиченной правкой README в `F:\Github\2026_H2\frontend` не трогать.
- Организация — `Cringe-Driven-Development-Team`, доска — Projects v2 №1. Маркер служебного комментария — ровно `<!-- auto -->` в начале тела.

## Review Focus

- Описание PR из веб-редактора GitHub приходит с CRLF: ссылки всё равно должны находиться (тест в задаче 2).
- PR без ссылок из форка или от Dependabot приходит без секретов: job `close` должен остаться зелёным, а не падать на пустом PAT (тест в задаче 2).
- Опечатка в номере задачи (такой задачи нет): job должен громко упасть и назвать номер (тест в задаче 2).
- Одна задача упомянута в разном регистре (`Frontend#5` и `frontend#5`): закрыть её ровно один раз (тест в задаче 2).
- Человек процитировал маркер `<!-- auto -->` в середине своего комментария: бот должен прислать комментарий как обычно (тест в задаче 3).

---

### Task 1: `extract-run.awk` берёт N-й блок, линт проверяет все блоки

**Files:**
- Modify: `tests/extract-run.awk` (весь файл)
- Modify: `tests/lint.sh:15-19`

**Interfaces:**
- Produces: `awk -v n=<N> -f tests/extract-run.awk <workflow>` печатает тело N-го блока `run: |`, без `-v n` — первого; блока нет — пустой вывод. Задача 2 вызывает его с `n=2`.

- [ ] **Step 1: Убедиться, что сейчас второй блок не достаётся**

Run: `awk -v n=2 -f tests/extract-run.awk .github/workflows/reminders.yml | head -3`
Expected: печатается начало **первого** блока `run: |` из `reminders.yml`, потому что `n` игнорируется. Это и есть ошибка, которую исправляем.

- [ ] **Step 2: Переписать `tests/extract-run.awk`**

```awk
# Печатает тело n-го блока `run: |` из workflow (по умолчанию первого) без отступа YAML.
# Блока нет — пустой вывод.
# Запуск: awk [-v n=2] -f tests/extract-run.awk .github/workflows/telegram.yml
BEGIN { if (n == "") n = 1 }
!found && /^[ ]*run: \|[ ]*$/ { if (++seen == n) found = 1; next }
found {
  if ($0 ~ /^[ ]*$/) { print ""; next }
  match($0, /^ */)
  if (!ind) ind = RLENGTH
  if (RLENGTH < ind) exit
  print substr($0, ind + 1)
}
```

- [ ] **Step 3: Проверить выборку блоков**

Run:
```bash
awk -f tests/extract-run.awk .github/workflows/telegram.yml | head -2
awk -v n=2 -f tests/extract-run.awk .github/workflows/reminders.yml | head -2
awk -v n=9 -f tests/extract-run.awk .github/workflows/telegram.yml | wc -c
```
Expected: первая команда печатает начало скрипта `telegram.yml` (как до правки). Вторая печатает начало **второго** блока `reminders.yml`, если он там есть; если блок один, вывод пустой. Третья печатает `0`.

- [ ] **Step 4: Линт — все блоки каждого workflow**

В `tests/lint.sh` заменить цикл

```bash
for wf in .github/workflows/*.yml; do
  awk -f tests/extract-run.awk "$wf" > "$TMP/run.sh"
  [ -s "$TMP/run.sh" ] || continue
  shellcheck -s bash -S warning "$TMP/run.sh" || { echo "shellcheck: замечания в $wf"; exit 1; }
done
```

на

```bash
# каждый блок run: | по очереди — в add-to-project.yml их два
for wf in .github/workflows/*.yml; do
  n=1
  while awk -v n="$n" -f tests/extract-run.awk "$wf" > "$TMP/run.sh" && [ -s "$TMP/run.sh" ]; do
    shellcheck -s bash -S warning "$TMP/run.sh" || { echo "shellcheck: замечания в $wf, блок run №$n"; exit 1; }
    n=$((n + 1))
  done
done
```

- [ ] **Step 5: Прогнать линт и тесты бота**

Run (таймаут 600000): `bash tests/lint.sh && bash tests/telegram.sh | tail -1`
Expected: `lint ok` и `итого: N ok, 0 fail`, где N — прежнее число.

- [ ] **Step 6: Commit**

```bash
git add tests/extract-run.awk tests/lint.sh
git commit -F <файл с сообщением>
```
Сообщение: `test: extract-run.awk берёт N-й блок run, линт проверяет все блоки` + пустая строка + `Co-Authored-By: …`.

---

### Task 2: job `close` — страховка закрытия задач

**Files:**
- Modify: `.github/workflows/add-to-project.yml` (добавить job в конец)
- Create: `tests/close.sh`

**Interfaces:**
- Consumes: `awk -v n=2 -f tests/extract-run.awk` (задача 1); `tests/lib.sh`: `when`, `pass`, `fail`, `error`, `summary`, `$TMP`, `$CODE`, `DEFAULTS`.
- Produces: job `close` в `add-to-project.yml`. Env скрипта: `PROJECT_OWNER` (из `env:` workflow), `GH_TOKEN`, `TITLE`, `BODY`, `PR_URL`, `RUNNER_TEMP`. Служебный комментарий начинается с `<!-- auto -->` (задача 3 его пропускает).

- [ ] **Step 1: Написать тест `tests/close.sh`**

```bash
#!/usr/bin/env bash
# Прогоняет job close из .github/workflows/add-to-project.yml на подставных PR.
# Нужны bash, jq, perl и awk. Запуск: bash tests/close.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/tests/lib.sh"

SCRIPT="$TMP/script.sh"
# первый блок run: | — добавление на доску, второй — закрытие задач
awk -v n=2 -f "$ROOT/tests/extract-run.awk" "$ROOT/.github/workflows/add-to-project.yml" > "$SCRIPT"
[ -s "$SCRIPT" ] || { echo "в add-to-project.yml не найден второй блок run: |"; exit 1; }

cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
# заглушка gh api: задачи — из $GH_ISSUES ({"<repo>#<N>": {...}}), нет ключа — 404;
# $GH_FAIL — «МЕТОД:<repo>#<N>» через запятую, на них gh падает; вызовы — строками «МЕТОД путь поля» в $CALLS
shift
method=""
path=""
filter="."
fields=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X)       method=$2; shift 2 ;;
    --jq)     filter=$2; shift 2 ;;
    -f)       fields="$fields $2"; shift 2 ;;
    --silent) shift ;;
    *)        path=$1; shift ;;
  esac
done
# как у gh: с полями и без -X — POST
if [ -z "$method" ]; then
  if [ -n "$fields" ]; then method=POST; else method=GET; fi
fi
printf '%s %s%s\n' "$method" "$path" "$fields" >> "$CALLS"
key=$(printf '%s' "$path" | sed -E 's#^repos/[^/]+/([^/]+)/issues/([0-9]+).*#\1\#\2#')
case ",${GH_FAIL-}," in
  *",$method:$key,"*) echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2; exit 1 ;;
esac
[ "$method" = GET ] || exit 0
printf '%s' "$GH_ISSUES" | jq -e --arg k "$key" 'has($k)' > /dev/null || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
printf '%s' "$GH_ISSUES" | jq -r --arg k "$key" ".[\$k] | $filter"
STUB
chmod +x "$TMP/bin/gh"

ORG=Cringe-Driven-Development-Team
PR=https://github.com/frontend-park-mail-ru/2026_2_Cringe_Driven_Development/pull/40
F=repos/$ORG/frontend/issues
B=repos/$ORG/backend/issues

# так GitHub заполняет env: пустое описание PR — пустая строка
DEFAULTS=(
  PROJECT_OWNER=$ORG GH_TOKEN=test-pat TITLE='WEB-5: Вход' BODY= PR_URL=$PR
  GH_ISSUES='{}' GH_FAIL= CALLS="$TMP/calls" RUNNER_TEMP="$TMP"
)

# called "вызов" "!вызов" ... — отработал без ошибки; в журнале gh есть одни вызовы и нет других
called() {
  local s
  [ "$CODE" -eq 0 ] || { fail "код выхода $CODE"; return; }
  touch "$TMP/calls"
  for s in "$@"; do
    case "$s" in
      !*) ! grep -qF -- "${s#!}" "$TMP/calls" || { fail "лишний вызов «${s#!}»"; return; } ;;
      *) grep -qF -- "$s" "$TMP/calls" || { fail "нет вызова «$s»; были: $(tr '\n' ';' < "$TMP/calls")"; return; } ;;
    esac
  done
  pass
}

# calls_n <n> "вызов" — вызов в журнале ровно n раз
calls_n() {
  local got
  touch "$TMP/calls"
  got=$(grep -cF -- "$2" "$TMP/calls")
  [ "$got" -eq "$1" ] || { fail "«$2» — $got раз, ожидали $1"; return; }
  pass
}

# in_order "раньше" "позже" — первый вызов в журнале выше второго
in_order() {
  local a b
  a=$(grep -nF -- "$1" "$TMP/calls" | head -1 | cut -d: -f1)
  b=$(grep -nF -- "$2" "$TMP/calls" | head -1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] || { fail "«$1» не раньше «$2»"; return; }
  pass
}

# no_calls — отработал без ошибки и ни разу не вызвал gh
no_calls() {
  [ "$CODE" -eq 0 ] || { fail "код выхода $CODE"; return; }
  [ ! -s "$TMP/calls" ] || { fail "были вызовы: $(tr '\n' ';' < "$TMP/calls")"; return; }
  pass
}

# --- закрываем

when "мерж с Closes: открытая задача закрыта, потом комментарий" \
  BODY="Closes $ORG/frontend#5" GH_ISSUES='{"frontend#5":{"state":"open"}}'
called "GET $F/5" "PATCH $F/5 state=closed state_reason=completed" \
  "POST $F/5/comments body=<!-- auto -->Закрыта мержем $PR"
in_order "PATCH $F/5" "POST $F/5/comments"

when "ключевые слова в любом регистре, в заголовке и описании; повтор — один раз" \
  TITLE="WEB-5: Вход (fixes $ORG/frontend#5)" \
  BODY=$'resolves: '"$ORG"$'/backend#7\nCLOSES cringe-driven-development-team/Frontend#5\n- Closes '"$ORG/frontend#5" \
  GH_ISSUES='{"frontend#5":{"state":"open"},"backend#7":{"state":"open"}}'
calls_n 1 "PATCH $F/5 "
calls_n 1 "PATCH $B/7 "

when "описание с CRLF из веб-редактора GitHub" \
  BODY=$'Сделал вход\r\nCloses '"$ORG"$'/frontend#5\r\n' GH_ISSUES='{"frontend#5":{"state":"open"}}'
called "PATCH $F/5 state=closed state_reason=completed"

# --- не трогаем

when "задача уже закрыта" BODY="Closes $ORG/frontend#5" GH_ISSUES='{"frontend#5":{"state":"closed"}}'
called "GET $F/5" "!PATCH" "!POST"

when "номер указывает на PR" BODY="Fixes $ORG/frontend#6" \
  GH_ISSUES='{"frontend#6":{"state":"open","pull_request":{"url":"u"}}}'
called "GET $F/6" "!PATCH" "!POST"

when "короткий #N, чужая организация, ссылка без ключевого слова, ссылка без номера" \
  BODY=$'Closes #5\nCloses frontend-park-mail-ru/2026_2_Cringe_Driven_Development#6\nsee '"$ORG"$'/frontend#7\nCloses '"$ORG"'/frontend#'
no_calls

when "PR без описания" BODY=
no_calls

when "ссылок нет и PAT пуст (PR из форка) — успех" GH_TOKEN= BODY='Поправил опечатку'
no_calls

# --- ошибки

when "ссылки есть, а PAT пуст" GH_TOKEN= BODY="Closes $ORG/frontend#5"
error "::error::Не задан секрет ADD_TO_PROJECT_PAT"
no_calls_after_error() { [ ! -s "$TMP/calls" ] || { fail "без токена были вызовы gh"; return; }; pass; }
no_calls_after_error

when "одна не закрылась — вторая закрыта, job падает" \
  BODY=$'Closes '"$ORG"$'/frontend#5\nCloses '"$ORG"'/backend#7' \
  GH_ISSUES='{"frontend#5":{"state":"open"},"backend#7":{"state":"open"}}' GH_FAIL='PATCH:frontend#5'
error "::error::Не закрыл frontend#5"
if grep -qF "PATCH $B/7 state=closed" "$TMP/calls"; then pass; else fail "backend#7 не закрыта"; fi
if grep -qF "POST $F/5/comments" "$TMP/calls"; then fail "комментарий к незакрытой задаче"; else pass; fi

when "задачи с таким номером нет" BODY="Closes $ORG/frontend#99"
error "::error::Не закрыл frontend#99: gh: Not Found (HTTP 404)"

when "закрыли, но комментарий не лёг — предупреждение, job зелёный" \
  BODY="Closes $ORG/frontend#5" GH_ISSUES='{"frontend#5":{"state":"open"}}' GH_FAIL='POST:frontend#5'
called "PATCH $F/5 state=closed"
if grep -qF "::warning::Закрыл frontend#5, но не оставил комментарий" "$TMP/out"; then pass; else fail "нет предупреждения"; fi

summary
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `bash tests/close.sh`
Expected: `в add-to-project.yml не найден второй блок run: |`, код выхода 1.

- [ ] **Step 3: Добавить job `close` в конец `.github/workflows/add-to-project.yml`**

После job `add-to-project` (отступ `jobs:` — два пробела):

```yaml

  # Страховка к «Closes Cringe-Driven-Development-Team/<repo>#N» в PR курсовых репозиториев: их мержат
  # менторы без прав на наши репозитории, и GitHub может не закрыть задачу сам. Мерж не в ветку
  # по умолчанию задачи не закрывает — как у GitHub
  close:
    if: >-
      github.event_name == 'pull_request' && github.event.action == 'closed' &&
      github.event.pull_request.merged &&
      github.event.pull_request.base.ref == github.event.repository.default_branch
    runs-on: ubuntu-latest
    steps:
      - name: Close issues referenced by the merged PR
        env:
          GH_TOKEN: ${{ secrets.ADD_TO_PROJECT_PAT }}
          TITLE: ${{ github.event.pull_request.title }}
          BODY: ${{ github.event.pull_request.body }}
          PR_URL: ${{ github.event.pull_request.html_url }}
        run: |
          # <repo>#<N> после ключевого слова — по строке на задачу, без повторов. Регистр, как у GitHub,
          # не важен; имя репозитория — в нижнем, чтобы Frontend#5 и frontend#5 не закрывались дважды
          REFS=$(printf '%s\n%s\n' "$TITLE" "$BODY" | perl -ne '
            my $org = quotemeta $ENV{PROJECT_OWNER};
            while (/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+$org\/([A-Za-z0-9._-]+)#([0-9]+)\b/gi) {
              print lc($1), "#$2\n";
            }' | sort -u)
          [ -n "$REFS" ] || { echo "В PR нет ссылок на задачи $PROJECT_OWNER"; exit 0; }
          # у PR из форков и Dependabot секретов нет — но и ссылок на наши задачи там не бывает
          [ -n "$GH_TOKEN" ] || { echo "::error::Не задан секрет ADD_TO_PROJECT_PAT — не закрыл: $(printf '%s' "$REFS" | tr '\n' ' ')"; exit 1; }

          ERR="${RUNNER_TEMP:-/tmp}/gh-close.err"
          FAILED=""
          while IFS='#' read -r R N; do
            API="repos/$PROJECT_OWNER/$R/issues/$N"
            # у PR тоже есть номер в /issues — его не трогаем
            if ! STATE=$(gh api "$API" --jq 'if .pull_request then "pr" else .state end' 2>"$ERR"); then
              echo "::error::Не закрыл $R#$N: $(head -c 200 "$ERR")"
              FAILED=1
              continue
            fi
            case "${STATE//$'\r'/}" in
              open) ;;
              pr) echo "$R#$N — pull request, пропускаю"; continue ;;
              *)  echo "$R#$N уже закрыта"; continue ;;
            esac
            # сначала закрыть, потом объяснить: не закрыли — не остаётся ложного комментария
            if ! gh api -X PATCH "$API" -f state=closed -f state_reason=completed --silent 2>"$ERR"; then
              echo "::error::Не закрыл $R#$N: $(head -c 200 "$ERR")"
              FAILED=1
              continue
            fi
            # <!-- auto --> — служебный комментарий, бот не пересылает его в чат
            gh api "$API/comments" -f body="<!-- auto -->Закрыта мержем $PR_URL" --silent 2>"$ERR" ||
              echo "::warning::Закрыл $R#$N, но не оставил комментарий: $(head -c 200 "$ERR")"
            echo "Закрыл $R#$N"
          done <<< "$REFS"
          [ -z "$FAILED" ]
```

- [ ] **Step 4: Прогнать тест**

Run (таймаут 600000): `bash tests/close.sh`
Expected: все строки `ok`, последняя — `итого: 18 ok, 0 fail`.

- [ ] **Step 5: Линт**

Run (таймаут 600000): `bash tests/lint.sh`
Expected: `lint ok`. Замечания shellcheck к блоку №2 `add-to-project.yml` исправить в yml, не глуша их.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/add-to-project.yml tests/close.sh
git commit -F <файл>
```
Сообщение: `feat: job close закрывает задачи организации по ссылкам из влитого PR` + пустая строка + `Co-Authored-By: …`.

---

### Task 3: бот молчит о служебных комментариях

**Files:**
- Modify: `.github/workflows/telegram.yml:333-334`
- Modify: `tests/telegram.sh` (после случая «комментарий бота молчит», около строки 590)

**Interfaces:**
- Consumes: маркер `<!-- auto -->` в начале тела комментария (задача 2 и скрипт переноса из задачи 8).

- [ ] **Step 1: Тесты в `tests/telegram.sh`**

Сразу после

```bash
when "комментарий бота молчит" "${IC[@]}" COMMENT_BY='github-actions[bot]' COMMENT_BY_TYPE=Bot COMMENT_BODY=отчёт
silent
```

добавить

```bash

when "служебный комментарий автоматики молчит" "${IC[@]}" COMMENT_BY=YarikMix \
  COMMENT_BODY='<!-- auto -->Закрыта мержем https://github.com/f/r/pull/40'
silent

when "маркер не в начале — обычный комментарий" "${IC[@]}" COMMENT_BY=iRedTea ASSIGNEES='[]' \
  COMMENT_BODY='Служебные начинаются с <!-- auto -->, а этот — нет'
sent "💬 Комментарий" "Служебные начинаются с"
```

- [ ] **Step 2: Убедиться, что первый новый тест падает**

Run (таймаут 600000): `bash tests/telegram.sh | grep -E "^FAIL|итого"`
Expected: `FAIL служебный комментарий автоматики молчит: отправлено сообщений: 1`, в итоге `1 fail`.

- [ ] **Step 3: Пропуск в `telegram.yml`**

Заменить

```bash
              # комментарии ботов — не новость
              [ "$COMMENT_BY_TYPE" = "Bot" ] && exit 0
```

на

```bash
              # комментарии ботов — не новость
              [ "$COMMENT_BY_TYPE" = "Bot" ] && exit 0
              # служебные комментарии автоматики (закрытие мержем, перенос задач) — тоже
              case "$COMMENT_BODY" in '<!-- auto -->'*) exit 0 ;; esac
```

- [ ] **Step 4: Тесты и линт**

Run (таймаут 600000): `bash tests/telegram.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: N ok, 0 fail` и `lint ok`.

- [ ] **Step 5: Commit**

Сообщение: `feat: бот не пересылает служебные комментарии с <!-- auto -->` + пустая строка + `Co-Authored-By: …`. Файлы: `.github/workflows/telegram.yml tests/telegram.sh`.

---

### Task 4: `REPOS` знает `frontend` и `backend`

**Files:**
- Modify: `scripts/reminders.sh:10-19`
- Modify: `tests/reminders.sh:112-119` (случай «запрос покрывает все восемь репозиториев») и после случая «новый подключённый репозиторий — без предупреждения» (около строки 325)

- [ ] **Step 1: Тесты**

Заменить в `tests/reminders.sh`

```bash
when "запрос покрывает все восемь репозиториев"
missing=""
for r in Cringe-Driven-Development-Team/.github Cringe-Driven-Development-Team/docs \
  Cringe-Driven-Development-Team/static Cringe-Driven-Development-Team/infra \
  Cringe-Driven-Development-Team/react Cringe-Driven-Development-Team/figma "$FRONT" "$BACK"; do
```

на

```bash
when "запрос покрывает все десять репозиториев"
missing=""
for r in Cringe-Driven-Development-Team/.github Cringe-Driven-Development-Team/docs \
  Cringe-Driven-Development-Team/static Cringe-Driven-Development-Team/infra \
  Cringe-Driven-Development-Team/react Cringe-Driven-Development-Team/figma \
  Cringe-Driven-Development-Team/frontend Cringe-Driven-Development-Team/backend "$FRONT" "$BACK"; do
```

и после

```bash
when "новый подключённый репозиторий — без предупреждения" DAILY=false ORG_REPOS="[$(repo figma 2026-09-20T09:00:00Z)]"
sent "🆕 Новый репозиторий" "figma" "!не подключён"
```

добавить

```bash

when "новые репозитории задач frontend и backend подключены" DAILY=false \
  ORG_REPOS="[$(repo frontend 2026-09-20T09:00:00Z),$(repo backend 2026-09-20T09:00:00Z)]"
sent_to 1 26 ">frontend</a>" "!не подключён"
sent_to 2 26 ">backend</a>" "!не подключён"
only 2
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run (таймаут 600000): `bash tests/reminders.sh | grep -E "^FAIL|итого"`
Expected: FAIL для «все десять репозиториев» (`в запросе нет: …frontend …backend`) и для «новые репозитории задач…» (`лишнее «не подключён»`).

- [ ] **Step 3: Добавить репозитории в `REPOS`**

В `scripts/reminders.sh` после `  Cringe-Driven-Development-Team/figma` вставить

```bash
  Cringe-Driven-Development-Team/frontend
  Cringe-Driven-Development-Team/backend
```

- [ ] **Step 4: Тесты**

Run (таймаут 600000): `bash tests/reminders.sh | tail -1 && bash tests/sprint.sh | tail -1 && bash tests/lint.sh`
Expected: `итого: N ok, 0 fail` в обоих тестах и `lint ok`.

- [ ] **Step 5: Commit**

Сообщение: `feat: напоминания и проверки видят репозитории задач frontend и backend` + пустая строка + `Co-Authored-By: …`. Файлы: `scripts/reminders.sh tests/reminders.sh`.

---

### Task 5: README `.github`

**Files:**
- Modify: `README.md`: таблица файлов (строка про `add-to-project.yml`), новый раздел `## Задачи фронта и бэка` перед `## Как вносить правки`, список тестов в «Как вносить правки»

- [ ] **Step 1: Таблица файлов**

Строку

```markdown
| `.github/workflows/add-to-project.yml` | добавляет новые и переоткрытые issue на доску |
```

заменить на

```markdown
| `.github/workflows/add-to-project.yml` | добавляет новые и переоткрытые issue на доску; после мержа PR закрывает задачи организации, на которые он ссылается |
```

- [ ] **Step 2: Новый раздел перед `## Как вносить правки`**

```markdown
## Задачи фронта и бэка

Код фронтенда и бэкенда лежит в курсовых репозиториях — [frontend](https://github.com/frontend-park-mail-ru/2026_2_Cringe_Driven_Development) и [backend](https://github.com/go-park-mail-ru/2026_2_Cringe_Driven_Development), а задачи к нему — здесь, в [frontend](https://github.com/Cringe-Driven-Development-Team/frontend) и [backend](https://github.com/Cringe-Driven-Development-Team/backend): так их видят доска, бот и смена спринта.

- Завести задачу — с доски: `+ Add item` → ввести `#` → `frontend` или `backend` → `Create new issue`. Текст без `#` создаёт черновик: он живёт только на доске, не связан ни с репозиторием, ни с PR.
- Закрыть — строкой в описании PR курсового репозитория: `Closes Cringe-Driven-Development-Team/frontend#N`. Короткое `#N` сослалось бы на сам курсовой репозиторий.

Такие PR мержат менторы, у которых нет прав на наши репозитории, и GitHub может не закрыть задачу сам. Поэтому job `close` в `add-to-project.yml` после мержа в ветку по умолчанию закрывает все задачи организации, на которые PR ссылается ключевым словом (`close`, `fix`, `resolve` в любой форме), и оставляет под задачей «Закрыта мержем …». Уже закрытые не трогает. Для этого `ADD_TO_PROJECT_PAT` нужна запись в задачи репозиториев организации: у fine-grained токена — `Issues: Read and write`, у classic — `public_repo`. Не смог закрыть — job падает, сбой приходит в «🚨 Сбои уведомлений».

Комментарии, которые начинаются с `<!-- auto -->`, бот в чат не пересылает: так помечены служебные комментарии автоматики.

Почему так — [спека](docs/superpowers/specs/2026-09-29-tasks-in-org-design.md).
```

- [ ] **Step 3: Список тестов в «Как вносить правки»**

Блок

```bash
   bash tests/telegram.sh
   bash tests/reminders.sh
   bash tests/lint.sh
```

заменить на

```bash
   bash tests/telegram.sh
   bash tests/reminders.sh
   bash tests/close.sh
   bash tests/lint.sh
```

- [ ] **Step 4: Commit**

Сообщение: `docs: задачи фронта и бэка в организации, страховка закрытия` + пустая строка + `Co-Authored-By: …`. Файл: `README.md`.

- [ ] **Step 5: Полный прогон перед раскаткой**

Run (таймаут 600000 на каждый): `bash tests/telegram.sh | tail -1; bash tests/reminders.sh | tail -1; bash tests/sprint.sh | tail -1; bash tests/close.sh | tail -1; bash tests/lint.sh`
Expected: четыре строки `итого: N ok, 0 fail` и `lint ok`.

---

### Task 6: создать репозитории `frontend` и `backend` 👁

**Files:** в `.github` ничего. Временные файлы — в каталоге scratchpad сессии (далее `$S`).

- [ ] **Step 1: Стоп — спросить пользователя**

«Создаю публичные `Cringe-Driven-Development-Team/frontend` и `/backend` с `automation.yml` и README из одной строки. Бот пришлёт в общий топик „🆕 Новый репозиторий“ с пометкой „нет в REPOS“, пока не влит PR из задачи 7. Создаём?» Без «да» дальше не идти.

- [ ] **Step 2: Шаблон `automation.yml` из README**

```bash
S=<scratchpad>
awk '/^```yaml$/{f=1;next} f&&/^```$/{exit} f' README.md > "$S/automation.yml"
grep -c "Cringe-Driven-Development-Team/.github/.github/workflows/" "$S/automation.yml"
```
Expected: `2`, по одной строке на `add-to-project.yml@main` и `telegram.yml@main`.

- [ ] **Step 3: Создать репозитории и положить файлы**

```bash
ORG=Cringe-Driven-Development-Team
TRAILER=$'\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
for side in frontend backend; do
  case $side in
    frontend) CODE=frontend-park-mail-ru/2026_2_Cringe_Driven_Development; WHAT=фронтенда ;;
    backend)  CODE=go-park-mail-ru/2026_2_Cringe_Driven_Development;       WHAT=бэкенда ;;
  esac
  gh repo create "$ORG/$side" --public --disable-wiki --description "Задачи $WHAT. Код — в $CODE"
  printf '# %s\n\nЗадачи %s команды. Код — в [%s](https://github.com/%s), доска — [Scrumban](https://github.com/orgs/%s/projects/1).\n' \
    "$side" "$WHAT" "$CODE" "$CODE" "$ORG" > "$S/README.md"
  jq -n --arg m "docs: описание репозитория задач$TRAILER" --arg c "$(base64 -w0 "$S/README.md")" \
    '{message: $m, content: $c}' > "$S/put.json"
  gh api -X PUT "repos/$ORG/$side/contents/README.md" --input "$S/put.json" --silent
  jq -n --arg m "chore: подключить доску и уведомления$TRAILER" --arg c "$(base64 -w0 "$S/automation.yml")" \
    '{message: $m, content: $c}' > "$S/put.json"
  gh api -X PUT "repos/$ORG/$side/contents/.github/workflows/automation.yml" --input "$S/put.json" --silent
done
```

- [ ] **Step 4: Проверить**

```bash
for side in frontend backend; do
  gh api "repos/$ORG/$side" --jq '"\(.full_name) \(.visibility) \(.default_branch) issues=\(.has_issues)"' | tr -d '\r'
  gh api "repos/$ORG/$side/contents/.github/workflows/automation.yml" --jq .name | tr -d '\r'
done
```
Expected: `… public main issues=true` и `automation.yml` для каждого.

---

### Task 7: PR в `.github` и мерж 👁

- [ ] **Step 1: Стоп — спросить пользователя**

«Открываю PR `feature/tasks-in-org` в `.github`: бот пришлёт „🔀 Открыт pull request“. Перед мержем проверь права `ADD_TO_PROJECT_PAT`: fine-grained — `Issues: Read and write` на репозитории организации, classic — `public_repo`. Открываем?»

- [ ] **Step 2: Push и PR**

Описание — файлом `$S/pr.md` (Write):

```markdown
Задачи фронта и бэка переезжают в `Cringe-Driven-Development-Team/frontend` и `/backend`, код остаётся в курсовых репозиториях. [Спека](docs/superpowers/specs/2026-09-29-tasks-in-org-design.md), [план](docs/superpowers/plans/2026-09-29-tasks-in-org.md).

- `add-to-project.yml`: job `close`. После мержа PR в ветку по умолчанию закрывает задачи организации, на которые PR ссылается ключевым словом (`Closes Cringe-Driven-Development-Team/frontend#N`), и оставляет комментарий. Нужен, потому что курсовые PR мержат менторы без прав на наши репозитории.
- `telegram.yml`: комментарии с `<!-- auto -->` в начале не пересылаются в чат.
- `reminders.sh`: в `REPOS` добавлены `frontend` и `backend`.
- `tests/close.sh`, `extract-run.awk -v n=N`, линт всех блоков `run`.

Проверено: `tests/telegram.sh`, `reminders.sh`, `sprint.sh`, `close.sh`, `lint.sh` — зелёные.

Перед мержем: `ADD_TO_PROJECT_PAT` должен уметь закрывать задачи и комментировать в репозиториях организации.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

```bash
git push -u origin feature/tasks-in-org
gh pr create -R Cringe-Driven-Development-Team/.github --base main --head feature/tasks-in-org \
  --title "feat: задачи фронта и бэка в организации, страховка закрытия" --body-file "$S/pr.md"
```

- [ ] **Step 3: Проверки PR**

Run: `gh pr checks -R Cringe-Driven-Development-Team/.github --watch`
Expected: все проверки зелёные. Workflow «Автоматизация» этого PR прошёл, job `close` пропущен.

- [ ] **Step 4: Стоп — «Права PAT проверил? Мержим?»** Без «да» не мержить.

- [ ] **Step 5: Мерж**

```bash
gh pr merge -R Cringe-Driven-Development-Team/.github --merge --delete-branch
git switch main && git pull --ff-only
```

---

### Task 8: перенос задач 👁

Скрипт одноразовый, в `.github` не коммитится. Лежит в `$S/migrate.sh`, запускается из Git Bash.

- [ ] **Step 1: Написать `$S/migrate.sh`**

```bash
#!/usr/bin/env bash
# Одноразово: переносит открытые задачи курсовых репозиториев в Cringe-Driven-Development-Team/{frontend,backend}.
# bash migrate.sh — dry-run: что и куда; bash migrate.sh --apply — перенос.
# Повторный запуск доделывает начатое: копия ищется по «Перенесено из <ссылка>», старая закрывается последней.
set -euo pipefail

ORG=Cringe-Driven-Development-Team
PROJECT_NUMBER=1
SOURCES=(
  frontend-park-mail-ru/2026_2_Cringe_Driven_Development:frontend
  go-park-mail-ru/2026_2_Cringe_Driven_Development:backend
)
APPLY=false
[ "${1:-}" = "--apply" ] && APPLY=true
S=$(mktemp -d)
trap 'rm -rf "$S"' EXIT

# gh и jq.exe на Windows отдают CRLF
cr () { tr -d '\r'; }

# доска: id и все карточки с пользовательскими полями
gh api graphql -f query='query($o: String!, $n: Int!) { organization(login: $o) { projectV2(number: $n) {
  id
  items(first: 100) { pageInfo { hasNextPage } nodes {
    id
    content { ... on Issue { url } }
    fieldValues(first: 30) { nodes {
      ... on ProjectV2ItemFieldSingleSelectValue { optionId name field { ... on ProjectV2FieldCommon { id name } } }
      ... on ProjectV2ItemFieldIterationValue { iterationId title field { ... on ProjectV2FieldCommon { id name } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id name } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id name } } }
    } }
  } }
} } }' -f o="$ORG" -F n="$PROJECT_NUMBER" | cr > "$S/board.json"
[ "$(jq -r '.data.organization.projectV2.items.pageInfo.hasNextPage' "$S/board.json" | cr)" = false ] ||
  { echo "на доске больше 100 карточек — нужна пагинация"; exit 1; }
PROJECT_ID=$(jq -r '.data.organization.projectV2.id' "$S/board.json" | cr)
MEMBERS=$(gh api "orgs/$ORG/members?per_page=100" --paginate --jq '.[].login' | cr | jq -R . | jq -sc .)

# card <url> — карточка задачи на доске ({} — нет на доске)
card () {
  jq -c --arg u "$1" '[.data.organization.projectV2.items.nodes[] | select(.content.url == $u)][0] // {}' "$S/board.json" | cr
}

for pair in "${SOURCES[@]}"; do
  SRC=${pair%%:*}
  T=${pair#*:}
  gh api "repos/$SRC/issues?state=open&per_page=100" --paginate \
    --jq '.[] | select(.pull_request | not) | {number, title, body, url: .html_url, assignees: [.assignees[].login]}' \
    | cr | jq -s 'sort_by(.number)' > "$S/src.json"
  COUNT=$(jq length "$S/src.json" | cr)
  echo "== $SRC → $ORG/$T: $COUNT"

  for i in $(seq 0 $((COUNT - 1))); do
    jq ".[$i]" "$S/src.json" > "$S/issue.json"
    N=$(jq -r .number "$S/issue.json" | cr)
    URL=$(jq -r .url "$S/issue.json" | cr)
    CARD=$(card "$URL")
    OLD_ITEM=$(jq -r '.id // ""' <<< "$CARD" | cr)
    # короткие #N — на задачи и PR курсового репозитория; &#123; и якоря ссылок не трогаем
    jq --arg src "$SRC" --argjson members "$MEMBERS" '{
        title,
        assignees: [.assignees[] | select(. as $a | $members | index($a))],
        body: ((.body // "" | gsub("(?<![\\w/&])#(?<n>[0-9]+)\\b"; "\($src)#\(.n)"))
               + "\n\n---\nПеренесено из \(.url)")
      }' "$S/issue.json" > "$S/new.json"

    FIELDS=$(jq -r '[.fieldValues.nodes[]? | select(.field) | "\(.field.name)=\(.name // .title // .number // .date)"] | join("; ")' <<< "$CARD" | cr)
    [ -n "$OLD_ITEM" ] || FIELDS="нет на доске"
    LOST=$(jq -r --argjson members "$MEMBERS" '[.assignees[] | select(. as $a | $members | index($a) | not)] | join(",")' "$S/issue.json" | cr)
    REFS=$(jq -r '[.body // "" | scan("(?<![\\w/&])#[0-9]+\\b")] | join(",")' "$S/issue.json" | cr)
    printf '#%s → %s | %s | %s | %s%s%s\n' "$N" "$T" "$(jq -r .title "$S/issue.json" | cr)" \
      "$(jq -r '.assignees | join(",")' "$S/new.json" | cr)" "$FIELDS" \
      "${REFS:+ | ссылки → $SRC: $REFS}" "${LOST:+ | ⚠️ не в организации, пропущу: $LOST}"
    $APPLY || continue

    # 1. копия: уже есть — берём её
    gh api "repos/$ORG/$T/issues?state=all&per_page=100" --paginate \
      --jq '.[] | select(.pull_request | not) | {number, node_id, body}' | cr | jq -s . > "$S/dst.json"
    EXIST=$(jq -r --arg m "Перенесено из $URL" '[.[] | select(.body // "" | endswith($m))][0] // empty | "\(.number) \(.node_id)"' "$S/dst.json" | cr)
    if [ -n "$EXIST" ]; then
      NEWN=${EXIST%% *}
      NODE=${EXIST#* }
      echo "   копия уже есть: $T#$NEWN"
    else
      read -r NEWN NODE < <(gh api "repos/$ORG/$T/issues" --input "$S/new.json" --jq '"\(.number) \(.node_id)"' | cr) || true
      [ -n "${NODE:-}" ] || { echo "не создал копию #$N"; exit 1; }
      echo "   создана $T#$NEWN"
    fi

    # 2. на доску с полями старой карточки; addProjectV2ItemById возвращает существующую карточку
    ITEM=$(gh api graphql -f query='mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: {projectId: $p, contentId: $c}) { item { id } } }' \
      -f p="$PROJECT_ID" -f c="$NODE" --jq .data.addProjectV2ItemById.item.id | cr)
    jq -c '.fieldValues.nodes[]? | select(.field) | {field: .field.id, value: (
        if .optionId then {singleSelectOptionId: .optionId}
        elif .iterationId then {iterationId: .iterationId}
        elif .date then {date: .date}
        elif .number != null then {number: .number}
        else empty end)}' <<< "$CARD" | cr > "$S/fields.jsonl"
    while read -r FV; do
      jq -n --argjson f "$FV" --arg p "$PROJECT_ID" --arg i "$ITEM" '{
          query: "mutation($p: ID!, $i: ID!, $f: ID!, $v: ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i, fieldId: $f, value: $v}) { projectV2Item { id } } }",
          variables: {p: $p, i: $i, f: $f.field, v: $f.value}}' > "$S/upd.json"
      gh api graphql --input "$S/upd.json" --silent
    done < "$S/fields.jsonl"

    # 3. комментарий к старой — если его ещё нет
    MOVED="$ORG/$T#$NEWN"
    if ! gh api "repos/$SRC/issues/$N/comments?per_page=100" --paginate --jq '.[].body' | cr | grep -qF "<!-- auto -->Перенесено в $MOVED"; then
      jq -n --arg b "<!-- auto -->Перенесено в $MOVED" '{body: $b}' > "$S/c.json"
      gh api "repos/$SRC/issues/$N/comments" --input "$S/c.json" --silent
    fi

    # 4. старую карточку — с доски, иначе в итогах спринта она «сделана»
    [ -z "$OLD_ITEM" ] || gh api graphql -f query='mutation($p: ID!, $i: ID!) { deleteProjectV2Item(input: {projectId: $p, itemId: $i}) { deletedItemId } }' \
      -f p="$PROJECT_ID" -f i="$OLD_ITEM" --silent

    # 5. закрыть старую — последним: пока открыта, повторный запуск её видит
    gh api -X PATCH "repos/$SRC/issues/$N" -f state=closed -f state_reason=not_planned --silent
    echo "   #$N закрыта, перенесена в $MOVED"
  done
done
```

- [ ] **Step 2: Dry-run**

Run: `bash "$S/migrate.sh"`
Expected: два блока `== … → …: N`, по строке на задачу: номер, заголовок, исполнители, `Status=…; Sprint=…` или `нет на доске`, переписанные ссылки и предупреждения. Запросов на запись нет.

- [ ] **Step 3: Стоп — показать таблицу пользователю**

Показать вывод dry-run целиком и текст объявления для чата. Пользователь публикует его сам: Telegram MCP в этой сессии не подключён.

> Задачи фронта и бэка переезжают в нашу организацию: github.com/Cringe-Driven-Development-Team/frontend и /backend. Сейчас перенесу открытые задачи, будет пачка уведомлений — это он.
> Как теперь:
> • заводить задачу — с доски: + Add item → ввести # → frontend/backend → Create new issue (без # получится черновик, который никуда не свяжется);
> • в описании PR — обязательно строка `Closes Cringe-Driven-Development-Team/frontend#N` (или backend), короткое `#N` не сработает.
> README во frontend и backend обновлю отдельным PR.

Спросить: «Таблица верна? Объявление отправил? Переносим?» Без «да» не запускать `--apply`.

- [ ] **Step 4: Перенос**

Run: `bash "$S/migrate.sh" --apply 2>&1 | tee "$S/migrate.log"`
Expected: у каждой задачи строки `создана <repo>#M` и `#N закрыта, перенесена в …`. Если скрипт упал, исправить причину и запустить `--apply` ещё раз: он доделает начатое.

- [ ] **Step 5: Проверить результат**

```bash
for r in frontend-park-mail-ru/2026_2_Cringe_Driven_Development go-park-mail-ru/2026_2_Cringe_Driven_Development; do
  echo "$r открыто: $(gh api "repos/$r/issues?state=open&per_page=100" --jq '[.[] | select(.pull_request | not)] | length' | tr -d '\r')"
done
bash "$S/migrate.sh" | grep -c '→' || true
gh api graphql -f query='{organization(login:"Cringe-Driven-Development-Team"){projectV2(number:1){items(first:100){nodes{content{... on Issue{repository{name owner{login}} state}} fieldValues(first:20){nodes{... on ProjectV2ItemFieldIterationValue{title}}}}}}}}' \
  --jq '[.data.organization.projectV2.items.nodes[] | select(.content.state == "OPEN") | "\(.content.repository.owner.login)/\(.content.repository.name) \([.fieldValues.nodes[].title // empty] | join(""))"] | group_by(.) | map("\(.[0]) — \(length)") | .[]' | tr -d '\r'
```
Expected: в курсовых репозиториях открыто `0`. Повторный dry-run находит `0` задач. На доске открытых задач из курсовых репозиториев нет, а `Cringe-Driven-Development-Team/frontend Sprint 3` и `…/backend Sprint 3` вместе с `… frontend` без спринта (бывшая frontend#27) дают столько же, сколько переносилось.

---

### Task 9: проверка поведения GitHub между организациями 👁

- [ ] **Step 1: Стоп — спросить пользователя**

«Для проверки нужны: тестовая задача в `frontend`, её заведёшь ты с доски, и публичный репозиторий `YarikMix/close-test` с одним PR, который я создам, смержу и удалю. Бот пришлёт о задаче „🆕“ и „✅“. Для удаления репозитория выполни `! gh auth refresh -h github.com -s delete_repo`. Делаем?»

- [ ] **Step 2: Пользователь заводит задачу с доски**

Попросить: в виде `Sprint`, колонка `Ready` → `+ Add item` → `#` → `frontend` → `Create new issue`, заголовок «Проверка: закрытие из другой организации». Затем найти её номер `T` и поля:

```bash
gh issue list -R Cringe-Driven-Development-Team/frontend --search "Проверка: закрытие" --json number,url | tr -d '\r'
gh api graphql -f query='query($u: URI!) { resource(url: $u) { ... on Issue { projectItems(first: 5) { nodes { fieldValues(first: 20) { nodes {
  ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
  ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } } } } } } } } }' \
  -f u="https://github.com/Cringe-Driven-Development-Team/frontend/issues/$T" \
  --jq '[.data.resource.projectItems.nodes[].fieldValues.nodes[] | select(.field) | "\(.field.name)=\(.name // .title)"] | join("; ")' | tr -d '\r'
```
Записать: подставился ли `Sprint` (результат 1).

- [ ] **Step 3: Пользователь проверяет кнопку ветки**

Попросить: открыть задачу → `Development` → `Create a branch` → `Change branch source`. Есть ли в списке `Repository destination` репозиторий `frontend-park-mail-ru/2026_2_Cringe_Driven_Development`? Ветку не создавать. Записать точные названия пунктов UI (результат 2).

- [ ] **Step 4: Тестовый PR**

```bash
gh repo create YarikMix/close-test --public --add-readme
cd "$S" && gh repo clone YarikMix/close-test && cd close-test
git switch -c test && echo x >> README.md && git commit -qam "test: проверка закрытия" && git push -q -u origin test
```
Описание `$S/close-pr.md` (Write): `Closes Cringe-Driven-Development-Team/frontend#<T>`.
```bash
gh pr create -R YarikMix/close-test --base main --head test --title "Проверка закрытия" --body-file "$S/close-pr.md"
gh pr view -R YarikMix/close-test 1 --json closingIssuesReferences --jq '[.closingIssuesReferences[] | .url]' | tr -d '\r'
```
Записать: связал ли GitHub PR с задачей (результат 3). Попросить пользователя посмотреть, в какой колонке теперь карточка на доске (результат 4, `In review` или нет).

- [ ] **Step 5: Мерж и закрытие**

```bash
gh pr merge -R YarikMix/close-test 1 --merge
```
Через минуту:
```bash
gh api repos/Cringe-Driven-Development-Team/frontend/issues/$T --jq '"\(.state) \(.state_reason) \(.closed_by.login)"' | tr -d '\r'
```
Записать: закрыл ли GitHub задачу (результат 5).

- [ ] **Step 6: Уборка**

```bash
ISSUE=https://github.com/Cringe-Driven-Development-Team/frontend/issues/$T
[ "$(gh api repos/Cringe-Driven-Development-Team/frontend/issues/$T --jq .state | tr -d '\r')" = closed ] ||
  gh api -X PATCH repos/Cringe-Driven-Development-Team/frontend/issues/$T -f state=closed -f state_reason=not_planned --silent
PID=$(gh api graphql -f query='{organization(login:"Cringe-Driven-Development-Team"){projectV2(number:1){id}}}' --jq .data.organization.projectV2.id | tr -d '\r')
IID=$(gh api graphql -f query='query($u: URI!) { resource(url: $u) { ... on Issue { projectItems(first: 5) { nodes { id } } } } }' -f u="$ISSUE" --jq '.data.resource.projectItems.nodes[0].id' | tr -d '\r')
gh api graphql -f query='mutation($p: ID!, $i: ID!) { deleteProjectV2Item(input: {projectId: $p, itemId: $i}) { deletedItemId } }' -f p="$PID" -f i="$IID" --silent
cd "$S" && rm -rf close-test
gh repo delete YarikMix/close-test --yes
```

- [ ] **Step 7: Записать результаты в спеку**

В `docs/superpowers/specs/2026-09-29-tasks-in-org-design.md` перед `## Вне рамок` добавить раздел `## Результаты проверки (<дата>)` с пятью пунктами: `Sprint` из фильтра, кнопка ветки, связь PR с задачей, колонка `In review`, закрытие мержем. Ветка от `main`: `docs/check-results`. Коммит `docs: результаты проверки закрытия между организациями`. PR — с разрешения пользователя, как в задаче 7.

---

### Task 10: README курсовых репозиториев 👁

Работа идёт по процессу самих курсовых репозиториев. Для каждой правки заводится задача в нашем репозитории, ветка `web-<N>`/`api-<N>`, PR `WEB-<N>: …`/`API-<N>: …` со строкой `Closes …`. Мерж ментора заодно станет первой настоящей проверкой job `close`.

- [ ] **Step 1: Стоп — спросить пользователя**

«Завожу задачи „Обновить README: задачи в организации“ в `frontend` и `backend` и открываю два PR в курсовые репозитории. Текст раздела ниже. Делаем?» Показать текст из шага 3 для обоих репозиториев с учётом результатов задачи 9.

- [ ] **Step 2: Задачи и рабочие копии**

```bash
ORG=Cringe-Driven-Development-Team
jq -n '{title: "Обновить README: задачи в организации"}' > "$S/i.json"
NF=$(gh api repos/$ORG/frontend/issues --input "$S/i.json" --jq .number | tr -d '\r')
NB=$(gh api repos/$ORG/backend/issues --input "$S/i.json" --jq .number | tr -d '\r')
git -C /f/Github/2026_H2/frontend fetch -q origin
git -C /f/Github/2026_H2/frontend worktree add "$S/fe" -b "web-$NF" origin/main
git -C /f/Github/2026_H2/backend fetch -q origin
git -C /f/Github/2026_H2/backend worktree add "$S/be" -b "api-$NB" origin/main
```
Основная рабочая копия `frontend` с веткой `web-23` не затрагивается: правка идёт в отдельном worktree.

- [ ] **Step 3: Переписать раздел «Как работать с задачами»**

В `$S/fe/README.md` заменить всё от `## Как работать с задачами` до `## Типы коммитов` (не включая его) на текст ниже. Пункт 3 зависит от результата 2 задачи 9, пункт 5 — от результатов 3 и 4. Выбрать ровно один вариант, пометки `[вариант …]` в README не попадают.

````markdown
## Как работать с задачами

Код лежит здесь, а задачи — в
[Cringe-Driven-Development-Team/frontend](https://github.com/Cringe-Driven-Development-Team/frontend)
и на общей [доске](https://github.com/orgs/Cringe-Driven-Development-Team/projects/1) вместе с бэковыми

1. **Завести задачу.** На доске в нужной колонке `+ Add item` → ввести `#` →
   выбрать `frontend` → `Create new issue`

> [!WARNING]
> Текст без `#` создаёт черновик: он живёт только на доске, из него нельзя создать ветку,
> и pull request его не закроет

2. **Взять задачу.** На доске выбрать карточку из `Ready`, поставить себя
   в `Assignees`, перевести в `In progress`

3. **Создать ветку** `web-<номер задачи>`, например `web-12`.

   [вариант: кнопка предлагает этот репозиторий]
   Открыть задачу → в правой колонке `Development` → `Create a branch` →
   `Change branch source` → в `Repository destination` выбрать
   `frontend-park-mail-ru/2026_2_Cringe_Driven_Development`, имя — `web-12`.
   Затем `Create branch` и локально:

   ```bash
   git fetch
   git switch web-12
   ```

   [вариант: не предлагает]

   ```bash
   git fetch
   git switch -c web-12 origin/main
   ```

4. **Закоммитить** по шаблону `<тип>: <описание>`, типы — в таблице ниже.
   Область в скобках после типа указывать необязательно:

   ```
   feat: добавить форму входа
   fix: не сбрасывать фокус при ошибке валидации
   refactor(editor): вынести подсветку синтаксиса в отдельный модуль
   ```

5. **Открыть pull request** в `main`, когда код готов к ревью.
   Заголовок — по шаблону `WEB-<номер задачи>: <название задачи>`, например
   `WEB-12: Форма входа`. В описании — **обязательно** строка

   ```
   Closes Cringe-Driven-Development-Team/frontend#12
   ```

   Короткое `Closes #12` сошлётся на этот репозиторий, и задача не закроется.

   [вариант: GitHub связал PR с задачей]
   Убедиться, что в правой колонке PR в блоке `Development` указана задача

   [вариант: не связал]
   Перевести карточку на доске в `In review`

6. **Получить апрув** от [Ярослава](https://t.me/Yaroslav738)

7. **Влить в `main`** через `Merge pull request`.
   Задача закроется сама, карточка уедет в `Done`

````

Если PR с задачей не связывается, в разделе «Статусы на доске» заменить последнюю строку на: `Статусы доска двигает сама, кроме двух: взять задачу в работу (In progress) и отдать на ревью (In review) — руками`.

В `$S/be/README.md` тот же текст с заменами: `frontend` → `backend` в ссылках на наш репозиторий и в `Closes`, `web-` → `api-`, `WEB-` → `API-`, `frontend-park-mail-ru/2026_2_Cringe_Driven_Development` → `go-park-mail-ru/2026_2_Cringe_Driven_Development`, «вместе с бэковыми» → «вместе с фронтовыми». Примеры коммитов в пункте 4 — из текущего backend README (`feat: добавить эндпоинт регистрации`, `fix: не отдавать 500 при пустом теле запроса`, `refactor(auth): вынести проверку токена в middleware`). Заголовок-пример — `API-12: Эндпоинт регистрации`. Апрув — от [Александра](https://github.com/blackHATred).

- [ ] **Step 4: Коммит, push, PR**

Для frontend (backend так же, с `api-$NB`, `API-$NB`, `backend#$NB`):
```bash
git -C "$S/fe" commit -qam "docs: задачи — в организации, PR закрывает их полной ссылкой" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C "$S/fe" push -q -u origin "web-$NF"
```
Описание `$S/fe-pr.md` (Write):
```markdown
Задачи команды переехали в [Cringe-Driven-Development-Team/frontend](https://github.com/Cringe-Driven-Development-Team/frontend): там их видят доска, бот и спринты. Раздел «Как работать с задачами» описывает новый порядок: задача заводится с доски, PR закрывает её полной ссылкой.

Closes Cringe-Driven-Development-Team/frontend#<NF>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
```bash
gh pr create -R frontend-park-mail-ru/2026_2_Cringe_Driven_Development --base main --head "web-$NF" \
  --title "WEB-$NF: Обновить README: задачи в организации" --body-file "$S/fe-pr.md"
```

- [ ] **Step 5: Убрать worktree**

```bash
git -C /f/Github/2026_H2/frontend worktree remove "$S/fe"
git -C /f/Github/2026_H2/backend worktree remove "$S/be"
```

- [ ] **Step 6: После мержа ментором — проверить страховку**

```bash
gh run list -R frontend-park-mail-ru/2026_2_Cringe_Driven_Development --workflow automation.yml --event pull_request --limit 3
gh api repos/Cringe-Driven-Development-Team/frontend/issues/$NF --jq '"\(.state) \(.state_reason)"' | tr -d '\r'
gh api repos/Cringe-Driven-Development-Team/frontend/issues/$NF/comments --jq '.[].body' | tr -d '\r'
```
Expected: запуск зелёный, задача `closed completed`. Комментарий `<!-- auto -->Закрыта мержем …` есть, если закрыла страховка, и его нет, если GitHub успел раньше. Результат дописать в раздел «Результаты проверки» спеки.

---

### Task 11: выключить Issues в курсовых репозиториях 👁

- [ ] **Step 1: Стоп — «Менторы согласны? Выключаю Issues в обоих курсовых репозиториях: ссылки на их задачи начнут отдавать 404, карточки 18 закрытых задач на доске перестанут открываться. Включается обратно тем же вызовом с `true`.»** Без «да» не выполнять.

- [ ] **Step 2: Выключить**

```bash
for r in frontend-park-mail-ru/2026_2_Cringe_Driven_Development go-park-mail-ru/2026_2_Cringe_Driven_Development; do
  gh api -X PATCH "repos/$r" -F has_issues=false --jq '"\(.full_name) issues=\(.has_issues)"' | tr -d '\r'
done
```
Expected: `… issues=false` для обоих.
