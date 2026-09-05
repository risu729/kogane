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
  if [[ "${arg}" == "--file" ]]; then
    printf "route verifier must use --command, not --file\\n" >&2
    exit 98
  fi
  if [[ "${arg}" == "--command" ]]; then
    saw_command=true
  fi
done
if [[ "${saw_command}" != "true" ]]; then
  printf "route verifier did not pass --command\\n" >&2
  exit 97
fi
printf "npm notice simulated diagnostic\\n" >&2
echo '[{"results":[{"route_count":1,"policy_count":1}],"success":true}]'
MOCK_WRANGLER
chmod 700 "${mock_wrangler}"

mock_npx="${test_dir}/npx"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "npx must not be invoked\\n" >&2' \
  'exit 99' \
  >"${mock_npx}"
chmod 700 "${mock_npx}"

stderr_file="${test_dir}/stderr"
if ! output="$(
  cd -- "${service_dir}"
  PATH="${test_dir}:${PATH}" WRANGLER_BIN="${mock_wrangler}" \
    bash scripts/verify-mobile-suica-route.sh 2>"${stderr_file}"
)"; then
  printf 'route verifier failed with the mock wrangler\n' >&2
  sed -n '1,20p' "${stderr_file}" >&2
  exit 1
fi

if [[ "${output}" != '{"verified":true,"routeCount":1,"policyCount":1}' ]]; then
  printf 'route verifier did not emit the expected aggregate-only JSON\n' >&2
  exit 1
fi
if ! grep -Fx 'npm notice simulated diagnostic' "${stderr_file}" >/dev/null; then
  printf 'mock diagnostic was not kept on stderr\n' >&2
  exit 1
fi
if grep -F 'npx must not be invoked' "${stderr_file}" >/dev/null; then
  printf 'route verifier invoked npx instead of the local wrangler executable\n' >&2
  exit 1
fi
