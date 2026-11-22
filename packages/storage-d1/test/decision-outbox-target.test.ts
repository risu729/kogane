// The dispatcher looks a row's processor up by the row's stored `target`. The
// CHECK on `decision_outbox.target` admits three names today, but the lookup
// must not depend on it: a target that names an `Object.prototype` member
// takes the unregistered-processor path (`blocked(no_processor)`), never the
// inherited member. The CHECK is switched off for the one synthetic insert
// below, which is the only way such a row can exist.
import type { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { dispatchDecisionOutbox } from "../src/core/decision-outbox.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

// The first build of the migrated CORE image runs every migration; pay it
// here under its own budget (see ./sqlite.ts).
beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const INHERITED = ["constructor", "__proto__", "toString", "hasOwnProperty"] as const;

/** Synthetic outbox rows whose targets the CHECK would refuse. Foreign keys
 * and the CHECK are off only for this insert. */
function seedInheritedTargets(db: Database): void {
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("PRAGMA ignore_check_constraints=ON");
  const insert = db.query(
    `INSERT INTO decision_outbox(decision_revision_id,principal,operation_id,target,enqueued_at)
     VALUES(?1,'principal-synthetic','op-synthetic',?2,'2000-01-01T00:00:00.000Z')`,
  );
  INHERITED.forEach((target, index) => insert.run(`revision-synthetic-${String(index)}`, target));
  db.exec("PRAGMA ignore_check_constraints=OFF");
  db.exec("PRAGMA foreign_keys=ON");
}

test("the CHECK refuses a target outside the three it names", () => {
  const db = fullCoreDatabase();
  db.exec("PRAGMA foreign_keys=OFF");
  expect(() =>
    db
      .query(
        `INSERT INTO decision_outbox(decision_revision_id,principal,operation_id,target,enqueued_at)
         VALUES('revision-synthetic','principal-synthetic','op-synthetic','constructor','2000-01-01T00:00:00.000Z')`,
      )
      .run(),
  ).toThrow();
  db.close();
});

test("a target naming an Object.prototype member is blocked as having no processor", async () => {
  const db = fullCoreDatabase();
  seedInheritedTargets(db);
  let called = 0;
  const result = await dispatchDecisionOutbox(sqliteD1(db), {
    limit: 50,
    now: 1_000_000,
    processors: {
      "identity-projection": () => {
        called++;
        return Promise.reject(new Error("unreachable"));
      },
    },
  });
  expect(called).toBe(0);
  expect(result).toMatchObject({
    claimed: INHERITED.length,
    processed: 0,
    failed: 0,
    waiting: 0,
    blocked: INHERITED.length,
    published: 0,
  });
  expect(result.outcomes).toEqual({ "blocked:no_processor": INHERITED.length });
  const rows = db
    .query(
      `SELECT target,processed_at,blocked_code,last_error_code,lease_token
       FROM decision_outbox ORDER BY id`,
    )
    .all();
  expect(rows).toEqual(
    INHERITED.map((target) => ({
      target,
      processed_at: null,
      blocked_code: "no_processor",
      last_error_code: "no_processor",
      lease_token: null,
    })),
  );
  db.close();
});
