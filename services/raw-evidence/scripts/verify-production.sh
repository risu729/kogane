#!/usr/bin/env bash
set -euo pipefail

readonly base_url="https://kogane-ingest.takuanimal.workers.dev"
readonly client_id="local-backfill"
user_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
config_dir="${KOGANE_CONFIG_DIR:-${user_home}/.config/kogane}"
credential_path="${config_dir}/ingest-client-keys.cred"
client_secret="$(sudo systemd-creds decrypt "${credential_path}" - | jq -er '."local-backfill"')"
auth_config="header = \"Authorization: Bearer ${client_id}.${client_secret}\""
unset client_secret

authorized_json() {
  local phase="$1"
  local response_and_status status body
  shift
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if response_and_status="$(curl --config <(printf '%s\n' "${auth_config}") \
      --silent --show-error --max-time 60 --proto '=https' --tlsv1.2 \
      --write-out $'\n%{http_code}' "$@")"; then
      status="${response_and_status##*$'\n'}"
      body="${response_and_status%$'\n'*}"
      if [[ "${status}" =~ ^2[0-9][0-9]$ ]]; then
        printf '%s' "${body}"
        return 0
      fi
      # A just-written D1 row may not yet be visible to the next request.
      # Every verifier request is idempotent, so bounded replay is safe.
      if test "${status}" = "404" -o "${status}" = "500" -o "${status}" = "503"; then
        sleep 1
        continue
      fi
      printf '%s failed with HTTP %s\n' "${phase}" "${status}" >&2
      return 1
    fi
    sleep 1
  done
  printf '%s did not become consistent after bounded retries\n' "${phase}" >&2
  return 1
}

health=''
for _ in 1 2 3 4 5 6 7 8 9 10; do
  health="$(curl --fail-with-body --silent --show-error --max-time 30 \
    --proto '=https' --tlsv1.2 "${base_url}/health" || true)"
  if jq -e '.ok == true and .schemaVersion == "0012"' <<<"${health}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
jq -e '.ok == true and .schemaVersion == "0012"' <<<"${health}" >/dev/null
payload='{"fixture":"production-round-trip"}'
payload_sha="$(printf '%s' "${payload}" | sha256sum | cut -d ' ' -f1)"
payload_size="$(printf '%s' "${payload}" | wc -c)"

session_id="${KOGANE_VERIFY_SESSION_ID:-synthetic-$(date -u +%Y%m%dT%H%M%SZ)}"
run_payload="$(jq -nc \
  --arg producerId local-file-importer \
  --arg sourceId kogane-synthetic \
  --arg namespace synthetic \
  --arg sessionId "${session_id}" \
  '{producerId:$producerId,sourceId:$sourceId,externalIdNamespace:$namespace,externalSessionId:$sessionId}')"
run_json="$(authorized_json create-run --request POST --header 'Content-Type: application/json' \
  --data "${run_payload}" "${base_url}/v1/runs")"
run_id="$(jq -er '.runId' <<<"${run_json}")"

put_json="$(authorized_json put-object \
  --request PUT --header "Content-Length: ${payload_size}" \
  --header "X-Kogane-Byte-Size: ${payload_size}" --data-binary "${payload}" \
  "${base_url}/v1/runs/${run_id}/objects/${payload_sha}")"
jq -e --arg sha256 "${payload_sha}" '.sha256 == $sha256' <<<"${put_json}" >/dev/null

artifact_payload="$(jq -nc --arg sha256 "${payload_sha}" --argjson byteSize "${payload_size}" \
  '{artifactKey:"fixture.json",artifactRole:"user_capture",payloadFidelity:"unknown",containerKind:"single",lineageDisposition:"not_applicable",sha256:$sha256,byteSize:$byteSize}')"
artifact_json="$(authorized_json catalogue-artifact --request POST --header 'Content-Type: application/json' \
  --data "${artifact_payload}" "${base_url}/v1/runs/${run_id}/artifacts")"
descriptor_sha="$(jq -er '.descriptorSha256' <<<"${artifact_json}")"

verification_json="$(authorized_json verify-object --request POST --header 'Content-Type: application/json' \
  --data '{}' "${base_url}/v1/runs/${run_id}/objects/${payload_sha}/verify")"
jq -e '.result == "ok"' <<<"${verification_json}" >/dev/null

report_payload='{"reportKey":"terminal","reportKind":"terminal","normalizedOutcome":"success","declaredArtifactCount":1,"artifactCountScope":"all_catalogued"}'
authorized_json terminal-report --request POST --header 'Content-Type: application/json' \
  --data "${report_payload}" "${base_url}/v1/runs/${run_id}/reports" >/dev/null

seal_payload="$(jq -nc --arg sha256 "${payload_sha}" --arg descriptorSha256 "${descriptor_sha}" \
  '{artifacts:[{artifactKey:"fixture.json",sha256:$sha256,descriptorSha256:$descriptorSha256}],declarationBasis:"operator",externalAttemptId:"first"}')"
seal_json="$(authorized_json seal-run --request POST --header 'Content-Type: application/json' \
  --data "${seal_payload}" "${base_url}/v1/runs/${run_id}/seal")"
jq -e '.sealed == true' <<<"${seal_json}" >/dev/null

jq -n --argjson health "${health}" --argjson put "${put_json}" \
  --argjson run "${run_json}" --argjson artifact "${artifact_json}" \
  --argjson verification "${verification_json}" --argjson seal "${seal_json}" \
  '{health:$health,put:$put,run:$run,artifact:$artifact,verification:$verification,seal:$seal}'

unset auth_config
