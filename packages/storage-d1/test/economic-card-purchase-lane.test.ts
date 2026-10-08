// The card purchase lane as a writer of the common consumption guard (ADR
// 0054, G1b): every batch of src/atomic/card-purchase-recognition.ts ends
// with a revision seal per member and one commit row, on the full CORE schema
// through the bun:sqlite D1Like whose batch rolls back on any SQL error as D1
// does. Every row is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  CARD_PURCHASE_ACTOR,
  CARD_PURCHASE_WRITER_RELEASE,
  cardPurchaseEventId,
  cardPurchaseMerge,
  cardPurchaseRetirement,
  cardPurchaseRevision,
  cardPurchaseSplit,
  classifyCardUsage,
  recognitionKey,
  type CardPurchaseDraft,
  type CardPurchaseLive,
  type CardUsageFact,
} from "../../domain/src/card-purchase.ts";
import { INITIAL_IDENTITY_EPOCH } from "../../domain/src/economic-contract.ts";
import {
  CURRENT_IDENTITY_EPOCH_SQL,
  cardPurchaseMergeWrites,
  cardPurchaseRecognitionWrites,
  cardPurchaseSplitWrites,
} from "../src/atomic/card-purchase-recognition.ts";
import { canonicalKnownAt } from "../src/atomic/economic-commit.ts";
import { currentRevisionsSql, type SqlWrite } from "../src/core/operations.ts";
import { factOf, seedCardRows } from "./card-purchase-fixture.ts";
import { preGuardDraft, preGuardRecognitionWrites } from "./card-purchase-pre-guard.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const NOW = "2026-09-24T00:00:00.000Z";
const LATER = "2026-09-25T00:00:00.000Z";

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

