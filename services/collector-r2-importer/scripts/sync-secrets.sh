#!/usr/bin/env bash
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="59ea63cc00914b30ca410b062ae2bb7f"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
raw_dir="$(cd -- "${service_dir}/../raw-evidence" && pwd)"
user_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
config_dir="${KOGANE_CONFIG_DIR:-${user_home}/.config/kogane}"
credential_path="${config_dir}/ingest-client-keys.cred"
fingerprint_path="${config_dir}/origin-fingerprint.cred"

if ! test -f "${credential_path}" || ! test -f "${fingerprint_path}"; then
  printf 'required local systemd credentials are missing\n' >&2
  exit 1
fi

(
  cd -- "${raw_dir}"
  KOGANE_INGEST_CLIENT_ID=collector-r2-sbi bash scripts/sync-ingest-key.sh
)

key_map="$(sudo systemd-creds decrypt "${credential_path}" -)"
client_secret="$(jq -er '."collector-r2-sbi" | select(type == "string" and length >= 20)' <<<"${key_map}")"
fingerprint_secret="$(sudo systemd-creds decrypt "${fingerprint_path}" -)"
if ! [[ "${fingerprint_secret}" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'origin fingerprint credential is invalid\n' >&2
  exit 1
fi

(
  cd -- "${service_dir}"
  printf 'collector-r2-sbi.%s' "${client_secret}" |
    npx wrangler secret put RAW_EVIDENCE_TOKEN >/dev/null
  printf '%s' "${fingerprint_secret}" |
    npx wrangler secret put ORIGIN_FINGERPRINT_KEY >/dev/null
)
unset key_map client_secret fingerprint_secret
printf '{"synced":true,"worker":"kogane-collector-r2-importer"}\n'
