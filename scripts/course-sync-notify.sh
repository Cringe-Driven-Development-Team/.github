#!/usr/bin/env bash
# One best-effort failure message; do not expose curl's URL or arbitrary API response in logs.
set -euo pipefail
[ "$#" -eq 3 ] || { echo 'usage: course-sync-notify.sh SOURCE_REPO SHA RUN_URL' >&2; exit 1; }
[ -n "${TOKEN:-}" ] && [ -n "${CHAT:-}" ] ||
  { echo 'Missing Telegram configuration' >&2; exit 1; }
text=$(printf 'Course synchronization failed\nRepository: %s\nCommit: %s\n%s' "$1" "$2" "$3")
args=(--data-urlencode "chat_id=$CHAT" --data-urlencode "text=$text")
[ -z "${TOPIC:-}" ] || args+=(-d "message_thread_id=$TOPIC")
if ! response=$(curl --silent --fail --connect-timeout 10 --max-time 30 \
  "https://api.telegram.org/bot$TOKEN/sendMessage" "${args[@]}" 2>/dev/null); then
  echo 'Telegram request failed' >&2
  exit 1
fi
if ! jq -e '.ok == true' <<<"$response" >/dev/null 2>&1; then
  echo 'Telegram rejected notification' >&2
  exit 1
fi
