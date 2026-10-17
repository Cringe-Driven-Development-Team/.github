#!/usr/bin/env bash
# Synchronize one accepted commit; the caller configures trusted origin/course remotes.
set -euo pipefail
[ "$#" -eq 2 ] || { echo 'usage: course-sync-git.sh BARE_DIR CANDIDATE_SHA' >&2; exit 1; }
repo=$1
candidate=$2
[[ "$candidate" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full commit SHA' >&2; exit 1; }
[ "$(git -C "$repo" rev-parse --is-bare-repository)" = true ] ||
  { echo 'Expected a bare repository' >&2; exit 1; }

git -C "$repo" fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
git -C "$repo" fetch --quiet --no-tags course '+refs/heads/main:refs/remotes/course/main'
if ! git -C "$repo" cat-file -e "$candidate^{commit}" 2>/dev/null ||
   ! git -C "$repo" merge-base --is-ancestor "$candidate" refs/remotes/origin/main; then
  echo "Candidate $candidate is not in source main" >&2
  exit 1
fi
course_sha=$(git -C "$repo" rev-parse refs/remotes/course/main)
if ! git -C "$repo" merge-base --is-ancestor "$course_sha" refs/remotes/origin/main; then
  echo "Course main diverged: $course_sha (candidate $candidate)" >&2
  exit 1
fi
if [ "$candidate" = "$course_sha" ]; then
  result=unchanged
elif git -C "$repo" merge-base --is-ancestor "$candidate" "$course_sha"; then
  result=superseded
elif git -C "$repo" merge-base --is-ancestor "$course_sha" "$candidate"; then
  if ! git -C "$repo" push --quiet course "$candidate:refs/heads/main"; then
    echo "Push failed for candidate $candidate" >&2
    exit 1
  fi
  git -C "$repo" fetch --quiet --no-tags course '+refs/heads/main:refs/remotes/course/main'
  git -C "$repo" fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
  course_sha=$(git -C "$repo" rev-parse refs/remotes/course/main)
  if ! git -C "$repo" merge-base --is-ancestor "$candidate" "$course_sha" ||
     ! git -C "$repo" merge-base --is-ancestor "$course_sha" refs/remotes/origin/main; then
    echo "Course main changed unexpectedly after push: $course_sha (candidate $candidate)" >&2
    exit 1
  fi
  result=updated
else
  echo "Course main diverged: $course_sha (candidate $candidate)" >&2
  exit 1
fi
jq -n --arg result "$result" --arg sha "$candidate" --arg course "$course_sha" \
  '{result:$result,source_sha:$sha,course_sha:$course}'
