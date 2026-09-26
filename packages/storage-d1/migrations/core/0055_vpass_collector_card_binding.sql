-- ADR 0023 (option 3): the Vpass collector writes the card binding itself.
--
-- The view keeps the retired importer's branch byte for byte (migration 0021)
-- and adds one branch for the shared-R2 run shape, under the same evidence:
-- a successful, sealed Vpass financial run whose card unit `card-NNN` holds the
-- financial artifact, and exactly one binding: one `card` unit keyed
-- `vpass-card-v1-<64 hex>` with a successful terminal report and no other
-- report, holding the `collector_derived` artifact `card-identity-binding.json`
-- of dataset `card-identity-binding`, format `vpass-card-identity-binding-json`
-- version `1`.
--
-- What differs is only where the binding sits. The importer wrote it as a
-- sibling fetch run in the same acquisition session, found by the run key
-- `card-NNN-vpass-card-binding-v1`. The collector writes it into the card's
-- own run, which the Processor registers under the producer `collector-vpass`,
-- the session namespace `shared-r2` and the run key
-- `<session>-card-NNN:terminal-registration-v<N>`
-- (`packages/application/src/collection/descriptors.ts`). So the binding unit
-- is a second unit of the same run, the run key must name the financial
-- unit's ordinal, the run holds no unit besides the two, and no second binding
-- artifact. The run's own status stands for the binding run's status.
--
-- The view stays a plain UNION ALL of two flattenable selects, so a lookup by
-- `financial_artifact_id` is pushed into both arms and each arm starts from the
-- artifact's primary key (services/processor/test/binding-query-plan.test.ts).
DROP VIEW trusted_vpass_card_bindings;
CREATE VIEW trusted_vpass_card_bindings AS
SELECT fa.id AS financial_artifact_id, fu.id AS financial_unit_id, fu.unit_key AS financial_unit_key,
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
   AND other.dataset='card-identity-binding' AND other.id<>ba.id)
UNION ALL
SELECT fa.id AS financial_artifact_id, fu.id AS financial_unit_id, fu.unit_key AS financial_unit_key,
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
   AND other.dataset='card-identity-binding' AND other.id<>ba.id)
;
