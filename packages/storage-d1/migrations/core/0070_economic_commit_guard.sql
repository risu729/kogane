-- The common economic-event consumption guard (ADR 0054; docs/economic-events.md,
-- "Common consumption guard"). Schema only: no writer writes the tables below
-- yet. Additive only: no existing table, view, trigger or row is altered or
-- backfilled, and a Worker build that predates this migration keeps working.
--
-- The new objects on existing tables are BEFORE INSERT triggers:
--   * the sealed-revision refusals on economic_legs, card_purchase_recognitions,
--     card_purchase_recognition_keys and card_settlement_decisions fire only
--     for a revision that has an economic_revision_seals row, which no
--     existing writer creates;
--   * the cross-writer holder triggers on card_purchase_recognition_keys and
--     card_settlement_decisions fire only when an economic_claims row holds the
--     same key, which no existing writer creates either.
-- So the card purchase lane and the card settlement commands are unaffected
-- until they join (G1b in ADR 0054).
--
-- Vocabulary (packages/domain/src/economic-contract.ts states the same codes):
--   * book: the dimension a provider row is consumed in -- card-usage (a card
--     usage row recognised as a purchase or refund), cash-movement (a posted
--     movement row of a cash or stored-value account), security-quantity (a
--     holding-quantity movement row; no writer, refused below until one has
--     its own ADR).
--   * consumption key: json_array(source_id, producer_id,
--     external_id_namespace, source_account, external_id), exactly the 0047
--     recognition key and the 0044 bank_key.
--     The key names a row inside one collection path, not an economic fact:
--     a producer or namespace change, a parser release or an identity rewrite
--     can give one fact several keys.
--   * alias class: json_array(source_id, provider identity components,
--     resolved account id, alias rule version), computed by a human-adopted
--     writer from a registry-declared, versioned provider-identity function,
--     never from the raw external id text, the producer or the namespace.
--     NULL only for a rule writer that proves retire-before-recognise.
--   * a claim: one live event revision consuming one (book, key). At most one
--     live holder per (book, key), and per (book, alias class) where one is
--     recorded, across every writer (INV06).
--   * identity epoch: the declared identity era. A declared identity rewrite
--     (as 0063 was) appends a new epoch, and seals pin the epoch they were
--     made under. This schema only refuses a new seal under a stale epoch;
--     routing a holder sealed under an older epoch to needs-review is the
--     planner's and the selector's job (ADR 0054), because a rule writer
--     under retire-before-recognise keeps revising and a reviewed correction
--     is itself the review.
--   * a seal: the revision's child rows are complete; nothing is added later.
--   * a commit row: the finalization of one economic batch, last in it, with a
--     dense per-core-epoch sequence. "Accepted" means this row exists.
--
-- Error codes raised here are closed codes; the append-only refusals keep the
-- repository's prose messages.

-- The declared identity epochs, in order. The current epoch is the row with
-- the highest ordinal. A declared identity rewrite appends the next one; a row
-- is never changed or removed.
CREATE TABLE economic_identity_epochs (
 ordinal INTEGER PRIMARY KEY CHECK(ordinal>0),
 identity_epoch TEXT NOT NULL UNIQUE CHECK(length(identity_epoch) BETWEEN 1 AND 64 AND identity_epoch NOT GLOB '*[^a-z0-9.-]*'),
 reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^a-z0-9_-]*'),
 declared_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER economic_identity_epochs_no_update BEFORE UPDATE ON economic_identity_epochs BEGIN SELECT RAISE(ABORT,'identity epochs are append-only'); END;
CREATE TRIGGER economic_identity_epochs_no_delete BEFORE DELETE ON economic_identity_epochs BEGIN SELECT RAISE(ABORT,'identity epochs are append-only'); END;
-- The next ordinal only, and never a name already declared: an INSERT OR
-- REPLACE on the unique name would otherwise delete the declared row without
-- firing the delete trigger.
CREATE TRIGGER economic_identity_epochs_next BEFORE INSERT ON economic_identity_epochs
WHEN NEW.ordinal<>coalesce((SELECT max(ordinal) FROM economic_identity_epochs),0)+1
 OR EXISTS(SELECT 1 FROM economic_identity_epochs WHERE identity_epoch=NEW.identity_epoch)
BEGIN SELECT RAISE(ABORT,'identity epochs are append-only'); END;
INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at)
 VALUES(1,'identity-epoch-1','contract-start','2026-10-08T00:00:00.000Z');

-- The keys one event revision consumes, beyond the legacy holders the views
-- below read (card purchase recognition keys and accepted card settlements).
-- The cited observation and parse run pin the row the key was derived from.
CREATE TABLE economic_claims (
 event_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 book TEXT NOT NULL CHECK(book IN ('card-usage','cash-movement','security-quantity')),
 consumption_key TEXT NOT NULL CHECK(length(consumption_key) BETWEEN 2 AND 2048
  AND json_valid(consumption_key) AND json_type(consumption_key)='array' AND json_array_length(consumption_key)=5),
 alias_class TEXT CHECK(alias_class IS NULL OR (length(alias_class) BETWEEN 2 AND 2048
  AND json_valid(alias_class) AND json_type(alias_class)='array' AND json_array_length(alias_class)=4
  AND json_type(alias_class,'$[0]')='text' AND json_type(alias_class,'$[1]')='array'
  AND json_array_length(alias_class,'$[1]')>0
  AND json_type(alias_class,'$[2]')='text' AND json_type(alias_class,'$[3]')='text')),
 identity_epoch TEXT NOT NULL REFERENCES economic_identity_epochs(identity_epoch),
 observation_id INTEGER NOT NULL REFERENCES transaction_observations(id),
 parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
 PRIMARY KEY(event_id,revision,book,consumption_key),
 FOREIGN KEY(event_id,revision) REFERENCES economic_event_revisions(event_id,revision)
) STRICT;
CREATE INDEX economic_claims_key ON economic_claims(book,consumption_key);
CREATE INDEX economic_claims_alias ON economic_claims(book,alias_class) WHERE alias_class IS NOT NULL;
CREATE INDEX economic_claims_observation ON economic_claims(observation_id);
CREATE TRIGGER economic_claims_no_update BEFORE UPDATE ON economic_claims BEGIN SELECT RAISE(ABORT,'economic claims are append-only'); END;
CREATE TRIGGER economic_claims_no_delete BEFORE DELETE ON economic_claims BEGIN SELECT RAISE(ABORT,'economic claims are append-only'); END;
CREATE TRIGGER economic_claims_no_replace BEFORE INSERT ON economic_claims
WHEN EXISTS(SELECT 1 FROM economic_claims WHERE event_id=NEW.event_id AND revision=NEW.revision
 AND book=NEW.book AND consumption_key=NEW.consumption_key)
