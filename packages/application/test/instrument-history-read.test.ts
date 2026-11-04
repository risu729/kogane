import { INSTRUMENT_HISTORY_SQL } from "../../read-model/src/instrument-resolution.ts";
import { LEGACY_INSTRUMENT_HISTORY_SQL } from "../../read-model/test/decision-origin-legacy-sql.ts";
import {
  originDecisionFixture,
  ORIGIN_CASES,
} from "../../read-model/test/decision-origin-fixture.ts";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  readInstrumentHistoryForGrant,
  INSTRUMENT_HISTORY_COUNT_SQL,
} from "../src/query/instrument-history-read.ts";
import {
  queryInstrumentHistory,
  queryInstrumentResolution,
} from "../src/query/instrument-resolution.ts";
import type { Grant } from "../src/grants.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { validInstrumentHistoryRead } from "../../observation-shared/src/instrument-history-contract.ts";
import {
  OPERATOR,
  world,
  ids,
  candidateOf,
  decide,
  stubDatabase,
} from "./instrument-resolution-world.ts";
const GRANT: Grant = {
  principal: "reader",
  capabilities: ["records.read"],
  scopes: { sources: "*", accounts: "*" },
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 3 },
};
beforeAll(() => stubDatabase().close(), 60_000);
describe("the grant-graded complete history", () => {
  test("matches the shipped history after adoption and rejection, preserves every revision and writes nothing", async () => {
    const w = await world();
    const id = ids(w);
    const candidate = candidateOf(
      await queryInstrumentResolution(w.sql),
      id.listing9001,
      id.broker9001,
    );
    await decide(
      w,
      OPERATOR,
      "relation.reject",
      { ...candidate.commands!.keepApart.payload, reason: "synthetic distinct listing" },
      "op-history-reject",
    );
    await decide(
      w,
      OPERATOR,
      "identity.assign",
      {
        subject: "instrument",
        referenceId: id.broker9001,
        targetId: candidate.commands!.adopt!.payload.targetId,
        reason: "synthetic correction",
      },
      "op-history-assign",
    );
    const before = w.snapshot();
    const outcome = await readInstrumentHistoryForGrant({
      grant: GRANT,
      sql: w.sql,
      identifierId: id.broker9001,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.history.entries).toEqual(
      (await queryInstrumentHistory(w.sql, [id.broker9001]))[0]!.entries,
    );
    expect(
      outcome.history.entries
        .filter((entry) => entry.entry === "mapping")
        .map((entry) => entry.revision),
    ).toEqual([1, 2]);
    expect(outcome.history.entries.some((entry) => entry.relationStatus === "rejected")).toBe(true);
    expect(validInstrumentHistoryRead(outcome.history)).toBe(true);
    expect(
      outcome.history.entries
        .filter((row) => row.entry !== "mapping" || row.revision === 2)
        .every((row) => row.decisionOrigin === "operator"),
    ).toBe(true);
    await decide(
      w,
      OPERATOR,
      "identity.release-override",
      { subject: "instrument", referenceId: id.broker9001, reason: "synthetic release" },
      "op-origin-release",
    );
    const released = await queryInstrumentHistory(w.sql, [id.broker9001]);
    expect(
      released[0]!.entries.find((row) => row.entry === "mapping" && row.revision === 2)!
        .decisionOrigin,
    ).toBe("operator");
    expect(
      released[0]!.entries.find((row) => row.decisionKind === "release-override")!.decisionOrigin,
    ).toBe("operator");
    // Release remains a later decision; take the read-only snapshot after that native command.
    const afterRelease = w.snapshot();
    const count = await w.sql.first<{ n: number }>(INSTRUMENT_HISTORY_COUNT_SQL, [id.broker9001]);
    expect(count!.n).toBe(outcome.history.total + 1);
    const plan = await w.sql.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${INSTRUMENT_HISTORY_COUNT_SQL}`,
      [id.broker9001],
    );
    expect(
      plan.some((row) => /SCAN (instrument_mappings|decision_revisions|r)\b/u.test(row.detail)),
    ).toBe(false);
    expect(before).not.toBe(afterRelease);
    expect(w.snapshot()).toBe(afterRelease);
    w.db.close();
  });
  test("capability, either narrowed scope and malformed identifier refuse before any read", async () => {
    const untouched: SqlExecutor = {
      all: async () => {
        throw new Error("read");
      },
      first: async () => {
        throw new Error("read");
      },
    };
    for (const grant of [
      { ...GRANT, capabilities: [] },
      { ...GRANT, scopes: { sources: ["sbi-securities"], accounts: "*" as const } },
      { ...GRANT, scopes: { sources: "*" as const, accounts: ["synthetic"] } },
    ])
      expect(
        (await readInstrumentHistoryForGrant({ grant, sql: untouched, identifierId: "synthetic" }))
          .ok,
      ).toBe(false);
    expect(
      await readInstrumentHistoryForGrant({
        grant: GRANT,
        sql: untouched,
        identifierId: "bad|identifier",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_query" } });
  });
  test("unknown id and history over budget refuse; the pre-count prevents reading entries", async () => {
    const w = await world();
    const id = ids(w).broker9001;
    expect(
      (await readInstrumentHistoryForGrant({ grant: GRANT, sql: w.sql, identifierId: "unknown" }))
        .ok,
    ).toBe(false);
    const sql: SqlExecutor = {
      first: w.sql.first,
      all: async () => {
        throw new Error("history read over budget");
      },
    };
    expect(
      await readInstrumentHistoryForGrant({
        grant: { ...GRANT, budget: { ...GRANT.budget, maxRows: 0 } },
        sql,
        identifierId: id,
      }),
    ).toMatchObject({ ok: false, error: { code: "budget_exceeded" } });
    const okay = await readInstrumentHistoryForGrant({
      grant: { ...GRANT, budget: { ...GRANT.budget, maxRows: 1 } },
      sql: w.sql,
      identifierId: id,
    });
    expect(okay.ok).toBe(true);
    w.db.close();
  });
});

test("persisted origin is closed, private, exact-revision and differential on scaled random histories", async () => {
  const w = await world();
  const target = (w.db.query("SELECT id FROM instruments LIMIT 1").get() as { id: string }).id;
  let random = 7;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  const identifiers: string[] = [];
  for (let n = 0; n < 80; n++) {
    const id = "synthetic-origin-identifier-" + n;
    identifiers.push(id);
    w.db
      .query("INSERT INTO instrument_identifiers VALUES (?,'synthetic-origin','fixture',?,'{}')")
      .run(id, String(n));
    for (let revision = 1, max = 2 + (next() % 14); revision <= max; revision++) {
      const key = n + "-" + revision;
      w.db
        .query(
          "INSERT INTO instrument_mappings VALUES (?,?,?,?,'manual','synthetic',1,'2099-01-01','synthetic','provider-local')",
        )
        .run("synthetic-origin-mapping-" + key, id, revision, target);
      const fixture = originDecisionFixture(
        "instrument_mapping",
        id,
        revision,
        next() % ORIGIN_CASES.length,
        key,
      );
      for (const write of fixture.writes) w.db.query(write.sql).run(...write.args);
      const read = await readInstrumentHistoryForGrant({
        grant: GRANT,
        sql: w.sql,
        identifierId: id,
      });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error("synthetic history refused");
      expect(
        read.history.entries
          .filter((row) => row.revision === revision)
          .every((row) => row.decisionOrigin === fixture.origin),
      ).toBe(true);
      expect(JSON.stringify(read.history)).not.toContain(fixture.actor);
      const invalid = structuredClone(read.history);
      invalid.entries[0]!.decisionOrigin = "raw-actor" as never;
      expect(validInstrumentHistoryRead(invalid)).toBe(false);
    }
  }
  const before = w.snapshot();
  const args = [JSON.stringify([...identifiers, identifiers[0]!])];
  const rows = await w.sql.all<Record<string, unknown>>(INSTRUMENT_HISTORY_SQL, args);
  expect(rows.map(({ decisionOrigin: _origin, ...old }) => old)).toEqual(
    await w.sql.all(LEGACY_INSTRUMENT_HISTORY_SQL, args),
  );
  const plan = await w.sql.all<{ detail: string }>(
    "EXPLAIN QUERY PLAN " + INSTRUMENT_HISTORY_SQL,
    args,
  );
  expect(plan.some((row) => /SCAN (origin_d|origin_op)\b/u.test(row.detail))).toBe(false);
  expect(plan.some((row) => row.detail.includes("decision_revisions_subject"))).toBe(true);
  expect(plan.some((row) => row.detail.includes("sqlite_autoindex_decision_operations"))).toBe(
    true,
  );
  expect(w.snapshot()).toBe(before);
  // A second assignment for the same mapping revision is ambiguous, not an actor guess.
  const fixture = originDecisionFixture("instrument_mapping", identifiers[0]!, 1, 1, "ambiguous");
  for (const write of fixture.writes) w.db.query(write.sql).run(...write.args);
  const ambiguous = await readInstrumentHistoryForGrant({
    grant: GRANT,
    sql: w.sql,
    identifierId: identifiers[0]!,
  });
  if (!ambiguous.ok) throw new Error("synthetic history refused");
  expect(
    ambiguous.history.entries.find((row) => row.entry === "mapping" && row.revision === 1)!
      .decisionOrigin,
  ).toBe("unknown");
  const exactId = "synthetic-origin-exact-release";
  w.db
    .query(
      "INSERT INTO instrument_identifiers VALUES (?,'synthetic-origin','fixture','release','{}')",
    )
    .run(exactId);
  w.db
    .query(
      "INSERT INTO instrument_mappings VALUES ('origin-exact-release-mapping',?,1,?,'manual','synthetic',1,'2099','synthetic','identified')",
    )
    .run(exactId, target);
  const delegated = originDecisionFixture("instrument_mapping", exactId, 1, 0, "exact-release");
  for (const write of delegated.writes) w.db.query(write.sql).run(...write.args);
  const release = await decide(
    w,
    OPERATOR,
    "identity.release-override",
    {
      subject: "instrument",
      referenceId: exactId,
      reason: "synthetic release of delegated assignment",
    },
    "op-origin-exact-release",
  );
  expect(release.stage === "commit" && release.result.ok).toBe(true);
  const exact = (await queryInstrumentHistory(w.sql, [exactId]))[0]!;
  expect(exact.entries.find((row) => row.entry === "mapping")!.decisionOrigin).toBe("delegated");
  expect(exact.entries.find((row) => row.decisionKind === "release-override")!.decisionOrigin).toBe(
    "operator",
  );
  // Relation history classifies its own decision, not the mapping or querying human.
  w.db
    .query(
      "INSERT INTO decision_operations VALUES ('origin-relation-op','mcp-client:synthetic-relation','server','accept',?,'{}','2100')",
    )
    .run("0".repeat(64));
  w.db
    .query(
      "INSERT INTO decision_revisions VALUES ('origin-relation-decision','relation','origin-relation',1,'accept','manual','mcp-client:synthetic-relation','origin-relation-op','synthetic','[]',NULL,NULL,'2100')",
    )
    .run();
  w.db
    .query(
      "INSERT INTO entity_relations VALUES ('origin-relation','listed_as',?,?,NULL,NULL,'accepted','origin-relation-decision','[]','2100')",
    )
    .run("instrument:" + target, "identifier:" + exactId);
  const relation = (await queryInstrumentHistory(w.sql, [exactId]))[0]!.entries.find(
    (row) => row.entry === "relation",
  )!;
  expect(relation.decisionOrigin).toBe("delegated");
  expect(JSON.stringify(relation)).not.toContain("mcp-client:");
  w.db.close();
}, 30000);
