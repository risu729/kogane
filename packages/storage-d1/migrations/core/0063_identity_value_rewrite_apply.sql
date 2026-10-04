-- ADR 0030 (amended 2026-09-28): the one-time identity-value rewrite, stage 2
-- of 2. Every pair staged in `identity_value_rewrites` (0062, plus the
-- owner's Vpass rows) replaces the importer-era (`v1`) value by its
-- collector-era (`v2`) value in the importer's stored rows, once. This is the
-- one declared exception to "evidence is never rewritten"
-- (docs/design.md#mutation-policy); no other migration may update evidence
-- without a new ADR. D1 applies a migration atomically: if any guard below
-- fails, nothing of it applies and the deploy stops.
--
-- 1. Guard before: every staged pair is still what 0062's trigger admitted
--    (exactly one importer source account and at least one importer fetch
--    unit carry the old value; no importer source account and at least one
--    fetch unit of another producer carry the new value); the importer's
--    source account of each old value has one account entity (`E_o`) across
--    its rule revisions; and no collector source account of a staged new
--    value has a manual or protected mapping (the "held" count of
--    docs/identity-operations.md).
-- 2. The `*_no_update` guards of the five rewritten tables are dropped. The
--    Layer A guard of `fetch_units` is dropped with IF EXISTS: the test stubs
--    of Layer A declare `fetch_units` without its guards and still run every
--    CORE migration; every deployed CORE database has it since 0001.
-- 3. Five columns take the new value, only in the importer's
--    (`collector-r2-importer`) rows of a staged old value:
--    `fetch_units.unit_key` of the importer's runs of that source (for Vpass
--    the binding run's card unit, for MoneyForward the account unit);
--    `identity_vpass_bindings.card_token` of pins on an importer unit;
--    `source_accounts.reference_json` of the importer's source account, in
--    the exact JSON the identity store writes (`JSON.stringify` of
--    `["vpass:card", token]` or `["moneyforward-me:<value>"]`, which
--    `json_array` reproduces byte for byte for these values);
--    `transaction_observations.source_account` (`moneyforward-me:<value>`,
--    what the MoneyForward parser writes from the unit key) of the importer's
--    MoneyForward parses; and `account_connection_reviews.connection_key` of
--    the importer's reviews. Every hashed id, external id, amount, date,
--    `extra_json`, R2 object, run and unit report key, range key, identity
--    run policy and `accounts` row stays as recorded.
-- 4. Each collector (any non-importer producer) source account of a staged
--    new value gets one appended `rule` mapping revision to `E_o`, with its
--    current revision's policy version, label and status and the reason
--    `identity-value-rewrite`; its id is its current rule id's base with the
--    new revision (`<base>-r<n>`, the form the identity store gives a later
--    automatic revision). The collector-era entity (`E_n`) stays in
--    `accounts` with no current mapping.
-- 5. Guard after: no staged old value remains in the five columns (in any
--    producer's rows), nor as `moneyforward-me:<old>` in the balance,
--    position, valuation or scheduled-payment observations; each importer
--    source account now carries its new value; and every collector source
--    account of a staged new value maps to `E_o`.
-- 6. The dropped guards are recreated with their exact text (0001, 0017,
--    0018, 0023, 0057), and `identity_value_rewrites` is dropped with its
--    triggers. An empty stage changes nothing but that drop.

CREATE TABLE identity_value_rewrite_0063_guard (
 stage_invalid INTEGER NOT NULL CONSTRAINT identity_value_rewrite_stage_invalid CHECK(stage_invalid=0),
 entity_ambiguous INTEGER NOT NULL CONSTRAINT identity_value_rewrite_entity_ambiguous CHECK(entity_ambiguous=0),
 mapping_held INTEGER NOT NULL CONSTRAINT identity_value_rewrite_mapping_held CHECK(mapping_held=0)
) STRICT;
INSERT INTO identity_value_rewrite_0063_guard(stage_invalid,entity_ambiguous,mapping_held)
SELECT
 (SELECT count(*) FROM identity_value_rewrites x
  WHERE (SELECT count(*) FROM source_accounts sa
    WHERE sa.source_id=x.source_id AND sa.producer_id='collector-r2-importer'
     AND sa.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card',x.old_value)
      ELSE json_array('moneyforward-me:'||x.old_value) END)<>1
   OR NOT EXISTS(SELECT 1 FROM fetch_units u JOIN fetch_runs r ON r.id=u.fetch_run_id
    WHERE r.source_id=x.source_id AND r.producer_id='collector-r2-importer' AND u.unit_key=x.old_value)
   OR EXISTS(SELECT 1 FROM source_accounts sa
    WHERE sa.source_id=x.source_id AND sa.producer_id='collector-r2-importer'
     AND sa.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card',x.new_value)
      ELSE json_array('moneyforward-me:'||x.new_value) END)
   OR NOT EXISTS(SELECT 1 FROM fetch_units u JOIN fetch_runs r ON r.id=u.fetch_run_id
    WHERE r.source_id=x.source_id AND r.producer_id<>'collector-r2-importer' AND u.unit_key=x.new_value)),
 (SELECT count(*) FROM identity_value_rewrites x
   JOIN source_accounts sa ON sa.source_id=x.source_id AND sa.producer_id='collector-r2-importer'
    AND sa.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card',x.old_value)
     ELSE json_array('moneyforward-me:'||x.old_value) END
  WHERE (SELECT count(DISTINCT m.account_id) FROM account_mappings m
    WHERE m.source_account_id=sa.id AND m.method='rule')<>1),
 (SELECT count(*) FROM identity_value_rewrites x
   JOIN source_accounts c ON c.source_id=x.source_id AND c.producer_id<>'collector-r2-importer'
    AND c.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card',x.new_value)
     ELSE json_array('moneyforward-me:'||x.new_value) END
   JOIN current_account_mappings m ON m.source_account_id=c.id
  WHERE m.method<>'rule'
   OR EXISTS(SELECT 1 FROM protected_mapping_subjects p
    WHERE p.subject_kind='account_mapping' AND p.subject_ref=c.id));
DROP TABLE identity_value_rewrite_0063_guard;

DROP TRIGGER IF EXISTS fetch_units_no_update;
DROP TRIGGER identity_vpass_bindings_no_update;
DROP TRIGGER source_accounts_no_update;
DROP TRIGGER transaction_observations_no_update;
DROP TRIGGER account_connection_no_update;

UPDATE fetch_units SET unit_key=(SELECT x.new_value FROM identity_value_rewrites x
  JOIN fetch_runs r ON r.id=fetch_units.fetch_run_id AND r.source_id=x.source_id
   AND r.producer_id='collector-r2-importer'
  WHERE x.old_value=fetch_units.unit_key)
WHERE unit_key IN (SELECT old_value FROM identity_value_rewrites)
 AND EXISTS(SELECT 1 FROM identity_value_rewrites x
  JOIN fetch_runs r ON r.id=fetch_units.fetch_run_id AND r.source_id=x.source_id
   AND r.producer_id='collector-r2-importer'
  WHERE x.old_value=fetch_units.unit_key);

UPDATE identity_vpass_bindings SET card_token=(SELECT x.new_value FROM identity_value_rewrites x
  WHERE x.source_id='vpass' AND x.old_value=identity_vpass_bindings.card_token)
WHERE card_token IN (SELECT old_value FROM identity_value_rewrites WHERE source_id='vpass')
 AND financial_unit_id IN (SELECT u.id FROM fetch_units u JOIN fetch_runs r ON r.id=u.fetch_run_id
  WHERE r.source_id='vpass' AND r.producer_id='collector-r2-importer');

UPDATE source_accounts SET reference_json=(SELECT CASE x.source_id
   WHEN 'vpass' THEN json_array('vpass:card',x.new_value)
   ELSE json_array('moneyforward-me:'||x.new_value) END
  FROM identity_value_rewrites x WHERE x.source_id=source_accounts.source_id
   AND source_accounts.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card',x.old_value)
    ELSE json_array('moneyforward-me:'||x.old_value) END)
WHERE producer_id='collector-r2-importer'
 AND EXISTS(SELECT 1 FROM identity_value_rewrites x WHERE x.source_id=source_accounts.source_id
  AND source_accounts.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card',x.old_value)
   ELSE json_array('moneyforward-me:'||x.old_value) END);

UPDATE transaction_observations SET source_account='moneyforward-me:'||(SELECT x.new_value
  FROM identity_value_rewrites x WHERE x.source_id='moneyforward-me'
   AND 'moneyforward-me:'||x.old_value=transaction_observations.source_account)
WHERE source_account IN (SELECT 'moneyforward-me:'||old_value FROM identity_value_rewrites
  WHERE source_id='moneyforward-me')
 AND parse_run_id IN (SELECT p.id FROM parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
  JOIN fetch_runs r ON r.id=a.fetch_run_id
  WHERE r.source_id='moneyforward-me' AND r.producer_id='collector-r2-importer');

UPDATE account_connection_reviews SET connection_key=(SELECT x.new_value FROM identity_value_rewrites x
  WHERE x.source_id='moneyforward-me' AND x.old_value=account_connection_reviews.connection_key)
WHERE producer_id='collector-r2-importer'
 AND connection_key IN (SELECT old_value FROM identity_value_rewrites WHERE source_id='moneyforward-me');

INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
SELECT CASE WHEN m.id GLOB '*-r[0-9]*' THEN substr(m.id,1,instr(m.id,'-r')-1) ELSE m.id END||'-r'||(m.revision+1),
 c.id,m.revision+1,
 (SELECT e.account_id FROM account_mappings e WHERE e.source_account_id=o.id AND e.method='rule'
  ORDER BY e.revision DESC LIMIT 1),
 'rule','identity-value-rewrite',m.policy_version,strftime('%Y-%m-%dT%H:%M:%fZ','now'),m.label,m.status
FROM identity_value_rewrites x
JOIN source_accounts o ON o.source_id=x.source_id AND o.producer_id='collector-r2-importer'
 AND o.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card',x.new_value)
  ELSE json_array('moneyforward-me:'||x.new_value) END
JOIN source_accounts c ON c.source_id=x.source_id AND c.producer_id<>'collector-r2-importer'
 AND c.reference_json=o.reference_json
JOIN current_account_mappings m ON m.source_account_id=c.id
WHERE m.account_id<>(SELECT e.account_id FROM account_mappings e WHERE e.source_account_id=o.id
  AND e.method='rule' ORDER BY e.revision DESC LIMIT 1)
ORDER BY c.id;

CREATE TABLE identity_value_rewrite_0063_check (
 old_values_remaining INTEGER NOT NULL CONSTRAINT identity_value_rewrite_old_value_remains CHECK(old_values_remaining=0),
 importer_unmoved INTEGER NOT NULL CONSTRAINT identity_value_rewrite_importer_unmoved CHECK(importer_unmoved=0),
 collector_unjoined INTEGER NOT NULL CONSTRAINT identity_value_rewrite_collector_unjoined CHECK(collector_unjoined=0)
) STRICT;
INSERT INTO identity_value_rewrite_0063_check(old_values_remaining,importer_unmoved,collector_unjoined)
SELECT
 (SELECT count(*) FROM fetch_units WHERE unit_key IN (SELECT old_value FROM identity_value_rewrites))
 +(SELECT count(*) FROM identity_vpass_bindings WHERE card_token IN (SELECT old_value FROM identity_value_rewrites))
 +(SELECT count(*) FROM source_accounts sa JOIN identity_value_rewrites x ON x.source_id=sa.source_id
   AND sa.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card',x.old_value)
    ELSE json_array('moneyforward-me:'||x.old_value) END)
 +(SELECT count(*) FROM account_connection_reviews WHERE connection_key IN (SELECT old_value FROM identity_value_rewrites))
 +(SELECT count(*) FROM transaction_observations WHERE source_account IN
   (SELECT 'moneyforward-me:'||old_value FROM identity_value_rewrites WHERE source_id='moneyforward-me'))
 +(SELECT count(*) FROM balance_observations WHERE source_account IN
   (SELECT 'moneyforward-me:'||old_value FROM identity_value_rewrites WHERE source_id='moneyforward-me'))
 +(SELECT count(*) FROM position_observations WHERE source_account IN
   (SELECT 'moneyforward-me:'||old_value FROM identity_value_rewrites WHERE source_id='moneyforward-me'))
 +(SELECT count(*) FROM valuation_observations WHERE source_account IN
   (SELECT 'moneyforward-me:'||old_value FROM identity_value_rewrites WHERE source_id='moneyforward-me'))
 +(SELECT count(*) FROM scheduled_payment_observations WHERE source_account IN
   (SELECT 'moneyforward-me:'||old_value FROM identity_value_rewrites WHERE source_id='moneyforward-me')),
 (SELECT count(*) FROM identity_value_rewrites x
  WHERE (SELECT count(*) FROM source_accounts sa
    WHERE sa.source_id=x.source_id AND sa.producer_id='collector-r2-importer'
     AND sa.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card',x.new_value)
      ELSE json_array('moneyforward-me:'||x.new_value) END)<>1),
 (SELECT count(*) FROM identity_value_rewrites x
   JOIN source_accounts o ON o.source_id=x.source_id AND o.producer_id='collector-r2-importer'
    AND o.reference_json=CASE x.source_id WHEN 'vpass' THEN json_array('vpass:card',x.new_value)
     ELSE json_array('moneyforward-me:'||x.new_value) END
   JOIN source_accounts c ON c.source_id=x.source_id AND c.producer_id<>'collector-r2-importer'
    AND c.reference_json=o.reference_json
   JOIN current_account_mappings m ON m.source_account_id=c.id
  WHERE m.account_id<>(SELECT e.account_id FROM account_mappings e WHERE e.source_account_id=o.id
    AND e.method='rule' ORDER BY e.revision DESC LIMIT 1));
DROP TABLE identity_value_rewrite_0063_check;

CREATE TRIGGER fetch_units_no_update BEFORE UPDATE ON fetch_units
BEGIN SELECT RAISE(ABORT, 'fetch_units is append-only'); END;
CREATE TRIGGER identity_vpass_bindings_no_update BEFORE UPDATE ON identity_vpass_bindings
BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER source_accounts_no_update BEFORE UPDATE ON source_accounts BEGIN SELECT RAISE(ABORT,'identity is append-only'); END;
CREATE TRIGGER transaction_observations_no_update BEFORE UPDATE ON transaction_observations BEGIN SELECT RAISE(ABORT,'transaction_observations is append-only'); END;
CREATE TRIGGER account_connection_no_update BEFORE UPDATE ON account_connection_reviews BEGIN SELECT RAISE(ABORT,'connection reviews are append-only'); END;

DROP TABLE identity_value_rewrites;