BEGIN SELECT RAISE(ABORT,'economic claim replacement is forbidden'); END;

-- Role-typed times of one revision (trade, settlement, posting, usage, value),
-- one row per role. There is no fallback between roles: a role without a row
-- is unknown, never the effective time of 0032.
CREATE TABLE economic_event_times (
 event_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 role TEXT NOT NULL CHECK(role IN ('trade','settlement','posting','usage','value')),
 temporal_json TEXT NOT NULL CHECK(length(temporal_json)<=4096 AND json_valid(temporal_json) AND json_type(temporal_json)='object'),
 PRIMARY KEY(event_id,revision,role),
 FOREIGN KEY(event_id,revision) REFERENCES economic_event_revisions(event_id,revision)
) STRICT;
CREATE TRIGGER economic_event_times_no_update BEFORE UPDATE ON economic_event_times BEGIN SELECT RAISE(ABORT,'economic event times are append-only'); END;
CREATE TRIGGER economic_event_times_no_delete BEFORE DELETE ON economic_event_times BEGIN SELECT RAISE(ABORT,'economic event times are append-only'); END;
CREATE TRIGGER economic_event_times_no_replace BEFORE INSERT ON economic_event_times
WHEN EXISTS(SELECT 1 FROM economic_event_times WHERE event_id=NEW.event_id AND revision=NEW.revision AND role=NEW.role)
BEGIN SELECT RAISE(ABORT,'economic event time replacement is forbidden'); END;
-- A time belongs to a live revision, as a claim does: a superseded revision,
-- sealed or not, takes no new child.
CREATE TRIGGER economic_event_times_guard BEFORE INSERT ON economic_event_times
WHEN NOT EXISTS(SELECT 1 FROM economic_event_revisions r WHERE r.event_id=NEW.event_id AND r.revision=NEW.revision
 AND r.superseded_by IS NULL)
BEGIN SELECT RAISE(ABORT,'economic_event_time_invalid'); END;

-- What one leg is: a real movement, a breakdown of another leg (a stated fee
-- inside a net movement), or a correspondence to another leg (a trade leg and
-- its settlement leg). A leg without a row keeps the legacy reading: increase
-- and decrease move, fee and unresolved have no effect of their own.
CREATE TABLE economic_leg_effects (
 event_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 leg_index INTEGER NOT NULL CHECK(leg_index>=0),
 effect TEXT NOT NULL CHECK(effect IN ('movement','breakdown','correspondence')),
 of_leg_index INTEGER CHECK(of_leg_index IS NULL OR of_leg_index>=0),
 PRIMARY KEY(event_id,revision,leg_index),
 FOREIGN KEY(event_id,revision,leg_index) REFERENCES economic_legs(event_id,revision,leg_index),
 CHECK((effect='movement')=(of_leg_index IS NULL)),
 CHECK(of_leg_index IS NULL OR of_leg_index<>leg_index)
) STRICT;
CREATE TRIGGER economic_leg_effects_no_update BEFORE UPDATE ON economic_leg_effects BEGIN SELECT RAISE(ABORT,'economic leg effects are append-only'); END;
CREATE TRIGGER economic_leg_effects_no_delete BEFORE DELETE ON economic_leg_effects BEGIN SELECT RAISE(ABORT,'economic leg effects are append-only'); END;
CREATE TRIGGER economic_leg_effects_no_replace BEFORE INSERT ON economic_leg_effects
WHEN EXISTS(SELECT 1 FROM economic_leg_effects WHERE event_id=NEW.event_id AND revision=NEW.revision AND leg_index=NEW.leg_index)
BEGIN SELECT RAISE(ABORT,'economic leg effect replacement is forbidden'); END;
-- The leg exists on a live revision; a breakdown or correspondence names
-- another leg of the same revision that is not itself a breakdown or
-- correspondence, and a breakdown is in that leg's unit (amounts in different
-- units are never parts, INV03). Order-independent: a movement row is always
-- admitted, so a target's row may follow the breakdown that names it.
CREATE TRIGGER economic_leg_effects_guard BEFORE INSERT ON economic_leg_effects
WHEN NOT EXISTS(SELECT 1 FROM economic_legs l
  JOIN economic_event_revisions r ON r.event_id=l.event_id AND r.revision=l.revision AND r.superseded_by IS NULL
  WHERE l.event_id=NEW.event_id AND l.revision=NEW.revision AND l.leg_index=NEW.leg_index)
 OR (NEW.of_leg_index IS NOT NULL AND NOT EXISTS(SELECT 1 FROM economic_legs o
  WHERE o.event_id=NEW.event_id AND o.revision=NEW.revision AND o.leg_index=NEW.of_leg_index))
 OR (NEW.of_leg_index IS NOT NULL AND EXISTS(SELECT 1 FROM economic_leg_effects o
  WHERE o.event_id=NEW.event_id AND o.revision=NEW.revision AND o.leg_index=NEW.of_leg_index AND o.effect<>'movement'))
 OR (NEW.effect<>'movement' AND EXISTS(SELECT 1 FROM economic_leg_effects o
  WHERE o.event_id=NEW.event_id AND o.revision=NEW.revision AND o.of_leg_index=NEW.leg_index))
 OR (NEW.effect='breakdown' AND NOT EXISTS(SELECT 1 FROM economic_legs l JOIN economic_legs o
  ON o.event_id=l.event_id AND o.revision=l.revision AND o.leg_index=NEW.of_leg_index
  WHERE l.event_id=NEW.event_id AND l.revision=NEW.revision AND l.leg_index=NEW.leg_index AND l.unit_ref=o.unit_ref))
