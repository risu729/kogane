#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
result_path="/tmp/mnie-sbi-passkey-probe-result.json"
status_path="/tmp/mnie-sbi-passkey-probe-status"
stage_path="/tmp/mnie-sbi-passkey-probe-stage"
secret_dir="${XDG_DATA_HOME:-$HOME/.local/share}/kogane/secrets"
secret_path="$secret_dir/sbi-securities.json"
secret_tmp=""
rm -f "$result_path" "$status_path" "$stage_path"

write_stage() {
  printf '%s\n' "$1" >"$stage_path"
}

# shellcheck disable=SC2329 # Invoked indirectly by the EXIT trap below.
cleanup() {
  exit_status="$?"
  if [[ -n "$secret_tmp" ]]; then rm -f "$secret_tmp"; fi
  unset BW_SESSION
  bw lock >/dev/null 2>&1 || true
  if [[ ! -f "$status_path" ]]; then
    printf '%s\n' "$exit_status" >"$status_path"
  fi
  if [[ "$exit_status" -ne 0 && -t 0 ]]; then
    printf '\n処理が途中で失敗しました（終了コード: %s）。Enter で閉じます。\n' "$exit_status"
    read -r || true
  fi
}
trap cleanup EXIT
cd "$repo_dir"

if [[ ! -s "$secret_path" ]]; then
  write_stage unlock
  printf 'Bitwarden vault を unlock してください。SBI 用の最小情報だけをローカル保存します。\n'
  bw_session="$(bw unlock --raw)"
  export BW_SESSION="$bw_session"
  unset bw_session

  write_stage sync
  bw sync >/dev/null
  write_stage locate-items
  mapfile -t item_ids < <(
    {
      for target_url in \
        'https://www.sbisec.co.jp' \
        'https://site2.sbisec.co.jp' \
        'https://go.sbisec.co.jp' \
        'https://sbisec.co.jp'
      do
        bw list items --url "$target_url" | jq -r '.[].id'
      done

      bw list items --search 'SBI証券' | jq -r '.[]
        | select(any(.login.uris[]?; (.uri // "") | test("sbisec\\.co\\.jp"; "i")))
        | .id'
    } | sort -u
  )
  if ((${#item_ids[@]} == 0)); then
    printf 'SBI証券に一致する Bitwarden item が見つかりませんでした。\n' >&2
    exit 1
  fi

  write_stage extract-minimal-secret
  install -d -m 0700 "$secret_dir"
  secret_tmp="$(mktemp "$secret_path.tmp.XXXXXX")"
  for item_id in "${item_ids[@]}"; do
    bw get item "$item_id"
  done | jq -s '.' | bun scripts/prepare-sbi-bitwarden-cli-secret.ts >"$secret_tmp"
  chmod 0600 "$secret_tmp"
  mv -f "$secret_tmp" "$secret_path"
  secret_tmp=""
  unset item_id item_ids
  printf 'SBI 用 credential を %s に保存しました。\n' "$secret_path"
else
  printf '保存済みの SBI 用 credential を使います。\n'
fi

write_stage verify-passkey
set +e
bun scripts/verify-sbi-bitwarden-cli-passkey.ts <"$secret_path" | tee "$result_path"
probe_status="${PIPESTATUS[0]}"
set -e
printf '%s\n' "$probe_status" >"$status_path"
write_stage complete

if [[ "$probe_status" -eq 0 ]]; then
  printf '\n検証は成功しました。Enter で閉じます。\n'
else
  printf '\n検証は失敗しました（終了コード: %s）。Enter で閉じます。\n' "$probe_status"
fi
read -r
exit "$probe_status"
