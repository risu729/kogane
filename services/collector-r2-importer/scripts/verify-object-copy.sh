#!/usr/bin/env bash
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="59ea63cc00914b30ca410b062ae2bb7f"

if (( $# != 3 )); then
  echo "usage: $0 SOURCE_OBJECT_KEY CENTRAL_BLOB_KEY EXPECTED_SHA256" >&2
  exit 2
fi
source_key=$1
central_key=$2
expected_sha256=$3
if [[ ! $source_key =~ ^raw/sbi-securities/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f-]{36}/[a-z0-9-]+\.json$ ||
      ! $central_key =~ ^objects/[0-9a-f]{2}/[0-9a-f]{64}$ ||
      ! $expected_sha256 =~ ^[0-9a-f]{64}$ ]]; then
  echo "invalid object key or digest" >&2
  exit 2
fi

verify_dir=$(mktemp -d /tmp/kogane-sbi-verify.XXXXXX)
case "$verify_dir" in
  /tmp/kogane-sbi-verify.*) ;;
  *) echo "unexpected temporary directory" >&2; exit 1 ;;
esac
trap 'rm -rf -- "$verify_dir"' EXIT
npx wrangler r2 object get "kogane-sbi-collector-poc/${source_key}" \
  --remote --file "$verify_dir/source.bin" >/dev/null
npx wrangler r2 object get "kogane-raw-evidence/${central_key}" \
  --remote --file "$verify_dir/central.bin" >/dev/null
cmp --silent "$verify_dir/source.bin" "$verify_dir/central.bin"
actual_sha256=$(sha256sum "$verify_dir/source.bin" | cut -d' ' -f1)
if [[ $actual_sha256 != "$expected_sha256" ]]; then
  echo "source digest mismatch" >&2
  exit 1
fi
bytes=$(stat -c %s "$verify_dir/source.bin")
printf '{"exactBytes":true,"sha256":"%s","bytes":%s}\n' "$actual_sha256" "$bytes"
