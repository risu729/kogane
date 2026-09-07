#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
port="${SBI_SHINSEI_AUDIT_PORT:-8978}"
if ! [[ "${port}" =~ ^[0-9]{4,5}$ ]] || (( port < 1024 || port > 65535 )); then
  printf 'audit port is invalid\n' >&2
  exit 2
fi
temp_dir="$(mktemp -d)"
account_id="$(jq -er '.account_id | select(type == "string" and test("^[0-9a-f]{32}$"))' "${service_dir}/wrangler.jsonc")"
audit_pid=""
cleanup() {
  if [[ -n "${audit_pid}" ]]; then kill "${audit_pid}" 2>/dev/null || true; wait "${audit_pid}" 2>/dev/null || true; fi
  rm -f -- "${temp_dir}/wrangler.log"
  rmdir -- "${temp_dir}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
(
  cd -- "${service_dir}"
  CLOUDFLARE_ACCOUNT_ID="${account_id}" npx wrangler dev --config wrangler.audit-sbi-shinsei.jsonc --ip 127.0.0.1 --port "${port}" >"${temp_dir}/wrangler.log" 2>&1
) &
audit_pid="$!"
ready=false
for _ in $(seq 1 45); do
  if curl --fail --silent --show-error "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then ready=true; break; fi
  if ! kill -0 "${audit_pid}" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "${ready}" != true ]]; then printf 'local read-only audit worker did not become ready\n' >&2; exit 1; fi

scanned=0 audited=0 skipped=0 failed=0 success=0 partial=0 failed_status=0 verified_success=0
nonempty_top_accounts=false nonempty_top_activity=false nonempty_yen_accounts=false multiple_currencies=false unclassified_product=false
cursor="" pages=0
while true; do
  ((pages += 1))
  if (( pages > 100000 )); then printf 'audit page limit exceeded\n' >&2; exit 1; fi
  request_body="$(jq -nc --arg cursor "${cursor}" 'if $cursor == "" then {} else {cursor:$cursor} end')"
  page="$(curl --fail --silent --show-error -H 'content-type: application/json' --data-binary "${request_body}" "http://127.0.0.1:${port}/audit-page")" || { printf 'read-only audit page failed\n' >&2; exit 1; }
  jq -e '
    type == "object" and .schemaVersion == "sbi-shinsei-r2-layer-b-aggregate-audit-v1" and
    (.scannedObjectCount == 0 or .scannedObjectCount == 1) and (.auditedManifestCount == 0 or .auditedManifestCount == 1) and
    (.skippedObjectCount == 0 or .skippedObjectCount == 1) and (.failedManifestCount == 0 or .failedManifestCount == 1) and
    (.auditedManifestCount + .skippedObjectCount + .failedManifestCount == .scannedObjectCount) and
    ((.nextCursor == null) or (.nextCursor | type == "string" and length > 0 and length <= 4096)) and (.truncated == (.nextCursor != null)) and
    ((.failedManifestCount == 1) == has("failureCode")) and
    ((.auditedManifestCount == 1) == (has("manifestStatus") and has("artifactCount") and has("matchedArtifactCount") and
      has("parsedArtifactCount") and has("decisionCoveredArtifactCount") and has("hasNonEmptyTopAccounts") and
      has("hasNonEmptyTopActivity") and has("hasNonEmptyYenAccounts") and has("hasMultipleCurrencies") and has("hasUnclassifiedProduct")))
  ' <<<"${page}" >/dev/null || { printf 'audit worker returned an invalid aggregate response\n' >&2; exit 1; }
  scanned=$((scanned + $(jq -r '.scannedObjectCount' <<<"${page}")))
  audited=$((audited + $(jq -r '.auditedManifestCount' <<<"${page}")))
  skipped=$((skipped + $(jq -r '.skippedObjectCount' <<<"${page}")))
  failed=$((failed + $(jq -r '.failedManifestCount' <<<"${page}")))
  if [[ "$(jq -r '.auditedManifestCount' <<<"${page}")" == 1 ]]; then
    case "$(jq -r '.manifestStatus' <<<"${page}")" in
      success)
        success=$((success + 1))
        if [[ "$(jq -r '.artifactCount == .decisionCoveredArtifactCount and .matchedArtifactCount == 2 and .parsedArtifactCount == 2' <<<"${page}")" == true ]]; then verified_success=$((verified_success + 1)); fi
        ;;
      partial) partial=$((partial + 1)) ;;
      failed) failed_status=$((failed_status + 1)) ;;
      *) printf 'unknown manifest status\n' >&2; exit 1 ;;
    esac
    [[ "$(jq -r '.hasNonEmptyTopAccounts' <<<"${page}")" == true ]] && nonempty_top_accounts=true
    [[ "$(jq -r '.hasNonEmptyTopActivity' <<<"${page}")" == true ]] && nonempty_top_activity=true
    [[ "$(jq -r '.hasNonEmptyYenAccounts' <<<"${page}")" == true ]] && nonempty_yen_accounts=true
    [[ "$(jq -r '.hasMultipleCurrencies' <<<"${page}")" == true ]] && multiple_currencies=true
    [[ "$(jq -r '.hasUnclassifiedProduct' <<<"${page}")" == true ]] && unclassified_product=true
  fi
  cursor="$(jq -r '.nextCursor // ""' <<<"${page}")"
  [[ -n "${cursor}" ]] || break
done
jq -nc --argjson scanned "${scanned}" --argjson audited "${audited}" --argjson skipped "${skipped}" --argjson failed "${failed}" \
  --argjson success "${success}" --argjson partial "${partial}" --argjson failedStatus "${failed_status}" --argjson verifiedSuccess "${verified_success}" \
  --argjson topAccounts "${nonempty_top_accounts}" --argjson topActivity "${nonempty_top_activity}" --argjson yenAccounts "${nonempty_yen_accounts}" \
  --argjson multipleCurrencies "${multiple_currencies}" --argjson unclassifiedProduct "${unclassified_product}" \
  '{schemaVersion:"sbi-shinsei-r2-layer-b-aggregate-audit-v1",source:"sbi-shinsei",scannedObjectCount:$scanned,auditedManifestCount:$audited,
    skippedObjectCount:$skipped,failedManifestCount:$failed,manifestStatusCounts:{success:$success,partial:$partial,failed:$failedStatus},
    fullyDecisionCoveredSuccessManifestCount:$verifiedSuccess,observedShapeEvidence:{nonemptyTopAccounts:$topAccounts,nonemptyTopActivity:$topActivity,
    nonemptyYenAccounts:$yenAccounts,multipleCurrencies:$multipleCurrencies,unclassifiedProduct:$unclassifiedProduct}}'
(( failed == 0 && verified_success == success ))
