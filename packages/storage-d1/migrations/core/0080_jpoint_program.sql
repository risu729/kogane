-- Observed J-POINT total counting unit; no policy or conversion is asserted.
INSERT INTO reward_programs(program_id,institution_ref,program_ref,source_id,unit_ref,holding_kind,terms_evidence_refs_json,release_id,recorded_at) VALUES
 ('program:j-point','institution:jcb','j-point','myjcb','points:j-point','reward-points','["docs/sources/myjcb.md#j-point"]','jpoint-observed-total-v1','2026-10-10T00:00:00.000Z');

-- New independently sealed reward unit; existing statement policies unchanged.
INSERT INTO dataset_snapshot_policies(source_id,dataset,parser_name,policy_id,policy_version,required_parser_version,replaces_previous_on_complete_empty,unit_scope,updated_at_ms,snapshot_selection) VALUES
 ('myjcb','jpoint-balance','myjcb-jpoint-balance','legacy-warning-compat-v1',1,NULL,1,'unit',1791590400000,0);
