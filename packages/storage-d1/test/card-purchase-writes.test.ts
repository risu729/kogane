// The guarded card purchase batch (src/atomic/card-purchase-recognition.ts)
// against the full CORE schema: triggers, CHECKKs and views, with synthetic rows.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  CARD_PURCHASE_ACTOR,
  cardPurchaseEventId,
  cardPurchaseRetirement,
  cardPurchaseRevision,
  cardPurchaseSummary,
  classifyCardUsage,
  recognitionKey,
  validCardPurchaseFacts,
  type CardPurchaseDraft,
  type CardUsageFact,
} from "../../domain/src/card-purchase.ts";
import { validSourceFactRef, type EconomicEventRevision } from "../../domain/src/events.ts";
import { cardPurchaseRecognitionWrites } from "../src/atomic/card-purchase-recognition.ts";
import type { SqlWrite } from "../src/core/operations.ts";
import { counts, factOf, seedCardRows } from "./card-purchase-fixture.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

const NOW = "2026-09-24T00:00:00.000Z";

function database(): Database {
  const db = fullCoreDatabase();
  seedCardRows(db);
  return db;
}

async function run(db: Database, writes: SqlWrite[]): Promise<number[]> {
  const d1 = sqliteD1(db);
  const results = await d1.batch(writes.map((write) => d1.prepare(write.sql).bind(...write.binds)));
  return results.map((result) => result.meta.changes);
}

async function eventIdOf(fact: CardUsageFact): Promise<string> {
  const classified = classifyCardUsage(fact);
  const key = recognitionKey(fact);
  if (!classified.ok || !key) throw new Error("fixture row is not recognisable");
  return cardPurchaseEventId(classified.kind, key);
}

async function draftOf(
  fact: CardUsageFact,
  revision = 1,
  action: "recognize" | "revise" | "reanchor" = revision === 1 ? "recognize" : "revise",
  eventId?: string,
): Promise<CardPurchaseDraft> {
  const draft = await cardPurchaseRevision({
    action,
    eventId: eventId ?? (await eventIdOf(fact)),
    revision,
    fact,
  });
  if (!draft) throw new Error("draft rejected");
  return draft;
}

const write = (draft: CardPurchaseDraft, expectedRevision: number | null) =>
  cardPurchaseRecognitionWrites({ draft, expectedRevision, now: NOW });

function revisionRows(db: Database, eventId: string): Record<string, unknown>[] {
  return db
    .query("SELECT * FROM economic_event_revisions WHERE event_id=? ORDER BY revision")
    .all(eventId) as Record<string, unknown>[];
}

function rowsOf(db: Database, table: string, eventId: string, revision: number): unknown[] {
  return db
    .query(`SELECT * FROM ${table} WHERE event_id=? AND revision=? ORDER BY 1,2,3`)
    .all(eventId, revision);
}

const sourceRevision = (db: Database) =>
  db.query("SELECT source_revision FROM core_source_revision WHERE id=1").get();

/** The stored live revision, read back into the domain shape for the summary. */
function liveEvent(db: Database, eventId: string): EconomicEventRevision {
  const row = db
    .query("SELECT * FROM current_economic_events WHERE event_id=?")
    .get(eventId) as Record<string, string | number | null>;
  const legs = db
    .query("SELECT * FROM economic_legs WHERE event_id=? AND revision=? ORDER BY leg_index")
    .all(eventId, row["revision"] as number) as Record<string, string | number>[];
  return {
    eventId,
    revision: row["revision"] as number,
    kind: row["kind"] as EconomicEventRevision["kind"],
    state: row["state"] as EconomicEventRevision["state"],
    unknownReason: row["unknown_reason"] as EconomicEventRevision["unknownReason"],
    effectiveTime: JSON.parse(row["effective_time_json"] as string),
    basis: row["basis"] as EconomicEventRevision["basis"],
    evidenceSupport: JSON.parse(row["evidence_support_json"] as string),
    decisionRevisionRef: row["decision_revision_id"] as string,
    supersededBy: null,
    legs: legs.map((leg) => ({
      eventId,
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
      basis: leg["basis"] as "purchase-recognition",
    })),
  };
}

