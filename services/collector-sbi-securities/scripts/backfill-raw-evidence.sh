#!/usr/bin/env bash
set -euo pipefail

admin_token_file=${1:-"$HOME/.local/share/kogane/secrets/sbi-worker-admin-token"}
collector_url=${SBI_WORKER_BASE_URL:-"https://kogane-sbi-collector-poc.takuanimal.workers.dev"}
state_dir=${KOGANE_STATE_DIR:-"$HOME/.local/state/kogane"}
cursor_file="${state_dir}/sbi-raw-evidence-backfill.cursor"
if [[ ! -s $admin_token_file ]]; then
  echo "admin token file does not exist" >&2
  exit 2
fi

IFS= read -r admin_token < "$admin_token_file"
auth_config="header = \"Authorization: Bearer ${admin_token}\""
unset admin_token
mkdir -p "$state_dir"
chmod 700 "$state_dir"
cursor=""
if [[ -s $cursor_file ]]; then IFS= read -r cursor < "$cursor_file"; fi
page=0
manifest_count=0
while (( page < 10000 )); do
  page=$((page + 1))
  url="${collector_url}/backfill-raw-evidence?limit=1"
  if [[ -n $cursor ]]; then
    encoded_cursor=$(jq -rn --arg value "$cursor" '$value|@uri')
    url="${url}&cursor=${encoded_cursor}"
  fi
  response=$(curl --config <(printf '%s\n' "$auth_config") \
    --fail-with-body --silent --show-error --max-time 180 \
    --request POST \
    "$url")
  failed=$(jq -er '.failedManifestCount' <<<"$response")
  if (( failed != 0 )); then
    jq '{page: $page, failedManifestCount, failureCode}' --argjson page "$page" <<<"$response" >&2
    exit 1
  fi
  imported=$(jq -er '.importedManifestCount' <<<"$response")
  manifest_count=$((manifest_count + imported))
  if [[ ${KOGANE_STOP_AFTER_MANIFEST:-0} == 1 && $imported -gt 0 ]]; then
    jq '{stoppedAfterManifest:true,result}' <<<"$response"
    exit 0
  fi
  truncated=$(jq -r '.truncated' <<<"$response")
  if [[ $truncated == false ]]; then
    rm -f -- "$cursor_file"
    printf '{"complete":true,"pages":%d,"importedManifests":%d}\n' "$page" "$manifest_count"
    exit 0
  fi
  cursor=$(jq -er '.nextCursor | select(type == "string" and length > 0)' <<<"$response")
  cursor_next="${cursor_file}.next.$$"
  printf '%s\n' "$cursor" >"$cursor_next"
  chmod 600 "$cursor_next"
  mv -f -- "$cursor_next" "$cursor_file"
done

echo "backfill exceeded the safety page limit" >&2
exit 1