BEGIN SELECT RAISE(ABORT,'economic_leg_effect_invalid'); END;

-- One row per sealed revision: its child counts, the writer's content digest
-- and the identity revisions and identity epoch it was adopted under
-- ({subjectRef: revision}, the expected-revision vocabulary of
-- core/operations.ts), and the commit that
-- finalizes it. Written after the revision's legs, claims, times and effects,
-- and before the commit row of the same batch.
CREATE TABLE economic_revision_seals (
 event_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 writer_release TEXT NOT NULL CHECK(length(writer_release) BETWEEN 1 AND 128 AND writer_release NOT GLOB '*[^a-z0-9.:-]*'),
 leg_count INTEGER NOT NULL CHECK(leg_count>=0),
 claim_count INTEGER NOT NULL CHECK(claim_count>=0),
 time_count INTEGER NOT NULL CHECK(time_count>=0),
 effect_count INTEGER NOT NULL CHECK(effect_count>=0),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
 identity_pins_json TEXT NOT NULL CHECK(length(identity_pins_json)<=16384 AND json_valid(identity_pins_json) AND json_type(identity_pins_json)='object'),
 identity_epoch TEXT NOT NULL REFERENCES economic_identity_epochs(identity_epoch),
 core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
 commit_seq INTEGER NOT NULL CHECK(commit_seq>0),
 created_at TEXT NOT NULL,
 PRIMARY KEY(event_id,revision),
 FOREIGN KEY(event_id,revision) REFERENCES economic_event_revisions(event_id,revision)
) STRICT;
CREATE INDEX economic_revision_seals_commit ON economic_revision_seals(core_epoch,commit_seq);
CREATE TRIGGER economic_revision_seals_no_update BEFORE UPDATE ON economic_revision_seals BEGIN SELECT RAISE(ABORT,'economic revision seals are append-only'); END;
CREATE TRIGGER economic_revision_seals_no_delete BEFORE DELETE ON economic_revision_seals BEGIN SELECT RAISE(ABORT,'economic revision seals are append-only'); END;
CREATE TRIGGER economic_revision_seals_no_replace BEFORE INSERT ON economic_revision_seals
WHEN EXISTS(SELECT 1 FROM economic_revision_seals WHERE event_id=NEW.event_id AND revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'economic revision seal replacement is forbidden'); END;

-- The finalization row of one economic batch. commit_seq is dense per core
-- epoch (a CORE restored from a backup takes a new epoch, 0038) and orders
-- knowledge; known_at never goes backwards within an epoch. members_json is
-- [{eventId, revision, supersedes: [[eventId, revision], ...]}, ...], one
-- member per event; claims_json and released_json are sets of
-- [book, consumption key text].
CREATE TABLE economic_commit_log (
 core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
 commit_seq INTEGER NOT NULL CHECK(commit_seq>0),
 decision_revision_id TEXT NOT NULL UNIQUE REFERENCES decision_revisions(id),
 operation_id TEXT CHECK(operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 256),
 principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 256),
 payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
 kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64 AND kind NOT GLOB '*[^a-z0-9.-]*'),
 members_json TEXT NOT NULL CHECK(json_valid(members_json) AND json_type(members_json)='array' AND json_array_length(members_json) BETWEEN 1 AND 16),
 claims_json TEXT NOT NULL CHECK(json_valid(claims_json) AND json_type(claims_json)='array' AND json_array_length(claims_json)<=64),
 released_json TEXT NOT NULL CHECK(json_valid(released_json) AND json_type(released_json)='array' AND json_array_length(released_json)<=64),
 -- One canonical UTC form (YYYY-MM-DDTHH:MM:SS.sssZ, a real instant): the
 -- log, its regression check and every cut compare known_at as text.
 known_at TEXT NOT NULL CHECK(length(known_at)=24 AND known_at IS strftime('%Y-%m-%dT%H:%M:%fZ',known_at)),
 PRIMARY KEY(core_epoch,commit_seq)
) STRICT;
CREATE TRIGGER economic_commit_log_no_update BEFORE UPDATE ON economic_commit_log BEGIN SELECT RAISE(ABORT,'the economic commit log is append-only'); END;
CREATE TRIGGER economic_commit_log_no_delete BEFORE DELETE ON economic_commit_log BEGIN SELECT RAISE(ABORT,'the economic commit log is append-only'); END;
CREATE TRIGGER economic_commit_log_no_replace BEFORE INSERT ON economic_commit_log
WHEN EXISTS(SELECT 1 FROM economic_commit_log WHERE (core_epoch=NEW.core_epoch AND commit_seq=NEW.commit_seq)
 OR decision_revision_id=NEW.decision_revision_id)
BEGIN SELECT RAISE(ABORT,'economic commit replacement is forbidden'); END;

