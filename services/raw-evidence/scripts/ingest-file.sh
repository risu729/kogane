#!/usr/bin/env bash
set -euo pipefail

user_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
config_dir="${KOGANE_CONFIG_DIR:-${user_home}/.config/kogane}"
credential_path="${config_dir}/ingest-client-keys.cred"
fingerprint_path="${config_dir}/origin-fingerprint.cred"
exec 3< <(sudo systemd-creds decrypt "${credential_path}" - | jq -er '."local-backfill"' | sed 's/^/local-backfill./')
exec 4< <(sudo systemd-creds decrypt "${fingerprint_path}" -)
bun run scripts/ingest-file.ts "$@"
exec 3<&-
exec 4<&-
