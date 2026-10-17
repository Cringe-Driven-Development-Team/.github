#!/usr/bin/env bash
# Accept only the required successful jobs of this main/push CI run, including job-only reruns.
set -euo pipefail
die() { printf 'Course sync refused: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 3 ] || die 'usage: course-sync-context.sh SOURCE_REPO CI_RUN_ID EXPECTED_SHA'
source_repo=$1
run_id=$2
sha=$3
case "$source_repo" in
  Cringe-Driven-Development-Team/frontend)
    target=frontend-park-mail-ru/2026_2_Cringe_Driven_Development
    required=(Check) ;;
  Cringe-Driven-Development-Team/backend)
    target=go-park-mail-ru/2026_2_Cringe_Driven_Development
    required=(lint test docker) ;;
  *) die 'unknown source repository' ;;
esac
[[ "$run_id" =~ ^[1-9][0-9]*$ ]] || die 'invalid CI run id'
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die 'expected a full commit SHA'

api="repos/$source_repo/actions"
run=$(gh api "$api/runs/$run_id") || die 'cannot read CI run'
workflow=$(gh api "$api/workflows/ci.yml") || die 'cannot read CI workflow'
if ! jq -e --arg repo "$source_repo" --arg sha "$sha" --argjson id "$run_id" \
  --argjson workflow "$workflow" '
    type == "object" and .id == $id and .event == "push" and .head_branch == "main"
    and .head_sha == $sha and .repository.full_name == $repo and .head_repository.full_name == $repo
    and (.status == "in_progress" or .status == "completed")
    and (.run_attempt | type == "number" and . >= 1 and floor == .)
    and .workflow_id == $workflow.id and ($workflow.id | type == "number")
    and $workflow.path == ".github/workflows/ci.yml"
  ' <<<"$run" >/dev/null; then
  die 'run does not match repository, main, push, SHA and CI workflow'
fi
run_attempt=$(jq -r .run_attempt <<<"$run" | tr -d '\r')
declare -A found=()
found_count=0
for ((attempt=run_attempt; attempt>=1 && found_count<${#required[@]}; attempt--)); do
  pages=$(gh api "$api/runs/$run_id/attempts/$attempt/jobs?per_page=100" --paginate --slurp) ||
    die "cannot read jobs for attempt $attempt"
  if ! jq -e '
    type == "array" and length > 0
    and (.[0].total_count | type == "number" and . >= 0 and floor == .)
    and (.[0].total_count as $total | all(.[]; .total_count == $total and (.jobs | type == "array"))
      and ([.[].jobs[]] | length) == $total)
  ' <<<"$pages" >/dev/null; then
    die "incomplete jobs for attempt $attempt"
  fi
  jobs=$(jq '[.[].jobs[]]' <<<"$pages")
  if ! jq -e --argjson id "$run_id" --argjson attempt "$attempt" \
    'all(.[]; .run_id == $id and .run_attempt == $attempt and (.name | type == "string"))' \
    <<<"$jobs" >/dev/null; then
    die "jobs do not match run/attempt $attempt"
  fi
  for name in "${required[@]}"; do
    [ -z "${found[$name]:-}" ] || continue
    matching=$(jq --arg name "$name" '[.[] | select(.name == $name)]' <<<"$jobs")
    count=$(jq 'length' <<<"$matching" | tr -d '\r')
    [ "$count" -le 1 ] || die "ambiguous job $name in attempt $attempt"
    [ "$count" -eq 1 ] || continue
    if ! jq -e '.[0].status == "completed" and .[0].conclusion == "success"' \
      <<<"$matching" >/dev/null; then
      die "job $name is not successful in attempt $attempt"
    fi
    found[$name]=true
    found_count=$((found_count + 1))
  done
done
[ "$found_count" -eq "${#required[@]}" ] || die 'missing required CI jobs'

current=$(gh api "$api/runs/$run_id") || die 'cannot confirm CI run'
if ! jq -e --argjson before "$run" '
  [.id,.head_sha,.head_branch,.event,.workflow_id,.run_attempt,.repository.full_name,.head_repository.full_name]
  == ($before | [.id,.head_sha,.head_branch,.event,.workflow_id,.run_attempt,.repository.full_name,.head_repository.full_name])
  ' <<<"$current" >/dev/null; then
  die 'run changed while checking its jobs'
fi
jq -n --arg source "$source_repo" --arg target "$target" --arg sha "$sha" \
  --argjson id "$run_id" --argjson attempt "$run_attempt" \
  '{source:$source,target:$target,sha:$sha,run_id:$id,run_attempt:$attempt}'
