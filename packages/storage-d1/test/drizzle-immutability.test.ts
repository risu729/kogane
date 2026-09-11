// G2-16: an append-only table is append-only for the ORM too.
//
// `db.update(...)` and `db.delete(...)` are ordinary methods on a Drizzle
// handle. Nothing in a `sqliteTable` declaration says "this table may not be
// updated" — a declaration cannot say it — so the only thing standing between
// a plausible-looking line of code and a rewritten piece of evidence is the
// database: the `*_no_update` / `*_no_delete` triggers of migrations 0001,
// 0024 and 0040.
//
// This test is the proof that they still stand when the statement arrives
// through an ORM rather than through `db.prepare`. For each table it attempts
// the mutation, requires the attempt to be refused by name, and then re-reads
// the row to show that nothing was written on the way to the refusal.
//
// The `ops_requests` triggers are the more interesting half: that table is
// *not* frozen — a request's dispatch state and status move forward — so the
// three checks are that what was accepted cannot be rewritten, that a
// terminal request cannot be reopened, and that a completed stage cannot be
// turned back into pending.
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { coreDrizzle } from "../src/drizzle/client.ts";
import {
  fetchArtifacts,
  observationDecimalValues,
  opsRequestStages,
  opsRequests,
  rawObjects,
} from "../src/drizzle/schema/core.ts";
import { CLIENT, OBJECT_SHA256, RUN_ID, pilotDatabase } from "./core-fixture.ts";
import { sqliteD1 } from "./sqlite.ts";

const OPERATION_ID = `op_${"1".repeat(64)}`;
const ACCEPTED_AT = "2026-09-07T00:00:00Z";

let database: Database;
let db: ReturnType<typeof coreDrizzle>;

beforeEach(() => {
  database = pilotDatabase();
  db = coreDrizzle(sqliteD1(database));
});

/** The message a `RAISE(ABORT, ...)` reached the caller with. */
async function refusal(attempt: Promise<unknown>): Promise<string> {
  const error = await attempt.then(
    () => null,
    (thrown: unknown) => thrown as { cause?: unknown },
  );
  expect(error, "the statement should have been refused").not.toBeNull();
  return String(error?.cause ?? error);
}

describe("append-only tables refuse an ORM update or delete (G2-16)", () => {
  test("raw_objects: the row cannot be rewritten or removed", async () => {
    expect(
      await refusal(
        db
          .update(rawObjects)
          .set({ blobKey: "objects/zz/rewritten" })
          .where(eq(rawObjects.sha256, OBJECT_SHA256)),
      ),
    ).toMatch(/raw_objects is append-only/u);
    expect(
      await refusal(db.delete(rawObjects).where(eq(rawObjects.sha256, OBJECT_SHA256))),
    ).toMatch(/raw_objects is append-only/u);
    // Neither attempt left a trace: the object still names its own bytes.
    expect(
      database.query("SELECT blob_key FROM raw_objects WHERE sha256=?").get(OBJECT_SHA256),
    ).toEqual({ blob_key: `objects/aa/${OBJECT_SHA256}` });
  });

  test("fetch_artifacts: a catalogued artifact cannot change its digest", async () => {
    expect(
      await refusal(
        db
          .update(fetchArtifacts)
          .set({ sha256: "0".repeat(64) })
          .where(eq(fetchArtifacts.fetchRunId, RUN_ID)),
      ),
    ).toMatch(/fetch_artifacts is append-only/u);
    expect(
      await refusal(db.delete(fetchArtifacts).where(eq(fetchArtifacts.fetchRunId, RUN_ID))),
    ).toMatch(/fetch_artifacts is append-only/u);
    expect(
      database.query("SELECT count(*) AS n FROM fetch_artifacts WHERE fetch_run_id=?").get(RUN_ID),
    ).toEqual({ n: 2 });
  });

  test("observation_decimal_values: a recorded amount cannot be edited away", async () => {
    // The one that matters most: an UPDATE here would change what an account
    // is worth, with no trace that anybody did it.
    expect(
      await refusal(
        db
          .update(observationDecimalValues)
          .set({ coefficient: "0", scale: 0 })
          .where(eq(observationDecimalValues.observationId, 1)),
      ),
    ).toMatch(/versioned decimal values are immutable/u);
    expect(
      await refusal(
        db.delete(observationDecimalValues).where(eq(observationDecimalValues.observationId, 1)),
      ),
    ).toMatch(/versioned decimal values are immutable/u);
    expect(
      database
        .query("SELECT coefficient,scale FROM observation_decimal_values WHERE observation_id=1")
        .get(),
    ).toEqual({ coefficient: "123456789012345678901234567891", scale: 4 });
  });
});

