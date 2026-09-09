-- Latest-balance read model (design review D10/D11, architecture addendum A07).
--
-- Additive and derived only. No Layer A or Layer B row, view, trigger or
-- parser contract is touched, and a Worker build that predates this migration
-- keeps reading and writing exactly as before because it never names the
-- tables below.
--
-- What these tables are: a projection that can be deleted and rebuilt from
-- the same declared inputs (published parses, identity release, metric
-- registry release, decimal policy, projection release). They are never the
-- record of what a provider reported; that stays in balance_observations.
-- Repairing a wrong projection is a rebuild, never a DELETE against Layer B
-- (review 06, "forbidden optimisations").
--
-- Why a snapshot: a list that pages must not change membership between pages.
-- A raw high-water mark alone cannot do that, because a later publication or
-- a mapping correction changes which parse a scope resolves to. The snapshot
-- id is the digest of the whole input context, so a new publication produces
-- a new snapshot rather than mutating the one a reader is paging.

-- One build of the projection. `status` is the only mutable column that
-- matters to readers: rows are written while 'building', the snapshot is
-- sealed to 'complete' in one statement after every row exists, and a
-- superseded build is 'retired' before its rows are deleted. A reader that
-- only ever selects 'complete' therefore never observes a partial build
-- (INV10) and never observes a half-deleted one.
CREATE TABLE balance_read_snapshots (
  snapshot_id TEXT PRIMARY KEY
    CHECK(length(snapshot_id)=64 AND snapshot_id NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  -- The declared inputs the id digests: published high-water parse run,
  -- identity release, metric registry release, decimal policy, projection
  -- release. Identifiers and release names only; never provider values.
  input_manifest_json TEXT NOT NULL
    CHECK(json_valid(input_manifest_json) AND json_type(input_manifest_json)='object'),
  status TEXT NOT NULL CHECK(status IN ('building','complete','retired')),
  row_count INTEGER NOT NULL CHECK(row_count>=0),
  projection_release TEXT NOT NULL CHECK(length(projection_release) BETWEEN 1 AND 64),
  -- Resume point of a bounded build: the last scope_key written, or NULL
  -- before the first invocation. Operational state, not a fact.
  build_cursor TEXT,
  sealed_at TEXT,
  CHECK((status='building') = (sealed_at IS NULL))
) STRICT;
CREATE INDEX balance_read_snapshots_status ON balance_read_snapshots(status,created_at);

-- A snapshot only moves building -> complete -> retired, and its declared
-- inputs never change: a different input context is a different snapshot id.
CREATE TRIGGER balance_read_snapshots_transition BEFORE UPDATE ON balance_read_snapshots
WHEN NEW.snapshot_id<>OLD.snapshot_id OR NEW.created_at<>OLD.created_at
 OR NEW.input_manifest_json<>OLD.input_manifest_json
 OR NEW.projection_release<>OLD.projection_release
 OR NOT ((OLD.status='building' AND NEW.status IN ('building','complete','retired'))
      OR (OLD.status='complete' AND NEW.status='retired')
      OR (OLD.status='retired' AND NEW.status='retired'))
BEGIN SELECT RAISE(ABORT,'invalid balance snapshot transition'); END;

-- One row per candidate measurement of the snapshot.
--
-- `scope_key` is the structured, unique key of the candidate (source, fetch
-- unit, parser family, account, provider metric, unit); `subject_scope_key`
-- is the scope whose relations decide adoption, so two routes reporting the
-- same account share a subject but keep separate candidate rows and separate
-- evidence.
--
-- `row_seq` is a dense sequence assigned at build time in the contract order
-- (as_of descending, scope_key ascending). It is what a cursor carries, so a
-- cursor never contains an account label, a provider metric or an amount.
CREATE TABLE current_balance_projection (
  snapshot_id TEXT NOT NULL REFERENCES balance_read_snapshots(snapshot_id),
  scope_key TEXT NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 1024),
  subject_scope_key TEXT NOT NULL CHECK(length(subject_scope_key) BETWEEN 1 AND 1024),
  row_seq INTEGER NOT NULL CHECK(row_seq>=0),
  -- Reference of the observation that represents the measurement, and every
  -- witness bundled into it (the representative included). Evidence count is
  -- deliberately separate from the balance count (addendum 11 section 4).
  representative_observation_ref TEXT NOT NULL,
  member_evidence_refs_json TEXT NOT NULL
    CHECK(json_valid(member_evidence_refs_json) AND json_type(member_evidence_refs_json)='array'),
  -- Distinct provider metrics among those witnesses. The metric filter reads
  -- this rather than the representative's own column, so filtering can never
  -- split a bundled measurement or hide it behind the other witness's name.
  member_metrics_json TEXT NOT NULL
    CHECK(json_valid(member_metrics_json) AND json_type(member_metrics_json)='array'),
  evidence_count INTEGER NOT NULL CHECK(evidence_count>=1),
  metric_id TEXT NOT NULL,
  definition_release TEXT NOT NULL,
  -- decimal-v1 value state; a non-exact status never becomes zero (INV05).
  quantity_coefficient TEXT,
  quantity_scale INTEGER,
  value_status TEXT NOT NULL CHECK(value_status IN ('exact','missing','unparsed','conflict')),
  unit_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('adopted','excluded','unresolved','conflict','stale')),
  reason_code TEXT,
  -- TemporalReference: the role, the kind, the stored value, and the whole
  -- structure for the API. A date is never promoted to an instant.
  as_of_role TEXT NOT NULL,
  as_of_kind TEXT NOT NULL CHECK(as_of_kind IN ('instant','local-date','period','unknown')),
  as_of_value TEXT,
  temporal_json TEXT NOT NULL CHECK(json_valid(temporal_json)),
  freshness TEXT NOT NULL CHECK(freshness IN ('current','stale','unknown')),
  freshness_reason TEXT,
  -- Total ordering key of the temporal value; unknown times sort last.
  sort_as_of TEXT NOT NULL,
  -- Display and filter columns, carried so a page needs no second join.
  source_id TEXT NOT NULL,
  source_account TEXT NOT NULL,
  metric TEXT NOT NULL,
  instrument TEXT NOT NULL,
  parser TEXT NOT NULL,
  observation_id INTEGER NOT NULL,
  parse_run_id INTEGER NOT NULL,
  fetch_artifact_id INTEGER NOT NULL,
  amount_minor TEXT,
  amount_text TEXT,
  as_of TEXT,
  observed_at TEXT,
  measure_view TEXT NOT NULL CHECK(measure_view IN ('balances','summaries')),
  -- 1 when the row is the latest witness of its group. The summaries view
  -- additionally keeps every statement month of the newest capture, so the
  -- projection holds their union and each view selects its own subset; the
  -- unfiltered list is exactly the rows with latest_in_group=1, as today.
  latest_in_group INTEGER NOT NULL CHECK(latest_in_group IN (0,1)),
  PRIMARY KEY(snapshot_id,scope_key),
  CHECK((value_status='exact') = (quantity_coefficient IS NOT NULL AND quantity_scale IS NOT NULL)),
  CHECK(quantity_scale IS NULL OR (quantity_scale BETWEEN 0 AND 4096))
) STRICT;
-- The paging index: one keyed range scan per page, in the contract order.
CREATE UNIQUE INDEX current_balance_projection_order
  ON current_balance_projection(snapshot_id,row_seq);
