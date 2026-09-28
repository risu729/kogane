-- ADR 0030 (amended 2026-09-28): the one-time identity-value rewrite, stage 1
-- of 2. The crosswalk of 0058 is retired; its table is dropped here, and the
-- importer-era identity values are instead replaced in place by their
-- collector-era values by the next migration (0063, a separate change), which
-- reads the pairs staged here.
--
-- 1. Guard: `account_identity_crosswalk` must hold no row. The crosswalk
--    command never ran in production; if a row exists, this migration aborts
--    and nothing below applies (D1 applies a migration atomically).
-- 2. `identity_value_rewrites`: the staged (old, new) pairs, one per
--    importer-era value and one per collector-era value per source. A work
--    list, not evidence: classified `operational-mutable`, and the rewrite
--    migration drops it once it has applied the pairs. Rows hold opaque
--    identity values (a prefix and 64 lowercase hex digits) and a basis code,
--    never a provider value.
-- 3. A validation trigger on every insert, whoever inserts: the old value is
--    importer-era (exactly one `collector-r2-importer` source account carries
--    it, and at least one importer fetch unit is keyed by it); the new value
--    is collector-era (no importer source account carries it, and at least one
--    fetch unit of another producer is keyed by it); and neither value is
--    already staged on either side, so no pair is many-to-one and no chain
--    (a -> b -> c) can form.
-- 4. The MoneyForward pairs the stored evidence already proves: the
--    shared-rows rule that the removed module `identity-crosswalk.ts`
--    stated for the crosswalk proposals, restricted to `moneyforward-me` and
--    to the one-to-one (`unique`) pairs of a `v1` old value and a `v2` new
--    value. Vpass pairs are not derivable this way (no collector-era Vpass row
--    is parsed yet, ADR 0023) and are inserted by the owner, with basis
--    `owner-recomputed`, between this migration and the rewrite
--    (docs/identity-operations.md).
-- 5. The crosswalk table is dropped (its two triggers go with it). Migration
--    0058 stays as history. The retired command kind
--    `identity.crosswalk.accept` stays admitted by the kind CHECKKs of
--    `change_plans` and `operation_receipts`: removing it would rebuild four
--    command tables for no row, and the application's closed vocabulary
--    already refuses it, so no plan of it can be created.

CREATE TABLE identity_value_rewrite_0062_guard (
 crosswalk_rows INTEGER NOT NULL CHECK(crosswalk_rows=0)
) STRICT;
INSERT INTO identity_value_rewrite_0062_guard(crosswalk_rows)
 SELECT count(*) FROM account_identity_crosswalk;
DROP TABLE identity_value_rewrite_0062_guard;

CREATE TABLE identity_value_rewrites (
 source_id TEXT NOT NULL CHECK(source_id IN ('vpass','moneyforward-me')),
 -- The importer-era value (v1) and the collector-era value (v2) it becomes.
 old_value TEXT NOT NULL,
 new_value TEXT NOT NULL,
 -- How the pair is known: `shared-rows`, the stored overlap (MoneyForward,
 -- staged below); `owner-recomputed`, a pair the owner established outside
 -- the stored rows and inserted by hand (Vpass).
 basis TEXT NOT NULL CHECK(basis IN ('shared-rows','owner-recomputed')),
 CHECK(CASE source_id
  WHEN 'vpass' THEN old_value GLOB 'vpass-card-v1-*' AND length(old_value)=78
   AND substr(old_value,15) NOT GLOB '*[^0-9a-f]*'
   AND new_value GLOB 'vpass-card-v2-*' AND length(new_value)=78
   AND substr(new_value,15) NOT GLOB '*[^0-9a-f]*'
  WHEN 'moneyforward-me' THEN old_value GLOB 'moneyforward-account-v1-*' AND length(old_value)=88
   AND substr(old_value,25) NOT GLOB '*[^0-9a-f]*'
   AND new_value GLOB 'moneyforward-account-v2-*' AND length(new_value)=88
   AND substr(new_value,25) NOT GLOB '*[^0-9a-f]*'
  ELSE 0 END),
 UNIQUE(source_id,old_value),
 UNIQUE(source_id,new_value)
) STRICT;

CREATE TRIGGER identity_value_rewrites_old_known BEFORE INSERT ON identity_value_rewrites
WHEN (SELECT count(*) FROM source_accounts sa
  WHERE sa.source_id=NEW.source_id AND sa.producer_id='collector-r2-importer'
   AND sa.reference_json=CASE NEW.source_id WHEN 'vpass' THEN json_array('vpass:card',NEW.old_value)
    ELSE json_array('moneyforward-me:'||NEW.old_value) END)<>1
 OR NOT EXISTS(SELECT 1 FROM fetch_units u JOIN fetch_runs r ON r.id=u.fetch_run_id
  WHERE r.source_id=NEW.source_id AND r.producer_id='collector-r2-importer' AND u.unit_key=NEW.old_value)
