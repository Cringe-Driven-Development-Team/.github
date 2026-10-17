#!/usr/bin/env bash
# The boundary is GitHub's read-only REST API; wrong provenance must never yield a candidate.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SCRIPT="$ROOT/scripts/course-sync-context.sh"
export FIXTURE="$TMP/fixture" CALLS="$TMP/calls" GH_TOKEN=fake-read-token
mkdir -p "$FIXTURE" "$TMP/bin"
export PATH="$TMP/bin:$PATH"
source_repo=Cringe-Driven-Development-Team/frontend
candidate=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
out="$TMP/out"
err="$TMP/err"
cat >"$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CALLS"
[ "$1" = api ] || exit 9
shift
path=
paginate=false
slurp=false
for arg in "$@"; do
  case "$arg" in
    repos/*) path=$arg ;;
    --paginate) paginate=true ;;
    --slurp) slurp=true ;;
    *) echo "Unexpected API argument: $arg" >&2; exit 9 ;;
  esac
done
[ -z "${GH_FAIL:-}" ] || { echo 'HTTP 403: test access denied' >&2; exit 1; }
case "$path" in
  */actions/workflows/ci.yml) cat "$FIXTURE/workflow.json" ;;
  */actions/runs/101)
    count=0
    [ ! -f "$FIXTURE/read-count" ] || count=$(cat "$FIXTURE/read-count")
    printf '%s' "$((count + 1))" >"$FIXTURE/read-count"
    if [ "$count" -gt 0 ] && [ -f "$FIXTURE/second-run.json" ]; then
      cat "$FIXTURE/second-run.json"
    else
      cat "$FIXTURE/run.json"
    fi ;;
  */actions/runs/101/attempts/*/jobs?per_page=100)
    [ "$paginate" = true ] && [ "$slurp" = true ] || {
      echo 'Expected complete paginated job response' >&2; exit 9;
    }
    attempt=${path#*/attempts/}
    attempt=${attempt%%/*}
    cat "$FIXTURE/jobs-$attempt.json" ;;
  *) echo "Unexpected API path: $path" >&2; exit 9 ;;
esac
STUB
chmod +x "$TMP/bin/gh"

fixture() {
  jq -n --arg repo "$source_repo" --arg sha "$candidate" \
    '{id:101, event:"push", head_branch:"main", head_sha:$sha, workflow_id:900,
      run_attempt:1, status:"in_progress", conclusion:null,
      repository:{id:10,full_name:$repo},head_repository:{id:10,full_name:$repo}}' >"$FIXTURE/run.json"
  printf '{"id":900,"name":"CI","path":".github/workflows/ci.yml","state":"active"}\n' >"$FIXTURE/workflow.json"
  printf '[{"total_count":1,"jobs":[{"id":1001,"name":"Check","status":"completed","conclusion":"success","run_id":101,"run_attempt":1}]}]\n' >"$FIXTURE/jobs-1.json"
}
run_selector() {
  [ "$#" -gt 0 ] || set -- "$source_repo" 101 "$candidate"
  : >"$CALLS"
  rm -f "$FIXTURE/read-count"
  code=0
  bash "$SCRIPT" "$@" >"$out" 2>"$err" || code=$?
}
assert_eq() {
  [ "$1" = "$2" ] || { printf 'expected <%s>, got <%s>\n' "$2" "$1" >&2; cat "$err" >&2; exit 1; }
}
assert_failure() {
  [ "$code" -eq 1 ] || { echo "Expected refusal, exit=$code" >&2; cat "$out" "$err" >&2; exit 1; }
  [ ! -s "$out" ] || { echo 'Refusal emitted a candidate' >&2; exit 1; }
}
valid_frontend() {
  run_selector
  assert_eq "$code" 0
  assert_eq "$(jq -r .target "$out")" frontend-park-mail-ru/2026_2_Cringe_Driven_Development
  assert_eq "$(jq -r .source "$out")" "$source_repo"
  assert_eq "$(jq -r .sha "$out")" "$candidate"
  assert_eq "$(jq -r .run_attempt "$out")" 1
}
valid_backend_without_deploy_success() {
  source_repo=Cringe-Driven-Development-Team/backend
  fixture
  jq '.[0].total_count=4 | .[0].jobs = [
    {id:1,name:"lint",status:"completed",conclusion:"success",run_id:101,run_attempt:1},
    {id:2,name:"test",status:"completed",conclusion:"success",run_id:101,run_attempt:1},
    {id:3,name:"docker",status:"completed",conclusion:"success",run_id:101,run_attempt:1},
    {id:4,name:"deploy",status:"completed",conclusion:"failure",run_id:101,run_attempt:1}]' \
    "$FIXTURE/jobs-1.json" >"$TMP/jobs"
  mv "$TMP/jobs" "$FIXTURE/jobs-1.json"
  run_selector
  assert_eq "$code" 0
  assert_eq "$(jq -r .target "$out")" go-park-mail-ru/2026_2_Cringe_Driven_Development
  assert_eq "$(jq -r .sha "$out")" "$candidate"
}
reject_untrusted_run() {
  cp "$FIXTURE/run.json" "$TMP/base-run"
  for mutation in '.event="pull_request"' '.head_branch="web-1"' '.workflow_id=901' \
    '.status="queued"' \
    '.repository.full_name="other/repo"' '.head_repository.full_name="fork/repo"' \
    '.head_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' '.id=102'; do
    jq "$mutation" "$TMP/base-run" >"$FIXTURE/run.json"
    run_selector
    assert_failure
  done
}
latest_job_results_win() {
  jq '.run_attempt=2' "$FIXTURE/run.json" >"$TMP/run"
  mv "$TMP/run" "$FIXTURE/run.json"
  jq '.[0].jobs[0] |= (.run_attempt=2 | .conclusion="failure")' "$FIXTURE/jobs-1.json" >"$FIXTURE/jobs-2.json"
  run_selector
  assert_failure
}
sync_only_rerun_inherits_successful_dependencies() {
  jq '.run_attempt=2' "$FIXTURE/run.json" >"$TMP/run"
  mv "$TMP/run" "$FIXTURE/run.json"
  printf '[{"total_count":1,"jobs":[{"id":2001,"name":"course-sync / sync","status":"in_progress","conclusion":null,"run_id":101,"run_attempt":2}]}]\n' >"$FIXTURE/jobs-2.json"
  run_selector
  assert_eq "$code" 0
  assert_eq "$(jq -r .run_attempt "$out")" 2
}
missing_or_skipped_check() {
  cp "$FIXTURE/jobs-1.json" "$TMP/base-jobs"
  for mutation in '.[0].jobs[0].name="Other"' '.[0].jobs[0].conclusion="skipped"' \
    '.[0].jobs[0].conclusion="cancelled"' '.[0].jobs[0] |= (.status="in_progress" | .conclusion=null)' \
    '.[0].jobs += .[0].jobs | .[0].total_count=2'; do
    jq "$mutation" "$TMP/base-jobs" >"$FIXTURE/jobs-1.json"
    run_selector
    assert_failure
  done
}
invalid_inputs_do_not_call_api() {
  run_selector other/repo 101 "$candidate"
  assert_failure
  [ ! -s "$CALLS" ]
  for id in 0 -1 ../101 1.5; do
    run_selector "$source_repo" "$id" "$candidate"
    assert_failure
    [ ! -s "$CALLS" ]
  done
  run_selector "$source_repo" 101 refs/heads/main
  assert_failure
  [ ! -s "$CALLS" ]
}
api_pagination_and_crlf() {
  jq '[{total_count:2,jobs:[]},{total_count:2,jobs:.[0].jobs + [
    {id:2,name:"Upload release",status:"in_progress",conclusion:null,run_id:101,run_attempt:1}]}]' \
    "$FIXTURE/jobs-1.json" >"$TMP/jobs"
  sed 's/$/\r/' "$TMP/jobs" >"$FIXTURE/jobs-1.json"
  run_selector
  assert_eq "$code" 0
  assert_eq "$(jq -r .sha "$out")" "$candidate"
}
attempt_changes_during_read() {
  jq '.run_attempt=2' "$FIXTURE/run.json" >"$FIXTURE/second-run.json"
  run_selector
  assert_failure
}
api_error_is_refused() {
  export GH_FAIL=1
  run_selector
  assert_failure
}
incomplete_jobs_are_refused() {
  jq '.[0].total_count=2' "$FIXTURE/jobs-1.json" >"$TMP/jobs"
  mv "$TMP/jobs" "$FIXTURE/jobs-1.json"
  run_selector
  assert_failure
}

if [ "$#" -gt 0 ]; then
  fixture
  "$1"
  printf 'ok %s\n' "$1"
else
  failures=0
  passed=0
  for name in valid_frontend valid_backend_without_deploy_success reject_untrusted_run \
    latest_job_results_win sync_only_rerun_inherits_successful_dependencies missing_or_skipped_check \
    invalid_inputs_do_not_call_api api_pagination_and_crlf attempt_changes_during_read \
    api_error_is_refused incomplete_jobs_are_refused; do
    if bash "$0" "$name" >"$TMP/$name.log" 2>&1; then
      cat "$TMP/$name.log"
      passed=$((passed + 1))
    else
      printf 'FAIL %s\n' "$name" >&2
      cat "$TMP/$name.log" >&2
      failures=$((failures + 1))
    fi
  done
  [ "$failures" -eq 0 ] || { printf 'FAIL: %s CI context scenarios\n' "$failures"; exit 1; }
  printf 'CI context: %s passed\n' "$passed"
fi
