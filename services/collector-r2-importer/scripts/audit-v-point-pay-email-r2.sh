#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
port="${VPOINT_PAY_EMAIL_AUDIT_PORT:-8977}"
temp_dir="$(mktemp -d)"
audit_pid=""
audit_stage="startup"
scanned=0; raw=0; normalized=0; failed=0; native_present=0; native_missing=0
usage=0; charge=0; addition=0; declined=0; cursor=""; pages=0
cleanup() {
  if [[ -n "${audit_pid}" ]]; then kill "${audit_pid}" 2>/dev/null || true; wait "${audit_pid}" 2>/dev/null || true; fi
  rm -f -- "${temp_dir}/wrangler.log"
  rmdir -- "${temp_dir}" 2>/dev/null || true
}
audit_error() {
  status="$?"
  trap - ERR
  jq -nc --arg stage "${audit_stage}" --argjson scanned "${scanned}" --argjson raw "${raw}" \
    --argjson normalized "${normalized}" --argjson failed "${failed}" \
    '{schemaVersion:"vpoint-pay-email-r2-aggregate-audit-v1",source:"v-point-pay-email",
      scannedObjectCount:$scanned,rawObjectCount:$raw,normalizedObjectCount:$normalized,
      failedObjectCount:$failed,complete:false,failureCode:("audit_" + $stage + "_failed")}'
  exit "${status}"
}
trap cleanup EXIT INT TERM
trap audit_error ERR
start_audit_worker() {
  (
    cd -- "${service_dir}"
    npx wrangler dev --config wrangler.audit-v-point-pay-email.jsonc \
      --ip 127.0.0.1 --port "${port}" >"${temp_dir}/wrangler.log" 2>&1
  ) &
  audit_pid="$!"
  for _ in $(seq 1 45); do
    if curl --fail --silent --retry 2 --retry-all-errors \
        "http://127.0.0.1:${port}/health" >/dev/null; then return; fi
    sleep 1
  done
  return 1
}
start_audit_worker

failure_code=""
while true; do
  ((pages += 1)); (( pages <= 100000 ))
  request="$(jq -nc --arg cursor "${cursor}" 'if $cursor == "" then {} else {cursor:$cursor} end')"
  audit_stage="page_request"
  page="$(curl --fail --silent --retry 4 --retry-all-errors \
    -H 'content-type: application/json' --data-binary "${request}" \
    "http://127.0.0.1:${port}/audit-page")"
  audit_stage="page_contract"
  jq -e 'type == "object" and .schemaVersion == "vpoint-pay-email-r2-aggregate-audit-v1" and
    (.scannedObjectCount >= 0 and .scannedObjectCount <= 25) and
    (.rawObjectCount + .normalizedObjectCount + .failedObjectCount == .scannedObjectCount) and
    (.nativeChecksumPresentObjectCount >= 0 and .nativeChecksumMissingObjectCount >= 0) and
    (.nativeChecksumPresentObjectCount + .nativeChecksumMissingObjectCount == .scannedObjectCount) and
    ((.nextCursor == null) or (.nextCursor | type == "string" and length > 0 and length <= 4096)) and
    (.truncated == (.nextCursor != null)) and
    (.eventTypeCounts | type == "object" and ([keys[]] - ["usage","charge","balanceAddition","declined"] | length == 0)) and
    ([keys[]] - ["schemaVersion","scannedObjectCount","rawObjectCount","normalizedObjectCount","failedObjectCount","nativeChecksumPresentObjectCount","nativeChecksumMissingObjectCount","nextCursor","truncated","failureCode","eventTypeCounts"] | length == 0)' <<<"${page}" >/dev/null
  scanned=$((scanned + $(jq -r '.scannedObjectCount' <<<"${page}")))
  raw=$((raw + $(jq -r '.rawObjectCount' <<<"${page}")))
  normalized=$((normalized + $(jq -r '.normalizedObjectCount' <<<"${page}")))
  failed=$((failed + $(jq -r '.failedObjectCount' <<<"${page}")))
  native_present=$((native_present + $(jq -r '.nativeChecksumPresentObjectCount' <<<"${page}")))
  native_missing=$((native_missing + $(jq -r '.nativeChecksumMissingObjectCount' <<<"${page}")))
  usage=$((usage + $(jq -r '.eventTypeCounts.usage' <<<"${page}")))
  charge=$((charge + $(jq -r '.eventTypeCounts.charge' <<<"${page}")))
  addition=$((addition + $(jq -r '.eventTypeCounts.balanceAddition' <<<"${page}")))
  declined=$((declined + $(jq -r '.eventTypeCounts.declined' <<<"${page}")))
  page_failure_code="$(jq -r '.failureCode // ""' <<<"${page}")"
  if [[ -z "${failure_code}" && -n "${page_failure_code}" ]]; then failure_code="${page_failure_code}"; fi
  cursor="$(jq -r '.nextCursor // ""' <<<"${page}")"
  [[ -n "${cursor}" ]] || break
done
audit_stage="finalize"
jq -nc --argjson scanned "${scanned}" --argjson raw "${raw}" --argjson normalized "${normalized}" \
  --argjson failed "${failed}" --argjson usage "${usage}" --argjson charge "${charge}" \
  --argjson addition "${addition}" --argjson declined "${declined}" --arg failure "${failure_code}" \
  --argjson native_present "${native_present}" --argjson native_missing "${native_missing}" \
  '{schemaVersion:"vpoint-pay-email-r2-aggregate-audit-v1",source:"v-point-pay-email",
    scannedObjectCount:$scanned,rawObjectCount:$raw,normalizedObjectCount:$normalized,
    failedObjectCount:$failed,nativeChecksumPresentObjectCount:$native_present,
    nativeChecksumMissingObjectCount:$native_missing,
    eventTypeCounts:{usage:$usage,charge:$charge,balanceAddition:$addition,declined:$declined},
    complete:($failed == 0 and $raw == $normalized)} +
    (if $failure == "" then {} else {failureCode:$failure} end)'
trap - ERR
(( failed == 0 && raw == normalized ))
