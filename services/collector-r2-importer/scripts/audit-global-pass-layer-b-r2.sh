#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
port="${GLOBAL_PASS_LAYER_B_AUDIT_PORT:-8979}"
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
  npx wrangler dev --config wrangler.audit-global-pass-layer-b.jsonc --ip 127.0.0.1 --port "${port}" >"${temp_dir}/wrangler.log" 2>&1
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
artifacts=0 table_count=0 header_cells=0 tables=0 rows=0 one=0 two=0 three=0 other=0 dates=0 money=0 pending=0 confirmed=0 opt8=0 opt6=0 selects=0 selected=0 selected_matches=0 recognized_headers=0 unknown_headers=0 recognized_tables=0 parsed_observations=0 unsigned_observations=0
date_labels=0 detail_labels=0 amount_labels=0 fee_labels=0 authorization_labels=0 status_labels=0 family_labels=0
date_tables=0 date_rows=0 detail_tables=0 detail_rows=0 amount_tables=0 amount_rows=0 fee_tables=0 fee_rows=0 status_tables=0 status_rows=0 authorization_tables=0 authorization_rows=0
table_shapes='{}'
row_shapes='{}'
failure_codes='{}'
cursor="" pages=0
while true; do
  pages=$((pages + 1))
  if ((pages > 100000)); then printf 'audit page bound exceeded\n' >&2; exit 1; fi
  request="$(jq -nc --arg cursor "${cursor}" 'if $cursor == "" then {} else {cursor:$cursor} end')"
  page="$(curl --fail --silent -H 'content-type: application/json' --data-binary "${request}" "http://127.0.0.1:${port}/audit-page")" || { printf 'audit page failed\n' >&2; exit 1; }
  jq -e 'type == "object" and .schemaVersion == "global-pass-layer-b-aggregate-audit-v1" and
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
    artifacts=$((artifacts + $(jq -r '.activityArtifactCount' <<<"${page}")))
    table_count=$((table_count + $(jq -r '.tableCount' <<<"${page}")))
    header_cells=$((header_cells + $(jq -r '.headerCellCount' <<<"${page}")))
    tables=$((tables + $(jq -r '.exactHeaderTableCount' <<<"${page}")))
    rows=$((rows + $(jq -r '.bodyRowCount' <<<"${page}")))
    one=$((one + $(jq -r '.oneCellRowCount' <<<"${page}")))
    two=$((two + $(jq -r '.twoCellRowCount' <<<"${page}")))
    three=$((three + $(jq -r '.threeCellRowCount' <<<"${page}")))
    other=$((other + $(jq -r '.otherCellRowCount' <<<"${page}")))
    dates=$((dates + $(jq -r '.dateCellCount' <<<"${page}")))
    money=$((money + $(jq -r '.currencyAmountCellCount' <<<"${page}")))
    pending=$((pending + $(jq -r '.pendingMarkerCount' <<<"${page}")))
    confirmed=$((confirmed + $(jq -r '.confirmedMarkerCount' <<<"${page}")))
    opt8=$((opt8 + $(jq -r '.eightDigitOptionCount' <<<"${page}")))
    opt6=$((opt6 + $(jq -r '.sixDigitOptionCount' <<<"${page}")))
    selects=$((selects + $(jq -r '.activitySelectCount' <<<"${page}")))
    selected=$((selected + $(jq -r '.selectedOptionCount' <<<"${page}")))
    selected_matches=$((selected_matches + $(jq -r '.selectedMonthMatchCount' <<<"${page}")))
    recognized_headers=$((recognized_headers + $(jq -r '.recognizedHeaderCount' <<<"${page}")))
    unknown_headers=$((unknown_headers + $(jq -r '.unknownHeaderCount' <<<"${page}")))
    recognized_tables=$((recognized_tables + $(jq -r '.exactRecognizedTableCount' <<<"${page}")))
    parsed_observations=$((parsed_observations + $(jq -r '.parsedObservationCount' <<<"${page}")))
    unsigned_observations=$((unsigned_observations + $(jq -r '.unsignedObservationCount' <<<"${page}")))
    date_labels=$((date_labels + $(jq -r '.dateLabelHitCount' <<<"${page}")))
    detail_labels=$((detail_labels + $(jq -r '.detailLabelHitCount' <<<"${page}")))
    amount_labels=$((amount_labels + $(jq -r '.amountLabelHitCount' <<<"${page}")))
    fee_labels=$((fee_labels + $(jq -r '.feeLabelHitCount' <<<"${page}")))
    authorization_labels=$((authorization_labels + $(jq -r '.authorizationLabelHitCount' <<<"${page}")))
    status_labels=$((status_labels + $(jq -r '.statusLabelHitCount' <<<"${page}")))
    family_labels=$((family_labels + $(jq -r '.familyLabelHitCount' <<<"${page}")))
    date_tables=$((date_tables + $(jq -r '.dateLabeledTableCount' <<<"${page}")))
    date_rows=$((date_rows + $(jq -r '.dateLabeledRowCount' <<<"${page}")))
    detail_tables=$((detail_tables + $(jq -r '.detailLabeledTableCount' <<<"${page}")))
    detail_rows=$((detail_rows + $(jq -r '.detailLabeledRowCount' <<<"${page}")))
    amount_tables=$((amount_tables + $(jq -r '.amountLabeledTableCount' <<<"${page}")))
    amount_rows=$((amount_rows + $(jq -r '.amountLabeledRowCount' <<<"${page}")))
    fee_tables=$((fee_tables + $(jq -r '.feeLabeledTableCount' <<<"${page}")))
    fee_rows=$((fee_rows + $(jq -r '.feeLabeledRowCount' <<<"${page}")))
    status_tables=$((status_tables + $(jq -r '.statusLabeledTableCount' <<<"${page}")))
    status_rows=$((status_rows + $(jq -r '.statusLabeledRowCount' <<<"${page}")))
    authorization_tables=$((authorization_tables + $(jq -r '.authorizationLabeledTableCount' <<<"${page}")))
    authorization_rows=$((authorization_rows + $(jq -r '.authorizationLabeledRowCount' <<<"${page}")))
    table_shapes="$(jq -cn --argjson left "${table_shapes}" --argjson right "$(jq '.tableShapeHistogram' <<<"${page}")" '
      reduce (($left + $right) | keys_unsorted[]) as $key ({}; .[$key] = (($left[$key] // 0) + ($right[$key] // 0)))')"
    row_shapes="$(jq -cn --argjson left "${row_shapes}" --argjson right "$(jq '.rowShapeHistogram' <<<"${page}")" '
      reduce (($left + $right) | keys_unsorted[]) as $key ({}; .[$key] = (($left[$key] // 0) + ($right[$key] // 0)))')"
  fi
  cursor="$(jq -r '.nextCursor // ""' <<<"${page}")"
  [[ -n "${cursor}" ]] || break
done
jq -nc --argjson scanned "${scanned}" --argjson audited "${audited}" --argjson skipped "${skipped}" --argjson failed "${failed}" \
  --argjson success "${success}" --argjson partial "${partial}" --argjson failedStatus "${failed_status}" --argjson failureEvidence "${failure_evidence}" \
  --argjson artifacts "${artifacts}" --argjson tableCount "${table_count}" --argjson headerCells "${header_cells}" --argjson tables "${tables}" --argjson rows "${rows}" --argjson one "${one}" --argjson two "${two}" \
  --argjson three "${three}" --argjson other "${other}" --argjson dates "${dates}" --argjson money "${money}" --argjson pending "${pending}" \
  --argjson confirmed "${confirmed}" --argjson opt8 "${opt8}" --argjson opt6 "${opt6}" --argjson dateLabels "${date_labels}" \
  --argjson selects "${selects}" --argjson selected "${selected}" --argjson selectedMatches "${selected_matches}" \
  --argjson recognizedHeaders "${recognized_headers}" --argjson unknownHeaders "${unknown_headers}" --argjson recognizedTables "${recognized_tables}" \
  --argjson parsedObservations "${parsed_observations}" --argjson unsignedObservations "${unsigned_observations}" \
  --argjson detailLabels "${detail_labels}" --argjson amountLabels "${amount_labels}" --argjson feeLabels "${fee_labels}" \
  --argjson authorizationLabels "${authorization_labels}" --argjson statusLabels "${status_labels}" --argjson familyLabels "${family_labels}" \
  --argjson dateTables "${date_tables}" --argjson dateRows "${date_rows}" --argjson detailTables "${detail_tables}" --argjson detailRows "${detail_rows}" \
  --argjson amountTables "${amount_tables}" --argjson amountRows "${amount_rows}" --argjson feeTables "${fee_tables}" --argjson feeRows "${fee_rows}" \
  --argjson statusTables "${status_tables}" --argjson statusRows "${status_rows}" --argjson authorizationTables "${authorization_tables}" --argjson authorizationRows "${authorization_rows}" \
  --argjson tableShapes "${table_shapes}" \
  --argjson rowShapes "${row_shapes}" \
  --argjson failureCodes "${failure_codes}" \
  '{schemaVersion:"global-pass-layer-b-aggregate-audit-v1",source:"prestia-globalpass",scannedObjectCount:$scanned,auditedManifestCount:$audited,
    skippedObjectCount:$skipped,failedManifestCount:$failed,manifestStatusCounts:{success:$success,partial:$partial,failed:$failedStatus},
    failureEvidenceCount:$failureEvidence,activityArtifactCount:$artifacts,tableCount:$tableCount,headerCellCount:$headerCells,
    exactHeaderTableCount:$tables,bodyRowCount:$rows,
    rowCellCardinality:{one:$one,two:$two,three:$three,other:$other},dateCellCount:$dates,currencyAmountCellCount:$money,
    pendingMarkerCount:$pending,confirmedMarkerCount:$confirmed,eightDigitOptionCount:$opt8,sixDigitOptionCount:$opt6,
    activitySelectCount:$selects,selectedOptionCount:$selected,selectedMonthMatchCount:$selectedMatches,
    recognizedHeaderCount:$recognizedHeaders,unknownHeaderCount:$unknownHeaders,exactRecognizedTableCount:$recognizedTables,
    parsedObservationCount:$parsedObservations,unsignedObservationCount:$unsignedObservations,
    knownLabelHitCounts:{date:$dateLabels,detail:$detailLabels,amount:$amountLabels,fee:$feeLabels,authorization:$authorizationLabels,status:$statusLabels,family:$familyLabels},
    labeledTableCounts:{date:$dateTables,detail:$detailTables,amount:$amountTables,fee:$feeTables,status:$statusTables,authorization:$authorizationTables},
    labeledRowCounts:{date:$dateRows,detail:$detailRows,amount:$amountRows,fee:$feeRows,status:$statusRows,authorization:$authorizationRows},
    tableShapeHistogram:$tableShapes,rowShapeHistogram:$rowShapes,failureCodeCounts:$failureCodes}'
((failed == 0))
