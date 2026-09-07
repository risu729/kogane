#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
port="${VPOINT_PAY_LAYER_B_AUDIT_PORT:-8979}"
if ! [[ "${port}" =~ ^[0-9]{4,5}$ ]] || (( port < 1024 || port > 65535 )); then
  printf 'audit port is invalid\n' >&2
  exit 2
fi
temp_dir="$(mktemp -d)"
audit_pid=""
cleanup() {
  if [[ -n "${audit_pid}" ]]; then kill "${audit_pid}" 2>/dev/null || true; wait "${audit_pid}" 2>/dev/null || true; fi
  rm -f -- "${temp_dir}/wrangler.log"
  rmdir -- "${temp_dir}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
(
  cd -- "${service_dir}"
  npx wrangler dev --config wrangler.audit-v-point-pay-layer-b.jsonc \
    --ip 127.0.0.1 --port "${port}" >"${temp_dir}/wrangler.log" 2>&1
) &
audit_pid="$!"
ready=false
for _ in $(seq 1 45); do
  if curl --fail --silent --show-error "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then ready=true; break; fi
  if ! kill -0 "${audit_pid}" 2>/dev/null; then break; fi
  sleep 1
done
[[ "${ready}" == true ]] || { printf 'local read-only audit worker did not become ready\n' >&2; exit 1; }

scanned=0; ignored_raw=0; audited=0; failed=0; transactions=0; balances=0; declined=0; cursor=""; pages=0; failure_code=""
while true; do
  ((pages += 1)); (( pages <= 100000 ))
  request="$(jq -nc --arg cursor "${cursor}" 'if $cursor == "" then {} else {cursor:$cursor} end')"
  page="$(curl --fail --silent --show-error -H 'content-type: application/json' --data-binary "${request}" "http://127.0.0.1:${port}/audit-page")"
  jq -e 'type == "object" and .schemaVersion == "v-point-pay-r2-layer-b-aggregate-audit-v1" and
    (.scannedObjectCount >= 0 and .scannedObjectCount <= 25) and
    (.ignoredRawObjectCount + .auditedNormalizedObjectCount + .failedNormalizedObjectCount == .scannedObjectCount) and
    (.transactionObservationCount == .auditedNormalizedObjectCount) and
    (.balanceObservationCount >= 0 and .balanceObservationCount <= .auditedNormalizedObjectCount) and
    (.declinedObservationCount >= 0 and .declinedObservationCount <= .transactionObservationCount) and
    ((.nextCursor == null) or (.nextCursor | type == "string" and length > 0 and length <= 4096)) and
    (.truncated == (.nextCursor != null)) and
    ([keys[]] - ["schemaVersion","scannedObjectCount","ignoredRawObjectCount","auditedNormalizedObjectCount","failedNormalizedObjectCount","transactionObservationCount","balanceObservationCount","declinedObservationCount","nextCursor","truncated","failureCode"] | length == 0)' <<<"${page}" >/dev/null
  scanned=$((scanned + $(jq -r '.scannedObjectCount' <<<"${page}")))
  ignored_raw=$((ignored_raw + $(jq -r '.ignoredRawObjectCount' <<<"${page}")))
  audited=$((audited + $(jq -r '.auditedNormalizedObjectCount' <<<"${page}")))
  failed=$((failed + $(jq -r '.failedNormalizedObjectCount' <<<"${page}")))
  transactions=$((transactions + $(jq -r '.transactionObservationCount' <<<"${page}")))
  balances=$((balances + $(jq -r '.balanceObservationCount' <<<"${page}")))
  declined=$((declined + $(jq -r '.declinedObservationCount' <<<"${page}")))
  page_failure_code="$(jq -r '.failureCode // ""' <<<"${page}")"
  if [[ -z "${failure_code}" && -n "${page_failure_code}" ]]; then failure_code="${page_failure_code}"; fi
  cursor="$(jq -r '.nextCursor // ""' <<<"${page}")"
  [[ -n "${cursor}" ]] || break
done
jq -nc --argjson scanned "${scanned}" --argjson ignoredRaw "${ignored_raw}" --argjson audited "${audited}" \
  --argjson failed "${failed}" --argjson transactions "${transactions}" --argjson balances "${balances}" --argjson declined "${declined}" --arg failure "${failure_code}" \
  '{schemaVersion:"v-point-pay-r2-layer-b-aggregate-audit-v1",source:"v-point-pay",
    scannedObjectCount:$scanned,ignoredRawObjectCount:$ignoredRaw,auditedNormalizedObjectCount:$audited,
    failedNormalizedObjectCount:$failed,transactionObservationCount:$transactions,
    balanceObservationCount:$balances,declinedObservationCount:$declined,complete:($failed == 0 and $ignoredRaw == $audited)} +
    (if $failure == "" then {} else {failureCode:$failure} end)'
(( failed == 0 && ignored_raw == audited ))
