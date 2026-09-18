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
