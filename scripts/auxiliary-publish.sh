#!/usr/bin/env bash
# Publish a full-SHA tag once, then expose only a verified public digest.
set -euo pipefail
service=${1:?service required}
local_image=${2:?local image required}
case "$service" in githubbot|webhook-alerts) ;; *) exit 1 ;; esac
[[ ${IMAGE_SHA:?} =~ ^[0-9a-f]{40}$ ]]
[[ ${GITHUB_RUN_ID:?} =~ ^[1-9][0-9]*$ ]]
[[ ${GITHUB_RUN_ATTEMPT:?} =~ ^[1-9][0-9]*$ ]]
: "${GITHUB_OUTPUT:?}" "${REGISTRY_USER:?}" "${REGISTRY_TOKEN:?}"
repository="cringe-driven-development-team/$service"
tag="sha-$IMAGE_SHA"
image="ghcr.io/$repository:$tag"
probe_dir=$(mktemp -d)
trap 'rm -rf "$probe_dir"' EXIT
rm -f release.json
accept='Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'
get_token() {
  curl --fail --silent --show-error --connect-timeout 10 --max-time 30 "$@" --get \
    --data-urlencode 'service=ghcr.io' --data-urlencode "scope=repository:$repository:pull" \
    https://ghcr.io/token | jq -er '.token | select(type == "string" and length > 0)'
}
probe() {
  curl --silent --show-error --connect-timeout 10 --max-time 30 \
    --header "Authorization: Bearer $registry_token" --header "$accept" \
    --dump-header "$probe_dir/headers" --output "$probe_dir/manifest" --write-out '%{http_code}' \
    "https://ghcr.io/v2/$repository/manifests/$1"
}
manifest_digest() {
  local header_digest body_digest
  header_digest=$(awk 'tolower($1) == "docker-content-digest:" {gsub("\r", "", $2); print $2}' "$probe_dir/headers")
  [[ "$header_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  body_digest="sha256:$(sha256sum "$probe_dir/manifest" | cut -d ' ' -f1)"
  [[ "$header_digest" == "$body_digest" ]] || return 1
  printf '%s' "$header_digest"
}
registry_token=$(get_token --user "$REGISTRY_USER:$REGISTRY_TOKEN")
echo "::add-mask::$registry_token"
status=$(probe "$tag")
case "$status" in
  200) ;;
  404)
    jq -e '.errors | type == "array" and length > 0 and all(.[]; .code == "MANIFEST_UNKNOWN" or .code == "NAME_UNKNOWN")' \
      "$probe_dir/manifest" >/dev/null || { echo 'Registry did not confirm a missing image' >&2; exit 1; }
    docker tag "$local_image" "$image"
    docker push "$image"
    [[ $(probe "$tag") == 200 ]]
    ;;
  *) echo "Registry lookup failed (HTTP $status)" >&2; exit 1 ;;
esac
digest=$(manifest_digest)
# A fresh anonymous token proves that deployers can fetch this exact publication.
registry_token=$(get_token)
echo "::add-mask::$registry_token"
[[ $(probe "$tag") == 200 ]]
[[ $(manifest_digest) == "$digest" ]]
[[ $(probe "$digest") == 200 ]]
[[ $(manifest_digest) == "$digest" ]]
image_ref="ghcr.io/$repository@$digest"
docker pull "$image_ref"
source=$(docker image inspect "$image_ref" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')
[[ "$source" == 'https://github.com/Cringe-Driven-Development-Team/.github' ]]
jq -n --arg service "$service" --arg image_ref "$image_ref" --arg source_sha "$IMAGE_SHA" \
  --argjson publisher_run_id "$GITHUB_RUN_ID" --argjson publisher_run_attempt "$GITHUB_RUN_ATTEMPT" \
  '{service: $service, image_ref: $image_ref, source_sha: $source_sha, publisher_run_id: $publisher_run_id, publisher_run_attempt: $publisher_run_attempt}' > release.json
printf 'image_ref=%s\n' "$image_ref" >> "$GITHUB_OUTPUT"
