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
  if [[ "${arg}" == "--file" ]]; then exit 98; fi
  if [[ "${arg}" == "--command" ]]; then saw_command=true; fi
done
if [[ "${saw_command}" != "true" ]]; then exit 97; fi
echo '[{"results":[{"route_count":1,"policy_count":1,"alias_count":1}],"success":true}]'
MOCK_WRANGLER
chmod 700 "${mock_wrangler}"

output="$(cd -- "${service_dir}" && WRANGLER_BIN="${mock_wrangler}" bash scripts/verify-vpass-route.sh)"
test "${output}" = '{"verified":true,"routeCount":1,"policyCount":1,"aliasCount":1}'
