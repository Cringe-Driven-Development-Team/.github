# Общие workflow в `.github` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести `telegram.yml` и `add-to-project.yml` в переиспользуемые workflow репозитория `Cringe-Driven-Development-Team/.github` и перевести шесть репозиториев на короткий файл-вызов `automation.yml`.

**Architecture:** В `.github` лежат два workflow с `on: workflow_call` и файл-вызов для самого `.github` (ссылки `./`, поэтому PR в `.github` проверяет правку на живых событиях до мержа). Шесть репозиториев вызывают их по `@main` и явно передают два секрета; `vars` и контекст `github` приходят от вызывающего репозитория. Скрипт уведомлений остаётся bash-блоком в YAML и покрывается тестовым стендом: скрипт извлекается из YAML и прогоняется на подставных событиях с заглушкой `curl`.

**Tech Stack:** GitHub Actions (reusable workflows), bash, jq, perl, GNU date/awk, `gh` CLI, actionlint, shellcheck. Рабочая машина — Windows, Git Bash.

**Spec:** `docs/superpowers/specs/2026-09-18-central-workflows-design.md` (в этом же репозитории).

## Global Constraints

- Центральные workflow вызываются по `@main`: `Cringe-Driven-Development-Team/.github/.github/workflows/<файл>.yml@main`.
- Секреты передаются явно, без `secrets: inherit`; в файле-вызове `permissions: {}`.
- Уведомления идут в боевой топик, песочницы нет — тестовые сообщения там ожидаемы.
- В публичный `.github` не попадают настоящие ID чата и участников: в тестах только выдуманные значения (`111`, `222`, `-100`).
- Значения секретов не печатать и не логировать.
- Коммиты: `<тип>: <что сделано>` по-русски со строчной буквы; последней строкой — `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Описание PR заканчивается строкой `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- PR мержатся только merge-коммитом: `gh pr merge <N> --merge`.
- Именование: frontend — issue → ветка `web-N` → PR «WEB-N: …»; backend — issue → `api-N` → «API-N: …»; react, static, infra, docs — ветка `chore/reusable-workflows`, PR без префикса.
- `actionlint` запускать только с `-shellcheck= -pyflakes=`: на этой машине встроенный вызов shellcheck зависает. shellcheck запускается отдельно (`tests/lint.sh`).
- Инструменты `jq`, `shellcheck`, `actionlint` уже в PATH. Рабочие копии — `F:\Github\2026_H2\<репозиторий>`, в Git Bash — `/f/Github/2026_H2/<репозиторий>`; клон `.github` — `/f/Github/2026_H2/.github`.
- Shell-функции (`last_run`, `tg_text`) не переживают отдельный вызов Bash — объявлять в той же команде, где используются.

## Карта файлов

Репозиторий `.github`:

| Файл | Ответственность |
|---|---|
| `.gitattributes` | LF в рабочей копии — bash и awk не работают с CRLF (`core.autocrlf=true` на машине) |
| `.github/workflows/telegram.yml` | уведомления в Telegram, `on: workflow_call` |
| `.github/workflows/add-to-project.yml` | issue на доску Sprint Board, `on: workflow_call` |
| `.github/workflows/automation.yml` | файл-вызов для самого `.github`, ссылки `./` |
| `tests/extract-run.awk` | достаёт тело первого `run: \|` из workflow |
| `tests/telegram.sh` | прогон скрипта уведомлений на подставных событиях |
| `tests/lint.sh` | actionlint по всем workflow + shellcheck по их скриптам |
| `README.md` | что здесь, как подключить репозиторий, как вносить правки |

В каждом из шести репозиториев: удалить `.github/workflows/telegram.yml` и `.github/workflows/add-to-project.yml`, добавить `.github/workflows/automation.yml`.

---

### Task 1: Переиспользуемый `telegram.yml` и тесты на текущее поведение

**Files:**
- Create: `.gitattributes`
- Create: `.github/workflows/telegram.yml` (копия `infra/.github/workflows/telegram.yml` с новым блоком `on:`)
- Create: `tests/extract-run.awk`
- Create: `tests/telegram.sh`

**Interfaces:**
- Produces: `bash tests/telegram.sh` — печатает `ok   <случай>` / `FAIL <случай>: <причина>`, в конце `итого: X ok, Y fail`, код выхода 0 только без FAIL. Хелперы внутри: `when "<название>" VAR=значение ...`, затем одна из проверок `sent "<есть>" "!<нет>" ...`, `silent`, `error "<текст>"`.
- Produces: `awk -f tests/extract-run.awk <workflow.yml>` — печатает тело первого блока `run: |` без YAML-отступа.

- [ ] **Step 1: Ветка и перевод строк**

```bash
cd /f/Github/2026_H2/.github
git switch main && git pull --ff-only
git switch -c feature/reusable-workflows
printf '* text=auto eol=lf\n' > .gitattributes
git add .gitattributes && git add --renormalize .
```

- [ ] **Step 2: Экстрактор скрипта**

Create `tests/extract-run.awk`:

```awk
# Печатает тело первого блока `run: |` из workflow без отступа YAML.
# Запуск: awk -f tests/extract-run.awk .github/workflows/telegram.yml
!found && /^[ ]*run: \|[ ]*$/ { found = 1; next }
found {
  if ($0 ~ /^[ ]*$/) { print ""; next }
  match($0, /^ */)
  if (!ind) ind = RLENGTH
  if (RLENGTH < ind) exit
  print substr($0, ind + 1)
}
```

- [ ] **Step 3: Тестовый стенд с регрессионными случаями**

Create `tests/telegram.sh`:

