#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
command -v bw >/dev/null || { echo "Bitwarden CLI is not available" >&2; exit 2; }

BW_SESSION=$(bw unlock --raw)
export BW_SESSION
metadata_file=/home/risu/.local/state/kogane/smbc-direct-bitwarden-item-id
mkdir -p "$(dirname "$metadata_file")"
umask 077
bw list items --session "$BW_SESSION" | bun scripts/select-bitwarden-item.ts > "$metadata_file"
./scripts/sync-local-secrets.sh "$metadata_file"
unset BW_SESSION
echo "SMBC Direct Worker secrets synchronized"
