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

for client_id in collector-r2-sbi collector-r2-sbi-vc collector-r2-sony-bank collector-r2-sbi-shinsei; do
  (
    cd -- "${raw_dir}"
    KOGANE_INGEST_CLIENT_ID="${client_id}" bash scripts/sync-ingest-key.sh
  )
done

key_map="$(sudo systemd-creds decrypt "${credential_path}" -)"
sbi_secret="$(jq -er '."collector-r2-sbi" | select(type == "string" and length >= 20)' <<<"${key_map}")"
sbi_vc_secret="$(jq -er '."collector-r2-sbi-vc" | select(type == "string" and length >= 20)' <<<"${key_map}")"
sony_secret="$(jq -er '."collector-r2-sony-bank" | select(type == "string" and length >= 20)' <<<"${key_map}")"
sbi_shinsei_secret="$(jq -er '."collector-r2-sbi-shinsei" | select(type == "string" and length >= 20)' <<<"${key_map}")"
fingerprint_secret="$(sudo systemd-creds decrypt "${fingerprint_path}" -)"
if ! [[ "${fingerprint_secret}" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'origin fingerprint credential is invalid\n' >&2
  exit 1
fi

(
  cd -- "${service_dir}"
  secrets_json="$(jq -nc \
    --arg sbi "collector-r2-sbi.${sbi_secret}" \
    --arg sbiVc "collector-r2-sbi-vc.${sbi_vc_secret}" \
    --arg sony "collector-r2-sony-bank.${sony_secret}" \
    --arg sbiShinsei "collector-r2-sbi-shinsei.${sbi_shinsei_secret}" \
    --arg fingerprint "${fingerprint_secret}" \
    '{RAW_EVIDENCE_TOKEN:$sbi,RAW_EVIDENCE_TOKEN_SBI_VC:$sbiVc,RAW_EVIDENCE_TOKEN_SONY:$sony,RAW_EVIDENCE_TOKEN_SBI_SHINSEI:$sbiShinsei,ORIGIN_FINGERPRINT_KEY:$fingerprint}')"
  # A bulk update changes only these non-null names; unrelated Worker secrets remain intact.
  printf '%s' "${secrets_json}" | npx wrangler secret bulk >/dev/null
  unset secrets_json

  readonly required_secret_names=(
    RAW_EVIDENCE_TOKEN
    RAW_EVIDENCE_TOKEN_SBI_VC
    RAW_EVIDENCE_TOKEN_SONY
    RAW_EVIDENCE_TOKEN_SBI_SHINSEI
    ORIGIN_FINGERPRINT_KEY
  )
  secret_inventory="$(npx wrangler secret list --format json)"
  for secret_name in "${required_secret_names[@]}"; do
    jq -e --arg required "${secret_name}" \
      'type == "array" and any(.[]; .name == $required)' \
      <<<"${secret_inventory}" >/dev/null
  done
  unset secret_inventory
  jq -nc --args \
    '{synced:true,worker:"kogane-collector-r2-importer",verifiedSecretNames:$ARGS.positional}' \
    "${required_secret_names[@]}"
)
unset key_map sbi_secret sbi_vc_secret sony_secret sbi_shinsei_secret fingerprint_secret
