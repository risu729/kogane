-- Card purchase recognition (schema only; no writer runs yet). Additive only:
-- no existing table, view, trigger or row is altered, and a Worker build that
-- predates this migration keeps working because it never reads or writes the
-- objects below. The one new object on an existing table is the
-- card_purchase_recognition_legs_sealed trigger on economic_legs; it fires
-- only for a revision that already has a sidecar row here, which no existing
-- writer (card settlements, reconciliation) ever creates.
--
-- A recognised purchase is an ordinary economic event (0032): a `purchase` or
-- `refund` revision on the `purchase-recognition` basis with a rule decision
-- (0029). These two sidecar tables record, per revision, which policy wrote it
-- and from which provider rows. Both are append-only; the only pointer that
-- ever moves is economic_event_revisions.superseded_by, guarded by 0032.
--
-- The core invariant is here: a recognition key is held by at most one live
-- event, so one provider row can never be counted as two purchases.

-- One row per recognised event revision. facts_json carries codes, amounts and
-- dates only: its keys and every value are checked below (closed code sets, a
-- date, an exact decimal), so no merchant or other provider text can be
-- stored in it.
CREATE TABLE card_purchase_recognitions (
 event_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 policy_release TEXT NOT NULL CHECK(length(policy_release) BETWEEN 1 AND 128),
 action TEXT NOT NULL CHECK(action IN ('recognize','revise','reanchor','retire','merge','split')),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
 account_id TEXT NOT NULL REFERENCES accounts(id),
 source_id TEXT NOT NULL CHECK(source_id IN ('vpass','myjcb')),
 statement_period TEXT CHECK(statement_period IS NULL OR (length(statement_period)=7
  AND statement_period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(statement_period,6,2) BETWEEN '01' AND '12')),
 facts_json TEXT NOT NULL CHECK(length(facts_json)<=4096 AND json_valid(facts_json) AND json_type(facts_json)='object'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(event_id,revision),
 FOREIGN KEY(event_id,revision) REFERENCES economic_event_revisions(event_id,revision)
) STRICT;
CREATE INDEX card_purchase_recognitions_account ON card_purchase_recognitions(account_id,source_id,statement_period);
CREATE TRIGGER card_purchase_recognitions_no_update BEFORE UPDATE ON card_purchase_recognitions BEGIN SELECT RAISE(ABORT,'card purchase recognitions are append-only'); END;
CREATE TRIGGER card_purchase_recognitions_no_delete BEFORE DELETE ON card_purchase_recognitions BEGIN SELECT RAISE(ABORT,'card purchase recognitions are append-only'); END;
CREATE TRIGGER card_purchase_recognitions_no_replace BEFORE INSERT ON card_purchase_recognitions
WHEN EXISTS(SELECT 1 FROM card_purchase_recognitions WHERE event_id=NEW.event_id AND revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'card purchase recognition replacement is forbidden'); END;
-- The sidecar describes the one live revision of a purchase/refund event on
-- the purchase-recognition basis (any earlier revision is already superseded,
-- so the batch order is revision -> legs -> supersede -> sidecar -> keys). Its
-- state is the displayed row's: `authorized` from an unconfirmed row,
-- `captured` from a posted/confirmed one. A retirement is exactly the
-- `unknown` state and has no leg; every other revision has exactly one exact,
-- positive purchase-recognition leg on account:<account_id> (a purchase
-- decreases net position, a refund increases it) and therefore no
-- cash-movement leg. That leg is the magnitude of the displayed row's exact
-- amount in facts_json, whose sign matches the kind (outflow negative: a
-- purchase is negative, a refund positive).
CREATE TRIGGER card_purchase_recognitions_guard BEFORE INSERT ON card_purchase_recognitions
WHEN NOT EXISTS(SELECT 1 FROM economic_event_revisions r
  WHERE r.event_id=NEW.event_id AND r.revision=NEW.revision AND r.superseded_by IS NULL
  AND r.kind IN ('purchase','refund') AND r.basis='purchase-recognition'
  AND (NEW.action='retire')=(r.state='unknown')
  AND CASE r.state WHEN 'unknown' THEN 1
   WHEN 'authorized' THEN json_extract(NEW.facts_json,'$.providerStatus')='unconfirmed'
   WHEN 'captured' THEN json_extract(NEW.facts_json,'$.providerStatus') IN ('posted','confirmed') ELSE 0 END
  AND (r.kind='purchase')=(json_extract(NEW.facts_json,'$.amount.value.value.coefficient') GLOB '-*')
  AND json_extract(NEW.facts_json,'$.providerSaleCode') IS NOT CASE r.kind WHEN 'purchase' THEN '6' ELSE '5' END)
 OR EXISTS(SELECT 1 FROM economic_event_revisions o
  WHERE o.event_id=NEW.event_id AND o.revision<>NEW.revision AND o.superseded_by IS NULL)
 OR (NEW.action='retire' AND EXISTS(SELECT 1 FROM economic_legs l WHERE l.event_id=NEW.event_id AND l.revision=NEW.revision))
 OR (NEW.action<>'retire' AND (
  (SELECT count(*) FROM economic_legs l WHERE l.event_id=NEW.event_id AND l.revision=NEW.revision)<>1
  OR NOT EXISTS(SELECT 1 FROM economic_legs l
   JOIN economic_event_revisions r ON r.event_id=l.event_id AND r.revision=l.revision
   WHERE l.event_id=NEW.event_id AND l.revision=NEW.revision AND l.leg_index=0
   AND l.basis='purchase-recognition' AND l.value_status='exact'
   AND l.coefficient<>'0' AND l.coefficient NOT GLOB '-*'
   AND l.subject_ref='account:'||NEW.account_id
   AND l.role=CASE r.kind WHEN 'purchase' THEN 'decrease' ELSE 'increase' END
   AND l.unit_ref=json_extract(NEW.facts_json,'$.amount.unitRef')
   AND l.coefficient=ltrim(json_extract(NEW.facts_json,'$.amount.value.value.coefficient'),'-')
   AND l.scale=json_extract(NEW.facts_json,'$.amount.value.value.scale'))))
BEGIN SELECT RAISE(ABORT,'card_purchase_recognition_invalid'); END;
-- facts_json is exactly {providerStatus, amount, usageDate, paymentType,
-- amountCheck, providerSaleCode} (packages/domain/src/card-purchase.ts
-- validCardPurchaseFacts): each key once, codes from closed sets, a calendar
-- date, and an exact non-zero decimal whose unit and version are codes. A
-- string that is not one of these (a merchant name, the provider's payment
-- wording) is refused wherever it is put.
CREATE TRIGGER card_purchase_recognitions_facts BEFORE INSERT ON card_purchase_recognitions
WHEN (SELECT count(*) FROM json_each(NEW.facts_json))<>6
 OR EXISTS(SELECT 1 FROM json_each(NEW.facts_json) f
  WHERE f.key NOT IN ('providerStatus','amount','usageDate','paymentType','amountCheck','providerSaleCode'))
 OR json_extract(NEW.facts_json,'$.providerStatus') IS NOT CASE
  WHEN json_extract(NEW.facts_json,'$.providerStatus')='unconfirmed' THEN 'unconfirmed'
  WHEN NEW.source_id='vpass' THEN 'posted' ELSE 'confirmed' END
 OR json_extract(NEW.facts_json,'$.paymentType') IS NOT 'single-payment'
 OR json_extract(NEW.facts_json,'$.amountCheck') IS NOT CASE NEW.source_id
  WHEN 'myjcb' THEN 'usage-equals-payment' ELSE 'provider-amount' END
 OR NOT (json_type(NEW.facts_json,'$.providerSaleCode') IS 'null'
  OR (json_type(NEW.facts_json,'$.providerSaleCode') IS 'text'
   AND json_extract(NEW.facts_json,'$.providerSaleCode') IN ('5','6')))
 OR json_type(NEW.facts_json,'$.usageDate') IS NOT 'text'
 OR date(json_extract(NEW.facts_json,'$.usageDate')) IS NOT json_extract(NEW.facts_json,'$.usageDate')
 OR json_type(NEW.facts_json,'$.amount') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.facts_json,'$.amount'))<>2
 OR json_type(NEW.facts_json,'$.amount.unitRef') IS NOT 'text'
 OR json_extract(NEW.facts_json,'$.amount.unitRef') NOT GLOB '[A-Z][A-Z][A-Z]'
 OR json_type(NEW.facts_json,'$.amount.value') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.facts_json,'$.amount.value'))<>3
 OR json_extract(NEW.facts_json,'$.amount.value.status') IS NOT 'exact'
 OR json_type(NEW.facts_json,'$.amount.value.normalizationVersion') IS NOT 'text'
 OR length(json_extract(NEW.facts_json,'$.amount.value.normalizationVersion')) NOT BETWEEN 1 AND 64
 OR json_extract(NEW.facts_json,'$.amount.value.normalizationVersion') GLOB '*[^a-z0-9.-]*'
 OR json_type(NEW.facts_json,'$.amount.value.value') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.facts_json,'$.amount.value.value'))<>2
 OR json_type(NEW.facts_json,'$.amount.value.value.coefficient') IS NOT 'text'
 OR NOT (json_extract(NEW.facts_json,'$.amount.value.value.coefficient') GLOB '[1-9]*'
  OR json_extract(NEW.facts_json,'$.amount.value.value.coefficient') GLOB '-[1-9]*')
 OR substr(json_extract(NEW.facts_json,'$.amount.value.value.coefficient'),2) GLOB '*[^0-9]*'
 OR json_type(NEW.facts_json,'$.amount.value.value.scale') IS NOT 'integer'
 OR json_extract(NEW.facts_json,'$.amount.value.value.scale') NOT BETWEEN 0 AND 4096
