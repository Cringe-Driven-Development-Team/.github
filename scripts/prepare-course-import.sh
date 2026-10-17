#!/usr/bin/env bash
# Build a local two-parent import; never rewrite either source and never push.
set -euo pipefail
die() { printf 'Import refused: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 3 ] || die 'usage: prepare-course-import.sh COURSE_BUNDLE TASKS_BUNDLE OUTPUT_DIR'
[ ! -e "$3" ] && [ ! -L "$3" ] || die 'output directory already exists'
[ -f "$1" ] && [ -f "$2" ] || die 'both input bundles must exist'
course_bundle=$(cd "$(dirname "$1")" && printf '%s/%s' "$PWD" "$(basename "$1")")
tasks_bundle=$(cd "$(dirname "$2")" && printf '%s/%s' "$PWD" "$(basename "$2")")
output=$3
verify_dir=$(mktemp -d)
trap 'rm -rf -- "$verify_dir"' EXIT
git init --quiet --bare --initial-branch=main "$verify_dir/repo.git"
git -C "$verify_dir/repo.git" bundle verify "$course_bundle" >&2 || die 'invalid course bundle'
git -C "$verify_dir/repo.git" bundle verify "$tasks_bundle" >&2 || die 'invalid tasks bundle'
course_sha=$(git bundle list-heads "$course_bundle" refs/heads/main | awk '$2 == "refs/heads/main" {print $1}')
tasks_sha=$(git bundle list-heads "$tasks_bundle" refs/heads/main | awk '$2 == "refs/heads/main" {print $1}')
[[ "$course_sha" =~ ^[0-9a-f]{40}$ && "$tasks_sha" =~ ^[0-9a-f]{40}$ ]] ||
  die 'both bundles must contain refs/heads/main'

git clone --quiet --no-checkout --branch main -- "$tasks_bundle" "$output"
git -C "$output" remote add course "$course_bundle"
git -C "$output" fetch --quiet --no-tags course refs/heads/main:refs/remotes/course/main
[ "$(git -C "$output" rev-parse refs/heads/main)" = "$tasks_sha" ] &&
  [ "$(git -C "$output" rev-parse refs/remotes/course/main)" = "$course_sha" ] ||
  die 'input bundle changed during import'
course_tree=$(git -C "$output" rev-parse "$course_sha^{tree}")
merged=$(git -C "$output" commit-tree "$course_tree" -p "$tasks_sha" -p "$course_sha" \
  -m 'chore: import course history for team development')
git -C "$output" -c core.hooksPath=/dev/null switch --quiet --create migration/import "$merged"
printf '%s\n' "$merged"