describe("operations records move forward only, through the ORM too (G2-16)", () => {
  /** One accepted request, written through Drizzle exactly as 0040 allows. */
  async function accept(): Promise<void> {
    await db.insert(opsRequests).values({
      operationId: OPERATION_ID,
      kind: "collection",
      principal: CLIENT,
      idempotencyKey: "key-1",
      payloadDigest: "2".repeat(64),
      sourceId: "pilot-source",
      requestJson: '{"source":"pilot-source"}',
      status: "accepted",
      dispatchState: "dispatch_pending",
      createdAt: ACCEPTED_AT,
      updatedAt: ACCEPTED_AT,
    });
  }

  test("an accepted request cannot be deleted or re-accepted", async () => {
    await accept();
    expect(
      await refusal(db.delete(opsRequests).where(eq(opsRequests.operationId, OPERATION_ID))),
    ).toMatch(/operations requests are append-only/u);
    // A second insert of the same id is a replacement, not an idempotent write.
    expect(await refusal(accept())).toMatch(/operations request replacement is forbidden/u);
    expect(database.query("SELECT count(*) AS n FROM ops_requests").get()).toEqual({ n: 1 });
  });

  test("what was accepted cannot be rewritten", async () => {
    await accept();
    expect(
      await refusal(
        db
          .update(opsRequests)
          .set({ payloadDigest: "3".repeat(64) })
          .where(eq(opsRequests.operationId, OPERATION_ID)),
      ),
    ).toMatch(/operations request is immutable except its progress/u);
    // Progress, by contrast, is exactly what may move.
    await db
      .update(opsRequests)
      .set({ dispatchState: "dispatched", dispatchAttempts: 1, updatedAt: "2026-09-07T00:01:00Z" })
      .where(eq(opsRequests.operationId, OPERATION_ID));
    expect(database.query("SELECT dispatch_state,payload_digest FROM ops_requests").get()).toEqual({
      dispatch_state: "dispatched",
      payload_digest: "2".repeat(64),
    });
  });

  test("a completed stage is never reopened", async () => {
    await accept();
    await db.insert(opsRequestStages).values({
      operationId: OPERATION_ID,
      stage: "persisted",
      state: "completed",
      evidenceRef: "run-1",
      attempts: 1,
      updatedAt: ACCEPTED_AT,
    });
    expect(
      await refusal(
        db
          .update(opsRequestStages)
          .set({ state: "pending", updatedAt: "2026-09-07T00:01:00Z" })
          .where(
            and(
              eq(opsRequestStages.operationId, OPERATION_ID),
              eq(opsRequestStages.stage, "persisted"),
            ),
          ),
      ),
    ).toMatch(/a completed stage is never reopened/u);
    expect(
      await refusal(
        db.delete(opsRequestStages).where(eq(opsRequestStages.operationId, OPERATION_ID)),
      ),
    ).toMatch(/operations stages are append-only/u);
    expect(database.query("SELECT state,attempts FROM ops_request_stages").get()).toEqual({
      state: "completed",
      attempts: 1,
    });
  });
});