-- The commit trigger finds every revision a member superseded, across event
-- ids (a merge supersedes another event's revision), by its pointer.
CREATE INDEX economic_event_revisions_superseded_by ON economic_event_revisions(superseded_by)
 WHERE superseded_by IS NOT NULL;

-- The settlement branch below is read by event revision; 0044 indexes the
-- decisions only by proposal. An index changes no row and no result.
CREATE INDEX card_settlement_decisions_event ON card_settlement_decisions(event_id,revision);

-- Every claim of every revision, live or not: economic_claims, the card
-- purchase recognition keys (0047) as book card-usage, and each accepted card
-- settlement decision's bank_key (0044) as book cash-movement on the event
-- revision that decision wrote (the settlement writer gives the event
-- revision the decision's revision number). A legacy holder that
-- economic_claims also records for the same revision is that row, once.
-- Legacy holders have no alias class.
CREATE VIEW economic_revision_claims AS
 SELECT event_id,revision,book,consumption_key,alias_class FROM economic_claims
 UNION ALL
 SELECT k.event_id,k.revision,'card-usage',k.recognition_key,NULL FROM card_purchase_recognition_keys k
 WHERE NOT EXISTS(SELECT 1 FROM economic_claims x WHERE x.event_id=k.event_id AND x.revision=k.revision
  AND x.book='card-usage' AND x.consumption_key=k.recognition_key)
 UNION ALL
 SELECT d.event_id,d.revision,'cash-movement',c.bank_key,NULL FROM card_settlement_decisions d
 JOIN card_settlement_candidates c ON c.id=d.proposal_id
 WHERE d.status='accepted' AND d.event_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM economic_claims x WHERE x.event_id=d.event_id AND x.revision=d.revision
  AND x.book='cash-movement' AND x.consumption_key=c.bank_key);

-- The live holders: a claim is live while the revision that holds it is live
-- (superseded_by IS NULL), never because of an allocation row. A withdrawn
-- settlement supersedes its event revision, so its bank_key is free again.
CREATE VIEW live_consumption_claims AS
 SELECT c.book,c.consumption_key,c.alias_class,c.event_id,c.revision FROM economic_revision_claims c
 JOIN economic_event_revisions r ON r.event_id=c.event_id AND r.revision=c.revision
 WHERE r.superseded_by IS NULL;

-- Inconsistencies are listed, never washed: a (book, key) or a (book, alias
-- class) with more than one live holder, and an event with more than one live
-- revision.
CREATE VIEW consumption_claim_conflicts AS
 SELECT 'key' AS dimension,book,consumption_key AS claim_ref,count(*) AS holder_count
 FROM live_consumption_claims GROUP BY book,consumption_key HAVING count(*)>1
 UNION ALL
 SELECT 'alias',book,alias_class,count(*) FROM live_consumption_claims
 WHERE alias_class IS NOT NULL GROUP BY book,alias_class HAVING count(*)>1;
CREATE VIEW economic_event_live_conflicts AS
 SELECT event_id,count(*) AS live_revisions FROM economic_event_revisions
 WHERE superseded_by IS NULL GROUP BY event_id HAVING count(*)>1;

-- Revisions no commit row finalizes: everything written before the log
-- started, and anything an older build writes after. after_log_start compares
-- writer clocks (created_at against the first known_at) and is a diagnostic
-- only; it is never adoption evidence.
CREATE VIEW unlogged_economic_revisions AS
 SELECT r.event_id,r.revision,r.kind,r.superseded_by IS NULL AS live,r.created_at,
 coalesce(r.created_at>=(SELECT min(l.known_at) FROM economic_commit_log l),0) AS after_log_start
 FROM economic_event_revisions r
 WHERE NOT EXISTS(SELECT 1 FROM economic_revision_seals s
  JOIN economic_commit_log l ON l.core_epoch=s.core_epoch AND l.commit_seq=s.commit_seq
  WHERE s.event_id=r.event_id AND s.revision=r.revision);

-- A claim belongs to a live revision and is re-derived from the row it cites,
-- as the 0047 key guard derives a recognition key: the observation matches its
-- parse run, the row has a provider external id, and the key equals the row's
-- own json_array. Rows without an external id have no identity to consume.
-- An alias class names the key's own source, and the epoch is a declared one.
CREATE TRIGGER economic_claims_guard BEFORE INSERT ON economic_claims
WHEN NOT EXISTS(SELECT 1 FROM economic_event_revisions r
  WHERE r.event_id=NEW.event_id AND r.revision=NEW.revision AND r.superseded_by IS NULL)
 OR NOT EXISTS(SELECT 1 FROM transaction_observations t
  JOIN parse_runs p ON p.id=t.parse_run_id
  JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
  JOIN fetch_runs fr ON fr.id=a.fetch_run_id
  JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
  WHERE t.id=NEW.observation_id AND t.parse_run_id=NEW.parse_run_id
  AND t.external_id IS NOT NULL AND t.external_id<>''
  AND json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id)=NEW.consumption_key)
 OR (NEW.alias_class IS NOT NULL AND json_extract(NEW.alias_class,'$[0]') IS NOT json_extract(NEW.consumption_key,'$[0]'))
 OR NOT EXISTS(SELECT 1 FROM economic_identity_epochs WHERE identity_epoch=NEW.identity_epoch)
BEGIN SELECT RAISE(ABORT,'economic_claim_invalid'); END;
-- No writer consumes holding quantities yet; which observation table carries
-- such a row is undecided, so the book is refused until its writer's ADR.
CREATE TRIGGER economic_claims_book_supported BEFORE INSERT ON economic_claims
WHEN NEW.book='security-quantity'
BEGIN SELECT RAISE(ABORT,'economic_claim_book_unsupported'); END;
-- The no-double-count invariant across writers: one live holder per
-- (book, key), whoever wrote the holder. The three sources of
-- live_consumption_claims are spelled out, each through its own key index:
-- SQLite does not push a trigger's or a correlated term into a UNION view, so
-- reading the view here would materialize every claim on every insert.
CREATE TRIGGER economic_claims_one_live_holder BEFORE INSERT ON economic_claims
WHEN EXISTS(SELECT 1 FROM economic_claims x
  JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision
  WHERE x.book=NEW.book AND x.consumption_key=NEW.consumption_key AND r.superseded_by IS NULL
  AND NOT (x.event_id=NEW.event_id AND x.revision=NEW.revision))
 OR (NEW.book='card-usage' AND EXISTS(SELECT 1 FROM card_purchase_recognition_keys k
  JOIN economic_event_revisions r ON r.event_id=k.event_id AND r.revision=k.revision
  WHERE k.recognition_key=NEW.consumption_key AND r.superseded_by IS NULL
  AND NOT (k.event_id=NEW.event_id AND k.revision=NEW.revision)))
 OR (NEW.book='cash-movement' AND EXISTS(SELECT 1 FROM card_settlement_candidates k
  JOIN card_settlement_decisions d ON d.proposal_id=k.id AND d.status='accepted'
  JOIN economic_event_revisions r ON r.event_id=d.event_id AND r.revision=d.revision
  WHERE k.bank_key=NEW.consumption_key AND r.superseded_by IS NULL
  AND NOT (d.event_id=NEW.event_id AND d.revision=NEW.revision)))
