// A settings write the schema refuses is a failure, never a skipped row and
// never a version conflict. The job edit's history row and the maintenance
// revision are plain `INSERT` statements (no `OR IGNORE`, which SQLite also
// applies to CHECK, NOT NULL and UNIQUE failures): a refused row raises, its
// whole batch — the schedule update, the provenance update, the audit record —
// rolls back, and the private route answers its closed
// `503 scheduling_unavailable`. A writer that loses its version check is still
// `409 revision_conflict`.
//
// Each refusing schema is the real CORE table rebuilt with one extra CHECK
// that names a synthetic actor, so a valid request reaches a refusal the
// shipped constraints would only raise for a row the writers never build.
// Every value is synthetic.
import { beforeAll, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { fullCoreDatabase, sqliteD1 } from "../../../packages/storage-d1/test/sqlite";
import {
  scheduleRoute,
  writeMaintenanceRevision,
  type MaintenanceWrite,
} from "../src/schedule-store";
import { envelopeHeaders } from "./audit-envelope";

const OPERATOR = "operator@synthetic.test";
/** The actor the rebuilt tables refuse. */
const REFUSED = "refused@synthetic.test";
const REFUSED_DELEGATE = "mcp-client:refused-synthetic";
/** On the host CORE 0065 registers for `vpass`; never fetched. */
const REFERENCE = "https://www.smbc-card.com/mem/synthetic-notice.html";
const DAY = 86_400_000;
const DAILY = { kind: "daily", time: "06:00", weekdays: [0, 1, 2, 3, 4, 5, 6] };

// The first build of the migrated CORE image runs every migration; pay it
// here under its own budget (see packages/storage-d1/test/sqlite.ts).
beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

/**
 * Rebuilds `table` with one more table CHECK, keeping its rows, indexes and
 * triggers: the shape a future migration that tightens the table would leave.
 */
function addCheck(sqlite: Database, table: string, check: string) {
  const objects = sqlite
    .query("SELECT type,sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL")
    .all(table) as { type: string; sql: string }[];
  const create = objects.find((o) => o.type === "table")!.sql;
  const amended = create.replace(/\)\s*STRICT\s*$/u, `, CHECK(${check})\n) STRICT`);
  if (amended === create) throw new Error("fixture_table_shape");
  sqlite.exec("PRAGMA foreign_keys=OFF");
  sqlite.exec("PRAGMA legacy_alter_table=ON");
  sqlite.exec(`ALTER TABLE ${table} RENAME TO refused_fixture_old`);
  sqlite.exec(amended);
  sqlite.exec(`INSERT INTO ${table} SELECT * FROM refused_fixture_old`);
  sqlite.exec("DROP TABLE refused_fixture_old");
  for (const o of objects) if (o.type !== "table") sqlite.exec(o.sql);
  sqlite.exec("PRAGMA legacy_alter_table=OFF");
  sqlite.exec("PRAGMA foreign_keys=ON");
}

function environment(sqlite: Database, db: unknown = sqliteD1(sqlite)): Env {
  return {
    DB: db,
    SCHEDULES_ENABLED: "true",
    SCHEDULE_ALARMS: {
      getByName: () => ({ reconcile: async () => null, alarmTime: async () => null }),
    },
  } as unknown as Env;
}

async function post(
  env: Env,
  path: string,
  body: unknown,
  operator: string,
  correlationId: string,
) {
  const url = `https://pipeline.internal/internal/schedules${path}`;
  const response = await scheduleRoute(
    new Request(url, {
      method: "POST",
      headers: {
        "x-kogane-internal-caller": "kogane-evidence-browser",
        "x-kogane-operator": operator,
        ...envelopeHeaders(correlationId),
      },
      body: JSON.stringify(body),
    }),
    env,
    new URL(url),
  );
  return { status: response!.status, body: (await response!.json()) as unknown };
}

const count = (sqlite: Database, sql: string, ...binds: unknown[]) =>
  (sqlite.query(sql).get(...(binds as never[])) as { n: number }).n;
const scheduleRow = (sqlite: Database) =>
  sqlite
    .query(
      "SELECT revision,enabled,updated_by,updated_at FROM collection_schedules WHERE id='vpass'",
    )
    .get();
const records = (sqlite: Database, correlationId: string) =>
  count(sqlite, "SELECT count(*) n FROM audit_records WHERE correlation_id=?", correlationId);

