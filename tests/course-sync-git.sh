#!/usr/bin/env bash
# Real bare repositories: a wrong refspec or stale-run branch changes these assertions.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SCRIPT="$ROOT/scripts/course-sync-git.sh"

fixture() {
  source_repo="$TMP/source.git"
  course="$TMP/course.git"
  runner="$TMP/runner.git"
  writer="$TMP/writer"
  out="$TMP/out"
  err="$TMP/err"
  git init -q --bare --initial-branch=main "$source_repo"
  git init -q --initial-branch=main "$writer"
  git -C "$writer" config user.name 'Sync test'
  git -C "$writer" config user.email 'sync-test@example.invalid'
  git -C "$writer" commit -q --allow-empty -m A
  A=$(git -C "$writer" rev-parse HEAD)
  git -C "$writer" commit -q --allow-empty -m B
  B=$(git -C "$writer" rev-parse HEAD)
  git -C "$writer" commit -q --allow-empty -m C
  C=$(git -C "$writer" rev-parse HEAD)
  git -C "$writer" push -q "$source_repo" main
  git clone -q --bare "$source_repo" "$course"
  git --git-dir="$course" update-ref refs/heads/main "$A"
  git --git-dir="$course" update-ref refs/heads/keep "$A"
  git --git-dir="$course" update-ref refs/tags/keep "$A"
  git init -q --bare "$runner"
  git --git-dir="$runner" remote add origin "$source_repo"
  git --git-dir="$runner" remote add course "$course"
}

run_sync() {
  code=0
  bash "$SCRIPT" "$runner" "$1" >"$out" 2>"$err" || code=$?
}
assert_eq() {
  [ "$1" = "$2" ] || { printf 'expected <%s>, got <%s>\n' "$2" "$1" >&2; cat "$err" >&2; exit 1; }
}
assert_result() {
  assert_eq "$code" 0
  assert_eq "$(jq -r .result "$out" | tr -d '\r')" "$1"
  assert_eq "$(jq -r .source_sha "$out" | tr -d '\r')" "$2"
  assert_eq "$(jq -r .course_sha "$out" | tr -d '\r')" "$3"
  assert_eq "$(git --git-dir="$course" rev-parse refs/heads/main)" "$3"
}

fast_forward_preserves_other_refs() {
  run_sync "$B"
  assert_result updated "$B" "$B"
  assert_eq "$(git --git-dir="$course" rev-parse refs/heads/keep)" "$A"
  assert_eq "$(git --git-dir="$course" rev-parse refs/tags/keep)" "$A"
  assert_eq "$(git --git-dir="$course" for-each-ref --format='%(refname)' | wc -l | tr -d ' ')" 3
}
same_sha_is_noop() {
  git --git-dir="$course" update-ref refs/heads/main "$B"
  run_sync "$B"
  assert_result unchanged "$B" "$B"
}
stale_run_is_noop() {
  git --git-dir="$course" update-ref refs/heads/main "$C"
  run_sync "$B"
  assert_result superseded "$B" "$C"
}
independent_commit() {
  git --git-dir="$course" -c user.name='Other writer' -c user.email='other@example.invalid' \
    commit-tree "$(git --git-dir="$course" rev-parse "$A^{tree}")" "$@" -m independent
}
assert_failure() {
  [ "$code" -ne 0 ] || { echo 'Expected refusal, got success' >&2; cat "$out" >&2; exit 1; }
  [ ! -s "$out" ] || { echo 'Failure must not emit a success object' >&2; exit 1; }
}
unknown_descendant_is_divergence() {
  D=$(independent_commit -p "$B")
  git --git-dir="$course" update-ref refs/heads/main "$D"
  run_sync "$B"
  assert_failure
  assert_eq "$(git --git-dir="$course" rev-parse refs/heads/main)" "$D"
  grep -q 'diverged' "$err"
}
unrelated_main_is_divergence() {
  D=$(independent_commit)
  git --git-dir="$course" update-ref refs/heads/main "$D"
  run_sync "$B"
  assert_failure
  assert_eq "$(git --git-dir="$course" rev-parse refs/heads/main)" "$D"
  grep -q 'diverged' "$err"
}
candidate_outside_source_main() {
  git -C "$writer" checkout -q -b work
  git -C "$writer" commit -q --allow-empty -m unaccepted
  D=$(git -C "$writer" rev-parse HEAD)
  git -C "$writer" push -q "$source_repo" work
  git --git-dir="$runner" fetch -q origin work:refs/test/candidate
  run_sync "$D"
  assert_failure
  assert_eq "$(git --git-dir="$course" rev-parse refs/heads/main)" "$A"
  grep -q 'not in source main' "$err"
}
failed_push_keeps_target() {
  printf '#!/bin/sh\nexit 1\n' >"$course/hooks/pre-receive"
  chmod +x "$course/hooks/pre-receive"
  run_sync "$B"
  assert_failure
  assert_eq "$(git --git-dir="$course" rev-parse refs/heads/main)" "$A"
}
transport_failure_keeps_target() {
  git --git-dir="$runner" remote set-url course "$TMP/missing.git"
  run_sync "$B"
  assert_failure
  assert_eq "$(git --git-dir="$course" rev-parse refs/heads/main)" "$A"
}
post_push_race_is_classified() {
  printf '#!/bin/sh\ngit update-ref refs/heads/main %s\n' "$C" >"$course/hooks/post-receive"
  chmod +x "$course/hooks/post-receive"
  run_sync "$B"
  assert_result updated "$B" "$C"
}
post_push_unknown_commit_is_rejected() {
  D=$(independent_commit -p "$B")
  printf '#!/bin/sh\ngit update-ref refs/heads/main %s\n' "$D" >"$course/hooks/post-receive"
  chmod +x "$course/hooks/post-receive"
  run_sync "$B"
  assert_failure
  assert_eq "$(git --git-dir="$course" rev-parse refs/heads/main)" "$D"
  grep -q 'changed unexpectedly' "$err"
}
invalid_candidate_is_rejected() {
  run_sync refs/heads/main
  assert_failure
  assert_eq "$(git --git-dir="$course" rev-parse refs/heads/main)" "$A"
}

if [ "$#" -gt 0 ]; then
  fixture
  "$1"
  printf 'ok %s\n' "$1"
else
  failures=0
  passed=0
  for name in fast_forward_preserves_other_refs same_sha_is_noop stale_run_is_noop \
    unknown_descendant_is_divergence unrelated_main_is_divergence candidate_outside_source_main \
    failed_push_keeps_target transport_failure_keeps_target post_push_race_is_classified \
    post_push_unknown_commit_is_rejected invalid_candidate_is_rejected; do
    if bash "$0" "$name" >"$TMP/$name.log" 2>&1; then
      cat "$TMP/$name.log"
      passed=$((passed + 1))
    else
      cat "$TMP/$name.log" >&2
      failures=$((failures + 1))
    fi
  done
  [ "$failures" -eq 0 ] || { printf 'FAIL: %s course Git scenarios\n' "$failures"; exit 1; }
  printf 'course Git: %s passed\n' "$passed"
fi
