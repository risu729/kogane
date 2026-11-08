// The change lifecycle's override-release target: planning, approving and
// committing `identity.release-override` refuse with `target_missing` a
// subject that has no protection to release (`identityPlan` and
// `PROTECTED_SUBJECT_SQL`, src/operations/targets.ts).
//
// What is proved here:
// - the planner's protection read and the identity command's ledger
//   condition (`precondition` of `prepareIdentityCommand`, which the commit's
//   receipt reservation carries) agree on every protection state a subject
//   passes through: a rule mapping, a person's assignment, its release, a
//   manual mapping no decision describes (an older build's), and that one's
//   release;
// - without table statistics (D1 never runs ANALYZE) the read reaches every
//   mapping and decision table of the view by a keyed index search, never a
//   scan.
// Every row is synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import { prepareIdentityCommand } from "../../storage-d1/src/core/identity-commands.ts";
import { IDENTITY_POLICY_VERSION } from "../../storage-d1/src/core/identity-store.ts";
import { sqliteD1 } from "../../storage-d1/test/sqlite.ts";
import { PROTECTED_SUBJECT_SQL, resolveAndSimulate } from "../src/operations/targets.ts";
import { decide, ids, OPERATOR, world, type World } from "./instrument-resolution-world.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

const RELEASE = (referenceId: string) => ({
  subject: "instrument" as const,
  referenceId,
  reason: "synthetic release",
});

/** Whether the planner accepts a release, and whether the commit's condition holds. */
async function agreement(w: World, referenceId: string) {
  const planned = await resolveAndSimulate(
    sqliteCommandStore(w.db),
    "identity.release-override",
    RELEASE(referenceId),
  );
  if (!planned.ok) expect(planned.error).toBe("target_missing");
  const { revision } = w.db
    .query("SELECT max(revision) AS revision FROM instrument_mappings WHERE identifier_id=?")
    .get(referenceId) as { revision: number };
  const prepared = await prepareIdentityCommand(
    sqliteD1(w.db),
    {
      operationId: `op-probe-${referenceId}`,
      actorId: OPERATOR.id,
      actorVerification: "server",
      action: "release-override",
      kind: "instrument",
      referenceId,
      expectedRevision: revision,
      targetId: null,
      reason: "synthetic release",
    },
    IDENTITY_POLICY_VERSION,
  );
  if ("error" in prepared) throw new Error(prepared.error);
  const holds = w.db
    .query(`SELECT 1 AS valid WHERE ${prepared.precondition.sql}`)
    .get(...(prepared.precondition.binds as never[]));
  return { planned: planned.ok, holds: holds !== null };
}

describe("an override release's target", () => {
  test("the planner and the commit's condition agree on every protection state", async () => {
    const w = await world();
    const subject = ids(w).broker9001;
    const before = w.snapshot();
    // A rule mapping: nothing protects it.
    expect(await agreement(w, subject)).toEqual({ planned: false, holds: false });
    expect(w.snapshot()).toBe(before);
    const current = w.db
      .query("SELECT instrument_id FROM current_instrument_mappings WHERE identifier_id=?")
      .get(subject) as { instrument_id: string };
    // A person's assignment protects it.
    expect(
      (
        await decide(
          w,
          OPERATOR,
          "identity.assign",
          {
            subject: "instrument",
            referenceId: subject,
            targetId: current.instrument_id,
            reason: "synthetic manual confirmation",
          },
          "op-target-assign",
        )
      ).result,
    ).toMatchObject({ ok: true, replayed: false });
    expect(await agreement(w, subject)).toEqual({ planned: true, holds: true });
    // Its release ends the protection without moving the mapping revision.
    expect(
      (await decide(w, OPERATOR, "identity.release-override", RELEASE(subject), "op-target-1"))
        .result,
    ).toMatchObject({ ok: true, replayed: false });
    expect(await agreement(w, subject)).toEqual({ planned: false, holds: false });
    expect(
      await decide(w, OPERATOR, "identity.release-override", RELEASE(subject), "op-target-2"),
    ).toEqual({
      stage: "plan",
      result: { ok: false, error: "target_missing", refs: [`instrument_mapping:${subject}`] },
    });
    // A manual mapping no decision describes keeps its legacy protection.
    const { revision } = w.db
      .query("SELECT max(revision) AS revision FROM instrument_mappings WHERE identifier_id=?")
      .get(subject) as { revision: number };
    w.db
      .query(
        `INSERT INTO instrument_mappings(id,identifier_id,revision,instrument_id,method,reason,policy_version,created_at,label,status)
         SELECT 'im-synthetic-legacy',identifier_id,?2,instrument_id,'manual','synthetic legacy',policy_version,created_at,label,status
         FROM instrument_mappings WHERE identifier_id=?1 AND revision=?3`,
      )
      .run(subject, revision + 1, revision);
    expect(await agreement(w, subject)).toEqual({ planned: true, holds: true });
    expect(
      (await decide(w, OPERATOR, "identity.release-override", RELEASE(subject), "op-target-3"))
        .result,
    ).toMatchObject({ ok: true, replayed: false });
    expect(await agreement(w, subject)).toEqual({ planned: false, holds: false });
    w.db.close();
  });

  test("without table statistics the protection read is a keyed search", () => {
    const db = migratedDatabase();
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").all()).toEqual(
      [],
    );
    for (const kind of ["account_mapping", "instrument_mapping"]) {
      const plan = (
        db.query(`EXPLAIN QUERY PLAN ${PROTECTED_SUBJECT_SQL}`).all(kind, "synthetic-ref") as {
          detail: string;
        }[]
      ).map((row) => row.detail);
      // The only scan is of the view's own keyed result (one row at most).
      expect(plan.filter((detail) => detail.startsWith("SCAN"))).toEqual([
        "SCAN protected_mapping_subjects",
      ]);
      expect(plan).toContain(
        "SEARCH d USING INDEX decision_revisions_subject (subject_kind=? AND subject_ref=?)",
      );
      expect(plan).toContain(
        "SEARCH m USING INDEX sqlite_autoindex_account_mappings_2 (source_account_id=?)",
      );
      expect(plan).toContain(
        "SEARCH m USING INDEX sqlite_autoindex_instrument_mappings_2 (identifier_id=?)",
      );
    }
    db.close();
  });
});