describe("card purchase recognition batch", () => {
  test("first recognition writes all rows in one guarded batch", async () => {
    const db = database();
    try {
      const draft = await draftOf(factOf(1));
      const eventId = draft.revision.eventId;
      const writes = write(draft, null);
      // decision → revision → leg → sidecar → keys (no supersede pointer for a first revision).
      expect(writes.map((entry) => /^(?:INSERT INTO|UPDATE) (\w+)/u.exec(entry.sql)?.[1])).toEqual([
        "decision_revisions",
        "economic_event_revisions",
        "economic_legs",
        "card_purchase_recognitions",
        "card_purchase_recognition_keys",
      ]);
      const before = counts(db);
      const changes = await run(db, writes);
      expect(changes.every((count) => count > 0)).toBe(true);
      expect(counts(db)).toEqual({
        ...before,
        decision_revisions: before["decision_revisions"]! + 1,
        economic_event_revisions: 1,
        economic_legs: 1,
        card_purchase_recognitions: 1,
        card_purchase_recognition_keys: 1,
        allocations: 0,
      });
      const decision = db
        .query("SELECT * FROM decision_revisions WHERE id=?")
        .get(draft.decisionRevisionId) as Record<string, unknown>;
      expect(decision).toMatchObject({
        subject_kind: "relation",
        subject_ref: `event:${eventId}`,
        revision: 1,
        decision_kind: "accept",
        method: "rule",
        actor_id: CARD_PURCHASE_ACTOR,
        operation_id: null,
        reason: "card-purchase-recognition-v1:recognize",
        previous_revision: null,
        superseded_by: null,
      });
      // Evidence is SourceFactRef objects everywhere, never strings.
      for (const json of [
        decision["evidence_refs_json"] as string,
        revisionRows(db, eventId)[0]!["evidence_support_json"] as string,
      ]) {
        const refs: unknown[] = JSON.parse(json);
        expect(refs).toEqual([
          { kind: "transaction", id: "transaction:1", revision: "parse_run:1" },
        ]);
        expect(refs.every(validSourceFactRef)).toBe(true);
      }
      expect(rowsOf(db, "economic_legs", eventId, 1)).toEqual([
        {
          event_id: eventId,
          revision: 1,
          leg_index: 0,
          subject_ref: "account:acct-card",
          unit_ref: "JPY",
          value_status: "exact",
          coefficient: "1234",
          scale: 0,
          value_reason_code: null,
          role: "decrease",
          basis: "purchase-recognition",
        },
      ]);
      const sidecar = db
        .query("SELECT * FROM current_card_purchase_recognitions WHERE event_id=?")
        .get(eventId) as Record<string, string | number>;
      expect(sidecar).toMatchObject({
        revision: 1,
        action: "recognize",
        policy_release: "card-purchase-recognition-v1",
        content_digest: draft.contentDigest,
        account_id: "acct-card",
        source_id: "vpass",
        statement_period: "2026-09",
        kind: "purchase",
        state: "captured",
      });
      // Codes, amounts and dates only: no merchant or payment wording is stored.
      const facts = sidecar["facts_json"] as string;
      expect(validCardPurchaseFacts(JSON.parse(facts))).toBe(true);
      expect(facts).not.toContain("merchant");
      expect(facts).not.toContain("回払い");
      expect(
        db
          .query(
            "SELECT event_id,revision,role,observation_id,parse_run_id FROM current_card_purchase_keys",
          )
          .all(),
      ).toEqual([
        { event_id: eventId, revision: 1, role: "posted", observation_id: 1, parse_run_id: 1 },
      ]);
      // MyJCB goes through the same batch.
      await run(db, write(await draftOf(factOf(5)), null));
      expect(
        db
          .query(
            "SELECT source_id,account_id,statement_period FROM current_card_purchase_recognitions WHERE source_id='myjcb'",
          )
          .all(),
      ).toEqual([{ source_id: "myjcb", account_id: "acct-jcb", statement_period: null }]);
      expect(counts(db)["allocations"]).toBe(0);
    } finally {
      db.close();
    }
  }, 30_000);

  test("replay writes nothing", async () => {
    const db = database();
    try {
      const writes = write(await draftOf(factOf(1)), null);
      await run(db, writes);
      const before = { counts: counts(db), revision: sourceRevision(db) };
      expect(await run(db, writes)).toEqual(writes.map(() => 0));
      // A concurrent duplicate is the same batch built again: it also writes nothing.
      expect(await run(db, write(await draftOf(factOf(1)), null))).toEqual(writes.map(() => 0));
      // A re-fetch showing the same content plans the same decision and writes nothing.
      expect(await run(db, write(await draftOf(factOf(3)), null))).toEqual(writes.map(() => 0));
      expect({ counts: counts(db), revision: sourceRevision(db) }).toEqual(before);
    } finally {
      db.close();
    }
  }, 30_000);

  test("a stale expected revision writes nothing in any table", async () => {
    const db = database();
    try {
      const first = await draftOf(factOf(1));
      const eventId = first.revision.eventId;
      await run(db, write(first, null));
      // Two writers plan against revision 1; the corrected amount commits first.
      const revise = await draftOf(factOf(4), 2);
      const retire = await cardPurchaseRetirement({
        live: first.revision,
        keys: first.keys,
        sidecar: first.sidecar,
      });
      await run(db, write(revise, 1));
      const before = { counts: counts(db), revision: sourceRevision(db) };
      const stale = write(retire!, 1);
      expect(await run(db, stale)).toEqual(stale.map(() => 0));
      // A first recognition of an event that already exists is stale too.
      const again = write(await draftOf(factOf(3), 1, "recognize", eventId), null);
      expect(await run(db, again)).toEqual(again.map(() => 0));
      // Another event may not claim a key a live event holds.
      const other = write(
        await draftOf(factOf(3), 1, "recognize", `purchase_${"0".repeat(64)}`),
        null,
      );
      expect(await run(db, other)).toEqual(other.map(() => 0));
      expect({ counts: counts(db), revision: sourceRevision(db) }).toEqual(before);
      expect(db.query("SELECT event_id,revision FROM current_economic_events").all()).toEqual([
        { event_id: eventId, revision: 2 },
      ]);
      // A builder input that does not follow its expected revision is a programming error.
      expect(() => write(revise, null)).toThrow(RangeError);
      expect(() => write(revise, 2)).toThrow(RangeError);
    } finally {
      db.close();
    }
  }, 30_000);

  test("supersession only moves superseded_by", async () => {
    const db = database();
    try {
      const first = await draftOf(factOf(1));
      const eventId = first.revision.eventId;
      await run(db, write(first, null));
      const [original] = revisionRows(db, eventId);
      const tables = [
        "economic_legs",
        "card_purchase_recognitions",
        "card_purchase_recognition_keys",
      ];
      const before = Object.fromEntries(
        tables.map((table) => [table, rowsOf(db, table, eventId, 1)]),
      );
      // Observation 3 re-parses the same row with the same content: a reanchor.
      const reanchor = await draftOf(factOf(3), 2, "reanchor");
      expect(reanchor.contentDigest).toBe(first.contentDigest);
      const writes = write(reanchor, 1);
      expect(writes.map((entry) => /^(?:INSERT INTO|UPDATE) (\w+)/u.exec(entry.sql)?.[1])).toEqual([
        "decision_revisions",
        "economic_event_revisions",
        "economic_legs",
        "economic_event_revisions",
        "card_purchase_recognitions",
        "card_purchase_recognition_keys",
      ]);
      await run(db, writes);
      const [old, current] = revisionRows(db, eventId);
      expect(old).toEqual({ ...original, superseded_by: `${eventId}@2` });
      expect(current).toMatchObject({ revision: 2, state: "captured", superseded_by: null });
      for (const table of tables) expect(rowsOf(db, table, eventId, 1)).toEqual(before[table]!);
      expect(
        db
          .query("SELECT decision_kind,previous_revision,reason FROM decision_revisions WHERE id=?")
          .get(reanchor.decisionRevisionId),
      ).toEqual({
        decision_kind: "supersede",
        previous_revision: 1,
        reason: "card-purchase-recognition-v1:reanchor",
      });
      expect(
        db
          .query("SELECT revision,action,content_digest FROM current_card_purchase_recognitions")
          .all(),
      ).toEqual([{ revision: 2, action: "reanchor", content_digest: first.contentDigest }]);
      expect(
        db.query("SELECT revision,observation_id FROM current_card_purchase_keys").all(),
      ).toEqual([{ revision: 2, observation_id: 3 }]);
      // Exactly one live purchase-recognition leg: nothing is double counted.
      const summary = cardPurchaseSummary([liveEvent(db, eventId)]);
      expect(summary.ok && summary.summary.units[0]!.captured.value).toMatchObject({
        value: { coefficient: "1234", scale: 0 },
      });
    } finally {
      db.close();
    }
  }, 30_000);

  test("retirement has no legs", async () => {
    const db = database();
    try {
      const pending = await draftOf(factOf(2));
      const eventId = pending.revision.eventId;
      await run(db, write(pending, null));
      expect(revisionRows(db, eventId)[0]).toMatchObject({ state: "authorized" });
      const retired = await cardPurchaseRetirement({
        live: pending.revision,
        keys: pending.keys,
        sidecar: pending.sidecar,
      });
      const writes = write(retired!, 1);
      expect(writes.some((entry) => entry.sql.startsWith("INSERT INTO economic_legs"))).toBe(false);
      await run(db, writes);
      expect(revisionRows(db, eventId)[1]).toMatchObject({
        revision: 2,
        kind: "purchase",
        state: "unknown",
        unknown_reason: "provider_status_absent",
        superseded_by: null,
      });
      expect(rowsOf(db, "economic_legs", eventId, 2)).toEqual([]);
      expect(db.query("SELECT action,state FROM current_card_purchase_recognitions").all()).toEqual(
        [{ action: "retire", state: "unknown" }],
      );
      // The retired event keeps its key, so no other event can take the row.
      expect(
        db.query("SELECT event_id,revision,role FROM current_card_purchase_keys").all(),
      ).toEqual([{ event_id: eventId, revision: 2, role: "pending" }]);
      const summary = cardPurchaseSummary([liveEvent(db, eventId)]);
      expect(summary.ok && summary.summary).toEqual({ units: [], unresolved: 1 });
      expect(counts(db)["allocations"]).toBe(0);
    } finally {
      db.close();
    }
  }, 30_000);
});