```bash
#!/usr/bin/env bash
# Прогоняет скрипт из .github/workflows/telegram.yml на подставных событиях.
# curl подменён заглушкой: в Telegram ничего не уходит, текст сообщения пишется в файл.
# Нужны bash, jq, perl, GNU date и awk. Запуск: bash tests/telegram.sh
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

awk -f "$ROOT/tests/extract-run.awk" "$ROOT/.github/workflows/telegram.yml" > "$TMP/script.sh"
[ -s "$TMP/script.sh" ] || { echo "в telegram.yml не найден блок run: |"; exit 1; }

mkdir "$TMP/bin"
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
# заглушка: запомнить text= и ответить как Telegram
while [ $# -gt 0 ]; do
  case "$1" in
    --data-urlencode) case "$2" in text=*) printf '%s' "${2#text=}" > "$SENT" ;; esac; shift 2 ;;
    *) shift ;;
  esac
done
echo '{"ok":true}'
STUB
chmod +x "$TMP/bin/curl"

# так GitHub заполняет env: отсутствующее поле события — пустая строка, toJSON(null) — null.
# ID в карте ненастоящие: репозиторий публичный.
DEFAULTS=(
  TOKEN=test-token CHAT=-100 TOPIC=26 MAP='{"YarikMix":"111","blackHATred":"222"}'
  EVENT= ACTION= MERGED= DRAFT= BASE= REVIEW= REVIEWER= PR_AUTHOR=
  ACTOR=YarikMix REPO=Cringe-Driven-Development-Team/react
  NUMBER= TITLE= URL= BRANCH= COMMITS=null COMPARE= FORCED=
  BODY= ASSIGNEES=null CREATED= UPDATED= CHG_BODY=null
)

PASS=0
FAIL=0

# when "название" VAR=значение ... — прогнать скрипт на событии
when() {
  NAME=$1
  shift
  rm -f "$TMP/sent"
  env PATH="$TMP/bin:$PATH" SENT="$TMP/sent" "${DEFAULTS[@]}" "$@" \
    bash -e "$TMP/script.sh" > "$TMP/out" 2>&1
  CODE=$?
}

pass() { PASS=$((PASS + 1)); echo "ok   $NAME"; }

fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL $NAME: $1"
  if [ -f "$TMP/sent" ]; then sed 's/^/     | /' "$TMP/sent"; echo; fi
  sed 's/^/     > /' "$TMP/out"
}

# sent "есть" "!нет" ... — ушло сообщение, в нём есть одни куски и нет других
sent() {
  [ "$CODE" -eq 0 ] || { fail "код выхода $CODE"; return; }
  [ -f "$TMP/sent" ] || { fail "сообщение не отправлено"; return; }
  for s in "$@"; do
    case "$s" in
      !*) ! grep -qF -- "${s#!}" "$TMP/sent" || { fail "лишнее «${s#!}»"; return; } ;;
      *) grep -qF -- "$s" "$TMP/sent" || { fail "нет «$s»"; return; } ;;
    esac
  done
  pass
}

# silent — отработал без ошибки и ничего не отправил
silent() {
  [ "$CODE" -eq 0 ] || { fail "код выхода $CODE"; return; }
  [ ! -f "$TMP/sent" ] || { fail "сообщение отправлено"; return; }
  pass
}

# error "текст" — упал до отправки и сказал почему
error() {
  [ "$CODE" -ne 0 ] || { fail "код выхода 0"; return; }
  [ ! -f "$TMP/sent" ] || { fail "сообщение отправлено"; return; }
  grep -qF -- "$1" "$TMP/out" || { fail "нет «$1» в выводе"; return; }
  pass
}

# --- задачи

when "issue opened: заголовок, автор, исполнитель, описание" \
  EVENT=issues ACTION=opened NUMBER=5 TITLE='Починить <b>вход</b>' URL=https://github.com/o/r/issues/5 \
  ASSIGNEES='[{"login":"blackHATred"}]' BODY=$'## Что сделать\r\nПроверить <!-- скрыто --> & записать' \
  CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T10:00:00Z
sent "🆕 Новая задача" "#5 Починить &lt;b&gt;вход&lt;/b&gt;" \
  'автор: <a href="tg://user?id=111">YarikMix</a>' \
  'исполнитель: <a href="tg://user?id=222">blackHATred</a>' \
  "<blockquote expandable>Что сделать" "&amp; записать" "!скрыто"

when "issue closed: без описания" \
  EVENT=issues ACTION=closed NUMBER=5 TITLE=Задача URL=u BODY=текст ASSIGNEES='[]' \
  CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T12:00:00Z
sent "✅ Задача закрыта" "!blockquote"

when "issue edited: правка заголовка молчит" \
  EVENT=issues ACTION=edited NUMBER=5 TITLE=Задача URL=u CHG_BODY=null \
  CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T12:00:00Z
silent

when "issue edited: правка описания в первые 10 минут молчит" \
  EVENT=issues ACTION=edited NUMBER=5 TITLE=Задача URL=u BODY=новое CHG_BODY='{"from":"старое"}' \
  CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T10:05:00Z
silent

when "issue edited: поздняя правка описания" \
  EVENT=issues ACTION=edited NUMBER=5 TITLE=Задача URL=u BODY=новое CHG_BODY='{"from":"старое"}' \
  ASSIGNEES='[]' CREATED=2026-09-17T10:00:00Z UPDATED=2026-09-17T11:00:00Z
sent "✏️ Описание изменено" "новое"

# --- пуши

when "push: коммиты ветки" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=https://github.com/o/r/compare/a...b FORCED=false \
  REPO=frontend-park-mail-ru/2026_2_Cringe_Driven_Development \
  COMMITS='[{"id":"aaaaaaa1111","message":"feat: первое\n\nтело","distinct":true},{"id":"ccccccc3333","message":"fix: второе","distinct":true}]'
sent "⚒️ 2 коммита" "· frontend ·" "• aaaaaaa feat: первое" "• ccccccc fix: второе" "!тело"

when "push: force-push помечен" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=c FORCED=true \
  COMMITS='[{"id":"aaaaaaa1111","message":"feat: первое","distinct":true}]'
sent "⚠️ 1 коммит (force-push)"

when "push: без коммитов (создание ветки) молчит" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=c FORCED=false COMMITS='[]'
silent

# --- pull request и ревью

when "pr opened" \
  EVENT=pull_request ACTION=opened DRAFT=false BASE=main NUMBER=7 TITLE='WEB-5: Вход' URL=https://github.com/o/r/pull/7
sent "🔀 Открыт pull request" "WEB-5: Вход" '<a href="tg://user?id=111">YarikMix</a>'

when "pr review requested: упомянут ревьюер" \
  EVENT=pull_request ACTION=review_requested REVIEWER=blackHATred NUMBER=7 TITLE=t URL=u
sent "👀 Запрошено ревью" 'tg://user?id=222'

when "pr review requested у команды молчит" \
  EVENT=pull_request ACTION=review_requested REVIEWER= NUMBER=7 TITLE=t URL=u
silent

when "pr влит в main" \
  EVENT=pull_request ACTION=closed MERGED=true BASE=main NUMBER=7 TITLE=t URL=u
sent "🎉 Влито в main"

when "pr закрыт без мержа" \
  EVENT=pull_request ACTION=closed MERGED=false BASE=main NUMBER=7 TITLE=t URL=u
sent "🚫 PR закрыт без мержа"

when "review approved: упомянут автор PR" \
  EVENT=pull_request_review ACTION=submitted REVIEW=approved PR_AUTHOR=blackHATred NUMBER=7 TITLE=t URL=u
sent "👍 Апрув" 'tg://user?id=222'

when "review commented молчит" \
  EVENT=pull_request_review ACTION=submitted REVIEW=commented PR_AUTHOR=blackHATred NUMBER=7 TITLE=t URL=u
silent

when "без карты: логин текстом, сторона — имя репозитория" \
  EVENT=pull_request ACTION=opened DRAFT=false MAP= REPO=Cringe-Driven-Development-Team/.github NUMBER=1 TITLE=t URL=u
sent "· .github" "YarikMix" "!tg://user"

echo
echo "итого: $PASS ok, $FAIL fail"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 4: Запустить стенд — должен упасть**

Run: `bash tests/telegram.sh`
Expected: `в telegram.yml не найден блок run: |` (awk также ругнётся на отсутствующий файл), код выхода 1.

- [ ] **Step 5: Скопировать `telegram.yml` из infra**

```bash
git -C ../infra switch main && git -C ../infra pull --ff-only
mkdir -p .github/workflows
cp ../infra/.github/workflows/telegram.yml .github/workflows/telegram.yml
```

- [ ] **Step 6: Заменить триггеры на `workflow_call`**

В `.github/workflows/telegram.yml` заменить блок

```yaml
on:
  push:
    branches-ignore: [main]
  issues:
    types: [opened, closed, reopened, edited]
  pull_request:
    types: [opened, ready_for_review, closed, review_requested]
  pull_request_review:
    types: [submitted]
