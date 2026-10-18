#!/usr/bin/env bash
# Observe notification payloads and GitHub history reads; no real messages or API writes.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export ROOT
source "$ROOT/tests/lib.sh"
SCRIPT="$TMP/call.sh"
export FIXTURE="$TMP/fixture" CALLS="$TMP/calls"
mkdir -p "$FIXTURE"
cat >"$SCRIPT" <<'CALL'
#!/usr/bin/env bash
bash "$ROOT/scripts/course-sync-recovery.sh" "$SOURCE_REPO" "$RUN_ID" "$RUN_ATTEMPT" "$SHA" "$RUN_URL"
CALL
cat >"$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CALLS"
[ -z "${GH_FAIL:-}" ] || { echo 'HTTP 403' >&2; exit 1; }
[ "$1" = api ] && [ "$3" = --paginate ] && [ "$4" = --slurp ] || exit 9
attempt=${2#*/attempts/}; attempt=${attempt%%/*}
cat "$FIXTURE/jobs-$attempt.json"
STUB
chmod +x "$TMP/bin/gh"
defaults() {
  printf '[{"total_count":1,"jobs":[{"name":"course-sync / sync","run_id":101,"run_attempt":1,"status":"completed","conclusion":"failure"}]}]\n' >"$FIXTURE/jobs-1.json"
  jq '.[0].jobs[0] |= (.run_attempt=2 | .conclusion="success")' "$FIXTURE/jobs-1.json" >"$FIXTURE/jobs-2.json"
}
DEFAULTS=(TOKEN=fake-token CHAT=-100 TOPIC=26 SOURCE_REPO=Cringe-Driven-Development-Team/frontend
  RUN_ID=101 RUN_ATTEMPT=2 SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  RUN_URL=https://github.com/Cringe-Driven-Development-Team/frontend/actions/runs/101 GH_FAIL=)
defaults
when ordinary_first_attempt_is_silent RUN_ATTEMPT=1
silent
[ ! -f "$CALLS" ] && pass || fail 'first attempt queried history'

when failed_attempt_recovers_once
sent_to 1 26 '✅ Course synchronization recovered' 'Cringe-Driven-Development-Team/frontend' '/actions/runs/101'
only 1

when another_successful_rerun_is_silent RUN_ATTEMPT=3
silent
[ "$(wc -l < "$CALLS")" -eq 1 ] && pass || fail 'read older failure after finding success'

jq '.[0].jobs[0].conclusion="cancelled"' "$FIXTURE/jobs-2.json" >"$TMP/jobs"
mv "$TMP/jobs" "$FIXTURE/jobs-2.json"
when cancellation_does_not_hide_unresolved_failure RUN_ATTEMPT=3
sent_to 1 26 '✅ Course synchronization recovered'
only 1

jq '.[0].jobs[0].conclusion="skipped"' "$FIXTURE/jobs-1.json" >"$TMP/jobs"
mv "$TMP/jobs" "$FIXTURE/jobs-1.json"
when previous_skipped_sync_did_not_alert
silent

defaults
jq '.[0].jobs[0].name="sync / sync"' "$FIXTURE/jobs-1.json" >"$TMP/jobs"
mv "$TMP/jobs" "$FIXTURE/jobs-1.json"
when manual_workflow_rerun_recovers
sent_to 1 26 '✅ Course synchronization recovered'

defaults
jq '.[0].total_count=2' "$FIXTURE/jobs-1.json" >"$TMP/jobs"
mv "$TMP/jobs" "$FIXTURE/jobs-1.json"
when incomplete_history_never_reports_recovery
error 'Incomplete sync history'

defaults
jq '.[0].jobs += .[0].jobs | .[0].total_count=2' "$FIXTURE/jobs-1.json" >"$TMP/jobs"
mv "$TMP/jobs" "$FIXTURE/jobs-1.json"
when ambiguous_history_never_reports_recovery
error 'Ambiguous sync history'

defaults
jq '.[0].jobs[0].run_id=999' "$FIXTURE/jobs-1.json" >"$TMP/jobs"
mv "$TMP/jobs" "$FIXTURE/jobs-1.json"
when wrong_run_never_reports_recovery
error 'Incomplete sync history'

defaults
when unavailable_history_never_reports_recovery GH_FAIL=1
error 'Cannot read sync history'

when invalid_attempt_never_calls_api RUN_ATTEMPT=0
error 'Invalid recovery request'
[ ! -f "$CALLS" ] && pass || fail 'invalid request queried history'
summary
