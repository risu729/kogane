#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
port="${VPOINT_AUDIT_PORT:-8976}"
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
  npx wrangler dev --config wrangler.audit-v-point.jsonc \
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
v1=0
v2=0
success=0
partial=0
failed_status=0
with_reconciliation=0
without_reconciliation=0
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
    .schemaVersion == "vpoint-r2-aggregate-audit-v1" and
    (.scannedObjectCount == 0 or .scannedObjectCount == 1) and
    (.auditedManifestCount == 0 or .auditedManifestCount == 1) and
    (.skippedObjectCount == 0 or .skippedObjectCount == 1) and
    (.failedManifestCount == 0 or .failedManifestCount == 1) and
    (.auditedManifestCount + .skippedObjectCount + .failedManifestCount == .scannedObjectCount) and
    ((.nextCursor == null) or (.nextCursor | type == "string" and length > 0 and length <= 4096)) and
    (.truncated == (.nextCursor != null)) and
    ((.failedManifestCount == 1) == has("failureCode")) and
    ((.auditedManifestCount == 1) ==
      (has("manifestSchemaVersion") and has("manifestStatus") and
       has("artifactCount") and has("hasReconciliation"))) and
    ([keys[]] - ["schemaVersion","scannedObjectCount","auditedManifestCount",
      "skippedObjectCount","failedManifestCount","nextCursor","truncated",
      "failureCode","manifestSchemaVersion","manifestStatus","artifactCount",
      "hasReconciliation"] | length == 0)
  ' <<<"${page}" >/dev/null || {
    printf 'audit worker returned an invalid aggregate response\n' >&2
    exit 1
  }

  scanned=$((scanned + $(jq -r '.scannedObjectCount' <<<"${page}")))
  audited=$((audited + $(jq -r '.auditedManifestCount' <<<"${page}")))
  skipped=$((skipped + $(jq -r '.skippedObjectCount' <<<"${page}")))
  failed=$((failed + $(jq -r '.failedManifestCount' <<<"${page}")))
  if [[ "$(jq -r '.auditedManifestCount' <<<"${page}")" == 1 ]]; then
    case "$(jq -r '.manifestSchemaVersion' <<<"${page}")" in
      vpoint-worker-poc-v1) v1=$((v1 + 1)) ;;
      vpoint-worker-poc-v2) v2=$((v2 + 1)) ;;
      *) printf 'unknown manifest schema in aggregate response\n' >&2; exit 1 ;;
    esac
    case "$(jq -r '.manifestStatus' <<<"${page}")" in
      success) success=$((success + 1)) ;;
      partial) partial=$((partial + 1)) ;;
      failed) failed_status=$((failed_status + 1)) ;;
      *) printf 'unknown manifest status in aggregate response\n' >&2; exit 1 ;;
    esac
    if [[ "$(jq -r '.hasReconciliation' <<<"${page}")" == true ]]; then
      with_reconciliation=$((with_reconciliation + 1))
    else
      without_reconciliation=$((without_reconciliation + 1))
    fi
  fi

  cursor="$(jq -r '.nextCursor // ""' <<<"${page}")"
  [[ -n "${cursor}" ]] || break
done

jq -nc \
  --argjson scanned "${scanned}" \
  --argjson audited "${audited}" \
  --argjson skipped "${skipped}" \
  --argjson failed "${failed}" \
  --argjson v1 "${v1}" --argjson v2 "${v2}" \
  --argjson success "${success}" --argjson partial "${partial}" \
  --argjson failedStatus "${failed_status}" \
  --argjson withReconciliation "${with_reconciliation}" \
  --argjson withoutReconciliation "${without_reconciliation}" \
  '{schemaVersion:"vpoint-r2-aggregate-audit-v1",source:"v-point",
    scannedObjectCount:$scanned,auditedManifestCount:$audited,
    skippedObjectCount:$skipped,failedManifestCount:$failed,
    manifestSchemaCounts:{v1:$v1,v2:$v2},
    manifestStatusCounts:{success:$success,partial:$partial,failed:$failedStatus},
    reconciliationCounts:{present:$withReconciliation,absent:$withoutReconciliation}}'

(( failed == 0 ))