```

на

```yaml
on:
  workflow_call:
    secrets:
      TELEGRAM_BOT_TOKEN:
        required: true
```

Проверить, что больше ничего не изменилось:

Run: `diff <(sed -n '13,$p' ../infra/.github/workflows/telegram.yml) <(sed -n '9,$p' .github/workflows/telegram.yml) && echo same`
Expected: `same`

- [ ] **Step 7: Запустить стенд — должен пройти**

Run: `bash tests/telegram.sh`
Expected: 16 строк `ok`, последняя — `итого: 16 ok, 0 fail`, код выхода 0.

- [ ] **Step 8: Commit**

```bash
git add .gitattributes .github/workflows/telegram.yml tests/extract-run.awk tests/telegram.sh
git commit -F - <<'EOF'
chore: переиспользуемый telegram.yml и тесты на текущее поведение

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Четыре правки в скрипте уведомлений

**Files:**
- Modify: `.github/workflows/telegram.yml` (блок `env:` и `run:`)
- Modify: `tests/telegram.sh` (новые случаи перед итогом)

**Interfaces:**
- Consumes: хелперы `when` / `sent` / `silent` / `error` из Task 1.
- Produces: `telegram.yml` читает две новые переменные окружения — `DRAFT` (`github.event.pull_request.draft`) и `BASE` (`github.event.pull_request.base.ref`); при пустых `TOKEN` или `CHAT` печатает `::error::…` с именем настройки и выходит с кодом 1.

- [ ] **Step 1: Добавить падающие тесты**

В `tests/telegram.sh` вставить перед финальными тремя строками (`echo`, `echo "итого: …"`, `[ "$FAIL" -eq 0 ]`):

```bash
# --- правки при переносе в .github

when "draft pr opened молчит" \
  EVENT=pull_request ACTION=opened DRAFT=true BASE=main NUMBER=7 TITLE=t URL=u
silent

when "draft переведён в ready" \
  EVENT=pull_request ACTION=ready_for_review DRAFT=false BASE=main NUMBER=7 TITLE='WEB-5: Вход' URL=u
sent "🔀 Открыт pull request" "WEB-5: Вход"

when "push: коммиты из main не показываются" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=c FORCED=false \
  COMMITS='[{"id":"ddddddd4444","message":"Merge branch main into web-5","distinct":true},{"id":"bbbbbbb2222","message":"fix: из main","distinct":false}]'
sent "⚒️ 1 коммит" "• ddddddd Merge branch main into web-5" "!bbbbbbb"

when "push: только чужие коммиты молчит" \
  EVENT=push BRANCH=refs/heads/web-5 COMPARE=c FORCED=false \
  COMMITS='[{"id":"bbbbbbb2222","message":"fix: из main","distinct":false}]'
silent

when "pr влит не в main, имя ветки экранировано" \
  EVENT=pull_request ACTION=closed MERGED=true BASE='exp<1>' NUMBER=7 TITLE=t URL=u
sent "🎉 Влито в exp&lt;1&gt;" "!Влито в main"

when "нет токена" TOKEN= EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u
error "TELEGRAM_BOT_TOKEN"

when "нет чата" CHAT= EVENT=issues ACTION=opened NUMBER=5 TITLE=t URL=u
error "TELEGRAM_CHAT_ID"
```

