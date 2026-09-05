#!/usr/bin/env bash
set -euo pipefail

if (( $# > 2 )); then
  echo "usage: $0 [MATCH_METADATA_FILE] [TOKEN_DIRECTORY]" >&2
  exit 2
fi

match_file=${1:-/home/risu/.local/state/kogane/moneyforward-bitwarden-match.json}
token_directory=${2:-/home/risu/.local/state/kogane}
admin_token_file="$token_directory/moneyforward-worker-admin-token"
worker_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

mkdir -p "$token_directory"
chmod 700 "$token_directory"
if [[ ! -s $admin_token_file ]]; then
  umask 077
  openssl rand -hex 32 > "$admin_token_file"
fi

cd "$worker_dir"
"$worker_dir/scripts/credential-from-bitwarden.sh" "$match_file" | \
  bunx wrangler secret put MONEYFORWARD_CREDENTIAL_JSON
tr -d '\r\n' < "$admin_token_file" | bunx wrangler secret put ADMIN_TRIGGER_TOKEN

echo "Worker secrets updated without printing secret values"
