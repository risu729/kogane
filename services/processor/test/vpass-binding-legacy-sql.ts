// The trusted Vpass card binding lookup as ADR 0023 specifies it, frozen:
// migration 0021's select verbatim (the retired importer's sibling-run
// binding) UNION ALL the select for the collector's binding inside its own
// shared-R2 run. Migration 0055 ships one select instead, because a compound
// view is materialized whole inside `eligible_identity_runs`;
// `vpass-binding-view.test.ts` proves the shipped view returns exactly these
// rows. Do not edit: this is the specification the shipped view is checked
// against.

/** Migration 0021's `trusted_vpass_card_bindings` select, byte for byte. */
export const IMPORTER_BINDING_SELECT_0021 = `SELECT fa.id AS financial_artifact_id, fu.id AS financial_unit_id, fu.unit_key AS financial_unit_key,
       ba.id AS binding_artifact_id, bu.unit_key AS card_token
FROM fetch_artifacts fa
JOIN observation_fetch_artifacts visible ON visible.id=fa.id
JOIN fetch_runs financial ON financial.id=fa.fetch_run_id
JOIN acquisition_sessions session ON session.id=financial.acquisition_session_id
 AND session.producer_id=financial.producer_id AND session.external_id_namespace='vpass-worker-card-v1'
JOIN observation_fetch_runs financial_status ON financial_status.id=financial.id
JOIN fetch_units fu ON fu.id=fa.fetch_unit_id AND fu.fetch_run_id=financial.id
JOIN fetch_runs binding ON binding.acquisition_session_id=financial.acquisition_session_id
 AND binding.source_id=financial.source_id AND binding.producer_id=financial.producer_id
 AND binding.source_run_key=fu.unit_key||'-vpass-card-binding-v1'
JOIN observation_fetch_runs binding_status ON binding_status.id=binding.id
JOIN fetch_units bu ON bu.fetch_run_id=binding.id AND bu.unit_kind='card'
JOIN fetch_artifacts ba ON ba.fetch_run_id=binding.id AND ba.fetch_unit_id=bu.id
 AND ba.source_id=binding.source_id
WHERE fa.source_id='vpass' AND financial.source_id='vpass'
 AND financial.producer_id='collector-r2-importer'
 AND financial_status.status='success' AND financial_status.failure_count=0
 AND binding_status.status='success' AND binding_status.failure_count=0
 AND NOT EXISTS(SELECT 1 FROM fetch_runs other_binding
   WHERE other_binding.acquisition_session_id=binding.acquisition_session_id
    AND other_binding.source_id=binding.source_id AND other_binding.source_run_key=binding.source_run_key
    AND other_binding.id<>binding.id)
 AND fu.unit_kind='card' AND fu.unit_key GLOB 'card-[0-9][0-9][0-9]'
 AND length(bu.unit_key)=78 AND substr(bu.unit_key,1,14)='vpass-card-v1-'
 AND substr(bu.unit_key,15) NOT GLOB '*[^0-9a-f]*'
 AND ba.dataset='card-identity-binding' AND ba.artifact_key='card-identity-binding.json'
 AND ba.artifact_role='collector_derived'
 AND ba.format_id='vpass-card-identity-binding-json' AND ba.format_version='1'
 AND EXISTS(SELECT 1 FROM fetch_unit_reports ur WHERE ur.fetch_unit_id=bu.id
   AND ur.report_kind='terminal' AND ur.normalized_outcome='success' AND ur.safe_failure_code IS NULL)
 AND NOT EXISTS(SELECT 1 FROM fetch_unit_reports ur WHERE ur.fetch_unit_id=bu.id
   AND (ur.normalized_outcome<>'success' OR ur.safe_failure_code IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM fetch_units other WHERE other.fetch_run_id=binding.id AND other.id<>bu.id)
 AND NOT EXISTS(SELECT 1 FROM fetch_artifacts other WHERE other.fetch_run_id=binding.id
   AND other.dataset='card-identity-binding' AND other.id<>ba.id)`;

/** The collector's binding: the same evidence, inside the financial run. */
export const COLLECTOR_BINDING_SELECT = `SELECT fa.id AS financial_artifact_id, fu.id AS financial_unit_id, fu.unit_key AS financial_unit_key,
       ba.id AS binding_artifact_id, bu.unit_key AS card_token
FROM fetch_artifacts fa
JOIN observation_fetch_artifacts visible ON visible.id=fa.id
JOIN fetch_runs financial ON financial.id=fa.fetch_run_id
JOIN acquisition_sessions session ON session.id=financial.acquisition_session_id
 AND session.producer_id=financial.producer_id AND session.external_id_namespace='shared-r2'
JOIN observation_fetch_runs financial_status ON financial_status.id=financial.id
JOIN fetch_units fu ON fu.id=fa.fetch_unit_id AND fu.fetch_run_id=financial.id
JOIN fetch_units bu ON bu.fetch_run_id=financial.id AND bu.unit_kind='card' AND bu.id<>fu.id
JOIN fetch_artifacts ba ON ba.fetch_run_id=financial.id AND ba.fetch_unit_id=bu.id
 AND ba.source_id=financial.source_id
WHERE fa.source_id='vpass' AND financial.source_id='vpass'
 AND financial.producer_id='collector-vpass'
 AND financial_status.status='success' AND financial_status.failure_count=0
 AND financial.source_run_key GLOB '*-'||fu.unit_key||':terminal-registration-v[0-9]*'
 AND fu.unit_kind='card' AND fu.unit_key GLOB 'card-[0-9][0-9][0-9]'
 AND length(bu.unit_key)=78 AND substr(bu.unit_key,1,14)='vpass-card-v1-'
 AND substr(bu.unit_key,15) NOT GLOB '*[^0-9a-f]*'
 AND ba.dataset='card-identity-binding' AND ba.artifact_key='card-identity-binding.json'
 AND ba.artifact_role='collector_derived'
 AND ba.format_id='vpass-card-identity-binding-json' AND ba.format_version='1'
 AND EXISTS(SELECT 1 FROM fetch_unit_reports ur WHERE ur.fetch_unit_id=bu.id
   AND ur.report_kind='terminal' AND ur.normalized_outcome='success' AND ur.safe_failure_code IS NULL)
 AND NOT EXISTS(SELECT 1 FROM fetch_unit_reports ur WHERE ur.fetch_unit_id=bu.id
   AND (ur.normalized_outcome<>'success' OR ur.safe_failure_code IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM fetch_units other WHERE other.fetch_run_id=financial.id
   AND other.id<>fu.id AND other.id<>bu.id)
 AND NOT EXISTS(SELECT 1 FROM fetch_artifacts other WHERE other.fetch_run_id=financial.id
   AND other.dataset='card-identity-binding' AND other.id<>ba.id)`;

/** The specification: both selects, as one relation. */
export const TRUSTED_BINDINGS_SPEC = `${IMPORTER_BINDING_SELECT_0021}
UNION ALL
${COLLECTOR_BINDING_SELECT}`;
