#!/usr/bin/env bash
set -euo pipefail

if (( $# < 1 || $# > 2 )); then
  echo "usage: $0 CREDENTIAL_JSON [TOKEN_DIRECTORY]" >&2
  exit 2
fi

credential_file=$1
token_directory=${2:-"${credential_file%/*}"}
admin_token_file="$token_directory/globalpass-worker-admin-token"
relay_token_file="$token_directory/globalpass-worker-relay-token"
worker_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if [[ ! -f $credential_file ]]; then
  echo "credential file does not exist" >&2
  exit 2
fi
if [[ $(jq -r '
  (.username | type == "string" and length > 0) and
  (.password | type == "string" and length > 0)
' "$credential_file") != true ]]; then
  echo "credential JSON must contain username and password" >&2
  exit 2
fi

mkdir -p "$token_directory"
chmod 700 "$token_directory"
for token_file in "$admin_token_file" "$relay_token_file"; do
  if [[ ! -s $token_file ]]; then
    umask 077
    openssl rand -hex 32 > "$token_file"
  fi
done

cd "$worker_dir"
jq -jr '.username' "$credential_file" | bunx wrangler secret put GLOBALPASS_ID
jq -jr '.password' "$credential_file" | bunx wrangler secret put GLOBALPASS_PASSWORD
tr -d '\r\n' < "$admin_token_file" | bunx wrangler secret put ADMIN_TRIGGER_TOKEN
tr -d '\r\n' < "$relay_token_file" | bunx wrangler secret put RELAY_TOKEN

echo "Worker secrets updated without printing secret values"
