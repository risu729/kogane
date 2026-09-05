#!/usr/bin/env bash
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="59ea63cc00914b30ca410b062ae2bb7f"

bun run typecheck
bun run check:importer
bun run test
bun run cf:check
sha256sum migrations/*.sql
npx wrangler d1 migrations list kogane-raw-evidence --remote
npx wrangler d1 migrations apply kogane-raw-evidence --remote
npx wrangler deploy
bash scripts/verify-production.sh
bash scripts/verify-sbi-shinsei-route.sh
bash scripts/verify-mobile-suica-route.sh
bash scripts/verify-global-pass-route.sh
bash scripts/verify-myjcb-route.sh
bash scripts/verify-v-point-route.sh
bash scripts/verify-smbc-direct-route.sh
