#!/usr/bin/env bash
# Verify conservation of two independent histories and exact course files.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SCRIPT="$ROOT/scripts/prepare-course-import.sh"
course="$TMP/course source"
tasks="$TMP/tasks source"
course_bundle="$TMP/course input.bundle"
tasks_bundle="$TMP/tasks input.bundle"
output="$TMP/imported code"
out="$TMP/out"
err="$TMP/err"
fixture() {
  for repo in "$course" "$tasks"; do
    git init -q --initial-branch=main "$repo"
    git -C "$repo" config user.name 'Original developer'
    git -C "$repo" config user.email original@example.invalid
    mkdir -p "$repo/.github/workflows"
  done
  printf 'Course application\n' >"$course/README.md"
  printf 'name: course CI\n' >"$course/.github/workflows/ci.yml"
  printf 'Application\n' >"$course/app.txt"
  printf 'Task placeholder\n' >"$tasks/README.md"
  printf 'name: tasks automation\n' >"$tasks/.github/workflows/automation.yml"
  for repo in "$course" "$tasks"; do
    git -C "$repo" add .
    git -C "$repo" commit -q -m original
  done
  course_sha=$(git -C "$course" rev-parse HEAD)
  tasks_sha=$(git -C "$tasks" rev-parse HEAD)
  course_tree=$(git -C "$course" rev-parse 'HEAD^{tree}')
  git -C "$course" bundle create "$course_bundle" --all
  git -C "$tasks" bundle create "$tasks_bundle" --all
}
run_import() {
  code=0
  env GIT_AUTHOR_NAME='Migration test' GIT_AUTHOR_EMAIL=migration@example.invalid \
    GIT_COMMITTER_NAME='Migration test' GIT_COMMITTER_EMAIL=migration@example.invalid \
    bash "$SCRIPT" "$course_bundle" "$tasks_bundle" "$output" >"$out" 2>"$err" || code=$?
}
assert_eq() {
  [ "$1" = "$2" ] || { printf 'expected <%s>, got <%s>\n' "$2" "$1" >&2; cat "$err" >&2; exit 1; }
}
unrelated_roots_preserve_history_and_tree() {
  source_refs=$(git -C "$course" for-each-ref)
  task_refs=$(git -C "$tasks" for-each-ref)
  run_import
  assert_eq "$code" 0
  git -C "$output" merge-base --is-ancestor "$tasks_sha" HEAD
  git -C "$output" merge-base --is-ancestor "$course_sha" HEAD
  assert_eq "$(git -C "$output" rev-parse 'HEAD^{tree}')" "$course_tree"
  assert_eq "$(git -C "$output" rev-parse HEAD^1)" "$tasks_sha"
  assert_eq "$(git -C "$output" rev-parse HEAD^2)" "$course_sha"
  assert_eq "$(git -C "$output" branch --show-current)" migration/import
  assert_eq "$(cat "$out")" "$(git -C "$output" rev-parse HEAD)"
  assert_eq "$(git -C "$course" for-each-ref)" "$source_refs"
  assert_eq "$(git -C "$tasks" for-each-ref)" "$task_refs"
  assert_eq "$(git -C "$output" remote get-url origin)" "$tasks_bundle"
  assert_eq "$(git -C "$output" remote get-url course)" "$course_bundle"
}
existing_output_is_untouched() {
  mkdir "$output"
  printf 'keep\n' >"$output/sentinel"
  run_import
  assert_eq "$code" 1
  assert_eq "$(cat "$output/sentinel")" keep
  grep -q 'already exists' "$err"
}
missing_main_or_broken_bundle_fails() {
  git -C "$course" branch other
  git -C "$course" bundle create "$TMP/no-main.bundle" other
  course_bundle="$TMP/no-main.bundle"
  run_import
  assert_eq "$code" 1
  [ ! -e "$output" ]
  grep -q 'main' "$err"
  printf 'not a bundle\n' >"$TMP/broken.bundle"
  course_bundle="$TMP/broken.bundle"
  run_import
  assert_eq "$code" 1
  [ ! -e "$output" ]
}
authors_are_not_rewritten() {
  run_import
  assert_eq "$code" 0
  for sha in "$course_sha" "$tasks_sha"; do
    assert_eq "$(git -C "$output" show -s --format=%an "$sha")" 'Original developer'
    assert_eq "$(git -C "$output" show -s --format=%ae "$sha")" original@example.invalid
    assert_eq "$(git -C "$output" cat-file commit "$sha")" \
      "$(git -C "$course" cat-file commit "$sha" 2>/dev/null || git -C "$tasks" cat-file commit "$sha")"
  done
  assert_eq "$(git -C "$output" show -s --format=%an HEAD)" 'Migration test'
}
works_outside_git_checkout() {
  cd "$TMP"
  run_import
  assert_eq "$code" 0
  assert_eq "$(git -C "$output" rev-parse 'HEAD^{tree}')" "$course_tree"
}
repeat_does_not_delete_import() {
  run_import
  assert_eq "$code" 0
  imported_sha=$(cat "$out")
  run_import
  assert_eq "$code" 1
  assert_eq "$(git -C "$output" rev-parse HEAD)" "$imported_sha"
}
if [ "$#" -gt 0 ]; then
  fixture
  "$1"
  printf 'ok %s\n' "$1"
else
  failures=0
  for name in unrelated_roots_preserve_history_and_tree existing_output_is_untouched \
    missing_main_or_broken_bundle_fails authors_are_not_rewritten works_outside_git_checkout repeat_does_not_delete_import; do
    if bash "$0" "$name" >"$TMP/$name.log" 2>&1; then
      cat "$TMP/$name.log"
    else
      printf 'FAIL %s\n' "$name" >&2
      cat "$TMP/$name.log" >&2
      failures=$((failures + 1))
    fi
  done
  [ "$failures" -eq 0 ] || exit 1
  echo 'course import: 6 passed'
fi
