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
    const count = await w.sql.first<{ n: number }>(INSTRUMENT_HISTORY_COUNT_SQL, [id.broker9001]);
    expect(count!.n).toBe(outcome.history.total);
    const plan = await w.sql.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${INSTRUMENT_HISTORY_COUNT_SQL}`,
      [id.broker9001],
    );
    expect(
      plan.some((row) => /SCAN (instrument_mappings|decision_revisions|r)\b/u.test(row.detail)),
    ).toBe(false);
    expect(w.snapshot()).toBe(before);
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
