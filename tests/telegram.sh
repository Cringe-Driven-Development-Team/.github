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

echo
echo "итого: $PASS ok, $FAIL fail"
[ "$FAIL" -eq 0 ]
