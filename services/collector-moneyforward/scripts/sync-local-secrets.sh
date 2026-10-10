#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
  echo "usage: $0 [MATCH_METADATA_FILE]" >&2
  exit 2
fi

match_file=${1:-/home/risu/.local/state/kogane/moneyforward-bitwarden-match.json}
worker_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)


cd "$worker_dir"
"$worker_dir/scripts/credential-from-bitwarden.sh" "$match_file" | \
  bunx wrangler secret put MONEYFORWARD_CREDENTIAL_JSON

echo "Worker secrets updated without printing secret values"