- [ ] **Step 2: Запустить — шесть новых случаев падают**

Run: `bash tests/telegram.sh | grep -E '^(FAIL|итого)'`
Expected:

```
FAIL draft pr opened молчит: сообщение отправлено
FAIL push: коммиты из main не показываются: нет «⚒️ 1 коммит»
FAIL push: только чужие коммиты молчит: сообщение отправлено
FAIL pr влит не в main, имя ветки экранировано: нет «🎉 Влито в exp&lt;1&gt;»
FAIL нет токена: код выхода 0
FAIL нет чата: код выхода 0
итого: 17 ok, 6 fail
```

- [ ] **Step 3: Новые переменные окружения**

В `.github/workflows/telegram.yml` заменить

```yaml
          MERGED:    ${{ github.event.pull_request.merged }}
```

на

```yaml
          MERGED:    ${{ github.event.pull_request.merged }}
          DRAFT:     ${{ github.event.pull_request.draft }}
          BASE:      ${{ github.event.pull_request.base.ref }}
```

- [ ] **Step 4: Проверка настроек в начале скрипта**

Заменить

```yaml
        run: |
          WHO="$ACTOR"
```

на

```yaml
        run: |
          # без токена или чата Telegram ответит невнятной ошибкой — называем, чего не хватает
          [ -n "$TOKEN" ] || { echo "::error::Не задан секрет TELEGRAM_BOT_TOKEN"; exit 1; }
          [ -n "$CHAT" ] || { echo "::error::Не задана переменная TELEGRAM_CHAT_ID"; exit 1; }

          WHO="$ACTOR"
```

- [ ] **Step 5: Только свои коммиты**

Заменить

```bash
            push:)
              COUNT=$(printf '%s' "$COMMITS" | jq 'length')
```

на

```bash
            push:)
              # коммиты, которые уже были в других ветках (подтянутые из main), — не новость
              COMMITS=$(printf '%s' "$COMMITS" | jq -c 'map(select(.distinct))')
              COUNT=$(printf '%s' "$COMMITS" | jq 'length')
```

- [ ] **Step 6: Черновики PR**

Заменить

```bash
            pull_request:opened|pull_request:ready_for_review)
                             HEAD="🔀 Открыт pull request" ;;
```

на

```bash
            pull_request:opened|pull_request:ready_for_review)
              # о черновике сообщим, когда его переведут в ready_for_review
              [ "$ACTION" = "opened" ] && [ "$DRAFT" = "true" ] && exit 0
              HEAD="🔀 Открыт pull request" ;;
```

- [ ] **Step 7: Целевая ветка из события**

Заменить

```bash
                HEAD="🎉 Влито в main"
```

на

```bash
                HEAD="🎉 Влито в $(esc "$BASE")"
```

- [ ] **Step 8: Запустить — всё проходит**

Run: `bash tests/telegram.sh | tail -1`
Expected: `итого: 23 ok, 0 fail`

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/telegram.yml tests/telegram.sh
git commit -F - <<'EOF'
fix: черновики, чужие коммиты, целевая ветка и пустые настройки в уведомлениях

- на открытие черновика PR сообщения нет, оно придёт на ready_for_review
- в пуше только коммиты с distinct: подтянутые из main не показываются
- «Влито в …» берёт ветку из pull_request.base.ref
- без TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID — понятная ошибка до обращения к Telegram

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Доска, файл-вызов, линтер, README

**Files:**
- Create: `.github/workflows/add-to-project.yml`
- Create: `.github/workflows/automation.yml`
- Create: `tests/lint.sh`
- Modify: `README.md` (заменить целиком)
- Modify: `docs/superpowers/specs/2026-09-18-central-workflows-design.md` (дерево репозитория и строка про локальную проверку)

**Interfaces:**
- Consumes: `.github/workflows/telegram.yml` с секретом `TELEGRAM_BOT_TOKEN` (Task 1–2), `tests/extract-run.awk` (Task 1).
- Produces: `add-to-project.yml` — `on: workflow_call`, обязательный секрет `ADD_TO_PROJECT_PAT`, job `add-to-project`. `bash tests/lint.sh` — печатает `lint ok` и выходит с 0, если actionlint и shellcheck (`-S warning`) чисты.

- [ ] **Step 1: Линтер**

Create `tests/lint.sh`:

```bash
#!/usr/bin/env bash
# Проверяет все workflow: actionlint — YAML и выражения, shellcheck — скрипты из run: |.
# shellcheck запускается отдельно: встроенный вызов из actionlint на Windows зависает.
# Нужны actionlint, shellcheck и awk. Запуск: bash tests/lint.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

actionlint -no-color -oneline -shellcheck= -pyflakes=

for wf in .github/workflows/*.yml; do
  awk -f tests/extract-run.awk "$wf" > "$TMP/run.sh"
  [ -s "$TMP/run.sh" ] || continue
  shellcheck -s bash -S warning "$TMP/run.sh" || { echo "shellcheck: замечания в $wf"; exit 1; }
done

echo "lint ok"
```

Run: `bash tests/lint.sh`
Expected: `lint ok` (пока проверяется только `telegram.yml`).

- [ ] **Step 2: `add-to-project.yml`**

```bash
cp ../infra/.github/workflows/add-to-project.yml .github/workflows/add-to-project.yml
```

В `.github/workflows/add-to-project.yml` заменить

```yaml
on:
  issues:
    types: [opened, reopened]
```

на

```yaml
on:
  workflow_call:
    secrets:
      ADD_TO_PROJECT_PAT:
        required: true
```

и заменить

```yaml
  add-to-project:
    runs-on: ubuntu-latest
```

на

```yaml
  add-to-project:
    if: github.event_name == 'issues' && (github.event.action == 'opened' || github.event.action == 'reopened')
    runs-on: ubuntu-latest
```

- [ ] **Step 3: Файл-вызов для самого `.github`**

