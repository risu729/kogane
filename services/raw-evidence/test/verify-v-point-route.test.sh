#!/usr/bin/env bash
set -euo pipefail

service_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "${test_dir}"' EXIT

mock_wrangler="${test_dir}/wrangler"
cat >"${mock_wrangler}" <<'MOCK_WRANGLER'
#!/usr/bin/env bash
saw_command=false
for arg in "$@"; do
  [[ "${arg}" == "--file" ]] && exit 98
  [[ "${arg}" == "--command" ]] && saw_command=true
done
[[ "${saw_command}" == true ]] || exit 97
echo '[{"results":[{"route_count":1,"policy_count":2,"alias_count":1}],"success":true}]'
MOCK_WRANGLER
chmod 700 "${mock_wrangler}"

output="$(cd -- "${service_dir}" && WRANGLER_BIN="${mock_wrangler}" bash scripts/verify-v-point-route.sh)"
[[ "${output}" == '{"verified":true,"routeCount":1,"policyCount":2,"aliasCount":1}' ]]
