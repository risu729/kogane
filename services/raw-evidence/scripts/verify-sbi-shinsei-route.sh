#!/usr/bin/env bash
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="59ea63cc00914b30ca410b062ae2bb7f"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
result="$(
  cd -- "${service_dir}"
  npx wrangler d1 execute kogane-raw-evidence --remote --json \
    --file scripts/verify-sbi-shinsei-route.sql
)"
route_count="$(jq -er \
  '[.. | objects | select(has("route_count")) | .route_count] | if length == 1 then .[0] else error("route_count_missing") end' \
  <<<"${result}")"
policy_count="$(jq -er \
  '[.. | objects | select(has("policy_count")) | .policy_count] | if length == 1 then .[0] else error("policy_count_missing") end' \
  <<<"${result}")"
unset result

if [[ "${route_count}" != "1" || "${policy_count}" != "1" ]]; then
  printf '{"verified":false,"routeCount":%s,"policyCount":%s}\n' \
    "${route_count}" "${policy_count}" >&2
  exit 1
fi
printf '{"verified":true,"routeCount":1,"policyCount":1}\n'
