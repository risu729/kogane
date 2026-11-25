// The Vpass binding insert of the identity sweep's empty-parse batch as it
// shipped before ADR 0129's decision 4 (packages/storage-d1/src/core/
// identity-store.ts until 2026-11-25), frozen so the rewrite is proven to
// insert the same rows (tick-rows-read.test.ts).
import { EMPTY_IDENTITY_PARSE_SQL } from "../../../packages/storage-d1/src/core/identity-sweep-sql.ts";

export const VPASS_BINDING_INSERT_LEGACY_SQL = `INSERT INTO identity_vpass_bindings
        SELECT r.id,b.financial_unit_id,b.binding_artifact_id,b.card_token FROM json_each(?) candidate
        JOIN identity_runs r ON r.id=json_extract(candidate.value,'$[0]')
          AND r.policy_version=json_extract(candidate.value,'$[2]') AND r.policy_version=2
        JOIN parse_runs p ON p.id=r.parse_run_id AND p.id=json_extract(candidate.value,'$[1]')
        JOIN trusted_vpass_card_bindings b ON b.financial_artifact_id=p.fetch_artifact_id
        WHERE p.status='ok' AND ${EMPTY_IDENTITY_PARSE_SQL}
          AND NOT EXISTS(SELECT 1 FROM identity_vpass_bindings pin WHERE pin.identity_run_id=r.id)`;
