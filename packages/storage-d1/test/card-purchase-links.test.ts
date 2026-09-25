// The guarded merge and split batches of a pending-to-posted link
// (src/atomic/card-purchase-recognition.ts) against the full CORE schema:
// the 0047 sidecar and key triggers, the 0032 cross-id supersession, and the
// `proposal:` / `card-purchase:` expected-revision subjects. Synthetic rows.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  cardPurchaseEventId,
  cardPurchaseMerge,
  cardPurchaseRetirement,
  cardPurchaseRevision,
  cardPurchaseSplit,
  cardPurchaseSummary,
  classifyCardUsage,
  recognitionKey,
  type CardPurchaseDraft,
  type CardPurchaseLive,
  type CardUsageFact,
} from "../../domain/src/card-purchase.ts";
import type { EconomicEventRevision } from "../../domain/src/events.ts";
import {
  cardPurchaseMergeWrites,
  cardPurchaseRecognitionWrites,
  cardPurchaseSplitWrites,
} from "../src/atomic/card-purchase-recognition.ts";
import { currentRevisionsSql, type SqlWrite } from "../src/core/operations.ts";
import { factOf, seedCardRows, snapshot } from "./card-purchase-fixture.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

const NOW = "2026-09-24T00:00:00.000Z";

function database(): Database {
  const db = fullCoreDatabase();
  seedCardRows(db);
  return db;
}

async function run(db: Database, writes: readonly SqlWrite[]): Promise<number[]> {
  const d1 = sqliteD1(db);
  const results = await d1.batch(writes.map((write) => d1.prepare(write.sql).bind(...write.binds)));
  return results.map((result) => result.meta.changes);
}

async function recognised(db: Database, fact: CardUsageFact): Promise<CardPurchaseDraft> {
  const classified = classifyCardUsage(fact);
  const key = recognitionKey(fact);
  if (!classified.ok || !key) throw new Error("fixture row is not recognisable");
  const draft = await cardPurchaseRevision({
    action: "recognize",
    eventId: await cardPurchaseEventId(classified.kind, key),
    revision: 1,
    fact,
  });
  if (!draft) throw new Error("draft rejected");
  await run(db, cardPurchaseRecognitionWrites({ draft, expectedRevision: null, now: NOW }));
  return draft;
}

const live = (draft: CardPurchaseDraft): CardPurchaseLive => ({
  revision: draft.revision,
  keys: draft.keys,
  sidecar: draft.sidecar,
});

/** The stored live revision's legs, read back for the summary. */
function liveEvents(db: Database): EconomicEventRevision[] {
  const events = db
    .query("SELECT * FROM current_economic_events ORDER BY event_id")
    .all() as Record<string, string | number | null>[];
  return events.map((row) => ({
    eventId: row["event_id"] as string,
    revision: row["revision"] as number,
    kind: row["kind"] as EconomicEventRevision["kind"],
    state: row["state"] as EconomicEventRevision["state"],
    unknownReason: row["unknown_reason"] as EconomicEventRevision["unknownReason"],
    effectiveTime: JSON.parse(row["effective_time_json"] as string),
    basis: "purchase-recognition",
    evidenceSupport: JSON.parse(row["evidence_support_json"] as string),
    decisionRevisionRef: row["decision_revision_id"] as string,
    supersededBy: null,
    legs: (
      db
        .query("SELECT * FROM economic_legs WHERE event_id=? AND revision=?")
        .all(row["event_id"] as string, row["revision"] as number) as Record<
        string,
        string | number
      >[]
    ).map((leg) => ({
      eventId: leg["event_id"] as string,
      revision: leg["revision"] as number,
      legIndex: leg["leg_index"] as number,
      subjectRef: leg["subject_ref"] as string,
      quantity: {
        unitRef: leg["unit_ref"] as string,
        value: {
          status: "exact",
          value: { coefficient: leg["coefficient"] as string, scale: leg["scale"] as number },
          normalizationVersion: "decimal-v1",
        },
      },
      role: leg["role"] as "decrease",
      basis: "purchase-recognition",
    })),
  }));
}

function figures(db: Database) {
  const summary = cardPurchaseSummary(liveEvents(db));
  if (!summary.ok) throw new Error("summary failed");
  const jpy = summary.summary.units.find((unit) => unit.unitRef === "JPY");
  const text = (value: unknown) =>
    (value as { value: { value?: { coefficient: string } } } | undefined)?.value.value
      ?.coefficient ?? "0";
  return {
    captured: text(jpy?.captured),
    authorized: text(jpy?.authorized),
    unresolved: summary.summary.unresolved,
  };
}

