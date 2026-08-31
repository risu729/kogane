#!/usr/bin/env bash
set -euo pipefail

worker_url=${1:?usage: $0 WORKER_URL [ADMIN_TOKEN_FILE]}
admin_token_file=${2:-/home/risu/.local/state/kogane/moneyforward-worker-admin-token}

if [[ ! -s $admin_token_file ]]; then
  echo "admin token file does not exist" >&2
  exit 2
fi

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $(tr -d '\r\n' < "$admin_token_file")" \
  "${worker_url%/}/trigger"
printf '\n'