Create `.github/workflows/automation.yml`:

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
    uses: ./.github/workflows/add-to-project.yml
    secrets:
      ADD_TO_PROJECT_PAT: ${{ secrets.ADD_TO_PROJECT_PAT }}
  telegram:
    uses: ./.github/workflows/telegram.yml
    secrets:
      TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
```

- [ ] **Step 4: Линтер и тесты по всем трём файлам**

Run: `bash tests/lint.sh && bash tests/telegram.sh | tail -1`
Expected: `lint ok`, затем `итого: 23 ok, 0 fail`. Если actionlint ругается на `uses: ./…` — проверить, что имя секрета в `automation.yml` совпадает с `workflow_call.secrets` вызываемого файла.

- [ ] **Step 5: README**

Заменить `README.md` целиком:

````markdown
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
````

- [ ] **Step 6: Обновить дерево в спеке**

В `docs/superpowers/specs/2026-09-18-central-workflows-design.md` заменить

```
├── README.md                — что здесь, как подключить репозиторий, как вносить правки
├── docs/superpowers/specs/  — эта спека
└── .github/workflows/
```

на

```
├── README.md                — что здесь, как подключить репозиторий, как вносить правки
├── .gitattributes           — LF в рабочей копии: bash и awk не работают с CRLF
├── docs/superpowers/        — спека и план
├── tests/
│   ├── telegram.sh          — скрипт уведомлений на подставных событиях, curl — заглушка
│   ├── lint.sh              — actionlint + shellcheck
│   └── extract-run.awk      — достаёт скрипт из блока run: |
└── .github/workflows/
```

и заменить

```
**Локально, до пуша:** `actionlint` по всем новым и изменённым YAML (синтаксис, контексты `${{ }}`, bash внутри `run:` через `shellcheck`, если установлен).
```

на

```
**Локально, до пуша:** `bash tests/telegram.sh` — скрипт уведомлений на подставных событиях с заглушкой `curl`; `bash tests/lint.sh` — `actionlint` (синтаксис, контексты `${{ }}`, вызовы reusable workflow) и `shellcheck -S warning` по скриптам из `run: |`. shellcheck запускается отдельно от actionlint: встроенный вызов на Windows зависает.
```

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/add-to-project.yml .github/workflows/automation.yml tests/lint.sh README.md docs/superpowers/specs/2026-09-18-central-workflows-design.md
git commit -F - <<'EOF'
chore: доска задач, файл-вызов, линтер и README

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: PR в `.github` и проверка на живых событиях

Каждый шаг ниже порождает событие. После него: дождаться нового запуска `Автоматизация` (появляется за 5–15 секунд после события), `gh run watch <id> -R "$R" --exit-status`, затем проверить текст сообщения. Хелперы (объявлять в той же команде):

```bash
R=Cringe-Driven-Development-Team/.github
# последний запуск «Автоматизация» по событию
last_run() { gh run list -R "$R" --workflow automation.yml --event "$1" --limit 1 --json databaseId,headBranch,conclusion,createdAt --jq '.[0]'; }
# текст ушедшего в Telegram сообщения; пусто — ничего не уходило
tg_text() { gh run view "$1" -R "$R" --log | grep -o '{"ok":true.*' | jq -r '.result.text'; }
```

**Files:** нет новых. Один служебный коммит в `main`: строка статуса в спеке.

**Interfaces:**
- Consumes: ветка `feature/reusable-workflows` из Task 1–3.
- Produces: `main` репозитория `.github` с тремя workflow — от него зависят Task 5–8.

- [ ] **Step 1: Push ветки**

```bash
cd /f/Github/2026_H2/.github
git push -u origin feature/reusable-workflows
```

Дождаться `last_run push`, `gh run watch`. Expected: запуск success; job `board / add-to-project` — skipped; job `telegram / notify` — success. Записать, что пришло: сообщение «⚒️ N коммитов · .github · feature/reusable-workflows» с коммитами Task 1–3 **или** ничего (если GitHub не кладёт коммиты в событие создания ветки). Это ответ на открытый вопрос «видно ли первый пуш новой ветки» — занести в итоговый отчёт.

- [ ] **Step 2: PR черновиком**

```bash
gh pr create -R "$R" --draft --base main --head feature/reusable-workflows \
  --title "Общие workflow: Telegram и доска задач" --body-file - <<'EOF'
Переиспользуемые workflow для всех репозиториев команды: уведомления в Telegram и добавление issue на доску. Подключённые репозитории вызывают их по `@main` из короткого `automation.yml`.

Перенос из копий в шести репозиториях плюс четыре правки: черновик PR не даёт лишнего сообщения, в пуше только свои коммиты, «Влито в …» берёт целевую ветку из события, пустые токен или чат дают понятную ошибку.

Спека: docs/superpowers/specs/2026-09-18-central-workflows-design.md
План: docs/superpowers/plans/2026-09-18-central-workflows.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Дождаться `last_run pull_request`. Expected: success; `tg_text <id>` — пусто (черновик молчит).

- [ ] **Step 3: Служебный коммит в `main`**

```bash
git switch main && git pull --ff-only
sed -i 's/^Статус: дизайн согласован в чате, ждёт вычитки спеки$/Статус: в работе — docs\/superpowers\/plans\/2026-09-18-central-workflows.md/' docs/superpowers/specs/2026-09-18-central-workflows-design.md
grep -n '^Статус:' docs/superpowers/specs/2026-09-18-central-workflows-design.md
git commit -am "docs: спека в работе" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push origin main
```

Expected: `grep` показывает новую строку статуса. Запуска `Автоматизация` на push в `main` нет — в `main` ещё нет `automation.yml`.

- [ ] **Step 4: Подтянуть `main` в ветку**

```bash
git switch feature/reusable-workflows
git merge --no-edit origin/main
git push
```

Expected: merge без конфликтов (правки спеки в разных местах файла). `last_run push` — success; `tg_text` — «⚒️ 1 коммит» и строка `• <sha> Merge remote-tracking branch 'origin/main' into feature/reusable-workflows`, без коммита «docs: спека в работе».