BEGIN SELECT RAISE(ABORT,'economic_claim_held'); END;
-- The same fact under another key: a live claim in the same book and alias
-- class, by any other row (another revision, or this revision under another
-- key), whatever its producer or namespace. Legacy holders carry no alias
-- class, so they are not seen here until their writer records one (G1b).
CREATE TRIGGER economic_claims_alias_one_live_holder BEFORE INSERT ON economic_claims
WHEN NEW.alias_class IS NOT NULL AND EXISTS(SELECT 1 FROM economic_claims x
  JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision
  WHERE x.book=NEW.book AND x.alias_class=NEW.alias_class AND r.superseded_by IS NULL
  AND NOT (x.event_id=NEW.event_id AND x.revision=NEW.revision AND x.consumption_key=NEW.consumption_key))
BEGIN SELECT RAISE(ABORT,'alias_conflict'); END;

-- The legacy writers meet the new holders. A card purchase key and an
-- accepted card settlement are refused while economic_claims holds the same
-- key in the same book for another revision. Neither fires before a writer
-- writes economic_claims.
CREATE TRIGGER card_purchase_recognition_keys_economic_claim_held BEFORE INSERT ON card_purchase_recognition_keys
WHEN EXISTS(SELECT 1 FROM economic_claims c
  JOIN economic_event_revisions r ON r.event_id=c.event_id AND r.revision=c.revision
  WHERE c.book='card-usage' AND c.consumption_key=NEW.recognition_key AND r.superseded_by IS NULL
  AND NOT (c.event_id=NEW.event_id AND c.revision=NEW.revision))
BEGIN SELECT RAISE(ABORT,'economic_claim_held'); END;
CREATE TRIGGER card_settlement_decisions_economic_claim_held BEFORE INSERT ON card_settlement_decisions
WHEN NEW.status='accepted' AND EXISTS(SELECT 1 FROM card_settlement_candidates k
  JOIN economic_claims c ON c.book='cash-movement' AND c.consumption_key=k.bank_key
  JOIN economic_event_revisions r ON r.event_id=c.event_id AND r.revision=c.revision
  WHERE k.id=NEW.proposal_id AND r.superseded_by IS NULL
  AND NOT (c.event_id IS NEW.event_id AND c.revision=NEW.revision))
BEGIN SELECT RAISE(ABORT,'economic_claim_held'); END;

-- A seal states the stored child rows exactly, of a live revision, for the
-- commit this batch is about to write (the next sequence number of the
-- current core epoch). Claims are counted as economic_revision_claims counts
-- them, each source through its own index. Identity pins are revisions:
-- non-negative integers; the identity epoch is a declared one, and every
-- claim of the revision was made under it.
CREATE TRIGGER economic_revision_seals_guard BEFORE INSERT ON economic_revision_seals
WHEN NOT EXISTS(SELECT 1 FROM economic_event_revisions r
  WHERE r.event_id=NEW.event_id AND r.revision=NEW.revision AND r.superseded_by IS NULL)
 OR NEW.leg_count<>(SELECT count(*) FROM economic_legs WHERE event_id=NEW.event_id AND revision=NEW.revision)
 OR NEW.claim_count<>(SELECT count(*) FROM economic_claims x WHERE x.event_id=NEW.event_id AND x.revision=NEW.revision)
  +(SELECT count(*) FROM card_purchase_recognition_keys k WHERE k.event_id=NEW.event_id AND k.revision=NEW.revision
   AND NOT EXISTS(SELECT 1 FROM economic_claims x WHERE x.event_id=k.event_id AND x.revision=k.revision
    AND x.book='card-usage' AND x.consumption_key=k.recognition_key))
  +(SELECT count(*) FROM card_settlement_decisions d JOIN card_settlement_candidates k ON k.id=d.proposal_id
   WHERE d.event_id=NEW.event_id AND d.revision=NEW.revision AND d.status='accepted'
   AND NOT EXISTS(SELECT 1 FROM economic_claims x WHERE x.event_id=d.event_id AND x.revision=d.revision
    AND x.book='cash-movement' AND x.consumption_key=k.bank_key))
 OR NEW.time_count<>(SELECT count(*) FROM economic_event_times WHERE event_id=NEW.event_id AND revision=NEW.revision)
 OR NEW.effect_count<>(SELECT count(*) FROM economic_leg_effects WHERE event_id=NEW.event_id AND revision=NEW.revision)
 OR NEW.core_epoch IS NOT (SELECT core_epoch FROM core_source_revision WHERE id=1)
 OR NEW.commit_seq<>coalesce((SELECT max(commit_seq) FROM economic_commit_log WHERE core_epoch=NEW.core_epoch),0)+1
 OR EXISTS(SELECT 1 FROM json_each(NEW.identity_pins_json) p
  WHERE p.type<>'integer' OR p.value<0 OR length(p.key) NOT BETWEEN 1 AND 512)
 OR NOT EXISTS(SELECT 1 FROM economic_identity_epochs WHERE identity_epoch=NEW.identity_epoch)
 OR EXISTS(SELECT 1 FROM economic_claims x WHERE x.event_id=NEW.event_id AND x.revision=NEW.revision
  AND x.identity_epoch<>NEW.identity_epoch)
BEGIN SELECT RAISE(ABORT,'economic_seal_invalid'); END;

