#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
port="${MONEYFORWARD_LAYER_B_AUDIT_PORT:-8982}"
if ! [[ "${port}" =~ ^[0-9]{4,5}$ ]] || ((port < 1024 || port > 65535)); then
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
  npx wrangler dev --config wrangler.audit-moneyforward-layer-b.jsonc --ip 127.0.0.1 --port "${port}" >"${temp_dir}/wrangler.log" 2>&1
) &
audit_pid="$!"
ready=false
for _ in $(seq 1 45); do
  if curl --fail --silent "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then ready=true; break; fi
  if ! kill -0 "${audit_pid}" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "${ready}" != true ]]; then printf 'local read-only audit worker did not become ready\n' >&2; exit 1; fi

scanned=0 audited=0 skipped=0 failed=0 success=0 partial=0 failed_status=0 failure_evidence=0
artifacts=0 monthly=0 evidence=0 tooltip_rows=0 parsed=0 inflow=0 outflow=0 adjacent=0
failure_codes='{}'
cursor="" pages=0
while true; do
  pages=$((pages + 1))
  if ((pages > 100000)); then printf 'audit page bound exceeded\n' >&2; exit 1; fi
  request="$(jq -nc --arg cursor "${cursor}" 'if $cursor == "" then {} else {cursor:$cursor} end')"
  page="$(curl --fail --silent -H 'content-type: application/json' --data-binary "${request}" "http://127.0.0.1:${port}/audit-page")" || { printf 'audit page failed\n' >&2; exit 1; }
  jq -e 'type == "object" and .schemaVersion == "moneyforward-layer-b-aggregate-audit-v1" and
    (.scannedObjectCount == 0 or .scannedObjectCount == 1) and
    (.auditedManifestCount + .skippedObjectCount + .failedManifestCount == .scannedObjectCount) and
    ((.nextCursor == null) or (.nextCursor | type == "string" and length > 0 and length <= 4096)) and
    (.truncated == (.nextCursor != null))' <<<"${page}" >/dev/null || { printf 'invalid aggregate response\n' >&2; exit 1; }
  scanned=$((scanned + $(jq -r '.scannedObjectCount' <<<"${page}")))
  audited=$((audited + $(jq -r '.auditedManifestCount' <<<"${page}")))
  skipped=$((skipped + $(jq -r '.skippedObjectCount' <<<"${page}")))
  failed=$((failed + $(jq -r '.failedManifestCount' <<<"${page}")))
  if [[ "$(jq -r '.failedManifestCount' <<<"${page}")" == 1 ]]; then
    failure_code="$(jq -r '.failureCode' <<<"${page}")"
    failure_codes="$(jq -cn --argjson counts "${failure_codes}" --arg key "${failure_code}" '$counts + {($key): (($counts[$key] // 0) + 1)}')"
  fi
  if [[ "$(jq -r '.auditedManifestCount' <<<"${page}")" == 1 ]]; then
    status="$(jq -r '.manifestStatus' <<<"${page}")"
    case "${status}" in success) success=$((success + 1));; partial) partial=$((partial + 1));; failed) failed_status=$((failed_status + 1));; *) exit 1;; esac
    failure_evidence=$((failure_evidence + $(jq -r '.failureCount' <<<"${page}")))
    artifacts=$((artifacts + $(jq -r '.artifactCount' <<<"${page}")))
    monthly=$((monthly + $(jq -r '.monthlyArtifactCount' <<<"${page}")))
    evidence=$((evidence + $(jq -r '.evidenceArtifactCount' <<<"${page}")))
    tooltip_rows=$((tooltip_rows + $(jq -r '.tooltipBodyRowCount' <<<"${page}")))
    parsed=$((parsed + $(jq -r '.parsedObservationCount' <<<"${page}")))
    inflow=$((inflow + $(jq -r '.inflowObservationCount' <<<"${page}")))
    outflow=$((outflow + $(jq -r '.outflowObservationCount' <<<"${page}")))
    adjacent=$((adjacent + $(jq -r '.adjacentCalendarRowCount' <<<"${page}")))
  fi
  if [[ "${STOP_AFTER_FIRST_MANIFEST:-false}" == true ]] &&
     [[ "$(jq -r '.auditedManifestCount + .failedManifestCount' <<<"${page}")" == 1 ]]; then
    break
  fi
  next="$(jq -r '.nextCursor // ""' <<<"${page}")"
  if [[ -n "${next}" && "${next}" == "${cursor}" ]]; then printf 'audit cursor did not advance\n' >&2; exit 1; fi
  cursor="${next}"
  [[ -n "${cursor}" ]] || break
done

jq -nc --argjson scanned "${scanned}" --argjson audited "${audited}" --argjson skipped "${skipped}" --argjson failed "${failed}" \
  --argjson success "${success}" --argjson partial "${partial}" --argjson failedStatus "${failed_status}" --argjson failureEvidence "${failure_evidence}" \
  --argjson artifacts "${artifacts}" --argjson monthly "${monthly}" --argjson evidence "${evidence}" --argjson tooltipRows "${tooltip_rows}" \
  --argjson parsed "${parsed}" --argjson inflow "${inflow}" --argjson outflow "${outflow}" --argjson adjacent "${adjacent}" --argjson failureCodes "${failure_codes}" \
  '{schemaVersion:"moneyforward-layer-b-aggregate-audit-v1",source:"moneyforward-me",scannedObjectCount:$scanned,
    auditedManifestCount:$audited,skippedObjectCount:$skipped,failedManifestCount:$failed,
    manifestStatusCounts:{success:$success,partial:$partial,failed:$failedStatus},failureEvidenceCount:$failureEvidence,
    artifactCount:$artifacts,monthlyArtifactCount:$monthly,evidenceArtifactCount:$evidence,tooltipBodyRowCount:$tooltipRows,
    parsedObservationCount:$parsed,inflowObservationCount:$inflow,outflowObservationCount:$outflow,
    adjacentCalendarRowCount:$adjacent,failureCodeCounts:$failureCodes}'
((failed == 0))