- [ ] **Step 5: Перевести PR в ready**

```bash
PR=$(gh pr view feature/reusable-workflows -R "$R" --json number --jq .number)
gh pr ready "$PR" -R "$R"
```

Expected: `last_run pull_request` — success; `tg_text` начинается с «🔀 Открыт pull request · .github», во второй строке «Общие workflow: Telegram и доска задач».

- [ ] **Step 6: Смерджить**

```bash
gh pr merge "$PR" -R "$R" --merge
git switch main && git pull --ff-only
```

Expected: `last_run pull_request` — success; `tg_text` — «🎉 Влито в main · .github». В `main` есть `.github/workflows/automation.yml`, `add-to-project.yml`, `telegram.yml`.

---

### Task 5: Трекинг-issue

**Files:** нет.

**Interfaces:**
- Consumes: `main` репозитория `.github` с workflow (Task 4).
- Produces: issue «Подключить общие workflow во все репозитории» в `.github` — номер ищется так: `gh issue list -R Cringe-Driven-Development-Team/.github --search "Подключить общие workflow во все репозитории in:title" --json number --jq '.[0].number'`. Task 6–8 оставляют в нём комментарии, Task 9 закрывает.

- [ ] **Step 1: Создать issue**

```bash
R=Cringe-Driven-Development-Team/.github
gh issue create -R "$R" --title "Подключить общие workflow во все репозитории" --body-file - <<'EOF'
Заменить копии telegram.yml и add-to-project.yml файлом-вызовом automation.yml в репозиториях:

- frontend-park-mail-ru/2026_2_Cringe_Driven_Development
- Cringe-Driven-Development-Team/react
- Cringe-Driven-Development-Team/static
- Cringe-Driven-Development-Team/infra
- Cringe-Driven-Development-Team/docs
- go-park-mail-ru/2026_2_Cringe_Driven_Development

По мере перевода — комментарий со ссылкой на PR.
EOF
```

- [ ] **Step 2: Проверить уведомление и доску**

Дождаться `last_run issues` (хелперы из Task 4). Expected: success; jobs `board / add-to-project` и `telegram / notify` — success; `tg_text` — «🆕 Новая задача · .github», `#<T> Подключить общие workflow во все репозитории`, цитата с описанием.

```bash
T=$(gh issue list -R Cringe-Driven-Development-Team/.github --search "Подключить общие workflow во все репозитории in:title" --json number --jq '.[0].number')
gh api graphql -F n="$T" -f query='query($n: Int!) { repository(owner: "Cringe-Driven-Development-Team", name: ".github") { issue(number: $n) { projectItems(first: 5) { nodes { project { title } } } } } }' --jq '.data.repository.issue.projectItems.nodes[].project.title'
```

Expected: `Sprint Board`.

---

### Task 6: Перевести frontend

Первая проверка вызова из другой организации.

**Files (в `/f/Github/2026_H2/frontend`):**
- Delete: `.github/workflows/telegram.yml`, `.github/workflows/add-to-project.yml`
- Create: `.github/workflows/automation.yml`

**Interfaces:**
- Consumes: `telegram.yml@main`, `add-to-project.yml@main` из `.github` (Task 4); номер трекинг-issue (Task 5).

Хелперы для этой задачи:

```bash
R=frontend-park-mail-ru/2026_2_Cringe_Driven_Development
last_run() { gh run list -R "$R" --workflow automation.yml --event "$1" --limit 1 --json databaseId,headBranch,conclusion,createdAt --jq '.[0]'; }
tg_text() { gh run view "$1" -R "$R" --log | grep -o '{"ok":true.*' | jq -r '.result.text'; }
```

- [ ] **Step 1: Issue и ветка**

```bash
cd /f/Github/2026_H2/frontend
git status --short          # должно быть пусто
git switch main && git pull --ff-only
N=$(gh issue create -R "$R" --title "Подключить общие workflow из .github" --body "Заменить копии telegram.yml и add-to-project.yml файлом-вызовом automation.yml: логика уведомлений и доски теперь живёт в Cringe-Driven-Development-Team/.github." | sed 's#.*/##')
echo "issue #$N"
gh issue develop "$N" -R "$R" --name "web-$N" --base main --checkout
git branch --show-current   # web-N
```

Issue и создание ветки ещё обрабатываются старыми workflow из `main` — это нормально.

- [ ] **Step 2: Заменить файлы**

```bash
git rm -q .github/workflows/telegram.yml .github/workflows/add-to-project.yml
```

Create `.github/workflows/automation.yml`:

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

Run: `actionlint -no-color -oneline -shellcheck= -pyflakes= .github/workflows/automation.yml && echo ok`
Expected: `ok`

- [ ] **Step 3: Commit и push**

```bash
git add .github/workflows/automation.yml
git commit -F - <<'EOF'
chore: подключить общие workflow из .github

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git push -u origin "web-$N"
```

Дождаться `last_run push`. Expected: success; `tg_text` — «⚒️ 1 коммит · frontend · web-N», `• <sha> chore: подключить общие workflow из .github`.
**Если conclusion — `startup_failure` или `failure` с текстом про доступ к workflow:** политика организации frontend-park-mail-ru не пускает чужие reusable workflow. Остановиться, показать пользователю `gh run view <id> -R "$R"` и не продолжать Task 7–8.

- [ ] **Step 4: PR**

