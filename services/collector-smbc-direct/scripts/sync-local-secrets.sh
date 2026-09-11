#!/usr/bin/env bash
set -euo pipefail

metadata_file=${1:-/home/risu/.local/state/kogane/smbc-direct-bitwarden-item-id}
encryption_key_file=${2:-/home/risu/.local/state/kogane/smbc-direct-session-encryption-key}
admin_token_file=${3:-/home/risu/.local/share/kogane/secrets/smbc-direct-worker-admin-token}

command -v bw >/dev/null || { echo "Bitwarden CLI is not available" >&2; exit 2; }
[[ -n ${BW_SESSION:-} ]] || { echo "BW_SESSION is required" >&2; exit 2; }
[[ -s $metadata_file ]] || { echo "Bitwarden item-id metadata is required" >&2; exit 2; }

item_id=$(tr -d '\r\n' < "$metadata_file")
[[ $item_id =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "Bitwarden item-id metadata is invalid" >&2; exit 2; }

bw get item "$item_id" --session "$BW_SESSION" \
  | bun scripts/credential-from-bitwarden.ts \
  | bunx wrangler secret put SMBC_CREDENTIAL_JSON

if [[ ! -s $encryption_key_file ]]; then
  mkdir -p "$(dirname "$encryption_key_file")"
  umask 077
  openssl rand -base64 32 > "$encryption_key_file"
fi
tr -d '\r\n' < "$encryption_key_file" | bunx wrangler secret put SESSION_ENCRYPTION_KEY

if [[ -e $admin_token_file || -L $admin_token_file ]]; then
  if [[ ! -f $admin_token_file || -L $admin_token_file ]]; then
    echo "admin token path must be a regular non-symlink file" >&2
    exit 2
  fi
  if [[ $(stat -c %u -- "$admin_token_file") != $(id -u) ]]; then
    echo "admin token file must be owned by the current user" >&2
    exit 2
  fi
  chmod 600 "$admin_token_file"
else
  mkdir -p "$(dirname "$admin_token_file")"
  umask 077
  set -o noclobber
  openssl rand -base64 48 | tr -d '\n' > "$admin_token_file"
  set +o noclobber
fi
[[ -s $admin_token_file ]] || { echo "admin token file is empty" >&2; exit 2; }
tr -d '\r\n' < "$admin_token_file" | bunx wrangler secret put ADMIN_TRIGGER_TOKEN
