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
  PROJECT_OWNER="$ORG" GH_TOKEN=test-pat TITLE='WEB-5: Вход' BODY= PR_URL="$PR"
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

# calls_n <n> "вызов" — отработал без ошибки; вызов в журнале ровно n раз, регистр не важен
calls_n() {
  local got
  [ "$CODE" -eq 0 ] || { fail "код выхода $CODE"; return; }
  touch "$TMP/calls"
  # grep -i с -F в Git Bash падает на UTF-8 — сравниваем в нижнем регистре
  got=$(tr 'A-Z' 'a-z' < "$TMP/calls" | grep -cF -- "$(printf '%s' "$2" | tr 'A-Z' 'a-z')")
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
if [ -s "$TMP/calls" ]; then fail "без токена были вызовы gh"; else pass; fi

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