/** Every row of every table, so a moved pointer shows as well as a new row. */
function snapshot(db: Database): Record<string, unknown[]> {
  const tables = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .query(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

async function draftOf(fact: CardUsageFact): Promise<CardPurchaseDraft> {
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
  return draft;
}

const recognise = (draft: CardPurchaseDraft, now = NOW) =>
  cardPurchaseRecognitionWrites({ draft, expectedRevision: null, now });

const live = (draft: CardPurchaseDraft): CardPurchaseLive => ({
  revision: draft.revision,
  keys: draft.keys,
  sidecar: draft.sidecar,
});

const commits = (db: Database) =>
  db
    .query(
      `SELECT commit_seq,decision_revision_id,operation_id,principal,payload_digest,kind,members_json,claims_json,released_json,known_at
       FROM economic_commit_log ORDER BY commit_seq`,
    )
    .all() as Record<string, unknown>[];

const seals = (db: Database) =>
  db
    .query(
      `SELECT event_id,revision,writer_release,leg_count,claim_count,time_count,effect_count,content_digest,identity_pins_json,identity_epoch,commit_seq
       FROM economic_revision_seals ORDER BY commit_seq,event_id,revision`,
    )
    .all() as Record<string, unknown>[];

const unlogged = (db: Database) =>
  db.query("SELECT event_id,revision,live FROM unlogged_economic_revisions ORDER BY 1,2").all();

function revisionOf(db: Database, subjects: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    (
      db.query(currentRevisionsSql("?")).all(JSON.stringify(subjects)) as {
        subject_ref: string;
        revision: number;
      }[]
    ).map((row) => [row.subject_ref, row.revision]),
  );
}

describe("a recognition is sealed and logged", () => {
  test("its keys are its claims: one seal, one commit row, no economic_claims row", async () => {
    const db = database();
    const draft = await draftOf(factOf(1));
    const ref = { eventId: draft.revision.eventId, revision: 1 };
    expect((await run(db, recognise(draft))).every((changes) => changes > 0)).toBe(true);
    expect(seals(db)).toEqual([
      {
        event_id: ref.eventId,
        revision: 1,
        writer_release: CARD_PURCHASE_WRITER_RELEASE,
        leg_count: 1,
        claim_count: 1,
        time_count: 0,
        effect_count: 0,
        content_digest: draft.contentDigest,
        identity_pins_json: "{}",
        identity_epoch: INITIAL_IDENTITY_EPOCH,
        commit_seq: 1,
      },
    ]);
    expect(commits(db)).toEqual([
      {
        commit_seq: 1,
        decision_revision_id: draft.decisionRevisionId,
        operation_id: null,
        principal: CARD_PURCHASE_ACTOR,
        payload_digest: draft.decisionRevisionId.slice("dr_cp_".length),
        kind: "card-purchase.recognize",
        members_json: JSON.stringify([{ ...ref, supersedes: [] }]),
        claims_json: JSON.stringify([["card-usage", draft.keys[0]!.key]]),
        released_json: "[]",
        known_at: NOW,
      },
    ]);
    // No duplicate storage: the key is read through the union view once.
    expect(db.query("SELECT count(*) AS n FROM economic_claims").get()).toEqual({ n: 0 });
    expect(
      db.query("SELECT book,consumption_key,event_id,revision FROM live_consumption_claims").all(),
    ).toEqual([
      {
        book: "card-usage",
        consumption_key: draft.keys[0]!.key,
        event_id: ref.eventId,
        revision: 1,
      },
    ]);
    expect(unlogged(db)).toEqual([]);
    // A replay finds every row it would write.
    const before = snapshot(db);
    const again = recognise(draft, LATER);
    expect(await run(db, again)).toEqual(again.map(() => 0));
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("known_at is the canonical instant of the lane's clock", async () => {
    const db = database();
    await run(db, recognise(await draftOf(factOf(1)), "2026-09-24T09:00:00+09:00"));
    expect(commits(db).map((row) => row["known_at"])).toEqual(["2026-09-24T00:00:00.000Z"]);
    expect(() => canonicalKnownAt("not a time")).toThrow("now is not an instant");
    db.close();
  });

  test("a revision supersedes its prior and keeps its keys: nothing is released", async () => {
    const db = database();
    const first = await draftOf(factOf(1));
    await run(db, recognise(first));
    const retired = await cardPurchaseRetirement({
      live: first.revision,
      keys: first.keys,
      sidecar: first.sidecar,
    });
    if (!retired) throw new Error("retirement rejected");
    await run(
      db,
      cardPurchaseRecognitionWrites({ draft: retired, expectedRevision: 1, now: LATER }),
    );
    const eventId = first.revision.eventId;
    expect(
      commits(db).map(({ kind, members_json, released_json }) => [
        kind,
        members_json,
        released_json,
      ]),
    ).toEqual([
      ["card-purchase.recognize", JSON.stringify([{ eventId, revision: 1, supersedes: [] }]), "[]"],
      [
        "card-purchase.retire",
        JSON.stringify([{ eventId, revision: 2, supersedes: [[eventId, 1]] }]),
        "[]",
      ],
    ]);
    expect(seals(db).map((row) => [row["revision"], row["leg_count"], row["claim_count"]])).toEqual(
      [
        [1, 1, 1],
        [2, 0, 1],
      ],
    );
    db.close();
  });

  test("a draft that drops a key its prior held is refused, never released silently", async () => {
    const db = database();
    const { pending, merge } = await pair(db);
    await run(db, cardPurchaseMergeWrites({ merge, now: NOW }));
    const retired = await cardPurchaseRetirement({
      live: merge.draft.revision,
      keys: merge.draft.keys,
      sidecar: merge.draft.sidecar,
    });
    if (!retired) throw new Error("retirement rejected");
    // The same retirement holding only the pending key: the posted key would
    // be dropped without being declared released.
    const dropping: CardPurchaseDraft = {
      ...retired,
      keys: retired.keys.filter((key) => key.key === pending.keys[0]!.key),
    };
    const before = snapshot(db);
    await expect(
      run(
        db,
        cardPurchaseRecognitionWrites({
          draft: dropping,
          expectedRevision: merge.draft.revision.revision,
          now: LATER,
        }),
      ),
    ).rejects.toThrow("economic_commit_released_mismatch");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });
});

describe("the decision digest names the writer release (G1b decisionEntry decision)", () => {
  test("a guard-era batch has its own entry; the pre-guard revision stays unlogged, never backdated", async () => {
    const db = database();
    const current = await draftOf(factOf(1));
    const legacy = await preGuardDraft(current);
    expect(current.decisionRevisionId).not.toBe(legacy.decisionRevisionId);
    // A pre-guard build recognised the row.
    await run(db, preGuardRecognitionWrites(legacy, null, NOW));
    // The guard-era lane retires it: its own decision, its own seal and commit row.
    const retired = await cardPurchaseRetirement({
      live: legacy.revision,
      keys: legacy.keys,
      sidecar: legacy.sidecar,
    });
    if (!retired) throw new Error("retirement rejected");
    expect(
      (
        await run(
          db,
          cardPurchaseRecognitionWrites({ draft: retired, expectedRevision: 1, now: LATER }),
        )
      ).every((changes) => changes > 0),
    ).toBe(true);
    const eventId = current.revision.eventId;
    expect(
      commits(db).map(({ decision_revision_id, known_at }) => [decision_revision_id, known_at]),
    ).toEqual([[retired.decisionRevisionId, LATER]]);
    // The pre-guard revision has no seal and no commit: it reads as unlogged
    // knowledge, not as known at the guard-era commit.
    expect(unlogged(db)).toEqual([{ event_id: eventId, revision: 1, live: 0 }]);
    db.close();
  });

  test("a pre-guard draft id replayed after its revision was superseded writes nothing and fails closed", async () => {
    const db = database();
    const legacy = await preGuardDraft(await draftOf(factOf(1)));
    await run(db, preGuardRecognitionWrites(legacy, null, NOW));
    const retired = await cardPurchaseRetirement({
      live: legacy.revision,
      keys: legacy.keys,
      sidecar: legacy.sidecar,
    });
    if (!retired) throw new Error("retirement rejected");
    await run(
      db,
      cardPurchaseRecognitionWrites({ draft: retired, expectedRevision: 1, now: LATER }),
    );
    const before = snapshot(db);
    // The old id's entry exists, so the replay reaches its seal, which a
    // superseded revision cannot take.
    await expect(run(db, recognise(legacy, LATER))).rejects.toThrow("economic_seal_invalid");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });
});

/** The MyJCB pending row (obs 2, authorized) and its posted row (obs 6, captured), each its own event. */
async function pair(db: Database) {
  const pending = await draftOf(factOf(2));
  const posted = await draftOf(factOf(6));
  await run(db, recognise(pending));
  await run(db, recognise(posted));
  const merge = await cardPurchaseMerge({ survivor: live(pending), absorbed: live(posted) });
  if (!merge) throw new Error("merge rejected");
  return { pending, posted, merge };
}

describe("merge and split commit every member", () => {
  test("a merge is one member superseding both events; a split seals both members in one commit", async () => {
    const db = database();
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
    expect(
      (await run(db, cardPurchaseSplitWrites({ split, now: LATER }))).every((n) => n > 0),
    ).toBe(true);
    const rows = commits(db);
    expect(rows.map(({ commit_seq, kind }) => [commit_seq, kind])).toEqual([
      [1, "card-purchase.recognize"],
      [2, "card-purchase.recognize"],
      [3, "card-purchase.merge"],
      [4, "card-purchase.split"],
    ]);
    expect(JSON.parse(rows[2]!["members_json"] as string)).toEqual([
      {
        eventId: a,
        revision: 2,
        supersedes: [
          [a, 1],
          [b, 1],
        ],
      },
    ]);
    expect(JSON.parse(rows[2]!["claims_json"] as string)).toEqual(
      [pending.keys[0]!.key, posted.keys[0]!.key].sort().map((key) => ["card-usage", key]),
    );
    expect(JSON.parse(rows[3]!["members_json"] as string)).toEqual([
      { eventId: a, revision: 3, supersedes: [[a, 2]] },
      { eventId: b, revision: 2, supersedes: [] },
    ]);
    expect(rows[3]!["decision_revision_id"]).toBe(split.retire.decisionRevisionId);
    expect(rows.map((row) => row["released_json"])).toEqual(["[]", "[]", "[]", "[]"]);
    expect(
      seals(db)
        .filter((row) => row["commit_seq"] === 4)
        .map((row) => [row["event_id"], row["revision"], row["claim_count"]]),
    ).toEqual(
      [
        [a, 3, 1],
        [b, 2, 1],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    expect(unlogged(db)).toEqual([]);
    db.close();
  });

  test("W5/W9: a split that fails at any statement, its second half included, writes nothing", async () => {
    const db = database();
    const { pending, posted, merge } = await pair(db);
    await run(db, cardPurchaseMergeWrites({ merge, now: NOW }));
    const split = await cardPurchaseSplit({
      merged: live(merge.draft),
      pendingSidecar: pending.sidecar,
      absorbed: { eventId: posted.revision.eventId, revision: 1 },
    });
    if (!split) throw new Error("split rejected");
    const writes = cardPurchaseSplitWrites({ split, now: LATER });
    const before = snapshot(db);
    // A statement that always raises (a CHECK violation), put in place of
    // each statement in turn.
    const failing: SqlWrite = {
      sql: "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(0,'x','x','x')",
      binds: [],
    };
    for (let index = 0; index < writes.length; index += 1) {
      const injected = writes.map((write, at) => (at === index ? failing : write));
      await expect(run(db, injected)).rejects.toThrow();
      expect(snapshot(db)).toEqual(before);
    }
    // The second half's own failure: the restored event's seal states a
    // claim count its stored keys do not have.
    const restoreSeal = writes.findLastIndex((write) =>
      write.sql.startsWith("INSERT INTO economic_revision_seals"),
    );
    const wrongCount = writes.map((write, at) =>
      at === restoreSeal
        ? { sql: write.sql, binds: write.binds.map((bind, i) => (i === 4 ? 7 : bind)) }
        : write,
    );
    await expect(run(db, wrongCount)).rejects.toThrow("economic_seal_invalid");
    expect(snapshot(db)).toEqual(before);
    // The batch itself is whole.
    expect((await run(db, writes)).every((changes) => changes > 0)).toBe(true);
    db.close();
  });

  test("W3: a sealed merged revision takes no second sidecar row and no leg", async () => {
    const db = database();
    const { merge } = await pair(db);
    await run(db, cardPurchaseMergeWrites({ merge, now: NOW }));
    const { eventId, revision } = merge.draft.revision;
    const before = snapshot(db);
    for (const sql of [
      `INSERT INTO card_purchase_recognitions(event_id,revision,policy_release,action,content_digest,account_id,source_id,statement_period,facts_json,created_at)
       SELECT event_id,revision,policy_release,action,content_digest,account_id,source_id,statement_period,facts_json,created_at
       FROM card_purchase_recognitions WHERE event_id=?1 AND revision=?2`,
      `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
       VALUES(?1,?2,5,'account:acct-jcb','JPY','exact','1',0,NULL,'fee','purchase-recognition')`,
    ])
      await expect(run(db, [{ sql, binds: [eventId, revision] }])).rejects.toThrow(
        "economic_revision_sealed",
      );
    expect(snapshot(db)).toEqual(before);
    db.close();
  });
});

describe("identity epochs and heads", () => {
  test("a batch sealed under an epoch that is no longer current is refused whole", async () => {
    const db = database();
    const draft = await draftOf(factOf(1));
    db.run(
      `INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at)
       VALUES(2,'identity-epoch-2','synthetic-rewrite','2026-09-24T00:00:00.000Z')`,
    );
    expect(db.query(CURRENT_IDENTITY_EPOCH_SQL).get()).toEqual({
      identity_epoch: "identity-epoch-2",
    });
    const before = snapshot(db);
    await expect(run(db, recognise(draft))).rejects.toThrow("identity_epoch_changed");
    expect(snapshot(db)).toEqual(before);
    expect(
      (
        await run(
          db,
          cardPurchaseRecognitionWrites({
            draft,
            expectedRevision: null,
            now: NOW,
            identityEpoch: "identity-epoch-2",
          }),
        )
      ).every((changes) => changes > 0),
    ).toBe(true);
    db.close();
  });

  test("economic-event: answers the live head, its negation once merged away, 0 for none", async () => {
    const db = database();
    const { pending, posted, merge } = await pair(db);
    const a = `economic-event:${pending.revision.eventId}`;
    const b = `economic-event:${posted.revision.eventId}`;
    const none = "economic-event:purchase_absent";
    expect(revisionOf(db, { [a]: 0, [b]: 0, [none]: 0 })).toEqual({ [a]: 1, [b]: 1, [none]: 0 });
    await run(db, cardPurchaseMergeWrites({ merge, now: NOW }));
    // The survivor's head moved to 2; the absorbed event's head 1 is no
    // longer live, so a plan that read it live conflicts.
    expect(revisionOf(db, { [a]: 0, [b]: 0 })).toEqual({ [a]: 2, [b]: -1 });
    // card-purchase: keeps its meaning (the live revision, or 0).
    const cp = `card-purchase:${posted.revision.eventId}`;
    expect(revisionOf(db, { [cp]: 0 })).toEqual({ [cp]: 0 });
    db.close();
  });
});
