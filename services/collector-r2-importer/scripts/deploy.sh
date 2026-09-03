#!/usr/bin/env bash
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="59ea63cc00914b30ca410b062ae2bb7f"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
cd -- "${service_dir}"

bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
npx wrangler deploy
bash scripts/sync-secrets.sh
