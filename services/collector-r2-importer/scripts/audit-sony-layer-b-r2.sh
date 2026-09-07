#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
port="${SONY_LAYER_B_AUDIT_PORT:-8978}"
if ! [[ "${port}" =~ ^[0-9]{4,5}$ ]] || (( port < 1024 || port > 65535 )); then
  printf 'audit port is invalid\n' >&2
  exit 2
fi

temp_dir="$(mktemp -d)"
audit_pid=""
cleanup() {
  if [[ -n "${audit_pid}" ]]; then
    kill "${audit_pid}" 2>/dev/null || true
    wait "${audit_pid}" 2>/dev/null || true
  fi
  rm -f -- "${temp_dir}/wrangler.log"
  rmdir -- "${temp_dir}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(
  cd -- "${service_dir}"
  npx wrangler dev --config wrangler.audit-sony-layer-b.jsonc \
    --ip 127.0.0.1 --port "${port}" >"${temp_dir}/wrangler.log" 2>&1
) &
audit_pid="$!"

ready=false
for _ in $(seq 1 45); do
  if curl --fail --silent --show-error "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "${audit_pid}" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "${ready}" != true ]]; then
  printf 'local read-only audit worker did not become ready\n' >&2
  exit 1
fi

scanned=0
audited=0
skipped=0
failed=0
success=0
partial=0
failed_status=0
verified_success=0
warnings=0
json_csv_overlap=false
eight_digit_wallet_option=false
default_wallet_selection=false
ambiguous_wallet_direction=false
cursor=""
pages=0

while true; do
  ((pages += 1))
  if (( pages > 100000 )); then
    printf 'audit page limit exceeded\n' >&2
    exit 1
  fi
  request_body="$(jq -nc --arg cursor "${cursor}" \
    'if $cursor == "" then {} else {cursor:$cursor} end')"
  page="$(curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    --data-binary "${request_body}" \
    "http://127.0.0.1:${port}/audit-page")" || {
      printf 'read-only audit page failed\n' >&2
      exit 1
    }
  jq -e '
    type == "object" and
    .schemaVersion == "sony-bank-r2-layer-b-aggregate-audit-v1" and
    (.scannedObjectCount == 0 or .scannedObjectCount == 1) and
    (.auditedManifestCount == 0 or .auditedManifestCount == 1) and
    (.skippedObjectCount == 0 or .skippedObjectCount == 1) and
    (.failedManifestCount == 0 or .failedManifestCount == 1) and
    (.auditedManifestCount + .skippedObjectCount + .failedManifestCount == .scannedObjectCount) and
    ((.nextCursor == null) or (.nextCursor | type == "string" and length > 0 and length <= 4096)) and
    (.truncated == (.nextCursor != null)) and
    ((.failedManifestCount == 1) == has("failureCode")) and
    ((.auditedManifestCount == 1) ==
      (has("manifestStatus") and has("artifactCount") and
       has("expectedParserArtifactCount") and has("matchedArtifactCount") and
       has("parsedArtifactCount") and has("warningCount") and
       has("hasJsonCsvOverlap") and has("hasEightDigitWalletOption") and
       has("hasDefaultWalletSelection") and has("hasAmbiguousWalletDirection")))
  ' <<<"${page}" >/dev/null || {
    printf 'audit worker returned an invalid aggregate response\n' >&2
    exit 1
  }

  scanned=$((scanned + $(jq -r '.scannedObjectCount' <<<"${page}")))
  audited=$((audited + $(jq -r '.auditedManifestCount' <<<"${page}")))
  skipped=$((skipped + $(jq -r '.skippedObjectCount' <<<"${page}")))
  failed=$((failed + $(jq -r '.failedManifestCount' <<<"${page}")))
  if [[ "$(jq -r '.auditedManifestCount' <<<"${page}")" == 1 ]]; then
    case "$(jq -r '.manifestStatus' <<<"${page}")" in
      success)
        success=$((success + 1))
        if [[ "$(jq -r '.expectedParserArtifactCount == .matchedArtifactCount and .expectedParserArtifactCount == .parsedArtifactCount' <<<"${page}")" == true ]]; then
          verified_success=$((verified_success + 1))
        fi
        ;;
      partial) partial=$((partial + 1)) ;;
      failed) failed_status=$((failed_status + 1)) ;;
      *) printf 'unknown manifest status\n' >&2; exit 1 ;;
    esac
    warnings=$((warnings + $(jq -r '.warningCount' <<<"${page}")))
    if [[ "$(jq -r '.hasJsonCsvOverlap' <<<"${page}")" == true ]]; then json_csv_overlap=true; fi
    if [[ "$(jq -r '.hasEightDigitWalletOption' <<<"${page}")" == true ]]; then eight_digit_wallet_option=true; fi
    if [[ "$(jq -r '.hasDefaultWalletSelection' <<<"${page}")" == true ]]; then default_wallet_selection=true; fi
    if [[ "$(jq -r '.hasAmbiguousWalletDirection' <<<"${page}")" == true ]]; then ambiguous_wallet_direction=true; fi
  fi
  cursor="$(jq -r '.nextCursor // ""' <<<"${page}")"
  [[ -n "${cursor}" ]] || break
done

jq -nc \
  --argjson scanned "${scanned}" --argjson audited "${audited}" \
  --argjson skipped "${skipped}" --argjson failed "${failed}" \
  --argjson success "${success}" --argjson partial "${partial}" \
  --argjson failedStatus "${failed_status}" --argjson verifiedSuccess "${verified_success}" \
  --argjson warnings "${warnings}" --argjson jsonCsvOverlap "${json_csv_overlap}" \
  --argjson eightDigitWalletOption "${eight_digit_wallet_option}" \
  --argjson defaultWalletSelection "${default_wallet_selection}" \
  --argjson ambiguousWalletDirection "${ambiguous_wallet_direction}" \
  '{schemaVersion:"sony-bank-r2-layer-b-aggregate-audit-v1",source:"sony-bank",
    scannedObjectCount:$scanned,auditedManifestCount:$audited,
    skippedObjectCount:$skipped,failedManifestCount:$failed,
    manifestStatusCounts:{success:$success,partial:$partial,failed:$failedStatus},
    fullyParsedSuccessManifestCount:$verifiedSuccess,warningCount:$warnings,
    observedShapeEvidence:{jsonCsvOverlap:$jsonCsvOverlap,
      eightDigitWalletOption:$eightDigitWalletOption,
      defaultWalletSelection:$defaultWalletSelection,
      ambiguousWalletDirection:$ambiguousWalletDirection}}'

(( failed == 0 && verified_success == success ))