BEGIN SELECT RAISE(ABORT,'card_purchase_recognition_invalid'); END;
-- Once a revision has its sidecar, its legs are complete: no leg can be added
-- to it later, so the one-leg rule above cannot be bypassed afterwards.
CREATE TRIGGER card_purchase_recognition_legs_sealed BEFORE INSERT ON economic_legs
WHEN EXISTS(SELECT 1 FROM card_purchase_recognitions c WHERE c.event_id=NEW.event_id AND c.revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'card_purchase_legs_sealed'); END;

-- The recognition keys of one revision:
-- json_array(source_id, producer_id, external_id_namespace, source_account, external_id),
-- the same shape as the 0044 bank_key. A key names one provider row inside
-- one verified namespace; the observation and parse run pin the displayed row.
CREATE TABLE card_purchase_recognition_keys (
 event_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 recognition_key TEXT NOT NULL CHECK(length(recognition_key) BETWEEN 2 AND 2048
  AND json_valid(recognition_key) AND json_type(recognition_key)='array' AND json_array_length(recognition_key)=5),
 role TEXT NOT NULL CHECK(role IN ('posted','pending')),
 observation_id INTEGER NOT NULL REFERENCES transaction_observations(id),
 parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
 PRIMARY KEY(event_id,revision,recognition_key),
 FOREIGN KEY(event_id,revision) REFERENCES card_purchase_recognitions(event_id,revision)
) STRICT;
CREATE INDEX card_purchase_recognition_keys_key ON card_purchase_recognition_keys(recognition_key);
CREATE INDEX card_purchase_recognition_keys_observation ON card_purchase_recognition_keys(observation_id);
CREATE TRIGGER card_purchase_recognition_keys_no_update BEFORE UPDATE ON card_purchase_recognition_keys BEGIN SELECT RAISE(ABORT,'card purchase recognition keys are append-only'); END;
CREATE TRIGGER card_purchase_recognition_keys_no_delete BEFORE DELETE ON card_purchase_recognition_keys BEGIN SELECT RAISE(ABORT,'card purchase recognition keys are append-only'); END;
CREATE TRIGGER card_purchase_recognition_keys_no_replace BEFORE INSERT ON card_purchase_recognition_keys
WHEN EXISTS(SELECT 1 FROM card_purchase_recognition_keys WHERE event_id=NEW.event_id AND revision=NEW.revision AND recognition_key=NEW.recognition_key)
BEGIN SELECT RAISE(ABORT,'card purchase recognition key replacement is forbidden'); END;
-- A key belongs to a live sidecar revision, and it is re-derived from the row
-- it cites: the observation matches its parse run, the key equals the row's
-- own json_array, the source matches the sidecar, and the role matches the
-- provider status (unconfirmed is pending; posted and confirmed are posted).
CREATE TRIGGER card_purchase_recognition_keys_guard BEFORE INSERT ON card_purchase_recognition_keys
WHEN NOT EXISTS(SELECT 1 FROM card_purchase_recognitions c
  JOIN economic_event_revisions r ON r.event_id=c.event_id AND r.revision=c.revision
  WHERE c.event_id=NEW.event_id AND c.revision=NEW.revision AND r.superseded_by IS NULL)
 OR NOT EXISTS(SELECT 1 FROM transaction_observations t
  JOIN parse_runs p ON p.id=t.parse_run_id
  JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
  JOIN fetch_runs fr ON fr.id=a.fetch_run_id
  JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
  JOIN card_purchase_recognitions c ON c.event_id=NEW.event_id AND c.revision=NEW.revision AND c.source_id=a.source_id
  WHERE t.id=NEW.observation_id AND t.parse_run_id=NEW.parse_run_id
  AND json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id)=NEW.recognition_key
  AND NEW.role IS CASE WHEN t.status='unconfirmed' THEN 'pending' WHEN t.status IN ('posted','confirmed') THEN 'posted' END)
