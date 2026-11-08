// The `instrument_auto_adoption` lane (src/instrument-auto-adoption.ts, ADR
// 0055 amendment 2026-11-08) over CORE migrations 0017+ on the minimal Layer A
// stub, with identifiers written by the production identity writer from
// synthetic SBI Securities rows through the deployed SBI rule
// (packages/application/test/instrument-resolution-world.ts). Every code and
// name is invented: the codes are four-character Japanese-code shapes with a
// leading zero and a letter, which no exchange has assigned.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  INSTRUMENT_AUTO_ADOPTION_ACTOR,
  JAPANESE_SECURITIES_CODE,
} from "../../../packages/domain/src/instrument-auto-adoption.ts";
import {
  queryInstrumentAutoAdoptions,
  queryInstrumentHistory,
  queryInstrumentResolution,
} from "../../../packages/application/src/query/instrument-resolution.ts";
import { executeIdentityCommand } from "../../../packages/storage-d1/src/core/identity-commands.ts";
import { IDENTITY_POLICY_VERSION } from "../../../packages/storage-d1/src/core/identity-store.ts";
import { sqliteD1 } from "../../../packages/storage-d1/test/sqlite.ts";
import {
  candidateOf,
  decide,
  OPERATOR,
  stateOf,
  stubDatabase,
  World,
} from "../../../packages/application/test/instrument-resolution-world.ts";
import {
  EVALUATION_INTERVAL_MS,
  INSTRUMENT_AUTO_ADOPTION_LANE,
  INSTRUMENT_AUTO_ADOPTION_SQL,
  instrumentAutoAdoptionLane,
} from "../src/instrument-auto-adoption.ts";

beforeAll(() => {
  stubDatabase().close();
}, 60_000);

const DOMESTIC = "sbi-securities:domestic";
const NOW = Date.UTC(2026, 10, 8, 3, 0, 0);

/** The lane over the world's database, as the Processor would run it. */
function lane(w: World, now = NOW) {
  return instrumentAutoAdoptionLane(sqliteD1(w.db) as unknown as D1Database, { now });
}

/** A held position on `market` and a trade of the same code on an unmapped venue. */
function heldAndTraded(code: string, market = "TKY", currency: string | null = "JPY") {
  return {
    position: { account: DOMESTIC, code, name: `Synthetic ${code}`, market, currency },
    trade: {
      account: DOMESTIC,
      currency: "JPY",
      extra: {
        issueCode: code,
        issueName: `Synthetic ${code}`,
        marketLabel: "PTS（X）",
        accountLabel: "synthetic",
      },
    },
  };
}

async function sbiWorld(codes: { code: string; market?: string; currency?: string | null }[]) {
  const w = new World();
  const rows = codes.map(({ code, market, currency }) => heldAndTraded(code, market, currency));
  const capture = await w.capture(
    "sbi-securities",
    rows.map((row) => row.position),
    rows.map((row) => row.trade),
  );
  return { w, capture };
}

const listingOf = (w: World, code: string, mic = "XTKS") => w.identifier("mic-symbol", mic, code);
const bareOf = (w: World, code: string) => w.identifier("sbi-security-code", "JP", code);

