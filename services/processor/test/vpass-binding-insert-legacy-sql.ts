// The Vpass binding insert of the identity sweep's empty-parse batch as it
// shipped before ADR 0129's decision 4 (packages/storage-d1/src/core/
// identity-store.ts until 2026-11-25, with EMPTY_IDENTITY_PARSE_SQL expanded),
// byte for byte, so the rewrite is proven to select the same rows
// (tick-rows-read.test.ts). Do not edit.
export const VPASS_BINDING_INSERT_LEGACY_SQL = `INSERT INTO identity_vpass_bindings
        SELECT r.id,b.financial_unit_id,b.binding_artifact_id,b.card_token FROM json_each(?) candidate
        JOIN identity_runs r ON r.id=json_extract(candidate.value,'$[0]')
          AND r.policy_version=json_extract(candidate.value,'$[2]') AND r.policy_version=2
        JOIN parse_runs p ON p.id=r.parse_run_id AND p.id=json_extract(candidate.value,'$[1]')
        JOIN trusted_vpass_card_bindings b ON b.financial_artifact_id=p.fetch_artifact_id
        WHERE p.status='ok' AND NOT EXISTS(SELECT 1 FROM transaction_observations empty_row WHERE empty_row.parse_run_id=p.id) AND NOT EXISTS(SELECT 1 FROM balance_observations empty_row WHERE empty_row.parse_run_id=p.id) AND NOT EXISTS(SELECT 1 FROM position_observations empty_row WHERE empty_row.parse_run_id=p.id) AND NOT EXISTS(SELECT 1 FROM valuation_observations empty_row WHERE empty_row.parse_run_id=p.id)
          AND NOT EXISTS(SELECT 1 FROM identity_vpass_bindings pin WHERE pin.identity_run_id=r.id)`;