BEGIN SELECT RAISE(ABORT,'card_purchase_key_invalid'); END;
-- The no-double-count invariant: a key has at most one live holder, counted
-- per revision, so neither another event nor a second live revision of the
-- same event can hold it (the same row again is left to *_no_replace). A key
-- held by a superseded revision is free, so superseding (same event, or a
-- reviewed cross-id merge) releases it before the new revision claims it.
CREATE TRIGGER card_purchase_recognition_keys_one_live_holder BEFORE INSERT ON card_purchase_recognition_keys
WHEN EXISTS(SELECT 1 FROM card_purchase_recognition_keys k
  JOIN economic_event_revisions r ON r.event_id=k.event_id AND r.revision=k.revision
  WHERE k.recognition_key=NEW.recognition_key AND r.superseded_by IS NULL
  AND NOT (k.event_id=NEW.event_id AND k.revision=NEW.revision))
BEGIN SELECT RAISE(ABORT,'card_purchase_key_held'); END;

-- Reader views: "current" is the live revision, never the newest row.
CREATE VIEW current_card_purchase_recognitions AS
 SELECT c.*,r.kind,r.state,r.unknown_reason FROM card_purchase_recognitions c
 JOIN economic_event_revisions r ON r.event_id=c.event_id AND r.revision=c.revision
 WHERE r.superseded_by IS NULL;
CREATE VIEW current_card_purchase_keys AS
 SELECT k.* FROM card_purchase_recognition_keys k
 JOIN economic_event_revisions r ON r.event_id=k.event_id AND r.revision=k.revision
 WHERE r.superseded_by IS NULL;

-- Operational scan progress, not financial evidence (as 0044's cursor): the
-- writer cycles through current usage rows so new rows cannot starve old ones.
CREATE TABLE card_purchase_scan_cursor (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 last_observation_id INTEGER NOT NULL CHECK(last_observation_id>=0)
) STRICT;
INSERT INTO card_purchase_scan_cursor VALUES(1,0);
