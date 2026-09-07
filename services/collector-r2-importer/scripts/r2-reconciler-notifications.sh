#!/usr/bin/env bash
set -euo pipefail

queue_name="kogane-r2-outbox-reconciler"
mode="${1:-plan}"
confirmation="${2:-}"

rules=(
  "kogane-sbi-collector-poc|raw/sbi-securities/|manifest.json|sbi-securities-manifest"
  "kogane-sbi-vc-trade-poc|raw/sbi-vc-trade/|manifest.json|sbi-vc-trade-manifest"
  "kogane-sony-bank-collector-poc|raw/sony-bank/|manifest.json|sony-bank-manifest"
  "kogane-sbi-shinsei-collector-poc|raw/sbi-shinsei/|manifest.json|sbi-shinsei-manifest"
  "kogane-mobile-suica-collector-poc|raw/mobile-suica/|manifest.json|mobile-suica-manifest"
  "kogane-globalpass-collector-poc|raw/prestia-globalpass/|manifest.json|global-pass-manifest"
  "kogane-myjcb-collector-poc|raw/myjcb/|manifest.json|myjcb-manifest"
  "kogane-moneyforward-collector-poc|raw/moneyforward/|manifest.json|moneyforward-manifest"
  "kogane-vpoint-collector-poc|raw/v-point/|manifest.json|v-point-manifest"
  "kogane-vpoint-pay-collector-poc|raw/v-point-pay-email/|.json|v-point-pay-normalized"
  "kogane-vpass-collector-poc|vpass/|manifest.json|vpass-manifest"
  "kogane-vpass-collector-poc|vpass/|error.json|vpass-error"
  "kogane-smbc-direct-backfill-poc|raw/smbc-direct/|manifest.json|smbc-direct-manifest"
)

case "$mode" in
  plan)
    printf 'queue=%s rules=%s mode=read-only-plan\n' "$queue_name" "${#rules[@]}"
    for rule in "${rules[@]}"; do
      IFS='|' read -r bucket prefix suffix description <<<"$rule"
      printf 'bucket=%s prefix=%s suffix=%s description=%s\n' \
        "$bucket" "$prefix" "$suffix" "kogane-r2-reconciler-v1:${description}"
    done
    ;;
  apply)
    if [[ "$confirmation" != "I_UNDERSTAND_THIS_CHANGES_CLOUDFLARE" ]]; then
      printf '%s\n' 'refusing: pass I_UNDERSTAND_THIS_CHANGES_CLOUDFLARE as the second argument' >&2
      exit 2
    fi
    for rule in "${rules[@]}"; do
      IFS='|' read -r bucket prefix suffix description <<<"$rule"
      npx wrangler r2 bucket notification create "$bucket" \
        --event-type object-create \
        --queue "$queue_name" \
        --prefix "$prefix" \
        --suffix "$suffix" \
        --description "kogane-r2-reconciler-v1:${description}"
    done
    printf 'queue=%s rules-created=%s\n' "$queue_name" "${#rules[@]}"
    ;;
  remove)
    if [[ "$confirmation" != "I_UNDERSTAND_THIS_CHANGES_CLOUDFLARE" ]]; then
      printf '%s\n' 'refusing: pass I_UNDERSTAND_THIS_CHANGES_CLOUDFLARE as the second argument' >&2
      exit 2
    fi
    mapfile -t buckets < <(printf '%s\n' "${rules[@]}" | cut -d'|' -f1 | sort -u)
    for bucket in "${buckets[@]}"; do
      npx wrangler r2 bucket notification delete "$bucket" --queue "$queue_name"
    done
    printf 'queue=%s bucket-rules-removed=%s\n' "$queue_name" "${#buckets[@]}"
    ;;
  *)
    printf 'usage: %s plan|apply|remove [I_UNDERSTAND_THIS_CHANGES_CLOUDFLARE]\n' "$0" >&2
    exit 2
    ;;
esac