function holders(db: Database) {
  return db
    .query("SELECT event_id,revision,role FROM current_card_purchase_keys ORDER BY role")
    .all();
}

/** The MyJCB pending row (obs 2, authorized) and its posted row (obs 6, captured), each its own event. */
async function pair(db: Database) {
  const pending = await recognised(db, factOf(2));
  const posted = await recognised(db, factOf(6));
  const merge = await cardPurchaseMerge({ survivor: live(pending), absorbed: live(posted) });
  if (!merge) throw new Error("merge rejected");
  return { pending, posted, merge };
}

describe("pending-to-posted merge and split batches", () => {
  test("a merge supersedes both live revisions across ids and holds both keys", async () => {
    const db = database();
    try {
      const { pending, posted, merge } = await pair(db);
      const a = pending.revision.eventId;
      const b = posted.revision.eventId;
      expect(figures(db)).toEqual({ captured: "1234", authorized: "1200", unresolved: 0 });
      const writes = cardPurchaseMergeWrites({ merge, now: NOW });
      // A@n+1 → legs → supersede A@n and B@m → sidecar → keys.
      expect(writes.map((entry) => /^(?:INSERT INTO|UPDATE) (\w+)/u.exec(entry.sql)?.[1])).toEqual([
        "decision_revisions",
        "economic_event_revisions",
        "economic_legs",
        "economic_event_revisions",
        "economic_event_revisions",
        "card_purchase_recognitions",
        "card_purchase_recognition_keys",
        "card_purchase_recognition_keys",
      ]);
      expect((await run(db, writes)).every((changes) => changes > 0)).toBe(true);
      expect(
        db
          .query(
            "SELECT event_id,revision,state,superseded_by FROM economic_event_revisions ORDER BY event_id=?,revision",
          )
          .all(a),
      ).toEqual([
        { event_id: b, revision: 1, state: "captured", superseded_by: `${a}@2` },
        { event_id: a, revision: 1, state: "authorized", superseded_by: `${a}@2` },
        { event_id: a, revision: 2, state: "captured", superseded_by: null },
      ]);
      expect(holders(db)).toEqual([
        { event_id: a, revision: 2, role: "pending" },
        { event_id: a, revision: 2, role: "posted" },
      ]);
      // One purchase-recognition leg, the posted amount; the captured total unchanged.
      expect(figures(db)).toEqual({ captured: "1234", authorized: "0", unresolved: 0 });
      expect(
        db
          .query("SELECT action FROM card_purchase_recognitions WHERE event_id=? AND revision=2")
          .get(a),
      ).toEqual({ action: "merge" });
      expect(
        db
          .query(
            "SELECT decision_kind,method,previous_revision,reason FROM decision_revisions WHERE id=?",
          )
          .get(merge.draft.decisionRevisionId),
      ).toEqual({
        decision_kind: "supersede",
        method: "rule",
        previous_revision: 1,
        reason: "card-purchase-recognition-v1:merge",
      });
      // Posted evidence first, then the pending row.
      expect(merge.draft.revision.evidenceSupport.map((ref) => ref.id)).toEqual([
        "transaction:6",
        "transaction:2",
      ]);
      // A replay writes nothing anywhere.
      const after = snapshot(db);
      expect(await run(db, writes)).toEqual(writes.map(() => 0));
      expect(snapshot(db)).toEqual(after);
    } finally {
      db.close();
    }
  }, 30_000);

  test("a stale merge, a key held elsewhere or a failed outer guard writes nothing", async () => {
    const db = database();
    try {
      const { pending, merge } = await pair(db);
      // The outer guard (the change lifecycle's receipt) did not hold.
      const before = snapshot(db);
      const refused = cardPurchaseMergeWrites({ merge, now: NOW, guard: { sql: "0", binds: [] } });
      expect(await run(db, refused)).toEqual(refused.map(() => 0));
      expect(snapshot(db)).toEqual(before);
      // A merge naming an event that does not hold the posted key: the key is
      // held elsewhere (by the posted event), so nothing moves.
      const third = await recognised(db, factOf(5));
      const forged = {
        ...merge,
        absorbed: { eventId: third.revision.eventId, revision: 1 },
      };
      const held = snapshot(db);
      const forgedWrites = cardPurchaseMergeWrites({ merge: forged, now: NOW });
      expect(await run(db, forgedWrites)).toEqual(forgedWrites.map(() => 0));
      expect(snapshot(db)).toEqual(held);
      // The pending event moved on (retired) after the merge was planned.
      const retired = await cardPurchaseRetirement({
        live: pending.revision,
        keys: pending.keys,
        sidecar: pending.sidecar,
      });
      await run(
        db,
        cardPurchaseRecognitionWrites({ draft: retired!, expectedRevision: 1, now: NOW }),
      );
      const moved = snapshot(db);
      const stale = cardPurchaseMergeWrites({ merge, now: NOW });
      expect(await run(db, stale)).toEqual(stale.map(() => 0));
      expect(snapshot(db)).toEqual(moved);
    } finally {
      db.close();
    }
  }, 30_000);

  test("without the cross-id pointer the one-live-holder trigger refuses the posted key", async () => {
    const db = database();
    try {
      const { merge } = await pair(db);
      const before = snapshot(db);
      const writes = cardPurchaseMergeWrites({ merge, now: NOW });
      // Drop the statement that supersedes the posted event's live revision.
      const unpointed = writes.filter((_, index) => index !== 4);
      await expect(run(db, unpointed)).rejects.toThrow("card_purchase_key_held");
      expect(snapshot(db)).toEqual(before);
    } finally {
      db.close();
    }
  }, 30_000);

  test("a split retires the merged event to its pending key and restores the posted event", async () => {
    const db = database();
    try {
      const { pending, posted, merge } = await pair(db);
      const a = pending.revision.eventId;
      const b = posted.revision.eventId;
      await run(db, cardPurchaseMergeWrites({ merge, now: NOW }));
      const split = await cardPurchaseSplit({
        merged: live(merge.draft),
        pendingSidecar: pending.sidecar,
        absorbed: { eventId: b, revision: 1 },
      });
      if (!split) throw new Error("split rejected");
      const writes = cardPurchaseSplitWrites({ split, now: NOW });
      expect((await run(db, writes)).every((changes) => changes > 0)).toBe(true);
      expect(
        db
          .query(
            `SELECT r.event_id,r.revision,r.state,r.unknown_reason,r.superseded_by,c.action
             FROM economic_event_revisions r JOIN card_purchase_recognitions c USING(event_id,revision)
             ORDER BY r.event_id=?,r.revision`,
          )
          .all(a),
      ).toEqual([
        {
          event_id: b,
          revision: 1,
          state: "captured",
          unknown_reason: null,
          superseded_by: `${a}@2`,
          action: "recognize",
        },
        {
          event_id: b,
          revision: 2,
          state: "captured",
          unknown_reason: null,
          superseded_by: null,
          action: "split",
        },
        {
          event_id: a,
          revision: 1,
          state: "authorized",
          unknown_reason: null,
          superseded_by: `${a}@2`,
          action: "recognize",
        },
        {
          event_id: a,
          revision: 2,
          state: "captured",
          unknown_reason: null,
          superseded_by: `${a}@3`,
          action: "merge",
        },
        {
          event_id: a,
          revision: 3,
          state: "unknown",
          unknown_reason: "conflicting_evidence",
          superseded_by: null,
          action: "retire",
        },
      ]);
      // Two live single-key holders again; the captured total is unchanged.
      expect(holders(db)).toEqual([
        { event_id: a, revision: 3, role: "pending" },
        { event_id: b, revision: 2, role: "posted" },
      ]);
      expect(figures(db)).toEqual({ captured: "1234", authorized: "0", unresolved: 1 });
      // The retirement keeps the pending row's own facts and date.
      expect(
        db
          .query(
            "SELECT json_extract(facts_json,'$.providerStatus') AS status FROM card_purchase_recognitions WHERE event_id=? AND revision=3",
          )
          .get(a),
      ).toEqual({ status: "unconfirmed" });
      // Replayed, or planned again against the split state, it writes nothing.
      const after = snapshot(db);
      expect(await run(db, writes)).toEqual(writes.map(() => 0));
      const again = cardPurchaseSplitWrites({ split, now: "2026-09-25T00:00:00.000Z" });
      expect(await run(db, again)).toEqual(again.map(() => 0));
      expect(snapshot(db)).toEqual(after);
      // And the pair can be merged again from the restored events.
      const remerge = await cardPurchaseMerge({
        survivor: live(split.retire),
        absorbed: live(split.restore),
      });
      expect(remerge).not.toBeNull();
      expect(
        (await run(db, cardPurchaseMergeWrites({ merge: remerge!, now: NOW }))).every((n) => n > 0),
      ).toBe(true);
      expect(figures(db)).toEqual({ captured: "1234", authorized: "0", unresolved: 0 });
    } finally {
      db.close();
    }
  }, 30_000);

  test("a merged event already retired splits into two retired events", async () => {
    const db = database();
    try {
      const { pending, posted, merge } = await pair(db);
      const a = pending.revision.eventId;
      const b = posted.revision.eventId;
      await run(db, cardPurchaseMergeWrites({ merge, now: NOW }));
      // Neither row is current any more: the lane retires the merged event
      // holding both keys, with no leg.
      const retired = await cardPurchaseRetirement({
        live: merge.draft.revision,
        keys: merge.draft.keys,
        sidecar: merge.draft.sidecar,
      });
      const retirement = cardPurchaseRecognitionWrites({
        draft: retired!,
        expectedRevision: 2,
        now: NOW,
      });
      expect((await run(db, retirement)).every((changes) => changes > 0)).toBe(true);
      expect(figures(db)).toEqual({ captured: "0", authorized: "0", unresolved: 1 });
      const split = await cardPurchaseSplit({
        merged: live(retired!),
        pendingSidecar: pending.sidecar,
        absorbed: { eventId: b, revision: 1 },
      });
      if (!split) throw new Error("split rejected");
      expect([split.retire.action, split.restore.action]).toEqual(["retire", "retire"]);
      const writes = cardPurchaseSplitWrites({ split, now: NOW });
      expect((await run(db, writes)).every((changes) => changes > 0)).toBe(true);
      expect(
        db
          .query(
            `SELECT r.event_id,r.revision,r.state,r.unknown_reason,c.action,
              (SELECT count(*) FROM economic_legs l WHERE l.event_id=r.event_id AND l.revision=r.revision) AS legs
             FROM current_economic_events r JOIN card_purchase_recognitions c USING(event_id,revision)
             ORDER BY r.event_id=?`,
          )
          .all(a),
      ).toEqual([
        {
          event_id: b,
          revision: 2,
          state: "unknown",
          unknown_reason: "provider_status_absent",
          action: "retire",
          legs: 0,
        },
        {
          event_id: a,
          revision: 4,
          state: "unknown",
          unknown_reason: "conflicting_evidence",
          action: "retire",
          legs: 0,
        },
      ]);
      expect(holders(db)).toEqual([
        { event_id: a, revision: 4, role: "pending" },
        { event_id: b, revision: 2, role: "posted" },
      ]);
      expect(figures(db)).toEqual({ captured: "0", authorized: "0", unresolved: 2 });
      // A replay writes nothing anywhere.
      const after = snapshot(db);
      expect(await run(db, writes)).toEqual(writes.map(() => 0));
      expect(snapshot(db)).toEqual(after);
    } finally {
      db.close();
    }
  }, 30_000);

  test("proposal: and card-purchase: subjects answer the decision count and the live revision", async () => {
    const db = database();
    try {
      const { pending, posted, merge } = await pair(db);
      const a = pending.revision.eventId;
      const b = posted.revision.eventId;
      const revisions = (subjects: Record<string, number>) =>
        Object.fromEntries(
          (
            db.query(currentRevisionsSql("?")).all(JSON.stringify(subjects)) as {
              subject_ref: string;
              revision: number;
            }[]
          ).map((row) => [row.subject_ref, row.revision]),
        );
      const subjects = {
        "proposal:rp_synthetic": 0,
        [`card-purchase:${a}`]: 0,
        [`card-purchase:${b}`]: 0,
        "card-purchase:purchase_absent": 0,
      };
      expect(revisions(subjects)).toEqual({
        "proposal:rp_synthetic": 0,
        [`card-purchase:${a}`]: 1,
        [`card-purchase:${b}`]: 1,
        "card-purchase:purchase_absent": 0,
      });
      db.run(
        `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
         VALUES('dr_p1','relation','proposal:rp_synthetic',1,'accept','manual','reviewer',NULL,'x','[]',NULL,NULL,?),
               ('dr_p2','relation','proposal:rp_synthetic',2,'supersede','manual','reviewer',NULL,'x','[]',1,NULL,?)`,
        [NOW, NOW],
      );
      await run(db, cardPurchaseMergeWrites({ merge, now: NOW }));
      // The survivor's live revision grew; the absorbed event has none.
      expect(revisions(subjects)).toEqual({
        "proposal:rp_synthetic": 2,
        [`card-purchase:${a}`]: 2,
        [`card-purchase:${b}`]: 0,
        "card-purchase:purchase_absent": 0,
      });
    } finally {
      db.close();
    }
  }, 30_000);
});
