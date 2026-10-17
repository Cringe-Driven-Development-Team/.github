#!/usr/bin/env bash
# Curl is the external boundary: assert the real payload and observable failure behavior.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export ROOT
source "$ROOT/tests/lib.sh"
SCRIPT="$TMP/call.sh"
cat >"$SCRIPT" <<'CALL'
#!/usr/bin/env bash
bash "$ROOT/scripts/course-sync-notify.sh" "$SOURCE_REPO" "$SHA" "$RUN_URL"
CALL
mv "$TMP/bin/curl" "$TMP/bin/curl-stub"
cat >"$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf 'called\n' >>"$CALLS"
if [ "${HTTP_FAIL:-}" = 1 ]; then
  printf 'curl transport failed for token %s and key %s\n' "$TOKEN" "$FAKE_KEY" >&2
  exit 22
fi
if [ "${TG_FALSE:-}" = 1 ]; then echo '{"ok":false,"description":"Rejected"}'; exit 0; fi
exec "$TEST_CURL_STUB" "$@"
STUB
chmod +x "$TMP/bin/curl" "$TMP/bin/curl-stub"
DEFAULTS=(
  TOKEN=fake-notification-token FAKE_KEY=fake-private-sync-key CHAT=-100 TOPIC=26
  SOURCE_REPO=Cringe-Driven-Development-Team/frontend SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  RUN_URL=https://github.com/Cringe-Driven-Development-Team/frontend/actions/runs/101
  HTTP_FAIL= TG_FALSE= TEST_CURL_STUB="$TMP/bin/curl-stub" CALLS="$TMP/calls"
)

when one_failure_message
sent_to 1 26 'Cringe-Driven-Development-Team/frontend' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' '/actions/runs/101'
only 1
[ -f "$TMP/calls" ] && [ "$(wc -l < "$TMP/calls")" -eq 1 ] && pass || fail 'expected exactly one request'

when telegram_false_is_error TG_FALSE=1
error 'Telegram rejected notification'

when missing_token_is_error TOKEN=
error 'Missing Telegram configuration'
[ ! -e "$TMP/calls" ] && pass || fail 'missing token still called Telegram'

when notification_failure_is_visible_without_secrets HTTP_FAIL=1
error 'Telegram request failed'
if grep -qE 'fake-notification-token|fake-private-sync-key' "$TMP/out"; then
  fail 'credentials leaked into diagnostics'
else
  pass
fi
[ -f "$TMP/calls" ] && [ "$(wc -l < "$TMP/calls")" -eq 1 ] && pass || fail 'expected exactly one failed request'

summary
