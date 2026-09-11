-- Prices, calculation policies, calculation runs, fixed report artifacts,
-- retention classes and evidence-use restrictions (architecture addendum A12;
-- findings AR03, AR12, AR17, AR18).
--
-- Additive only. No existing table, view, trigger or row is altered, and a
-- Worker build that predates this migration keeps working because it never
-- reads or writes anything below. Four ideas are kept apart on purpose:
--
--   * a price is an observation with an explicit base quantity and a source
--     claim, never a bare number (addendum 09 section 2);
--   * a calculation run fixes the policies and the input manifest it used, so
--     a later price or rule correction produces a new run, not a rewrite;
--   * a ReportArtifact is a fixed body with a digest and its own event
--     history, which is not the same object as a rebuildable projection
--     (AR03, SC16, UC59/UC60);
--   * retention classes and evidence-use restrictions record what may be kept
--     and what may no longer be used, so replayability can be downgraded
--     honestly instead of claiming a digest proves reproducibility (AR17).
--
-- Nothing here concludes anything about tax. cost-basis exists only as a
-- policy contract with a verification gate.

-- A price is "quote_amount of quote_unit_ref per base_quantity of
-- base_instrument_ref". 8,000 alone cannot say whether it prices one share,
-- one unit, 10,000 fund units or one contract, so the basis is stored beside
-- the amount and is never defaulted to 1 by a reader.
CREATE TABLE price_observations (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
 base_instrument_ref TEXT NOT NULL CHECK(length(base_instrument_ref) BETWEEN 1 AND 256),
 base_quantity_coefficient TEXT NOT NULL,
 base_quantity_scale INTEGER NOT NULL CHECK(base_quantity_scale BETWEEN 0 AND 4096),
 quote_unit_ref TEXT NOT NULL CHECK(length(quote_unit_ref) BETWEEN 1 AND 128),
 quote_amount_coefficient TEXT NOT NULL,
 quote_amount_scale INTEGER NOT NULL CHECK(quote_amount_scale BETWEEN 0 AND 4096),
 price_kind TEXT NOT NULL CHECK(price_kind IN ('execution','bid','ask','reference','nav','provider-value')),
 -- Serialized TemporalValue: a provider date stays a date; no instant is invented.
 effective_time TEXT NOT NULL CHECK(json_valid(effective_time) AND json_type(effective_time)='object'),
 -- Which claim asserted this price. Prices are never fetched at read time.
 source_claim_ref TEXT NOT NULL CHECK(length(source_claim_ref) BETWEEN 1 AND 512),
 market_ref TEXT CHECK(market_ref IS NULL OR length(market_ref) BETWEEN 1 AND 256),
 adjustment_policy_ref TEXT CHECK(adjustment_policy_ref IS NULL OR length(adjustment_policy_ref) BETWEEN 1 AND 256),
 recorded_at TEXT NOT NULL CHECK(length(recorded_at) BETWEEN 1 AND 64),
 -- Canonical decimal-v1 coefficients: no leading zeros, one optional sign, "0" has scale 0.
 CHECK(base_quantity_coefficient GLOB '[1-9]*' AND base_quantity_coefficient NOT GLOB '*[^0-9]*'
   AND length(base_quantity_coefficient) BETWEEN 1 AND 4096),
 CHECK(length(quote_amount_coefficient) BETWEEN 1 AND 4097
   AND (quote_amount_coefficient='0' OR (length(quote_amount_coefficient)-length(replace(quote_amount_coefficient,'-',''))<=1
     AND ltrim(quote_amount_coefficient,'-') NOT GLOB '*[^0-9]*'
     AND substr(ltrim(quote_amount_coefficient,'-'),1,1) BETWEEN '1' AND '9'))),
 CHECK(quote_amount_coefficient IS NOT '0' OR quote_amount_scale=0)
) STRICT;
CREATE INDEX price_observations_instrument ON price_observations(base_instrument_ref,quote_unit_ref,price_kind);
CREATE TRIGGER price_observations_no_update BEFORE UPDATE ON price_observations
BEGIN SELECT RAISE(ABORT,'price observations are append-only'); END;
CREATE TRIGGER price_observations_no_delete BEFORE DELETE ON price_observations
BEGIN SELECT RAISE(ABORT,'price observations are append-only'); END;

