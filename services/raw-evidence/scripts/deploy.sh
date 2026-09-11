#!/usr/bin/env bash
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="59ea63cc00914b30ca410b062ae2bb7f"

mise run ingest:typecheck
mise run ingest:build
mise run ingest:test
mise run ingest:dry-run
sha256sum ../../packages/storage-d1/migrations/core/*.sql
./node_modules/.bin/wrangler d1 migrations list kogane-raw-evidence --remote
./node_modules/.bin/wrangler d1 migrations apply kogane-raw-evidence --remote
./node_modules/.bin/wrangler deploy
bash scripts/verify-production.sh
bash scripts/verify-sbi-shinsei-route.sh
bash scripts/verify-mobile-suica-route.sh
bash scripts/verify-global-pass-route.sh
bash scripts/verify-myjcb-route.sh
bash scripts/verify-moneyforward-route.sh
bash scripts/verify-v-point-route.sh
bash scripts/verify-vpass-route.sh
bash scripts/verify-v-point-pay-email-route.sh
bash scripts/verify-smbc-direct-route.sh