-- Nothing is added to a sealed revision: no leg, claim, time, effect, card
-- purchase sidecar or key, and no accepted card settlement decision naming it.
CREATE TRIGGER economic_legs_sealed BEFORE INSERT ON economic_legs
WHEN EXISTS(SELECT 1 FROM economic_revision_seals s WHERE s.event_id=NEW.event_id AND s.revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'economic_revision_sealed'); END;
CREATE TRIGGER economic_claims_sealed BEFORE INSERT ON economic_claims
WHEN EXISTS(SELECT 1 FROM economic_revision_seals s WHERE s.event_id=NEW.event_id AND s.revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'economic_revision_sealed'); END;
CREATE TRIGGER economic_event_times_sealed BEFORE INSERT ON economic_event_times
WHEN EXISTS(SELECT 1 FROM economic_revision_seals s WHERE s.event_id=NEW.event_id AND s.revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'economic_revision_sealed'); END;
CREATE TRIGGER economic_leg_effects_sealed BEFORE INSERT ON economic_leg_effects
WHEN EXISTS(SELECT 1 FROM economic_revision_seals s WHERE s.event_id=NEW.event_id AND s.revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'economic_revision_sealed'); END;
CREATE TRIGGER card_purchase_recognitions_economic_sealed BEFORE INSERT ON card_purchase_recognitions
WHEN EXISTS(SELECT 1 FROM economic_revision_seals s WHERE s.event_id=NEW.event_id AND s.revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'economic_revision_sealed'); END;
CREATE TRIGGER card_purchase_recognition_keys_economic_sealed BEFORE INSERT ON card_purchase_recognition_keys
WHEN EXISTS(SELECT 1 FROM economic_revision_seals s WHERE s.event_id=NEW.event_id AND s.revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'economic_revision_sealed'); END;
CREATE TRIGGER card_settlement_decisions_economic_sealed BEFORE INSERT ON card_settlement_decisions
WHEN NEW.status='accepted' AND EXISTS(SELECT 1 FROM economic_revision_seals s
 WHERE s.event_id=NEW.event_id AND s.revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'economic_revision_sealed'); END;