-- Rounding, P&L decomposition, cost basis and FX handling are versioned
-- inputs, not implementation details. `verification` is the gate: an
-- unverified rule package may be referenced by a run, but a caller that needs
-- a verified rule (a cost-basis calculation, for instance) refuses instead of
-- guessing (AT59).
CREATE TABLE calculation_policies (
 policy_id TEXT PRIMARY KEY CHECK(length(policy_id) BETWEEN 1 AND 256),
 kind TEXT NOT NULL CHECK(kind IN ('rounding','pnl-decomposition','cost-basis','fx')),
 version TEXT NOT NULL CHECK(length(version) BETWEEN 1 AND 64),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json) AND json_type(definition_json)='object'),
 verification TEXT NOT NULL CHECK(verification IN ('verified','unverified')),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json) AND json_type(evidence_refs_json)='array'),
 created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 1 AND 64)
) STRICT;
CREATE INDEX calculation_policies_kind ON calculation_policies(kind,version);
CREATE TRIGGER calculation_policies_no_update BEFORE UPDATE ON calculation_policies
BEGIN SELECT RAISE(ABORT,'calculation policies are append-only; publish a new version'); END;
CREATE TRIGGER calculation_policies_no_delete BEFORE DELETE ON calculation_policies
BEGIN SELECT RAISE(ABORT,'calculation policies are append-only'); END;

-- One run per (context, policy set, input manifest). The run is operational
-- state: it moves forward from 'building' exactly once, and its replayability
-- may be downgraded later when evidence use is restricted. It is never
-- deleted, and a completed run never returns to 'building'.
CREATE TABLE calculation_runs (
 run_id TEXT PRIMARY KEY CHECK(length(run_id) BETWEEN 1 AND 256),
 context_id TEXT NOT NULL CHECK(length(context_id) BETWEEN 1 AND 256),
 policy_refs_json TEXT NOT NULL CHECK(json_valid(policy_refs_json) AND json_type(policy_refs_json)='array'),
 input_manifest_digest TEXT NOT NULL CHECK(length(input_manifest_digest)=64 AND input_manifest_digest NOT GLOB '*[^0-9a-f]*'),
 status TEXT NOT NULL CHECK(status IN ('building','complete','failed')),
 replayability TEXT NOT NULL CHECK(replayability IN ('replayable','artifact-preserved','restricted','unavailable')),
 started_at TEXT NOT NULL CHECK(length(started_at) BETWEEN 1 AND 64),
 completed_at TEXT CHECK(completed_at IS NULL OR length(completed_at) BETWEEN 1 AND 64),
 CHECK((status='building' AND completed_at IS NULL) OR (status<>'building' AND completed_at IS NOT NULL))
) STRICT;
CREATE INDEX calculation_runs_context ON calculation_runs(context_id,started_at);
CREATE TRIGGER calculation_runs_no_delete BEFORE DELETE ON calculation_runs
BEGIN SELECT RAISE(ABORT,'calculation runs are not deleted'); END;
-- Inputs are fixed at creation: a different context, policy set or manifest is
-- a different run (AR12/INV09), never an edit of this one.
CREATE TRIGGER calculation_runs_inputs_fixed BEFORE UPDATE ON calculation_runs
WHEN NEW.context_id<>OLD.context_id OR NEW.policy_refs_json<>OLD.policy_refs_json
 OR NEW.input_manifest_digest<>OLD.input_manifest_digest OR NEW.started_at<>OLD.started_at
BEGIN SELECT RAISE(ABORT,'calculation run inputs are immutable'); END;
CREATE TRIGGER calculation_runs_status_forward BEFORE UPDATE OF status ON calculation_runs
WHEN OLD.status<>'building' AND NEW.status<>OLD.status
BEGIN SELECT RAISE(ABORT,'a terminal calculation run cannot change status'); END;