describe("the instrument_auto_adoption lane", () => {
  test("the synthetic codes have the shape the rule adopts", () => {
    for (const code of ["0Z0A", "0Z0B", "0Z0C"])
      expect(JAPANESE_SECURITIES_CODE.test(code)).toBe(true);
  });

  test("adopts the bare code onto the listing as a rule revision with a rule decision", async () => {
    const { w } = await sbiWorld([{ code: "0Z0A" }, { code: "0Z0B" }]);
    const listing = listingOf(w, "0Z0A");
    const bare = bareOf(w, "0Z0A");
    const before = await queryInstrumentResolution(w.sql);
    expect(candidateOf(before, listing, bare).status).toBe("proposed");

    expect(await lane(w)).toEqual({
      pairs: 2,
      evaluated: true,
      eligible: 2,
      adopted: 2,
      conflicts: 0,
      refused: 0,
    });

    const after = await queryInstrumentResolution(w.sql);
    expect(candidateOf(after, listing, bare)).toMatchObject({ status: "adopted", commands: null });
    expect(stateOf(after, listing)).toBe("resolved-by-rule");
    expect(stateOf(after, bare)).toBe("resolved-by-rule");
    const subject = after.identifiers.find((row) => row.identifierId === bare)!;
    const anchor = after.identifiers.find((row) => row.identifierId === listing)!;
    expect(subject).toMatchObject({
      instrumentId: anchor.instrumentId,
      mappingMethod: "rule",
      mappingRevision: 2,
    });

    // Append-only: the first revision is still there, the adoption is the second.
    const mappings = w.db
      .query(
        "SELECT revision,instrument_id,method FROM instrument_mappings WHERE identifier_id=? ORDER BY revision",
      )
      .all(bare) as { revision: number; instrument_id: string; method: string }[];
    expect(mappings.map((row) => [row.revision, row.method])).toEqual([
      [1, "rule"],
      [2, "rule"],
    ]);
    expect(mappings[1]!.instrument_id).toBe(anchor.instrumentId);
    expect(mappings[0]!.instrument_id).not.toBe(anchor.instrumentId);

    // The decision names the rule, the mapping and both identifiers, and
    // protects nothing: a person's later command is never blocked by it.
    const decision = w.db
      .query(
        "SELECT decision_kind,method,actor_id,operation_id,reason,evidence_refs_json FROM decision_revisions WHERE subject_kind='instrument_mapping' AND subject_ref=?",
      )
      .get(bare) as Record<string, string> & { evidence_refs_json: string; reason: string };
    expect(decision).toMatchObject({
      decision_kind: "assign",
      method: "rule",
      actor_id: INSTRUMENT_AUTO_ADOPTION_ACTOR,
      operation_id: `instrument-auto-v1:${bare}:r1`,
    });
    expect(decision.reason).toContain("instrument-auto-v1");
    expect(decision.reason).toContain("XTKS/0Z0A");
    const refs = JSON.parse(decision.evidence_refs_json) as string[];
    expect(refs.slice(1)).toEqual([`identifier:${listing}`, `identifier:${bare}`]);
    expect(refs[0]).toStartWith("instrument_mapping:");
    expect(
      w.db
        .query("SELECT count(*) AS n FROM protected_mapping_subjects WHERE subject_ref=?")
        .get(bare),
    ).toEqual({ n: 0 });

    // The history shows the adoption as an automatic decision.
    const [history] = await queryInstrumentHistory(w.sql, [bare]);
    expect(
      history!.entries
        .map((entry) => [entry.entry, entry.method, entry.decisionOrigin].join(" "))
        .sort(),
    ).toEqual(["decision rule automatic", "mapping rule automatic", "mapping rule automatic"]);

    // Nothing left: the gate ends the next tick without the full read.
    expect(await lane(w)).toEqual({
      pairs: 0,
      evaluated: false,
      eligible: 0,
      adopted: 0,
      conflicts: 0,
      refused: 0,
    });
  });

  test("a later identity policy version does not revert an adoption", async () => {
    const { w, capture } = await sbiWorld([{ code: "0Z0A" }]);
    await lane(w);
    const bare = bareOf(w, "0Z0A");
    const target = (await queryInstrumentResolution(w.sql)).identifiers.find(
      (row) => row.identifierId === listingOf(w, "0Z0A"),
    )!.instrumentId;
    await w.reidentify(capture, IDENTITY_POLICY_VERSION + 1);
    const after = await queryInstrumentResolution(w.sql);
    expect(after.identifiers.find((row) => row.identifierId === bare)).toMatchObject({
      instrumentId: target,
      mappingRevision: 2,
    });
    expect(stateOf(after, bare)).toBe("resolved-by-rule");
  });

  test("shapes the rule declines are left proposed for a person or an agent", async () => {
    // Two listings of one code (ambiguous), and a code whose held row names
    // no currency (unconfirmed).
    const w = new World();
    const a = heldAndTraded("0Z0A");
    const c = heldAndTraded("0Z0C", "TKY", null);
    await w.capture(
      "sbi-securities",
      [
        a.position,
        { account: DOMESTIC, code: "0Z0A", name: "Synthetic 0Z0A", market: "NGY", currency: "JPY" },
        c.position,
      ],
      [a.trade, c.trade],
    );
    // The gate counts three pairs; the rule adopts none of them.
    expect(await lane(w)).toEqual({
      pairs: 3,
      evaluated: true,
      eligible: 0,
      adopted: 0,
      conflicts: 0,
      refused: 0,
    });
    const result = await queryInstrumentResolution(w.sql);
    expect(candidateOf(result, listingOf(w, "0Z0A"), bareOf(w, "0Z0A")).status).toBe("proposed");
    expect(candidateOf(result, listingOf(w, "0Z0A", "XNGO"), bareOf(w, "0Z0A")).status).toBe(
      "proposed",
    );
    expect(candidateOf(result, listingOf(w, "0Z0C"), bareOf(w, "0Z0C")).status).toBe("proposed");
    expect(
      w.db.query("SELECT count(*) AS n FROM decision_revisions WHERE method='rule'").get(),
    ).toEqual({ n: 0 });
  });

  test("the full read runs at most once an hour while the gate keeps finding pairs", async () => {
    const { w } = await sbiWorld([{ code: "0Z0A", currency: null }]);
    const evaluated = (startedAt: number) =>
      w.db.run(
        `INSERT INTO processor_lane_ticks(lane,started_at_ms,finished_at_ms,outcome,error_code,counts_json)
         VALUES(?,?,?,'ran',NULL,'{"pairs":1,"evaluated":true}')`,
        [INSTRUMENT_AUTO_ADOPTION_LANE, startedAt, startedAt],
      );
    evaluated(NOW - EVALUATION_INTERVAL_MS + 1);
    expect(await lane(w)).toMatchObject({ pairs: 1, evaluated: false });
    // An hour later it runs again.
    expect(await lane(w, NOW + 1)).toMatchObject({ pairs: 1, evaluated: true, eligible: 0 });
    // A tick that did not run the full read does not count.
    w.db.run("DELETE FROM processor_lane_ticks");
    w.db.run(
      `INSERT INTO processor_lane_ticks(lane,started_at_ms,finished_at_ms,outcome,error_code,counts_json)
       VALUES(?,?,?,'ran',NULL,'{"pairs":1,"evaluated":false}')`,
      [INSTRUMENT_AUTO_ADOPTION_LANE, NOW, NOW],
    );
    expect(await lane(w)).toMatchObject({ evaluated: true });
  });

  test("a person's undo is a manual mapping the rule never re-adopts", async () => {
    const { w } = await sbiWorld([{ code: "0Z0A" }]);
    const bare = bareOf(w, "0Z0A");
    const own = (
      w.db
        .query("SELECT instrument_id FROM instrument_mappings WHERE identifier_id=? AND revision=1")
        .get(bare) as { instrument_id: string }
    ).instrument_id;
    await lane(w);
    const undo = await decide(
      w,
      OPERATOR,
      "identity.assign",
      { subject: "instrument", referenceId: bare, targetId: own, reason: "not the same issue" },
      "op-undo",
    );
    expect(undo.result.ok).toBe(true);
    const result = await queryInstrumentResolution(w.sql);
    expect(candidateOf(result, listingOf(w, "0Z0A"), bare).status).toBe("proposed");
    expect(await queryInstrumentAutoAdoptions(w.sql)).toEqual([]);
    expect(await lane(w)).toMatchObject({ pairs: 0, adopted: 0 });
  });

  test("an adoption is not written when the anchor moved after the read", async () => {
    const { w } = await sbiWorld([{ code: "0Z0A" }, { code: "0Z0B" }]);
    const [planned] = (await queryInstrumentAutoAdoptions(w.sql)).filter(
      (adoption) => adoption.subjectIdentifierId === bareOf(w, "0Z0A"),
    );
    // A person maps the anchor elsewhere in between.
    const moved = await decide(
      w,
      OPERATOR,
      "identity.assign",
      {
        subject: "instrument",
        referenceId: planned!.anchorIdentifierId,
        targetId: (
          w.db
            .query("SELECT instrument_id FROM instrument_mappings WHERE identifier_id=?")
            .get(listingOf(w, "0Z0B")) as { instrument_id: string }
        ).instrument_id,
        reason: "synthetic correction",
      },
      "op-move-anchor",
    );
    expect(moved.result.ok).toBe(true);
    const before = w.snapshot();
    const outcome = await executeIdentityCommand(
      sqliteD1(w.db),
      {
        operationId: "instrument-auto-v1:stale",
        actorId: INSTRUMENT_AUTO_ADOPTION_ACTOR,
        actorVerification: "server",
        action: "assign",
        kind: "instrument",
        referenceId: planned!.subjectIdentifierId,
        expectedRevision: planned!.subjectMappingRevision,
        targetId: planned!.targetInstrumentId,
        reason: "synthetic stale adoption",
      },
      IDENTITY_POLICY_VERSION,
      {
        method: "rule",
        guard: {
          sql: INSTRUMENT_AUTO_ADOPTION_SQL.anchorUnchanged,
          binds: [
            planned!.anchorIdentifierId,
            planned!.anchorMappingRevision,
            planned!.targetInstrumentId,
          ],
        },
      },
    );
    expect(outcome).toEqual({ ok: false, error: "target_missing" });
    expect(w.snapshot()).toBe(before);
  });

  test("a rule recording is refused for a non-rule actor or a release", async () => {
    const { w } = await sbiWorld([{ code: "0Z0A" }]);
    const base = {
      operationId: "synthetic-op",
      actorVerification: "server" as const,
      kind: "instrument" as const,
      referenceId: bareOf(w, "0Z0A"),
      expectedRevision: 1,
      reason: "synthetic",
    };
    const db = sqliteD1(w.db);
    expect(
      await executeIdentityCommand(
        db,
        { ...base, actorId: "operator@example.invalid", action: "assign", targetId: "x" },
        IDENTITY_POLICY_VERSION,
        { method: "rule" },
      ),
    ).toEqual({ ok: false, error: "invalid_command" });
    expect(
      await executeIdentityCommand(
        db,
        {
          ...base,
          actorId: INSTRUMENT_AUTO_ADOPTION_ACTOR,
          action: "release-override",
          targetId: null,
        },
        IDENTITY_POLICY_VERSION,
        { method: "rule" },
      ),
    ).toEqual({ ok: false, error: "invalid_command" });
  });

  test("the gate reads no observation table", () => {
    const w = new World();
    const plan = (
      w.db.query(`EXPLAIN QUERY PLAN ${INSTRUMENT_AUTO_ADOPTION_SQL.gate}`).all() as {
        detail: string;
      }[]
    ).map((step) => step.detail);
    expect(plan.join("\n")).not.toMatch(/observation/u);
    expect(plan.join("\n")).not.toMatch(/SCAN instrument_mappings/u);
  });
});
