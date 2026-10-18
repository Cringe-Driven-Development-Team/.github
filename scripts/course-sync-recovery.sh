#!/usr/bin/env bash
# A successful retry clears the prior failed sync in this run; ordinary success stays silent.
set -euo pipefail
[ "$#" -eq 5 ] || { echo 'usage: course-sync-recovery.sh SOURCE_REPO RUN_ID RUN_ATTEMPT SHA RUN_URL' >&2; exit 1; }
repo=$1 run=$2 attempt=$3 sha=$4 url=$5
case "$repo" in
  Cringe-Driven-Development-Team/frontend|Cringe-Driven-Development-Team/backend) ;;
  *) echo 'Invalid recovery request' >&2; exit 1 ;;
esac
[[ "$run" =~ ^[1-9][0-9]*$ && "$attempt" =~ ^[1-9][0-9]*$ && "$sha" =~ ^[0-9a-f]{40}$ ]] ||
  { echo 'Invalid recovery request' >&2; exit 1; }
for ((previous=attempt-1; previous>=1; previous--)); do
  if ! pages=$(gh api "repos/$repo/actions/runs/$run/attempts/$previous/jobs?per_page=100" --paginate --slurp); then
    echo 'Cannot read sync history' >&2
    exit 1
  fi
  if ! jq -e --argjson run "$run" --argjson attempt "$previous" '
    type == "array" and length > 0
    and (.[0].total_count | type == "number" and . >= 0 and floor == .)
    and (.[0].total_count as $total |
      all(.[]; .total_count == $total and (.jobs | type == "array"))
      and ([.[].jobs[]] | length) == $total)
    and all(.[].jobs[]; .run_id == $run and .run_attempt == $attempt)
  ' <<<"$pages" >/dev/null; then
    echo 'Incomplete sync history' >&2
    exit 1
  fi
  jobs=$(jq '[.[].jobs[] | select(.name == "course-sync / sync" or .name == "sync / sync")]' <<<"$pages")
  count=$(jq length <<<"$jobs")
  [ "$count" -le 1 ] || { echo 'Ambiguous sync history' >&2; exit 1; }
  [ "$count" -gt 0 ] || continue
  [ "$(jq -r '.[0].status' <<<"$jobs")" = completed ] ||
    { echo 'Incomplete sync history' >&2; exit 1; }
  case "$(jq -r '.[0].conclusion' <<<"$jobs")" in
    failure)
      exec bash "$(dirname "$0")/course-sync-notify.sh" "$repo" "$sha" "$url" recovered ;;
    cancelled) continue ;;
    *) exit 0 ;;
  esac
done
