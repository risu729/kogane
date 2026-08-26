#!/usr/bin/env bash
set -euo pipefail

if (( $# < 2 || $# > 3 )); then
  echo "usage: $0 FROM TO [ADMIN_TOKEN_FILE]" >&2
  exit 2
fi

from=$1
to=$2
admin_token_file=${3:-"$HOME/.local/share/kogane/secrets/sbi-worker-admin-token"}
collector_url=${SBI_WORKER_BASE_URL:-"https://kogane-sbi-collector-poc.takuanimal.workers.dev"}

if [[ ! $from =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ||
      ! $to =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ || $from > $to ]]; then
  echo "FROM and TO must be a valid YYYY-MM-DD range" >&2
  exit 2
fi
if [[ ! -s $admin_token_file ]]; then
  echo "admin token file does not exist" >&2
  exit 2
fi

IFS= read -r admin_token < "$admin_token_file"
window_from=$from
while [[ $window_from < $to || $window_from == $to ]]; do
  window_to=$(date --date="${window_from} +89 days" +%F)
  if [[ $window_to > $to ]]; then window_to=$to; fi

  for scope in domestic foreign; do
    response=$(curl --fail-with-body --silent --show-error --max-time 180 \
      --retry 3 --retry-all-errors --retry-delay 5 \
      --request POST \
      --header "Authorization: Bearer ${admin_token}" \
      "${collector_url}/trigger?scope=${scope}&from=${window_from}&to=${window_to}")
    jq -n --arg scope "$scope" --argjson result "$response" '{
      scope: $scope,
      status: $result.status,
      window: [$result.artifacts[] | select(.window != null) | .window][0],
      artifactCount: ($result.artifacts | length),
      failureCount: ($result.failures | length),
      manifestKey: $result.manifestKey
    }'
  done

  window_from=$(date --date="${window_to} +1 day" +%F)
done
