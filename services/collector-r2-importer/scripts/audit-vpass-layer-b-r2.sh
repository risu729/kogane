#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
port="${VPASS_LAYER_B_AUDIT_PORT:-8985}"
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
  npx wrangler dev --config wrangler.audit-vpass-layer-b.jsonc \
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

summary='{"scanned":0,"audited":0,"skipped":0,"failed":0,"statuses":{},"schemas":{},"artifacts":0,"statementArtifacts":0,"rows":0,"webRows":0,"customizedRows":0,"parsedStatementArtifacts":0,"parsedTransactions":0,"parserWarnings":0,"blockedStatementArtifacts":0,"webShapes":{},"customizedShapes":{},"webPresentationShapes":{},"customizedPageShapes":{},"webRowKeyShapes":{},"customizedRowKeyShapes":{},"webBeanKeyShapes":{},"customizedBeanKeyShapes":{},"rootKeyShapes":{},"headerKeyShapes":{},"bodyKeyShapes":{},"contentKeyShapes":{},"failures":{}}'
cursor=""
pages=0
while true; do
  ((pages += 1))
  if (( pages > 100000 )); then
    printf 'audit page limit exceeded\n' >&2
    exit 1
  fi
  request_body="$(jq -nc --arg cursor "${cursor}" 'if $cursor == "" then {} else {cursor:$cursor} end')"
  page="$(curl --fail --silent --show-error -H 'content-type: application/json' \
    --data-binary "${request_body}" "http://127.0.0.1:${port}/audit-page")" || {
      printf 'read-only audit page failed\n' >&2
      exit 1
    }
  jq -e '
    type == "object" and .schemaVersion == "vpass-r2-layer-b-structural-audit-v1" and
    (.auditedRecordCount + .skippedObjectCount + .failedRecordCount == .scannedObjectCount) and
    ((.nextCursor == null) or (.nextCursor | type == "string" and length > 0 and length <= 4096)) and
    (.truncated == (.nextCursor != null)) and
    ([.recordStatusCounts,.recordSchemaCounts,.observedWebShapes,
      .observedCustomizedShapes,.observedWebRowKeyShapes,.observedCustomizedRowKeyShapes,
      .observedWebPresentationShapes,.observedCustomizedPageShapes,
      .observedWebBeanKeyShapes,.observedCustomizedBeanKeyShapes,
      .observedRootKeyShapes,.observedHeaderKeyShapes,.observedBodyKeyShapes,
      .observedContentKeyShapes,
      .failureCodeCounts] | all(type == "object"))
  ' <<<"${page}" >/dev/null || {
    printf 'audit worker returned an invalid aggregate response\n' >&2
    exit 1
  }
  summary="$(jq -nc --argjson s "${summary}" --argjson p "${page}" '
    def addmap(a;b): reduce (b|to_entries[]) as $e (a; .[$e.key] = (.[$e.key] // 0) + $e.value);
    $s
    | .scanned += $p.scannedObjectCount
    | .audited += $p.auditedRecordCount
    | .skipped += $p.skippedObjectCount
    | .failed += $p.failedRecordCount
    | .statuses = addmap(.statuses; $p.recordStatusCounts)
    | .schemas = addmap(.schemas; $p.recordSchemaCounts)
    | .artifacts += $p.artifactCount
    | .statementArtifacts += $p.statementArtifactCount
    | .rows += $p.statementRowCount
    | .webRows += $p.webRowCount
    | .customizedRows += $p.customizedRowCount
    | .parsedStatementArtifacts += $p.parsedStatementArtifactCount
    | .parsedTransactions += $p.parsedTransactionCount
    | .parserWarnings += $p.parserWarningCount
    | .blockedStatementArtifacts += $p.blockedStatementArtifactCount
    | .webShapes = addmap(.webShapes; $p.observedWebShapes)
    | .customizedShapes = addmap(.customizedShapes; $p.observedCustomizedShapes)
    | .webPresentationShapes = addmap(.webPresentationShapes; $p.observedWebPresentationShapes)
    | .customizedPageShapes = addmap(.customizedPageShapes; $p.observedCustomizedPageShapes)
    | .webRowKeyShapes = addmap(.webRowKeyShapes; $p.observedWebRowKeyShapes)
    | .customizedRowKeyShapes = addmap(.customizedRowKeyShapes; $p.observedCustomizedRowKeyShapes)
    | .webBeanKeyShapes = addmap(.webBeanKeyShapes; $p.observedWebBeanKeyShapes)
    | .customizedBeanKeyShapes = addmap(.customizedBeanKeyShapes; $p.observedCustomizedBeanKeyShapes)
    | .rootKeyShapes = addmap(.rootKeyShapes; $p.observedRootKeyShapes)
    | .headerKeyShapes = addmap(.headerKeyShapes; $p.observedHeaderKeyShapes)
    | .bodyKeyShapes = addmap(.bodyKeyShapes; $p.observedBodyKeyShapes)
    | .contentKeyShapes = addmap(.contentKeyShapes; $p.observedContentKeyShapes)
    | .failures = addmap(.failures; $p.failureCodeCounts)
  ')"
  cursor="$(jq -r '.nextCursor // ""' <<<"${page}")"
  [[ -n "${cursor}" ]] || break
done

jq -nc --argjson s "${summary}" '{schemaVersion:"vpass-r2-layer-b-structural-audit-v1",source:"vpass",
  scannedObjectCount:$s.scanned,auditedRecordCount:$s.audited,skippedObjectCount:$s.skipped,
  failedRecordCount:$s.failed,recordStatusCounts:$s.statuses,recordSchemaCounts:$s.schemas,
  artifactCount:$s.artifacts,statementArtifactCount:$s.statementArtifacts,
  statementRowCount:$s.rows,webRowCount:$s.webRows,customizedRowCount:$s.customizedRows,
  parsedStatementArtifactCount:$s.parsedStatementArtifacts,
  parsedTransactionCount:$s.parsedTransactions,parserWarningCount:$s.parserWarnings,
  blockedStatementArtifactCount:$s.blockedStatementArtifacts,
  observedWebShapes:$s.webShapes,observedCustomizedShapes:$s.customizedShapes,
  observedWebPresentationShapes:$s.webPresentationShapes,
  observedCustomizedPageShapes:$s.customizedPageShapes,
  observedWebRowKeyShapes:$s.webRowKeyShapes,
  observedCustomizedRowKeyShapes:$s.customizedRowKeyShapes,
  observedWebBeanKeyShapes:$s.webBeanKeyShapes,
  observedCustomizedBeanKeyShapes:$s.customizedBeanKeyShapes,
  observedRootKeyShapes:$s.rootKeyShapes,observedHeaderKeyShapes:$s.headerKeyShapes,
  observedBodyKeyShapes:$s.bodyKeyShapes,observedContentKeyShapes:$s.contentKeyShapes,
  failureCodeCounts:$s.failures}'