test("a job edit whose history row the schema refuses writes nothing and is not saved", async () => {
  const sqlite = fullCoreDatabase();
  try {
    addCheck(sqlite, "collection_schedule_revisions", `actor<>'${REFUSED}'`);
    const env = environment(sqlite);
    const before = scheduleRow(sqlite) as { revision: number };
    const history = count(sqlite, "SELECT count(*) n FROM collection_schedule_revisions");
    const correlationId = crypto.randomUUID();
    const answer = await post(
      env,
      "/vpass",
      { revision: before.revision, enabled: false, timezone: "Asia/Tokyo", pattern: DAILY },
      REFUSED,
      correlationId,
    );
    expect(answer).toEqual({ status: 503, body: { error: "scheduling_unavailable" } });
    // Nothing of the batch: the job did not move, no history, no record.
    expect(scheduleRow(sqlite)).toEqual(before);
    expect(count(sqlite, "SELECT count(*) n FROM collection_schedule_revisions")).toBe(history);
    expect(records(sqlite, correlationId)).toBe(0);
    // The same edit by an actor the table accepts saves, with its history row.
    const saved = await post(
      env,
      "/vpass",
      { revision: before.revision, enabled: false, timezone: "Asia/Tokyo", pattern: DAILY },
      OPERATOR,
      crypto.randomUUID(),
    );
    expect(saved.status).toBe(200);
    expect(
      sqlite
        .query(
          "SELECT revision,enabled,actor FROM collection_schedule_revisions WHERE schedule_id='vpass' AND revision=?",
        )
        .get(before.revision + 1),
    ).toEqual({ revision: before.revision + 1, enabled: 0, actor: OPERATOR });
  } finally {
    sqlite.close();
  }
});

test("a job edit whose next revision history already holds is refused, not saved without its own row", async () => {
  const sqlite = fullCoreDatabase();
  try {
    const env = environment(sqlite);
    const before = scheduleRow(sqlite) as { revision: number };
    // A history row ahead of its job: the UNIQUE (schedule_id, revision) the
    // edit's own row would take is already held by a row it did not write.
    sqlite
      .query(
        "INSERT INTO collection_schedule_revisions(schedule_id,revision,enabled,timezone,pattern_json,actor,created_at) VALUES('vpass',?,1,'UTC',?,'synthetic-ahead','2026-01-01T00:00:00.000Z')",
      )
      .run(before.revision + 1, JSON.stringify(DAILY));
    const correlationId = crypto.randomUUID();
    const answer = await post(
      env,
      "/vpass",
      { revision: before.revision, enabled: false, timezone: "Asia/Tokyo", pattern: DAILY },
      OPERATOR,
      correlationId,
    );
    expect(answer).toEqual({ status: 503, body: { error: "scheduling_unavailable" } });
    expect(scheduleRow(sqlite)).toEqual(before);
    expect(
      sqlite
        .query(
          "SELECT actor FROM collection_schedule_revisions WHERE schedule_id='vpass' AND revision=?",
        )
        .all(before.revision + 1),
    ).toEqual([{ actor: "synthetic-ahead" }]);
    expect(records(sqlite, correlationId)).toBe(0);
  } finally {
    sqlite.close();
  }
});

for (const sameMillisecond of [false, true])
  test(`two job edits from one revision race: one saves, the other is revision_conflict (same actor, same millisecond: ${sameMillisecond})`, async () => {
    const sqlite = fullCoreDatabase();
    if (sameMillisecond) setSystemTime(Date.now());
    try {
      const db = sqliteD1(sqlite);
      let arrivals = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Both writers read the same revision before either batch runs.
      const racing = {
        ...db,
        batch: async (statements: Parameters<typeof db.batch>[0]) => {
          if (++arrivals === 2) release();
          await ready;
          return db.batch(statements);
        },
      };
      const env = environment(sqlite, racing);
      const before = scheduleRow(sqlite) as { revision: number };
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      const answers = await Promise.all(
        [false, true].map((enabled, i) =>
          post(
            env,
            "/vpass",
            { revision: before.revision, enabled, timezone: "Asia/Tokyo", pattern: DAILY },
            sameMillisecond ? OPERATOR : `${i}-${OPERATOR}`,
            ids[i]!,
          ),
        ),
      );
      expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
      expect(answers.find((a) => a.status === 409)!.body).toEqual({ error: "revision_conflict" });
      const winner = answers.findIndex((a) => a.status === 200);
      // The job moved once, with exactly one history row and one record: the winner's.
      expect((scheduleRow(sqlite) as { revision: number }).revision).toBe(before.revision + 1);
      expect(
        sqlite
          .query(
            "SELECT enabled FROM collection_schedule_revisions WHERE schedule_id='vpass' AND revision=?",
          )
          .all(before.revision + 1),
      ).toEqual([{ enabled: winner === 0 ? 0 : 1 }]);
      expect(ids.map((id) => records(sqlite, id))).toEqual(winner === 0 ? [1, 0] : [0, 1]);
    } finally {
      setSystemTime();
      sqlite.close();
    }
  });

