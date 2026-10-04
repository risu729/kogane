-- ADR 0023 (amendment, option 3): the Vpass collector writes the card binding
-- itself, and the trusted view admits it under the importer's evidence rules.
--
-- The evidence is unchanged: a visible artifact of a successful, sealed Vpass
-- financial run whose `card-NNN` card unit holds it, and exactly one binding:
-- one `card` unit keyed `vpass-card-v1-<64 hex>` with a successful terminal
-- report and no other report, holding the `collector_derived` artifact
-- `card-identity-binding.json` of dataset `card-identity-binding`, format
-- `vpass-card-identity-binding-json` version `1`, and no second binding
-- artifact in its run.
--
-- Only where the binding sits differs by producer:
--  * `collector-r2-importer` (migration 0021, unchanged): session namespace
--    `vpass-worker-card-v1`; the binding is a sibling run of the same session,
--    source and producer keyed `card-NNN-vpass-card-binding-v1`, the only run
--    with that key, holding no other unit;
--  * `collector-vpass`: session namespace `shared-r2`; the binding is inside the
--    financial run itself, whose registration run key names the same ordinal
--    (`<session>-card-NNN:terminal-registration-v<N>`,
--    packages/application/src/collection/descriptors.ts), and the run holds no
--    unit other than the card and the binding.
--
-- One SELECT covers both: for the collector the "binding run" join finds the
-- financial run itself (its own session, source, producer and run key, which
-- `fetch_runs` holds unique), so every importer condition reads the same run.
-- It is not written as `0021 UNION ALL <collector select>`: a compound view is
-- not flattened into the join in `eligible_identity_runs`, and SQLite then
-- materializes the whole view behind an automatic index on every current
-- identity read. services/processor/test/vpass-binding-view.test.ts proves this
-- view returns exactly the rows of that UNION ALL form (0021's select verbatim
-- plus the collector select) on random stores, and
-- services/processor/test/binding-query-plan.test.ts that its lookups keep
-- 0021's plans.
DROP VIEW trusted_vpass_card_bindings;
CREATE VIEW trusted_vpass_card_bindings AS
SELECT fa.id AS financial_artifact_id, fu.id AS financial_unit_id, fu.unit_key AS financial_unit_key,
       ba.id AS binding_artifact_id, bu.unit_key AS card_token
FROM fetch_artifacts fa
JOIN observation_fetch_artifacts visible ON visible.id=fa.id
JOIN fetch_runs financial ON financial.id=fa.fetch_run_id
JOIN acquisition_sessions session ON session.id=financial.acquisition_session_id
 AND session.producer_id=financial.producer_id
 AND session.external_id_namespace=CASE financial.producer_id
   WHEN 'collector-r2-importer' THEN 'vpass-worker-card-v1' WHEN 'collector-vpass' THEN 'shared-r2' END
JOIN observation_fetch_runs financial_status ON financial_status.id=financial.id
JOIN fetch_units fu ON fu.id=fa.fetch_unit_id AND fu.fetch_run_id=financial.id
JOIN fetch_runs binding ON binding.acquisition_session_id=financial.acquisition_session_id
 AND binding.source_id=financial.source_id AND binding.producer_id=financial.producer_id
 AND binding.source_run_key=CASE financial.producer_id
   WHEN 'collector-r2-importer' THEN fu.unit_key||'-vpass-card-binding-v1'
   WHEN 'collector-vpass' THEN financial.source_run_key END
JOIN observation_fetch_runs binding_status ON binding_status.id=binding.id
JOIN fetch_units bu ON bu.fetch_run_id=binding.id AND bu.unit_kind='card'
JOIN fetch_artifacts ba ON ba.fetch_run_id=binding.id AND ba.fetch_unit_id=bu.id
 AND ba.source_id=binding.source_id
WHERE fa.source_id='vpass' AND financial.source_id='vpass'
 AND financial.producer_id IN ('collector-r2-importer','collector-vpass')
 AND financial_status.status='success' AND financial_status.failure_count=0
 AND binding_status.status='success' AND binding_status.failure_count=0
 AND (financial.producer_id='collector-r2-importer' OR (binding.id=financial.id
   AND financial.source_run_key GLOB '*-'||fu.unit_key||':terminal-registration-v[0-9]*'))
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
 AND NOT EXISTS(SELECT 1 FROM fetch_units other WHERE other.fetch_run_id=binding.id AND other.id<>bu.id
   AND (financial.producer_id='collector-r2-importer' OR other.id<>fu.id))
 AND NOT EXISTS(SELECT 1 FROM fetch_artifacts other WHERE other.fetch_run_id=binding.id
   AND other.dataset='card-identity-binding' AND other.id<>ba.id)
;
