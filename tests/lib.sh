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
  # sent — отправленные сообщения, calls — журнал вызовов заглушек (если тест его ведёт)
  rm -rf "$TMP/sent" "$TMP/calls"
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
