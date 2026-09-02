#!/usr/bin/env bash
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="59ea63cc00914b30ca410b062ae2bb7f"

readonly base_url="https://kogane-ingest.takuanimal.workers.dev"
user_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
config_dir="${KOGANE_CONFIG_DIR:-${user_home}/.config/kogane}"
credential_path="${config_dir}/ingest-client-keys.cred"
legacy_path="${config_dir}/ingest-client.cred"
fingerprint_path="${config_dir}/origin-fingerprint.cred"
client_id="local-backfill"
next_path="${credential_path}.next.$$"
recovery_path="${credential_path}.recovery"

mkdir -p "${config_dir}"
chmod 700 "${config_dir}"

old_map='{}'
if test -f "${credential_path}"; then
  old_map="$(sudo systemd-creds decrypt "${credential_path}" -)"
elif test -f "${legacy_path}"; then
  legacy_secret="$(sudo systemd-creds decrypt "${legacy_path}" -)"
  old_map="$(jq -nc --arg clientId "${client_id}" --arg secret "${legacy_secret}" \
    '{($clientId):$secret}')"
  unset legacy_secret
fi
jq -e 'type == "object" and all(values[]; type == "string" and length >= 20)' \
  <<<"${old_map}" >/dev/null

key_map="${old_map}"
write_local=0
if test "${1:-}" = "--rotate" || ! test -f "${credential_path}"; then
  client_secret="$(openssl rand -hex 32)"
  key_map="$(jq -c --arg clientId "${client_id}" --arg secret "${client_secret}" \
    '. + {($clientId):$secret}' <<<"${old_map}")"
  unset client_secret
  printf '%s' "${key_map}" | sudo systemd-creds encrypt \
    --with-key=host --name=ingest-client-keys.cred - "${next_path}" >/dev/null
  sudo chown "$(id -u):$(id -g)" "${next_path}"
  chmod 600 "${next_path}"
  write_local=1
fi

if ! test -f "${fingerprint_path}"; then
  fingerprint_secret="$(openssl rand -hex 32)"
  printf '%s' "${fingerprint_secret}" | sudo systemd-creds encrypt \
    --with-key=host --name=origin-fingerprint.cred - "${fingerprint_path}" >/dev/null
  sudo chown "$(id -u):$(id -g)" "${fingerprint_path}"
  chmod 600 "${fingerprint_path}"
  unset fingerprint_secret
fi

printf '%s' "${key_map}" | npx wrangler secret put INGEST_CLIENT_KEYS >/dev/null
new_secret="$(jq -er --arg clientId "${client_id}" '.[$clientId]' <<<"${key_map}")"
auth_config="header = \"Authorization: Bearer ${client_id}.${new_secret}\""
unset new_secret
verified=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  status="$(curl --config <(printf '%s\n' "${auth_config}") --silent --show-error \
    --output /dev/null --write-out '%{http_code}' --max-time 15 --proto '=https' \
    --request POST --header 'Content-Type: application/json' --data '{}' \
    "${base_url}/v1/runs" || true)"
  if test "${status}" = "400"; then verified=1; break; fi
  sleep 1
done
unset auth_config

if test "${verified}" != "1"; then
  if test "${old_map}" != '{}'; then
    printf '%s' "${old_map}" | npx wrangler secret put INGEST_CLIENT_KEYS >/dev/null || true
  fi
  if test -f "${next_path}"; then mv -f -- "${next_path}" "${recovery_path}"; fi
  printf 'credential sync verification failed; recovery blob: %s\n' "${recovery_path}" >&2
  exit 1
fi

if test "${write_local}" = "1"; then
  mv -f -- "${next_path}" "${credential_path}"
fi
printf '{"synced":true,"clientId":"%s","credentialPath":"%s"}\n' \
  "${client_id}" "${credential_path}"
unset old_map key_map