/** A maintenance edit of the operator's route for `vpass`, creating `id`. */
const maintenanceBody = (id: string) => ({
  id,
  revision: 0,
  source: "vpass",
  timezone: "Asia/Tokyo",
  pattern: { kind: "weekly", weekdays: [2], start: "02:00", end: "03:00" },
  enabled: true,
  referenceUrl: REFERENCE,
  verifiedAt: new Date(Date.now() - 60_000).toISOString(),
  scope: "collection",
});
const provenance = (sqlite: Database) =>
  sqlite.query("SELECT * FROM provider_maintenance_references WHERE source='vpass'").get();

test("a maintenance edit the schema refuses is scheduling_unavailable, never revision_conflict", async () => {
  const sqlite = fullCoreDatabase();
  try {
    addCheck(
      sqlite,
      "provider_maintenance_rules",
      `actor NOT IN('${REFUSED}','${REFUSED_DELEGATE}')`,
    );
    const env = environment(sqlite);
    const before = provenance(sqlite);
    const rules = count(sqlite, "SELECT count(*) n FROM provider_maintenance_rules");
    const correlationId = crypto.randomUUID();
    const answer = await post(
      env,
      "/maintenance",
      maintenanceBody("vpass-synthetic-refused"),
      REFUSED,
      correlationId,
    );
    expect(answer).toEqual({ status: 503, body: { error: "scheduling_unavailable" } });
    // Nothing of the batch: no revision, no provenance change, no record.
    expect(count(sqlite, "SELECT count(*) n FROM provider_maintenance_rules")).toBe(rules);
    expect(provenance(sqlite)).toEqual(before);
    expect(records(sqlite, correlationId)).toBe(0);
    // The same edit by an actor the table accepts saves.
    const saved = await post(
      env,
      "/maintenance",
      maintenanceBody("vpass-synthetic-refused"),
      OPERATOR,
      crypto.randomUUID(),
    );
    expect(saved).toEqual({
      status: 200,
      body: { saved: true, revision: 1, reservation: "armed" },
    });
  } finally {
    sqlite.close();
  }
});

test("a delegated revision the schema refuses throws from the writer; it is neither a conflict nor a spent budget", async () => {
  const sqlite = fullCoreDatabase();
  try {
    addCheck(
      sqlite,
      "provider_maintenance_rules",
      `actor NOT IN('${REFUSED}','${REFUSED_DELEGATE}')`,
    );
    const env = environment(sqlite);
    const rules = count(sqlite, "SELECT count(*) n FROM provider_maintenance_rules");
    const now = Date.now();
    const write = (actor: string): MaintenanceWrite => ({
      source: "vpass",
      ruleId: null,
      expectedRevision: 0,
      change: {
        timezone: "Asia/Tokyo",
        pattern: {
          kind: "once",
          from: new Date(now + DAY).toISOString(),
          to: new Date(now + DAY + 3_600_000).toISOString(),
        },
        enabled: true,
        scope: "collection",
      },
      provenance: {
        referenceUrl: REFERENCE,
        verifiedAt: new Date(now - 60_000).toISOString(),
        decisionRef: `delegated-audit:aud_${crypto.randomUUID()}`,
      },
      actor: { kind: "delegated", id: actor },
      reason: "official-notice-added",
    });
    const noRecord = () => ({ statements: [], settle: () => {} });
    // A delegated route maps a throw to its closed `scheduling_unavailable`
    // (or the delegation failure the batch explains), never to 409 or 429.
    await expect(
      writeMaintenanceRevision(env, write(REFUSED_DELEGATE), noRecord),
    ).rejects.toThrow();
    expect(count(sqlite, "SELECT count(*) n FROM provider_maintenance_rules")).toBe(rules);
    const accepted = await writeMaintenanceRevision(
      env,
      write("mcp-client:accepted-synthetic"),
      noRecord,
    );
    expect(accepted).toMatchObject({ ok: true, revision: 1 });
  } finally {
    sqlite.close();
  }
});
