#!/usr/bin/env bash
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="59ea63cc00914b30ca410b062ae2bb7f"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
cd -- "${service_dir}"

mise run install
bun test
mise run importer:typecheck
mise run importer:dry-run
bash scripts/sync-secrets.sh
./node_modules/.bin/wrangler deploy