-- A result is either an exact value or an explicitly unvalued cell with a
-- typed reason. There is no third option and no zero substitute: "we could not
-- price it" and "it is worth nothing" are different facts (INV05, addendum 09
-- section 3). rounding_inputs_json keeps the pre-rounding operands and the
-- rounding policy so another policy can recompute from the same inputs.
CREATE TABLE calculation_results (
 run_id TEXT NOT NULL REFERENCES calculation_runs(run_id),
 subject_ref TEXT NOT NULL CHECK(length(subject_ref) BETWEEN 1 AND 512),
 scope_ref TEXT NOT NULL CHECK(length(scope_ref) BETWEEN 1 AND 512),
 metric TEXT NOT NULL CHECK(length(metric) BETWEEN 1 AND 128),
 unit_ref TEXT NOT NULL CHECK(length(unit_ref) BETWEEN 1 AND 128),
 coefficient TEXT,
 scale INTEGER CHECK(scale IS NULL OR scale BETWEEN 0 AND 4096),
 value_status TEXT NOT NULL CHECK(value_status IN ('exact','unvalued')),
 unvalued_reason TEXT CHECK(unvalued_reason IS NULL OR unvalued_reason IN
  ('missing-quantity','unresolved-identity','overlap','stale-price','missing-price','unsupported-instrument','incomplete-liabilities')),
 rounding_inputs_json TEXT NOT NULL CHECK(json_valid(rounding_inputs_json) AND json_type(rounding_inputs_json)='object'),
 PRIMARY KEY(run_id,subject_ref,scope_ref,metric),
 CHECK((value_status='exact' AND coefficient IS NOT NULL AND scale IS NOT NULL AND unvalued_reason IS NULL)
   OR (value_status='unvalued' AND coefficient IS NULL AND scale IS NULL AND unvalued_reason IS NOT NULL)),
 CHECK(coefficient IS NULL OR (length(coefficient) BETWEEN 1 AND 4097
   AND (coefficient='0' OR (length(coefficient)-length(replace(coefficient,'-',''))<=1
     AND ltrim(coefficient,'-') NOT GLOB '*[^0-9]*'
     AND substr(ltrim(coefficient,'-'),1,1) BETWEEN '1' AND '9')))),
 CHECK(coefficient IS NOT '0' OR scale=0)
) STRICT;
CREATE INDEX calculation_results_metric ON calculation_results(run_id,metric);
CREATE TRIGGER calculation_results_no_update BEFORE UPDATE ON calculation_results
BEGIN SELECT RAISE(ABORT,'calculation results are append-only; start a new run'); END;
CREATE TRIGGER calculation_results_no_delete BEFORE DELETE ON calculation_results
BEGIN SELECT RAISE(ABORT,'calculation results are append-only'); END;
-- Results only belong to a run that is still building; a complete run is fixed.
CREATE TRIGGER calculation_results_run_building BEFORE INSERT ON calculation_results
WHEN NOT EXISTS(SELECT 1 FROM calculation_runs r WHERE r.run_id=NEW.run_id AND r.status='building')
BEGIN SELECT RAISE(ABORT,'results can only be added to a building run'); END;

-- The fixed deliverable. content_digest identifies the exact body that was
-- generated; storage_ref names the stored bytes. Re-displaying this artifact
-- and recomputing it under the current rules are different operations, and
-- only the first one is a read of this table (AR03, UC60/AT60).
CREATE TABLE report_artifacts (
 report_id TEXT PRIMARY KEY CHECK(length(report_id) BETWEEN 1 AND 256),
 context_id TEXT NOT NULL CHECK(length(context_id) BETWEEN 1 AND 256),
 purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 128),
 schema_version TEXT NOT NULL CHECK(length(schema_version) BETWEEN 1 AND 64),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
 storage_ref TEXT NOT NULL CHECK(storage_ref GLOB 'reports/*' AND length(storage_ref) BETWEEN 9 AND 512),
 created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 256),
 created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 1 AND 64)
) STRICT;
CREATE INDEX report_artifacts_context ON report_artifacts(context_id,created_at);
CREATE TRIGGER report_artifacts_no_update BEFORE UPDATE ON report_artifacts
BEGIN SELECT RAISE(ABORT,'report artifacts are immutable; a correction is a new report'); END;
CREATE TRIGGER report_artifacts_no_delete BEFORE DELETE ON report_artifacts
BEGIN SELECT RAISE(ABORT,'report artifacts are immutable'); END;

-- Generated, confirmed, externally shared, submitted, corrected and superseded
-- are separate operations, so an agent cannot rewrite a submitted deliverable
-- through one ambiguous "regenerate" (addendum 09 section 9).
CREATE TABLE report_events (
 id INTEGER PRIMARY KEY,
 report_id TEXT NOT NULL REFERENCES report_artifacts(report_id),
 kind TEXT NOT NULL CHECK(kind IN ('generated','confirmed','shared','submitted','corrected','superseded')),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 256),
 related_report_id TEXT REFERENCES report_artifacts(report_id),
 occurred_at TEXT NOT NULL CHECK(length(occurred_at) BETWEEN 1 AND 64),
 -- A correction or supersession names the other report; the others do not.
 CHECK((kind IN ('corrected','superseded')) = (related_report_id IS NOT NULL)),
 CHECK(related_report_id IS NULL OR related_report_id<>report_id)
) STRICT;
CREATE INDEX report_events_report ON report_events(report_id,occurred_at);
CREATE TRIGGER report_events_no_update BEFORE UPDATE ON report_events
BEGIN SELECT RAISE(ABORT,'report events are append-only'); END;
CREATE TRIGGER report_events_no_delete BEFORE DELETE ON report_events
BEGIN SELECT RAISE(ABORT,'report events are append-only'); END;