```bash
gh pr create -R "$R" --base main --head "web-$N" --title "WEB-$N: Подключить общие workflow из .github" --body-file - <<EOF
Уведомления в Telegram и добавление issue на доску теперь живут в Cringe-Driven-Development-Team/.github. Здесь остаётся только \`automation.yml\` с триггерами и вызовом общих workflow — правки скрипта больше не нужно проносить в каждый репозиторий.

Заодно: на черновик PR не приходит лишнее сообщение, после merge main в ветку в уведомлении только свои коммиты, «Влито в …» берёт целевую ветку из события.

Спека: https://github.com/Cringe-Driven-Development-Team/.github/blob/main/docs/superpowers/specs/2026-09-18-central-workflows-design.md

Closes #$N

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Дождаться `last_run pull_request`. Expected: success; `tg_text` — «🔀 Открыт pull request · frontend», «WEB-N: Подключить общие workflow из .github».

- [ ] **Step 5: Мерж**

```bash
PR=$(gh pr view "web-$N" -R "$R" --json number --jq .number)
gh pr merge "$PR" -R "$R" --merge
git switch main && git pull --ff-only
ls .github/workflows        # только automation.yml
```

Expected:
- `last_run pull_request` — success, `tg_text` — «🎉 Влито в main · frontend»;
- `last_run issues` (закрытие issue #N, уже из нового `main`) — success, `board / add-to-project` skipped, `tg_text` — «✅ Задача закрыта · frontend».

- [ ] **Step 6: Отметить в трекинг-issue**

```bash
T=$(gh issue list -R Cringe-Driven-Development-Team/.github --search "Подключить общие workflow во все репозитории in:title" --json number --jq '.[0].number')
gh issue comment "$T" -R Cringe-Driven-Development-Team/.github --body "frontend: https://github.com/$R/pull/$PR — влит, вызов из другой организации работает."
```

---

### Task 7: Перевести react, static, infra, docs

Четыре одинаковых прохода: для каждой пары `D` (папка) и `R` (репозиторий) из списка выполнить шаги 1–5.

| D | R |
|---|---|
| react | Cringe-Driven-Development-Team/react |
| static | Cringe-Driven-Development-Team/static |
| infra | Cringe-Driven-Development-Team/infra |
| docs | Cringe-Driven-Development-Team/docs |

**Files (в `/f/Github/2026_H2/$D`):**
- Delete: `.github/workflows/telegram.yml`, `.github/workflows/add-to-project.yml`
- Create: `.github/workflows/automation.yml`

**Interfaces:**
- Consumes: `telegram.yml@main`, `add-to-project.yml@main` (Task 4); номер трекинг-issue (Task 5).

Хелперы (подставить `R` текущего прохода):

```bash
R=Cringe-Driven-Development-Team/react
last_run() { gh run list -R "$R" --workflow automation.yml --event "$1" --limit 1 --json databaseId,headBranch,conclusion,createdAt --jq '.[0]'; }
tg_text() { gh run view "$1" -R "$R" --log | grep -o '{"ok":true.*' | jq -r '.result.text'; }
```

- [ ] **Step 0 (только для docs): клонировать**

```bash
[ -d /f/Github/2026_H2/docs ] || git clone git@github.com:Cringe-Driven-Development-Team/docs.git /f/Github/2026_H2/docs
```

- [ ] **Step 1: Ветка и замена файлов**

```bash
cd /f/Github/2026_H2/$D
git status --short          # должно быть пусто
git switch main && git pull --ff-only
git switch -c chore/reusable-workflows
git rm -q .github/workflows/telegram.yml .github/workflows/add-to-project.yml
```

Create `.github/workflows/automation.yml`:

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

Run: `actionlint -no-color -oneline -shellcheck= -pyflakes= .github/workflows/automation.yml && echo ok`
Expected: `ok`

- [ ] **Step 2: Commit и push**

```bash
git add .github/workflows/automation.yml
git commit -F - <<'EOF'
chore: подключить общие workflow из .github

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git push -u origin chore/reusable-workflows
```

Дождаться `last_run push`. Expected: success; `tg_text` — «⚒️ 1 коммит · $D · chore/reusable-workflows» или ничего — так же, как в Task 4 Step 1 (зависит от того, кладёт ли GitHub коммиты в событие создания ветки).

- [ ] **Step 3: PR**

```bash
T=$(gh issue list -R Cringe-Driven-Development-Team/.github --search "Подключить общие workflow во все репозитории in:title" --json number --jq '.[0].number')
gh pr create -R "$R" --base main --head chore/reusable-workflows --title "Подключить общие workflow из .github" --body-file - <<EOF
Уведомления в Telegram и добавление issue на доску теперь живут в Cringe-Driven-Development-Team/.github. Здесь остаётся только \`automation.yml\` с триггерами и вызовом общих workflow.

Часть Cringe-Driven-Development-Team/.github#$T

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Дождаться `last_run pull_request`. Expected: success; `tg_text` — «🔀 Открыт pull request · $D».
Для docs дополнительно: `gh pr checks <PR> -R "$R" --watch` — CI должен быть зелёным.

- [ ] **Step 4: Мерж**

```bash
PR=$(gh pr view chore/reusable-workflows -R "$R" --json number --jq .number)
gh pr merge "$PR" -R "$R" --merge
git switch main && git pull --ff-only
ls .github/workflows        # docs: automation.yml ci.yml pages.yml; остальные: automation.yml
```

Expected: `last_run pull_request` — success, `tg_text` — «🎉 Влито в main · $D».

- [ ] **Step 5: Отметить в трекинг-issue**

```bash
gh issue comment "$T" -R Cringe-Driven-Development-Team/.github --body "$D: https://github.com/$R/pull/$PR — влит."
```

---

### Task 8: Перевести backend

Репозиторием владеет другой ментор. Мерж — только после его апрува.

**Files (в `/f/Github/2026_H2/backend`):**
- Delete: `.github/workflows/telegram.yml`, `.github/workflows/add-to-project.yml`
- Create: `.github/workflows/automation.yml`

**Interfaces:**
- Consumes: `telegram.yml@main`, `add-to-project.yml@main` (Task 4); номер трекинг-issue (Task 5).

Хелперы:

```bash
R=go-park-mail-ru/2026_2_Cringe_Driven_Development
last_run() { gh run list -R "$R" --workflow automation.yml --event "$1" --limit 1 --json databaseId,headBranch,conclusion,createdAt --jq '.[0]'; }
tg_text() { gh run view "$1" -R "$R" --log | grep -o '{"ok":true.*' | jq -r '.result.text'; }
```

- [ ] **Step 1: Issue и ветка**

```bash
cd /f/Github/2026_H2/backend
git status --short          # должно быть пусто
git switch main && git pull --ff-only
N=$(gh issue create -R "$R" --title "Подключить общие workflow из .github" --body "Заменить копии telegram.yml и add-to-project.yml файлом-вызовом automation.yml: логика уведомлений и доски теперь живёт в Cringe-Driven-Development-Team/.github." | sed 's#.*/##')
echo "issue #$N"
gh issue develop "$N" -R "$R" --name "api-$N" --base main --checkout
git branch --show-current   # api-N
```

- [ ] **Step 2: Заменить файлы**

```bash
git rm -q .github/workflows/telegram.yml .github/workflows/add-to-project.yml
```

Create `.github/workflows/automation.yml`:

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

Run: `actionlint -no-color -oneline -shellcheck= -pyflakes= .github/workflows/automation.yml && echo ok`
Expected: `ok`

- [ ] **Step 3: Commit, push, PR**

```bash
git add .github/workflows/automation.yml
git commit -F - <<'EOF'
chore: подключить общие workflow из .github

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git push -u origin "api-$N"
gh pr create -R "$R" --base main --head "api-$N" --title "API-$N: Подключить общие workflow из .github" --body-file - <<EOF
Уведомления в Telegram и добавление issue на доску теперь живут в Cringe-Driven-Development-Team/.github. Здесь остаётся только \`automation.yml\` с триггерами и вызовом общих workflow — правки скрипта больше не нужно проносить в каждый репозиторий.

Важно для владельца репозитория: после мержа при событиях здесь выполняется код из публичного репозитория Cringe-Driven-Development-Team/.github (ветка main) с секретами TELEGRAM_BOT_TOKEN и ADD_TO_PROJECT_PAT этого репозитория. Права встроенного GITHUB_TOKEN в вызове отключены (\`permissions: {}\`).

Спека: https://github.com/Cringe-Driven-Development-Team/.github/blob/main/docs/superpowers/specs/2026-09-18-central-workflows-design.md

Closes #$N

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Expected: `last_run push` и `last_run pull_request` — success; `tg_text` последнего — «🔀 Открыт pull request · backend», «API-N: Подключить общие workflow из .github».

- [ ] **Step 4: СТОП — апрув второго ментора**

Сообщить пользователю ссылку на PR и попросить: (1) логин второго ментора на GitHub, (2) предупредить его. Получив логин:

```bash
PR=$(gh pr view "api-$N" -R "$R" --json number --jq .number)
gh pr edit "$PR" -R "$R" --add-reviewer <логин>
```

Expected: `last_run pull_request` — success, `tg_text` — «👀 Запрошено ревью · backend» с упоминанием ревьюера.
Дальше ждать, пока `gh pr view "$PR" -R "$R" --json reviewDecision --jq .reviewDecision` не вернёт `APPROVED`. Когда вернёт: `last_run pull_request_review` — success, `tg_text` — «👍 Апрув · backend» с упоминанием автора PR. Это закрывает проверку ревью-событий из спеки.

- [ ] **Step 5: Мерж**

```bash
gh pr merge "$PR" -R "$R" --merge
git switch main && git pull --ff-only
ls .github/workflows        # automation.yml и workflow бэкенда, без telegram.yml и add-to-project.yml
```

Expected: `last_run pull_request` — «🎉 Влито в main · backend»; `last_run issues` — «✅ Задача закрыта · backend».

- [ ] **Step 6: Отметить в трекинг-issue**

```bash
T=$(gh issue list -R Cringe-Driven-Development-Team/.github --search "Подключить общие workflow во все репозитории in:title" --json number --jq '.[0].number')
gh issue comment "$T" -R Cringe-Driven-Development-Team/.github --body "backend: https://github.com/$R/pull/$PR — влит после апрува."
```

---

### Task 9: Завершение

**Files:**
- Modify: `docs/superpowers/specs/2026-09-18-central-workflows-design.md` (строка статуса)

- [ ] **Step 1: Старых файлов не осталось**

```bash
for r in Cringe-Driven-Development-Team/docs Cringe-Driven-Development-Team/static Cringe-Driven-Development-Team/infra Cringe-Driven-Development-Team/react frontend-park-mail-ru/2026_2_Cringe_Driven_Development go-park-mail-ru/2026_2_Cringe_Driven_Development; do
  printf '%s: ' "$r"; gh api "repos/$r/contents/.github/workflows" --jq '[.[].name] | join(" ")'