-- Filtered pages stay on the ordered index; this one serves the subtotal and
-- filter-option reads that select by scope rather than by position.
CREATE INDEX current_balance_projection_scope
  ON current_balance_projection(snapshot_id,source_id,source_account,instrument,metric);
CREATE INDEX current_balance_projection_state
  ON current_balance_projection(snapshot_id,state,metric_id,unit_ref);

-- Rows exist only inside a build, and a sealed build is immutable. Deleting a
-- retired snapshot's rows is allowed: that is the rebuild path.
CREATE TRIGGER current_balance_projection_building_only BEFORE INSERT ON current_balance_projection
WHEN NOT EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'balance projection rows need a building snapshot'); END;
CREATE TRIGGER current_balance_projection_sealed_no_update BEFORE UPDATE ON current_balance_projection
WHEN EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status<>'building')
BEGIN SELECT RAISE(ABORT,'a sealed balance snapshot is immutable'); END;
CREATE TRIGGER current_balance_projection_sealed_no_delete BEFORE DELETE ON current_balance_projection
WHEN EXISTS(SELECT 1 FROM balance_read_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status='complete')
BEGIN SELECT RAISE(ABORT,'retire the snapshot before deleting its rows'); END;

-- Typed relations between measurement scopes, derived per release from the
-- adopted entity_relations of migration 0029 and from explicit policy. An
-- unknown overlap is absent here; it is never written as 'disjoint' (INV06,
-- SC01, SC06). `source` says where the claim came from so a policy default
-- can be told apart from a human decision.
CREATE TABLE scope_relations (
  from_scope_key TEXT NOT NULL CHECK(length(from_scope_key) BETWEEN 1 AND 1024),
  to_scope_key TEXT NOT NULL
    CHECK(length(to_scope_key) BETWEEN 1 AND 1024 AND to_scope_key<>from_scope_key),
  relation TEXT NOT NULL CHECK(relation IN ('same','disjoint','subset','overlaps','unknown')),
  source TEXT NOT NULL CHECK(source IN ('policy','decision','derived')),
  decision_revision_id TEXT REFERENCES decision_revisions(id),
  release TEXT NOT NULL CHECK(length(release) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(from_scope_key,to_scope_key,release),
  CHECK((source='decision') = (decision_revision_id IS NOT NULL))
) STRICT;
CREATE INDEX scope_relations_release ON scope_relations(release,from_scope_key);
