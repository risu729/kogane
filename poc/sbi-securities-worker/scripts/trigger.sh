#!/usr/bin/env bash
set -euo pipefail

scope=${1:-all}
admin_token_file=${2:-"$HOME/.local/share/kogane/secrets/sbi-worker-admin-token"}
collector_url=${SBI_WORKER_BASE_URL:-"https://kogane-sbi-collector-poc.takuanimal.workers.dev"}

if [[ $scope != all && $scope != domestic && $scope != foreign ]]; then
  echo "scope must be all, domestic, or foreign" >&2
  exit 2
fi
if [[ ! -s $admin_token_file ]]; then
  echo "admin token file does not exist" >&2
  exit 2
fi

IFS= read -r admin_token < "$admin_token_file"
curl --fail-with-body --silent --show-error --max-time 180 \
  --request POST \
  --header "Authorization: Bearer ${admin_token}" \
  "${collector_url}/trigger?scope=${scope}"
printf '\n'
