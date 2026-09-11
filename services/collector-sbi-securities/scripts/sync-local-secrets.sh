#!/usr/bin/env bash
set -euo pipefail

if (( $# < 1 || $# > 2 )); then
  echo "usage: $0 BITWARDEN_ITEM_JSON [ADMIN_TOKEN_FILE]" >&2
  exit 2
fi

credential_file=$1
admin_token_file=${2:-"${credential_file%/*}/sbi-worker-admin-token"}
handshake_key_file="${credential_file%/*}/sbi-worker-handshake-key.json"
worker_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if [[ ! -f $credential_file ]]; then
  echo "credential file does not exist" >&2
  exit 2
fi

credential_count=$(jq -r '.login.fido2Credentials | length' "$credential_file")
if [[ $credential_count != 1 ]]; then
  echo "expected exactly one SBI passkey credential" >&2
  exit 2
fi

if [[ ! -s $admin_token_file ]]; then
  umask 077
  openssl rand -hex 32 > "$admin_token_file"
fi
if [[ ! -s $handshake_key_file ]]; then
  umask 077
  bun "$worker_dir/scripts/generate-handshake-key.ts" > "$handshake_key_file"
fi

cd "$worker_dir"

jq -ce '{
  rpId: .login.fido2Credentials[0].rpId,
  origin: "https://login.sbisec.co.jp",
  credentialId: .login.fido2Credentials[0].credentialId,
  keyValue: .login.fido2Credentials[0].keyValue,
  userHandle: .login.fido2Credentials[0].userHandle,
  counter: (.login.fido2Credentials[0].counter | tonumber)
}' "$credential_file" | bunx wrangler secret put SBI_CREDENTIAL_JSON

jq -ce '{publicKeyParam, privateKeyPem}' "$handshake_key_file" | \
  bunx wrangler secret put SBI_HANDSHAKE_KEY_JSON

tr -d '\r\n' < "$admin_token_file" | bunx wrangler secret put ADMIN_TRIGGER_TOKEN

echo "Worker secrets updated without printing secret values"
