#!/usr/bin/env bash
# Смена спринта: в первый день (или если понедельничный запуск был пропущен) переносит
# незакрытые задачи прошлого спринта в текущий и пишет в чат итоги, кто и что не сделал, план.
# Итерации поля Sprint классифицируются по датам сами — GitHub не помечает, какая из них "прошлая".
# Env: PAT (ADD_TO_PROJECT_PAT — читает и пишет доску), TOKEN, CHAT, TOPIC, MAP, необязательный TODAY.
set -euo pipefail

DONE_STATUS=Done
ORDER='["In review","In progress","Ready","Backlog"]' # порядок хвостов; без статуса — в конец
LIMIT=20          # больше строк хвостов не влезет в лимит Telegram 4096 символов
OPS_PING=YarikMix # кому пинговать, если следующий спринт на доске не заведён

PAT=${PAT:-}
if [ -z "$PAT" ]; then
  echo "::warning::ADD_TO_PROJECT_PAT недоступен — смена спринта не проверена"
  exit 0
fi
[ -n "${TOKEN:-}" ] || { echo "::error::Не задан секрет TELEGRAM_BOT_TOKEN"; exit 1; }
[ -n "${CHAT:-}" ] || { echo "::error::Не задана переменная TELEGRAM_CHAT_ID"; exit 1; }

MAP=${MAP:-}
[ -n "$MAP" ] || MAP='{}'
TOPIC=${TOPIC:-}
TODAY=${TODAY:-$(TZ=Europe/Moscow date +%F)}

esc () { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

# plural 3 задача задачи задач → «задачи» — как в reminders.sh
plural () {
  case "$(($1 % 100))" in
    11|12|13|14) printf '%s' "$4" ;;
    *) case "$(($1 % 10))" in
         1)     printf '%s' "$2" ;;
         2|3|4) printf '%s' "$3" ;;
         *)     printf '%s' "$4" ;;
       esac ;;
  esac
}
tasks () { printf '%s %s' "$1" "$(plural "$1" задача задачи задач)"; }
# согласование глагола с «задача»/«задачи»/«задач»: 1 — не перенесена, иначе — не перенесены
notmoved () { plural "$1" "не перенесена" "не перенесены" "не перенесены"; }

# «ДД.ММ» из «ГГГГ-ММ-ДД»
dm () { printf '%s.%s' "${1:8:2}" "${1:5:2}"; }

# send <топик> <текст> [<кнопки: reply_markup>] — отправить в Telegram; отказ валит job
send () {
  local markup=${3:-'{"inline_keyboard":[]}'}
  RESP=$(curl -sS -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
    -d chat_id="$CHAT" \
    -d message_thread_id="$1" \
    -d parse_mode=HTML \
    -d disable_web_page_preview=true \
    --data-urlencode reply_markup="$markup" \
    --data-urlencode text="$2")
  echo "$RESP"
  case "$RESP" in
    *'"ok":true'*) ;;
    *) echo "::error::Telegram отклонил сообщение"; exit 1 ;;
  esac
}

# ---------- чтение доски: один запрос с пагинацией по 100 задач

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
PAGES=$(GH_TOKEN="$PAT" gh api graphql --paginate -f query="$QUERY" | tr -d '\r') ||
  { echo "::error::Не прочитал доску"; exit 1; }