done
```

Expected: в каждой строке есть `automation.yml`, ни в одной нет `telegram.yml` и `add-to-project.yml`.

- [ ] **Step 2: Закрыть трекинг-issue**

```bash
R=Cringe-Driven-Development-Team/.github
T=$(gh issue list -R "$R" --search "Подключить общие workflow во все репозитории in:title" --json number --jq '.[0].number')
gh issue close "$T" -R "$R" --comment "Все шесть репозиториев переведены на общие workflow."
```

Expected: `last_run issues` (хелперы из Task 4) — success, `tg_text` — «✅ Задача закрыта · .github».

- [ ] **Step 3: Статус спеки**

```bash
cd /f/Github/2026_H2/.github
git switch main && git pull --ff-only
sed -i 's/^Статус: в работе — .*$/Статус: реализовано 2026-09-18/' docs/superpowers/specs/2026-09-18-central-workflows-design.md
grep -n '^Статус:' docs/superpowers/specs/2026-09-18-central-workflows-design.md
git commit -am "docs: спека реализована" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 4: Итоговый отчёт пользователю**

Сообщить: какие PR влиты (ссылки), что показала проверка первого пуша новой ветки (Task 4 Step 1), какие проверки из таблицы спеки пройдены и какие нет. Напомнить, что scope `admin:org` можно убрать: `gh auth refresh -h github.com -r admin:org`.