BEGIN SELECT RAISE(ABORT,'identity_value_rewrite_old_unknown'); END;
CREATE TRIGGER identity_value_rewrites_new_known BEFORE INSERT ON identity_value_rewrites
WHEN EXISTS(SELECT 1 FROM source_accounts sa
  WHERE sa.source_id=NEW.source_id AND sa.producer_id='collector-r2-importer'
   AND sa.reference_json=CASE NEW.source_id WHEN 'vpass' THEN json_array('vpass:card',NEW.new_value)
    ELSE json_array('moneyforward-me:'||NEW.new_value) END)
 OR NOT EXISTS(SELECT 1 FROM fetch_units u JOIN fetch_runs r ON r.id=u.fetch_run_id
  WHERE r.source_id=NEW.source_id AND r.producer_id<>'collector-r2-importer' AND u.unit_key=NEW.new_value)
BEGIN SELECT RAISE(ABORT,'identity_value_rewrite_new_unknown'); END;
CREATE TRIGGER identity_value_rewrites_one_to_one BEFORE INSERT ON identity_value_rewrites
WHEN EXISTS(SELECT 1 FROM identity_value_rewrites x WHERE x.source_id=NEW.source_id
  AND (x.old_value IN (NEW.old_value,NEW.new_value) OR x.new_value IN (NEW.old_value,NEW.new_value)))
BEGIN SELECT RAISE(ABORT,'identity_value_rewrite_not_one_to_one'); END;

-- The shared-rows rule (ADR 0030, first form), MoneyForward only. A row is
-- what the external id's fingerprint covers besides the identity (the
-- selected month, the date, the description and the stored amount) plus the
-- occurrence counter the id ends with (`moneyforward-monthly:<32 hex>:<n>`),
-- read from current transaction observations (published parses of successful
-- runs) filed under an identity value. A value is importer-era when its
-- source account's producer is `collector-r2-importer`. A pair is staged when
-- the new value shares rows with exactly one old value, that old value shares
-- rows with no other new value, the importer does not itself carry the new
-- value, and the pair is a v1 old value and a v2 new value. Uniqueness is
-- measured over every pair before the shape filter, so a pair that is unique
-- only because a differently-shaped competitor was left out is not staged.
INSERT INTO identity_value_rewrites(source_id,old_value,new_value,basis)
WITH shared_rows AS MATERIALIZED (
 SELECT DISTINCT era,key_ref,row_key FROM (
  SELECT CASE WHEN sa.producer_id='collector-r2-importer' THEN 'old' ELSE 'new' END AS era,
   CASE WHEN json_array_length(sa.reference_json)=1 AND json_type(sa.reference_json,'$[0]')='text'
     AND substr(json_extract(sa.reference_json,'$[0]'),1,16)='moneyforward-me:'
    THEN substr(json_extract(sa.reference_json,'$[0]'),17) END AS key_ref,
   CASE WHEN substr(t.external_id,1,21)='moneyforward-monthly:'
     AND substr(t.external_id,54,1)=':' AND length(t.external_id)>54
    THEN json_array(json_extract(t.extra_json,'$._kogane.selectedMonth'),t.as_of,t.description,
     t.amount_text,substr(t.external_id,55)) END AS row_key
  FROM current_identity_observations o
  JOIN source_accounts sa ON sa.id=o.source_account_id
  JOIN transaction_observations t ON t.id=o.observation_id
  WHERE o.kind='transaction' AND sa.source_id='moneyforward-me'
 ) WHERE key_ref IS NOT NULL AND row_key IS NOT NULL
  AND key_ref GLOB 'moneyforward-account-v[12]-*' AND length(key_ref)=88
  AND substr(key_ref,25) NOT GLOB '*[^0-9a-f]*'
), shared_pairs AS MATERIALIZED (
 SELECT n.key_ref AS new_value,o.key_ref AS old_value,count(DISTINCT n.row_key) AS shared
 FROM shared_rows n JOIN shared_rows o ON o.row_key=n.row_key AND o.era='old' AND o.key_ref<>n.key_ref
 WHERE n.era='new' GROUP BY 1,2
)
SELECT 'moneyforward-me',p.old_value,p.new_value,'shared-rows'
FROM shared_pairs p
WHERE p.shared>0
 AND NOT EXISTS(SELECT 1 FROM shared_pairs q WHERE q.new_value=p.new_value AND q.old_value<>p.old_value)
 AND NOT EXISTS(SELECT 1 FROM shared_pairs q WHERE q.old_value=p.old_value AND q.new_value<>p.new_value)
 AND NOT EXISTS(SELECT 1 FROM shared_rows r WHERE r.era='old' AND r.key_ref=p.new_value)
 AND p.old_value GLOB 'moneyforward-account-v1-*' AND p.new_value GLOB 'moneyforward-account-v2-*'
ORDER BY p.old_value;

DROP TABLE account_identity_crosswalk;
