#!/usr/bin/env bash
set -euo pipefail

mode=${1:-daily}
admin_token_file=${2:-"$HOME/.local/share/kogane/secrets/globalpass-worker-admin-token"}
collector_url=${GLOBALPASS_WORKER_BASE_URL:-"https://kogane-globalpass-collector-poc.takuanimal.workers.dev"}

if [[ $mode != daily && $mode != backfill && $mode != probe && $mode != stop ]]; then
  echo "mode must be daily, backfill, probe, or stop" >&2
  exit 2
fi
if [[ ! -s $admin_token_file ]]; then
  echo "admin token file does not exist" >&2
  exit 2
fi

IFS= read -r admin_token < "$admin_token_file"
if [[ $mode == probe ]]; then
  variant=${3:-baseline}
  curl --fail-with-body --silent --show-error --max-time 180 \
    --request POST \
    --header "Authorization: Bearer ${admin_token}" \
    "${collector_url}/container-probe?variant=${variant}"
elif [[ $mode == stop ]]; then
  instance=${3:-v14}
  action=${4:-stop}
  curl --fail-with-body --silent --show-error --max-time 60 \
    --request POST \
    --header "Authorization: Bearer ${admin_token}" \
    "${collector_url}/container-stop?instance=${instance}&action=${action}"
else
  curl --fail-with-body --silent --show-error --max-time 900 \
    --request POST \
    --header "Authorization: Bearer ${admin_token}" \
    "${collector_url}/trigger?mode=${mode}"
fi
printf '\n'
