#!/usr/bin/env bash
set -euo pipefail

service_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "${test_dir}"' EXIT

mock_wrangler="${test_dir}/wrangler"
# These single-quoted lines intentionally become the mock script verbatim.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'saw_command=false' \
  'for arg in "$@"; do' \
  '  [[ "${arg}" == "--file" ]] && exit 98' \
  '  [[ "${arg}" == "--command" ]] && saw_command=true' \
  'done' \
  '[[ "${saw_command}" == true ]] || exit 97' \
  'echo '\''[{"results":[{"route_count":1,"policy_count":1,"alias_count":1}],"success":true}]'\''' \
  >"${mock_wrangler}"
chmod 700 "${mock_wrangler}"

output="$(cd -- "${service_dir}" && WRANGLER_BIN="${mock_wrangler}" bash scripts/verify-v-point-pay-email-route.sh)"
[[ "${output}" == '{"verified":true,"routeCount":1,"policyCount":1,"aliasCount":1}' ]]