# project/поле — из первой страницы (на всех одинаковые), items.nodes — со всех; jq.exe шлёт CRLF — снимаем
BOARD=$(printf '%s' "$PAGES" | jq -sc '
  (.[0].data.organization.projectV2) as $p
  | if ($p == null) or ($p.field.id == null) then null else {
      id: $p.id, url: $p.url, field: $p.field.id,
      iterations: (($p.field.configuration.iterations // []) + ($p.field.configuration.completedIterations // [])),
      items: [ .[] | .data.organization.projectV2.items.nodes[]? ]
    } end
' | tr -d '\r')
[ "$BOARD" != "null" ] && [ -n "$BOARD" ] || { echo "::error::Не прочитал доску"; exit 1; }

# общие jq-определения для чтения доски и сборки сообщения
DEFS='
  def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
  def who: if $map[.] then "<a href=\"tg://user?id=\($map[.])\">\(esc)</a>" else esc end;
  def side: if startswith("frontend-park-mail-ru/") then "frontend"
    elif startswith("go-park-mail-ru/") then "backend" else sub("^[^/]*/"; "") end;
  def enddate: (.startDate | strptime("%Y-%m-%d") | mktime) + ((.duration - 1) * 86400) | strftime("%Y-%m-%d");
  def isdone: (.status.name == $done)
    or (.content.__typename == "Issue" and .content.state == "CLOSED")
    or (.content.__typename == "PullRequest" and (.content.state == "CLOSED" or .content.state == "MERGED"));
  def valid: (.isArchived | not) and (.content != null);
  def rank: (.status.name // "") as $s | ($order | index($s)) // ($order | length);
  def tailline:
    (if .isDraft then "черновик · \(.title | esc)"
     else "\(.side) #\(.number) <a href=\"\(.url)\">\(.title | esc)</a>" end)
    + " · " + (if .status == "" then "без статуса" else (.status | esc) end)
    + " · " + (if (.assignees | length) == 0 then "без исполнителя" else (.assignees | map(who) | join(", ")) end);
  # план считает так, будто перенесутся все хвосты: сообщение уходит раньше мутаций (см. «Перенос»)
  def planitems: .curExisting + [ .tails[] | {assignees} ];
'
# J <json> <filter> — общий раннер: $today/$done/$map/$order/$limit доступны всегда
J () {
  printf '%s' "$1" | jq -rc --arg today "$TODAY" --arg "done" "$DONE_STATUS" \
    --argjson map "$MAP" --argjson order "$ORDER" --argjson limit "$LIMIT" \
    "$DEFS $2" | tr -d '\r'
}

# ---------- решение: прошлая/текущая итерация, хвосты, «сделано», план

STATE=$(J "$BOARD" '
  (.iterations | map(. + {end: enddate})) as $its
  | ($its | map(select(.end < $today)) | sort_by(.end) | last) as $past
  | ($its | map(select(.startDate <= $today and $today <= .end)) | first) as $cur
  | (.items | map(select(valid))) as $v
  | ($past.id) as $pid
  | (if $pid == null then [] else ($v | map(select(.sprint.iterationId == $pid))) end) as $pastItems
  | ($cur.id) as $cid
  | (if $cid == null then [] else ($v | map(select(.sprint.iterationId == $cid))) end) as $curItems
  | ($pastItems | map(select(isdone | not)) | sort_by(rank) | map({
      id: .id,
      isDraft: (.content.__typename == "DraftIssue"),
      side: ((.content.repository.nameWithOwner // "") | side),
      number: (.content.number // null),
      url: (.content.url // null),
      title: (.content.title // ""),
      status: (.status.name // ""),
      assignees: [(.content.assignees.nodes // [])[].login]
    })) as $tails
  | {
      hasPast: ($past != null), hasCurrent: ($cur != null),
      firstDay: ($cur != null and $cur.startDate == $today),
      pastTitle: $past.title, pastStart: $past.startDate, pastEnd: $past.end,
      curId: $cid, curTitle: $cur.title, curStart: $cur.startDate, curEnd: $cur.end,
      doneCount: ($pastItems | map(select(isdone)) | length),
      totalCount: ($pastItems | length),
      tails: $tails,
      curExisting: ($curItems | map({assignees: [(.content.assignees.nodes // [])[].login]}))
    }
')

[ "$(J "$STATE" '.hasPast')" = "true" ] || exit 0

TAILS_COUNT=$(J "$STATE" '.tails | length')

if [ "$(J "$STATE" '.hasCurrent')" != "true" ]; then
  [ "$TAILS_COUNT" -gt 0 ] || exit 0
  PAST_TITLE=$(J "$STATE" '.pastTitle')
  PROJECT_URL=$(J "$BOARD" '.url')
  PING=$(jq -rn --argjson map "$MAP" --arg u "$OPS_PING" \
    'if $map[$u] then "<a href=\"tg://user?id=\($map[$u])\">\($u)</a>" else $u end' | tr -d '\r')
  TEXT=$(printf '<b>⚠️ %s закончился</b>, а следующего спринта на доске нет: %s %s · %s' \
    "$(esc "$PAST_TITLE")" "$(tasks "$TAILS_COUNT")" "$(notmoved "$TAILS_COUNT")" "$PING")
  MARKUP=$(jq -nc --arg u "$PROJECT_URL" '{inline_keyboard: [[{text: "Открыть доску", url: $u}]]}')
  send "$TOPIC" "$TEXT" "$MARKUP"
  exit 0
fi

if [ "$(J "$STATE" '.firstDay')" != "true" ] && [ "$TAILS_COUNT" -eq 0 ]; then
  exit 0
fi

# первый день без хвостов — «всё сделано» шлём только по ANNOUNCE_EMPTY: иначе ручной прогон
# (sprint=true) или повтор той же утренней попытки постил бы один и тот же итог заново
if [ "$TAILS_COUNT" -eq 0 ] && [ "${ANNOUNCE_EMPTY:-}" != "true" ]; then
  exit 0
fi

# ---------- сообщение: план и список хвостов строятся заранее, как будто перенесутся все —
# сначала уходит сообщение, и только потом начинается перенос (см. «Перенос» в спеке): если
# Telegram отклонит текст, доска ещё не тронута ни одной мутацией

PROJECT_ID=$(J "$BOARD" '.id')
FIELD_ID=$(J "$BOARD" '.field')
CUR_ID=$(J "$STATE" '.curId')
CUR_TITLE=$(J "$STATE" '.curTitle')
CUR_START=$(J "$STATE" '.curStart')
CUR_END=$(J "$STATE" '.curEnd')
PAST_TITLE=$(J "$STATE" '.pastTitle')
PAST_START=$(J "$STATE" '.pastStart')
PAST_END=$(J "$STATE" '.pastEnd')
DONE_COUNT=$(J "$STATE" '.doneCount')
TOTAL_COUNT=$(J "$STATE" '.totalCount')
PROJECT_URL=$(J "$BOARD" '.url')
MARKUP=$(jq -nc --arg u "$PROJECT_URL" '{inline_keyboard: [[{text: "Открыть доску", url: $u}]]}')

TAILS_BLOCK=$(J "$STATE" '
  (.tails) as $t
  | if ($t | length) == 0 then "всё сделано 🎉"
    else "перенесено в \(.curTitle | esc) — \($t | length):\n"
      + ([$t[0:$limit][] | "• " + tailline] | join("\n"))
      + (if ($t | length) > $limit then "\n…и ещё \($t | length - $limit)" else "" end)
    end
')
PLAN_COUNT=$(J "$STATE" 'planitems | length')
BREAKDOWN=$(J "$STATE" '
  planitems as $p
  | ($p | map(select(.assignees | length == 0)) | length) as $none
  | ($p | map(.assignees[]) | group_by(.) | map({login: .[0], n: length}) | sort_by(-.n, .login)
      | map("\(.login | esc) \(.n)")) as $named
  | ($named + (if $none > 0 then ["без исполнителя \($none)"] else [] end)) | join(" · ")
')

# пустой план — без висячего двоеточия («0 задач», а не «0 задач: »)
PLAN_LINE=$(tasks "$PLAN_COUNT")
[ -z "$BREAKDOWN" ] || PLAN_LINE="$PLAN_LINE: $BREAKDOWN"

TEXT=$(printf '<b>🏁 %s закрыт · %s–%s</b>\nсделано %s из %s\n%s\n\n<b>🚀 %s · %s–%s</b>\n%s' \
  "$(esc "$PAST_TITLE")" "$(dm "$PAST_START")" "$(dm "$PAST_END")" \
  "$DONE_COUNT" "$TOTAL_COUNT" \
  "$TAILS_BLOCK" \
  "$(esc "$CUR_TITLE")" "$(dm "$CUR_START")" "$(dm "$CUR_END")" \
  "$PLAN_LINE")

send "$TOPIC" "$TEXT" "$MARKUP"

# ---------- перенос: одна мутация на хвост, сбой одной не останавливает остальные

FAILED_ROWS=()
if [ "$TAILS_COUNT" -gt 0 ]; then
  while IFS= read -r ROW; do
    ITEM_ID=$(jq -r '.id' <<<"$ROW")
    MUTATION='mutation($project: ID!, $item: ID!, $field: ID!, $iteration: String!) {
      updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {iterationId: $iteration}}) { projectV2Item { id } } }'
    if GH_TOKEN="$PAT" gh api graphql -f query="$MUTATION" -f project="$PROJECT_ID" -f item="$ITEM_ID" \
        -f field="$FIELD_ID" -f iteration="$CUR_ID" >/dev/null; then
      :
    else
      if [ "$(jq -r '.isDraft' <<<"$ROW")" = "true" ]; then
        LABEL="черновик $(jq -r '.title' <<<"$ROW")"
      else
        LABEL="$(jq -r '.side' <<<"$ROW") #$(jq -r '.number' <<<"$ROW")"
      fi
      echo "::warning::Не перенёс $LABEL"
      FAILED_ROWS+=("$ROW")
    fi
  done < <(jq -c '.tails[]' <<<"$STATE")
fi

# сбой части мутаций не валит job — сообщение уже ушло, доска почти вся переехала; тем,
# что не переехало, — отдельное короткое сообщение с просьбой перенести руками
if [ "${#FAILED_ROWS[@]}" -gt 0 ]; then
  FAILED_JSON=$(printf '%s\n' "${FAILED_ROWS[@]}" | jq -s -c '.')
  FAILED_LINES=$(J "$FAILED_JSON" '[.[] | "• " + tailline] | join("\n")')
  FOLLOWUP=$(printf '<b>⚠️ Не перенесены в %s</b> — перенесите руками:\n%s' "$(esc "$CUR_TITLE")" "$FAILED_LINES")
  send "$TOPIC" "$FOLLOWUP" "$MARKUP"
fi
