#!/usr/bin/env bash
# Execute the actual inline workflow blocks: no GitHub runner or real credentials required.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
WF="$ROOT/.github/workflows/sync-to-course.yml"
out="$TMP/out"
err="$TMP/err"
source_repo=Cringe-Driven-Development-Team/frontend
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ref=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
extract() {
  awk -v n="$1" -f "$ROOT/tests/extract-run.awk" "$WF" >"$TMP/block.sh"
  [ -s "$TMP/block.sh" ] || { echo "Missing workflow run block $1" >&2; exit 1; }
}
assert_eq() {
  [ "$1" = "$2" ] || { printf 'expected <%s>, got <%s>\n' "$2" "$1" >&2; cat "$err" >&2; exit 1; }
}
trusted_action_is_wired() {
  grep -Fq 'uses: ./automation/actions/course-sync-context' "$WF"
  grep -Fq 'id: context' "$WF"
  grep -Fq 'TARGET: ${{ steps.context.outputs.target }}' "$WF"
  grep -Fq 'ref: ${{ inputs.automation_ref }}' "$WF"
  grep -Fq 'SOURCE_REPO: ${{ github.repository }}' "$WF"
  grep -Fq 'CI_RUN_ID: ${{ inputs.ci_run_id }}' "$WF"
  grep -Fq 'GH_TOKEN: ${{ github.token }}' "$WF"
  grep -Fq 'contents: read' "$WF"
  grep -Fq 'actions: read' "$WF"
}
invalid_request_is_rejected() {
  extract 1
  defaults=("SOURCE_REPO=$source_repo" SOURCE_REF=refs/heads/main "SHA=$sha" CI_RUN_ID=101 "AUTOMATION_REF=$ref")
  env "${defaults[@]}" bash "$TMP/block.sh"
  for invalid in SOURCE_REPO=other/repo SOURCE_REF=refs/heads/work SHA=main CI_RUN_ID=../1 AUTOMATION_REF=main; do
    code=0
    env "${defaults[@]}" "$invalid" bash "$TMP/block.sh" >"$out" 2>"$err" || code=$?
    assert_eq "$code" 1
  done
}
temporary_credentials_are_removed_on_failure() {
  extract 2
  mkdir -p "$TMP/job/automation/scripts" "$TMP/runner"
  cat >"$TMP/job/automation/scripts/course-sync-git.sh" <<'CORE'
#!/usr/bin/env bash
set -euo pipefail
key=$(find "$RUNNER_TEMP" -name key -type f)
[ -n "$key" ]
stat -c %a "$key" >"$PROOF"
exit 1
CORE
  code=0
  (cd "$TMP/job" && env RUNNER_TEMP="$TMP/runner" SYNC_KEY=fake-private-sync-key \
    SOURCE_REPO="$source_repo" TARGET=frontend-park-mail-ru/2026_2_Cringe_Driven_Development \
    SHA="$sha" PROOF="$TMP/proof" GITHUB_STEP_SUMMARY="$TMP/summary" bash "$TMP/block.sh") \
    >"$out" 2>"$err" || code=$?
  assert_eq "$code" 1
  assert_eq "$(cat "$TMP/proof")" 600
  assert_eq "$(find "$TMP/runner" -mindepth 1 | wc -l)" 0
  ! grep -q 'fake-private-sync-key' "$out" "$err"
}
checkout_failure_still_notifies() {
  extract 3
  mkdir -p "$TMP/job" "$TMP/bin" "$TMP/sent"
  cp "$ROOT/tests/stub-curl.sh" "$TMP/bin/curl"
  chmod +x "$TMP/bin/curl"
  (cd "$TMP/job" && env PATH="$TMP/bin:$PATH" SENT="$TMP/sent" TOKEN=fake-token \
    CHAT=-100 TOPIC=26 SOURCE_REPO="$source_repo" SHA="$sha" \
    RUN_URL=https://github.com/Cringe-Driven-Development-Team/frontend/actions/runs/101 \
    bash "$TMP/block.sh") >"$out" 2>"$err"
  assert_eq "$(find "$TMP/sent" -type f | wc -l)" 1
  grep -qF '❌ Course synchronization failed' "$TMP/sent/1"
  grep -q "$source_repo" "$TMP/sent/1"
  grep -q '/actions/runs/101' "$TMP/sent/1"
}
if [ "$#" -gt 0 ]; then
  "$1"
  printf 'ok %s\n' "$1"
else
  failures=0
  for name in trusted_action_is_wired invalid_request_is_rejected temporary_credentials_are_removed_on_failure checkout_failure_still_notifies; do
    if bash "$0" "$name" >"$TMP/$name.log" 2>&1; then
      cat "$TMP/$name.log"
    else
      printf 'FAIL %s\n' "$name" >&2
      cat "$TMP/$name.log" >&2
      failures=$((failures + 1))
    fi
  done
  [ "$failures" -eq 0 ] || exit 1
  echo 'workflow blocks: 4 passed'
fi
