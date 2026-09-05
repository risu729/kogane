#!/usr/bin/env bash
set -euo pipefail

service_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "${test_dir}"' EXIT

mock_bin="${test_dir}/bin"
mkdir -m 700 -- "${mock_bin}"
mock_openssl="${mock_bin}/openssl"
cat >"${mock_openssl}" <<'MOCK_OPENSSL'
#!/usr/bin/env bash
[[ "$1" == "rand" && "$2" == "-hex" && "$3" == "32" ]] || exit 96
printf "%s\\n" "${MOCK_GENERATED_TOKEN}"
MOCK_OPENSSL
chmod 700 -- "${mock_openssl}"

mock_wrangler="${mock_bin}/wrangler"
cat >"${mock_wrangler}" <<'MOCK_WRANGLER'
#!/usr/bin/env bash
[[ "$1" == "secret" && "$2" == "put" && "$3" == "ADMIN_TRIGGER_TOKEN" ]] || exit 95
umask 077
cat >"${MOCK_CAPTURE_FILE}"
[[ "${MOCK_WRANGLER_FAIL:-0}" == "0" ]]
MOCK_WRANGLER
chmod 700 -- "${mock_wrangler}"

token_dir="${test_dir}/secrets"
token_file="${token_dir}/sbi-shinsei-worker-admin-token"
capture_file="${test_dir}/captured"
first_token="$(printf 'a%.0s' {1..64})"

output="$(
  SBI_SHINSEI_ADMIN_TOKEN_FILE="${token_file}" \
  WRANGLER_BIN="${mock_wrangler}" \
  OPENSSL_BIN="${mock_openssl}" \
  MOCK_GENERATED_TOKEN="${first_token}" \
  MOCK_CAPTURE_FILE="${capture_file}" \
    bash "${service_dir}/scripts/sync-admin-trigger-token.sh" --rotate
)"

[[ -f "${token_file}" && ! -L "${token_file}" ]]
[[ "$(stat -c '%u' -- "${token_file}")" == "$(id -u)" ]]
[[ "$(stat -c '%a' -- "${token_file}")" == "600" ]]
[[ "$(<"${token_file}")" == "$(<"${capture_file}")" ]]
[[ "${output}" == "synced secret ADMIN_TRIGGER_TOKEN from ${token_file}" ]]
[[ "${output}" != *"${first_token}"* ]]

old_token="${first_token}"
next_token="$(printf 'b%.0s' {1..64})"
if SBI_SHINSEI_ADMIN_TOKEN_FILE="${token_file}" \
  WRANGLER_BIN="${mock_wrangler}" \
  OPENSSL_BIN="${mock_openssl}" \
  MOCK_GENERATED_TOKEN="${next_token}" \
  MOCK_CAPTURE_FILE="${capture_file}" \
  MOCK_WRANGLER_FAIL=1 \
    bash "${service_dir}/scripts/sync-admin-trigger-token.sh" --rotate \
      >"${test_dir}/failed.stdout" 2>"${test_dir}/failed.stderr"; then
  printf 'rotation unexpectedly succeeded with a failing wrangler\n' >&2
  exit 1
fi

[[ "$(<"${token_file}")" == "${old_token}" ]]
[[ "$(<"${token_file}.pending")" == "${next_token}" ]]
if grep -F -- "${next_token}" "${test_dir}/failed.stdout" \
  "${test_dir}/failed.stderr" >/dev/null; then
  printf 'failed rotation exposed the token\n' >&2
  exit 1
fi

resume_output="$(
  SBI_SHINSEI_ADMIN_TOKEN_FILE="${token_file}" \
  WRANGLER_BIN="${mock_wrangler}" \
  OPENSSL_BIN="${mock_openssl}" \
  MOCK_CAPTURE_FILE="${capture_file}" \
    bash "${service_dir}/scripts/sync-admin-trigger-token.sh" --resume
)"

[[ ! -e "${token_file}.pending" && ! -L "${token_file}.pending" ]]
[[ "$(<"${token_file}")" == "${next_token}" ]]
[[ "$(<"${token_file}")" == "$(<"${capture_file}")" ]]
[[ "${resume_output}" == "synced secret ADMIN_TRIGGER_TOKEN from ${token_file}" ]]
[[ "${resume_output}" != *"${next_token}"* ]]

ln -s -- "${token_file}" "${token_file}.pending"
rm -f -- "${capture_file}"
if SBI_SHINSEI_ADMIN_TOKEN_FILE="${token_file}" \
  WRANGLER_BIN="${mock_wrangler}" \
  OPENSSL_BIN="${mock_openssl}" \
  MOCK_CAPTURE_FILE="${capture_file}" \
    bash "${service_dir}/scripts/sync-admin-trigger-token.sh" --resume \
      >"${test_dir}/symlink.stdout" 2>"${test_dir}/symlink.stderr"; then
  printf 'resume unexpectedly accepted a symlink\n' >&2
  exit 1
fi
if [[ -e "${capture_file}" ]]; then
  printf 'resume invoked wrangler for an unsafe pending file\n' >&2
  exit 1
fi