-- The finalization. This is where the batch's invariants are enforced, after
-- every mutation of the batch: 0032's supersede trigger requires the
-- successor revision to exist first, so an event is briefly two-live inside a
-- batch and no per-row constraint can say "one live revision per event".
-- Every lookup goes to a base table through an index, never through the
-- UNION views above (SQLite would materialize them). The checks run in this
-- order, each with its own code:
--   1. shape of members_json, claims_json and released_json;
--   2. the sequence: the current core epoch, commit_seq = max + 1, and
--      known_at not before the previous commit's;
--   3. every member revision exists, is live, is the newest revision of its
--      event and is sealed for exactly this commit, and the seals of this
--      commit are exactly the members;
--   3a. every member was sealed under the current identity epoch, and the
--      kind is not the reserved economic-event.resolve-identity, which is
--      refused outright: G2 recreates this trigger with that kind's receipt
--      binding when it opens the exemption together with its planner. No
--      0070 object reads the command tables, so G2 can rebuild them;
--   4. every revision a member names in supersedes points at that member,
--      and every revision that points at a member is named in its
--      supersedes (an undeclared supersession would release claims, or wash
--      a conflict, without saying so);
--   5. no other live revision of a member's event;
--   6. the members' claims equal claims_json as a set: every entry is held
--      by a member, and there are as many entries as the members' seals
--      count (no claim can be added after a seal, so the counts still hold);
--   7. no claimed key has a live holder outside the members, and no member
--      claim's alias class has a live holder under another row;
--   8. released_json is exactly the superseded revisions' claims that no
--      member claims again, and no released key keeps a live holder
--      (a pre-existing double holder is never released silently);
--   9. the commit's decision and every member's event decision exist under
--      this operation id and principal.
CREATE TRIGGER economic_commit_log_guard BEFORE INSERT ON economic_commit_log
BEGIN
 SELECT RAISE(ABORT,'economic_commit_shape_invalid')
 WHERE EXISTS(SELECT 1 FROM json_each(NEW.members_json) m
   WHERE m.type<>'object' OR (SELECT count(*) FROM json_each(m.value))<>3
   OR json_type(m.value,'$.eventId') IS NOT 'text'
   OR length(json_extract(m.value,'$.eventId')) NOT BETWEEN 1 AND 256
   OR json_type(m.value,'$.revision') IS NOT 'integer' OR json_extract(m.value,'$.revision')<1
   OR json_type(m.value,'$.supersedes') IS NOT 'array'
   OR EXISTS(SELECT 1 FROM json_each(m.value,'$.supersedes') s
    WHERE s.type<>'array' OR json_array_length(s.value)<>2
    OR json_type(s.value,'$[0]') IS NOT 'text' OR json_type(s.value,'$[1]') IS NOT 'integer'
    OR json_extract(s.value,'$[1]')<1))
  OR (SELECT count(DISTINCT json_extract(m.value,'$.eventId')) FROM json_each(NEW.members_json) m)<>json_array_length(NEW.members_json)
  OR EXISTS(SELECT 1 FROM json_each(NEW.claims_json) c
   WHERE c.type<>'array' OR json_array_length(c.value)<>2
   OR json_type(c.value,'$[0]') IS NOT 'text' OR json_type(c.value,'$[1]') IS NOT 'text')
  OR EXISTS(SELECT 1 FROM json_each(NEW.released_json) c
   WHERE c.type<>'array' OR json_array_length(c.value)<>2
   OR json_type(c.value,'$[0]') IS NOT 'text' OR json_type(c.value,'$[1]') IS NOT 'text')
  OR (SELECT count(DISTINCT c.value) FROM json_each(NEW.claims_json) c)<>json_array_length(NEW.claims_json)
  OR (SELECT count(DISTINCT c.value) FROM json_each(NEW.released_json) c)<>json_array_length(NEW.released_json);

 SELECT RAISE(ABORT,'economic_commit_sequence_invalid')
 WHERE NEW.core_epoch IS NOT (SELECT core_epoch FROM core_source_revision WHERE id=1)
  OR NEW.commit_seq<>coalesce((SELECT max(commit_seq) FROM economic_commit_log WHERE core_epoch=NEW.core_epoch),0)+1;

 SELECT RAISE(ABORT,'economic_commit_known_at_regressed')
 WHERE NEW.known_at<(SELECT l.known_at FROM economic_commit_log l
  WHERE l.core_epoch=NEW.core_epoch AND l.commit_seq=NEW.commit_seq-1);

 SELECT RAISE(ABORT,'economic_commit_member_invalid')
 WHERE EXISTS(SELECT 1 FROM json_each(NEW.members_json) m
   WHERE NOT EXISTS(SELECT 1 FROM economic_event_revisions r
     JOIN economic_revision_seals s ON s.event_id=r.event_id AND s.revision=r.revision
     WHERE r.event_id=json_extract(m.value,'$.eventId') AND r.revision=json_extract(m.value,'$.revision')
     AND r.superseded_by IS NULL AND s.core_epoch=NEW.core_epoch AND s.commit_seq=NEW.commit_seq)
   OR EXISTS(SELECT 1 FROM economic_event_revisions n
     WHERE n.event_id=json_extract(m.value,'$.eventId') AND n.revision>json_extract(m.value,'$.revision')))
  OR (SELECT count(*) FROM economic_revision_seals s
   WHERE s.core_epoch=NEW.core_epoch AND s.commit_seq=NEW.commit_seq)<>json_array_length(NEW.members_json);

 SELECT RAISE(ABORT,'identity_epoch_changed')
 WHERE NEW.kind='economic-event.resolve-identity' OR EXISTS(SELECT 1 FROM economic_revision_seals s
  WHERE s.core_epoch=NEW.core_epoch AND s.commit_seq=NEW.commit_seq
  AND s.identity_epoch IS NOT (SELECT e.identity_epoch FROM economic_identity_epochs e ORDER BY e.ordinal DESC LIMIT 1));

 SELECT RAISE(ABORT,'economic_commit_prior_not_superseded')
 WHERE EXISTS(SELECT 1 FROM json_each(NEW.members_json) m JOIN json_each(m.value,'$.supersedes') p
  WHERE NOT EXISTS(SELECT 1 FROM economic_event_revisions r
   WHERE r.event_id=json_extract(p.value,'$[0]') AND r.revision=json_extract(p.value,'$[1]')
   AND r.superseded_by=json_extract(m.value,'$.eventId')||'@'||json_extract(m.value,'$.revision')));

 SELECT RAISE(ABORT,'economic_commit_supersession_undeclared')
 WHERE EXISTS(SELECT 1 FROM json_each(NEW.members_json) m
  JOIN economic_event_revisions r
   ON r.superseded_by=json_extract(m.value,'$.eventId')||'@'||json_extract(m.value,'$.revision')
  WHERE NOT EXISTS(SELECT 1 FROM json_each(m.value,'$.supersedes') p
   WHERE json_extract(p.value,'$[0]')=r.event_id AND json_extract(p.value,'$[1]')=r.revision));

 SELECT RAISE(ABORT,'economic_event_live_conflict')
 WHERE EXISTS(SELECT 1 FROM json_each(NEW.members_json) m
  WHERE EXISTS(SELECT 1 FROM economic_event_revisions o
   WHERE o.event_id=json_extract(m.value,'$.eventId') AND o.revision<>json_extract(m.value,'$.revision')
   AND o.superseded_by IS NULL));

 SELECT RAISE(ABORT,'economic_commit_claims_mismatch')
 WHERE json_array_length(NEW.claims_json)<>(SELECT coalesce(sum(s.claim_count),0) FROM economic_revision_seals s
   WHERE s.core_epoch=NEW.core_epoch AND s.commit_seq=NEW.commit_seq)
  OR EXISTS(SELECT 1 FROM json_each(NEW.claims_json) c
   WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.members_json) m
    WHERE (EXISTS(SELECT 1 FROM economic_claims x WHERE x.event_id=json_extract(m.value,'$.eventId') AND x.revision=json_extract(m.value,'$.revision')
     AND x.book=json_extract(c.value,'$[0]') AND x.consumption_key=json_extract(c.value,'$[1]'))
    OR (json_extract(c.value,'$[0]')='card-usage' AND EXISTS(SELECT 1 FROM card_purchase_recognition_keys k
     WHERE k.event_id=json_extract(m.value,'$.eventId') AND k.revision=json_extract(m.value,'$.revision') AND k.recognition_key=json_extract(c.value,'$[1]')))
    OR (json_extract(c.value,'$[0]')='cash-movement' AND EXISTS(SELECT 1 FROM card_settlement_decisions d
     JOIN card_settlement_candidates k ON k.id=d.proposal_id
     WHERE d.event_id=json_extract(m.value,'$.eventId') AND d.revision=json_extract(m.value,'$.revision') AND d.status='accepted' AND k.bank_key=json_extract(c.value,'$[1]'))))));

 SELECT RAISE(ABORT,'economic_claim_held')
 WHERE EXISTS(SELECT 1 FROM json_each(NEW.claims_json) c
  WHERE (EXISTS(SELECT 1 FROM economic_claims x
    JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision
    WHERE x.book=json_extract(c.value,'$[0]') AND x.consumption_key=json_extract(c.value,'$[1]') AND r.superseded_by IS NULL
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.members_json) m WHERE json_extract(m.value,'$.eventId')=x.event_id AND json_extract(m.value,'$.revision')=x.revision))
   OR (json_extract(c.value,'$[0]')='card-usage' AND EXISTS(SELECT 1 FROM card_purchase_recognition_keys k
    JOIN economic_event_revisions r ON r.event_id=k.event_id AND r.revision=k.revision
    WHERE k.recognition_key=json_extract(c.value,'$[1]') AND r.superseded_by IS NULL
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.members_json) m WHERE json_extract(m.value,'$.eventId')=k.event_id AND json_extract(m.value,'$.revision')=k.revision)))
   OR (json_extract(c.value,'$[0]')='cash-movement' AND EXISTS(SELECT 1 FROM card_settlement_candidates k
    JOIN card_settlement_decisions d ON d.proposal_id=k.id AND d.status='accepted'
    JOIN economic_event_revisions r ON r.event_id=d.event_id AND r.revision=d.revision
    WHERE k.bank_key=json_extract(c.value,'$[1]') AND r.superseded_by IS NULL
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.members_json) m WHERE json_extract(m.value,'$.eventId')=d.event_id AND json_extract(m.value,'$.revision')=d.revision)))));

 SELECT RAISE(ABORT,'alias_conflict')
 WHERE EXISTS(SELECT 1 FROM json_each(NEW.members_json) m
  JOIN economic_claims x ON x.event_id=json_extract(m.value,'$.eventId') AND x.revision=json_extract(m.value,'$.revision')
  JOIN economic_claims y ON y.book=x.book AND y.alias_class=x.alias_class
  JOIN economic_event_revisions r ON r.event_id=y.event_id AND r.revision=y.revision
  WHERE x.alias_class IS NOT NULL AND r.superseded_by IS NULL
  AND NOT (y.event_id=x.event_id AND y.revision=x.revision AND y.consumption_key=x.consumption_key));

 SELECT RAISE(ABORT,'economic_commit_released_mismatch')
 WHERE EXISTS(SELECT 1 FROM json_each(NEW.released_json) c
   WHERE EXISTS(SELECT 1 FROM json_each(NEW.claims_json) q WHERE json_extract(q.value,'$[0]')=json_extract(c.value,'$[0]') AND json_extract(q.value,'$[1]')=json_extract(c.value,'$[1]'))
   OR NOT EXISTS(SELECT 1 FROM json_each(NEW.members_json) m JOIN json_each(m.value,'$.supersedes') p
    WHERE (EXISTS(SELECT 1 FROM economic_claims x WHERE x.event_id=json_extract(p.value,'$[0]') AND x.revision=json_extract(p.value,'$[1]')
     AND x.book=json_extract(c.value,'$[0]') AND x.consumption_key=json_extract(c.value,'$[1]'))
    OR (json_extract(c.value,'$[0]')='card-usage' AND EXISTS(SELECT 1 FROM card_purchase_recognition_keys k
     WHERE k.event_id=json_extract(p.value,'$[0]') AND k.revision=json_extract(p.value,'$[1]') AND k.recognition_key=json_extract(c.value,'$[1]')))
    OR (json_extract(c.value,'$[0]')='cash-movement' AND EXISTS(SELECT 1 FROM card_settlement_decisions d
     JOIN card_settlement_candidates k ON k.id=d.proposal_id
     WHERE d.event_id=json_extract(p.value,'$[0]') AND d.revision=json_extract(p.value,'$[1]') AND d.status='accepted' AND k.bank_key=json_extract(c.value,'$[1]'))))))
  OR EXISTS(SELECT 1 FROM json_each(NEW.members_json) m JOIN json_each(m.value,'$.supersedes') p
   JOIN economic_claims x ON x.event_id=json_extract(p.value,'$[0]') AND x.revision=json_extract(p.value,'$[1]')
   WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.claims_json) q WHERE json_extract(q.value,'$[0]')=x.book AND json_extract(q.value,'$[1]')=x.consumption_key)
   AND NOT EXISTS(SELECT 1 FROM json_each(NEW.released_json) q WHERE json_extract(q.value,'$[0]')=x.book AND json_extract(q.value,'$[1]')=x.consumption_key))
  OR EXISTS(SELECT 1 FROM json_each(NEW.members_json) m JOIN json_each(m.value,'$.supersedes') p
   JOIN card_purchase_recognition_keys k ON k.event_id=json_extract(p.value,'$[0]') AND k.revision=json_extract(p.value,'$[1]')
   WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.claims_json) q WHERE json_extract(q.value,'$[0]')='card-usage' AND json_extract(q.value,'$[1]')=k.recognition_key)
   AND NOT EXISTS(SELECT 1 FROM json_each(NEW.released_json) q WHERE json_extract(q.value,'$[0]')='card-usage' AND json_extract(q.value,'$[1]')=k.recognition_key))
  OR EXISTS(SELECT 1 FROM json_each(NEW.members_json) m JOIN json_each(m.value,'$.supersedes') p
   JOIN card_settlement_decisions d ON d.event_id=json_extract(p.value,'$[0]') AND d.revision=json_extract(p.value,'$[1]') AND d.status='accepted'
   JOIN card_settlement_candidates k ON k.id=d.proposal_id
   WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.claims_json) q WHERE json_extract(q.value,'$[0]')='cash-movement' AND json_extract(q.value,'$[1]')=k.bank_key)
   AND NOT EXISTS(SELECT 1 FROM json_each(NEW.released_json) q WHERE json_extract(q.value,'$[0]')='cash-movement' AND json_extract(q.value,'$[1]')=k.bank_key));

 SELECT RAISE(ABORT,'economic_claim_conflict_unresolved')
 WHERE EXISTS(SELECT 1 FROM json_each(NEW.released_json) c
  WHERE (EXISTS(SELECT 1 FROM economic_claims x
    JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision
    WHERE x.book=json_extract(c.value,'$[0]') AND x.consumption_key=json_extract(c.value,'$[1]') AND r.superseded_by IS NULL)
   OR (json_extract(c.value,'$[0]')='card-usage' AND EXISTS(SELECT 1 FROM card_purchase_recognition_keys k
    JOIN economic_event_revisions r ON r.event_id=k.event_id AND r.revision=k.revision
    WHERE k.recognition_key=json_extract(c.value,'$[1]') AND r.superseded_by IS NULL))
   OR (json_extract(c.value,'$[0]')='cash-movement' AND EXISTS(SELECT 1 FROM card_settlement_candidates k
    JOIN card_settlement_decisions d ON d.proposal_id=k.id AND d.status='accepted'
    JOIN economic_event_revisions r ON r.event_id=d.event_id AND r.revision=d.revision
    WHERE k.bank_key=json_extract(c.value,'$[1]') AND r.superseded_by IS NULL))));

 SELECT RAISE(ABORT,'economic_commit_decision_mismatch')
 WHERE NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.id=NEW.decision_revision_id
   AND d.operation_id IS NEW.operation_id AND d.actor_id=NEW.principal)
  OR EXISTS(SELECT 1 FROM json_each(NEW.members_json) m
   JOIN economic_event_revisions r ON r.event_id=json_extract(m.value,'$.eventId') AND r.revision=json_extract(m.value,'$.revision')
   WHERE NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.id=r.decision_revision_id
    AND d.subject_kind='relation' AND d.subject_ref='event:'||r.event_id AND d.revision=r.revision
    AND d.operation_id IS NEW.operation_id AND d.actor_id=NEW.principal));
END;