-- Retention classes. "Immutable evidence" is not a promise of unconditional
-- permanent storage of everything, and it is not a licence to delete on a
-- whim either (AR17). What each class means is recorded here; the concrete
-- legal or contractual retention obligations are NOT decided by this table.
CREATE TABLE retention_classes (
 class_id TEXT PRIMARY KEY CHECK(length(class_id) BETWEEN 1 AND 64),
 description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 1000),
 policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json)='object')
) STRICT;
CREATE TRIGGER retention_classes_no_delete BEFORE DELETE ON retention_classes
BEGIN SELECT RAISE(ABORT,'retention classes are removed only by migration review'); END;
INSERT INTO retention_classes(class_id,description,policy_json) VALUES
 ('secret-session','Credentials, cookies, session and passkey material. Removed at the collection boundary before evidence is retained.',
  '{"retain":"never","atCollectionBoundary":"stripped","replayImpact":"collection cannot be replayed from stored bytes","legalObligation":"undecided"}'),
 ('financial-evidence','Sanitized provider evidence that financial claims are derived from.',
  '{"retain":"until-privileged-removal","normalCorrection":"never-deletes","replayImpact":"removal downgrades affected runs to restricted or unavailable","legalObligation":"undecided"}'),
 ('reference-evidence','Public reference material: product catalogues, rule packages, conversion terms.',
  '{"retain":"versioned","normalCorrection":"new-version","replayImpact":"old versions must survive for old contexts","legalObligation":"undecided"}'),
 ('decision','Human and adopted judgements, approvals and their audit history.',
  '{"retain":"not-rebuildable","normalCorrection":"supersede-not-erase","replayImpact":"loss is unrecoverable by replay","legalObligation":"undecided"}'),
 ('report','Fixed report artifacts, their bodies and their event history.',
  '{"retain":"not-rebuildable","normalCorrection":"new-report","replayImpact":"artifact-preserved even when inputs are gone","legalObligation":"undecided"}'),
 ('cache','Rebuildable projections and derived read models.',
  '{"retain":"disposable","normalCorrection":"rebuild","replayImpact":"none","legalObligation":"undecided"}'),
 ('log','Non-sensitive operational logs: ids, routes, codes, counts and durations.',
  '{"retain":"bounded-window","contains":"no amounts, no raw bodies, no tokens, no provider URLs","replayImpact":"none","legalObligation":"undecided"}');

-- Deletion, key destruction and a use prohibition are recorded, not silently
-- applied. Everything that depended on the evidence is named here so a later
-- audit can downgrade the affected manifests instead of pretending a digest
-- still proves reproducibility. Past authorization is never restored by an
-- old context: the current restriction wins (addendum 06 section 6, UC66).
CREATE TABLE evidence_use_restrictions (
 id INTEGER PRIMARY KEY,
 evidence_ref TEXT NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 512),
 restriction TEXT NOT NULL CHECK(restriction IN ('no-reuse','deleted','key-destroyed')),
 since TEXT NOT NULL CHECK(length(since) BETWEEN 1 AND 64),
 affected_manifests_json TEXT NOT NULL CHECK(json_valid(affected_manifests_json) AND json_type(affected_manifests_json)='array'),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 256),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000)
) STRICT;
CREATE INDEX evidence_use_restrictions_ref ON evidence_use_restrictions(evidence_ref,since);
CREATE TRIGGER evidence_use_restrictions_no_update BEFORE UPDATE ON evidence_use_restrictions
BEGIN SELECT RAISE(ABORT,'evidence use restrictions are append-only'); END;
CREATE TRIGGER evidence_use_restrictions_no_delete BEFORE DELETE ON evidence_use_restrictions
BEGIN SELECT RAISE(ABORT,'evidence use restrictions are append-only'); END;
