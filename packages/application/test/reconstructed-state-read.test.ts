// `readReconstructedState` (src/query/reconstructed-state-read.ts): the one
// service the GET route and the agent tool call. What it answers for each
// synthetic world, the request rules and their closed refusal codes, the
// grant, a pinned set version, and that it writes nothing. Every account,
// amount and date is invented.
import { describe, expect, test } from "bun:test";
import { DATED_BALANCES_SQL, DATED_STATE_ROW_BOUND } from "../../read-model/src/dated-state.ts";
import { storeExecutor } from "../../read-model/test/economic-history-fixture.ts";
import { ERROR_STATUS } from "../src/errors.ts";
import {
  parseReconstructedStateRequest,
  readReconstructedState,
  RECONSTRUCTED_STATE_REFUSALS,
  reconstructedStateBodyFromQuery,
  reconstructedStateError,
  reconstructedStateRefusalOf,
  type ReconstructedStateOutcome,
} from "../src/query/reconstructed-state-read.ts";
import {
  reconstructedStateOutcome,
  reconstructedStateWorlds,
  WORLD_BANK,
  WORLD_CARD,
  WORLD_EMPTY_LOG,
  WORLD_FROM,
  WORLD_GRANT,
  WORLD_NO_GUARD,
  WORLD_PRE_LOG,
  WORLD_TO,
} from "./reconstructed-state-world.ts";

const NOW = "2026-04-30T00:00:00.000Z";
const params = (fields: Record<string, string> = {}) =>
  new URLSearchParams({ account: WORLD_BANK, from: WORLD_FROM, to: WORLD_TO, ...fields });

function body(outcome: ReconstructedStateOutcome) {
  if (!outcome.ok) throw new Error(`refused: ${outcome.refusal}`);
  return outcome.body;
}
function refusal(outcome: ReconstructedStateOutcome): string {
  return outcome.ok ? "answered" : outcome.refusal;
}

describe("answers", () => {
  const worlds = reconstructedStateWorlds();
  const ask = (fields: Record<string, string> = {}) =>
    reconstructedStateOutcome(worlds, params(fields), NOW);

  test("a bank account: reported and reconstructed side by side, the difference kept", async () => {
    const answer = body(await ask());
    expect(answer.apiVersion).toBe(2);
    expect(answer.status).toBe("incomplete");
    expect(answer.reasons).toEqual(["family_not_evented", "history_coverage_unknown"]);
    const cell = answer.reconstruction!.cells[0]!;
    expect(cell.start!.reported.value).toMatchObject({ value: { coefficient: "10000" } });
    expect(cell.reconstructed.value).toMatchObject({ value: { coefficient: "9000" } });
    expect(cell.explanation.reported!.reported.value).toMatchObject({
      value: { coefficient: "8500" },
    });
    // reported − reconstructed, exact, never absorbed and never a zero.
    expect(cell.explanation.remainder.value).toMatchObject({
      status: "exact",
      value: { coefficient: "-500" },
    });
    expect(cell.explanation).toMatchObject({
      status: "not_comparable",
      reasonCode: "reconstruction_incomplete",
    });
    expect(answer.reconstruction!.netWorth).toBe("not-computed");
    expect(answer.cutStanding).toBe("final");
    expect(answer.knowledge!.setVersion).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("a card account is unavailable, its purchase listed on another basis", async () => {
    const answer = body(await ask({ account: WORLD_CARD }));
    expect(answer.status).toBe("unavailable");
    expect(answer.reasons).toContain("no_reported_container");
  });

  test("a pre-log settlement is indeterminate; an empty log is provisional", async () => {
    const pre = body(await ask({ account: WORLD_PRE_LOG }));
    expect(pre.status).toBe("indeterminate");
    expect(pre.reasons).toContain("knowledge_unlogged");
    const empty = body(await ask({ account: WORLD_EMPTY_LOG }));
    expect(empty.status).toBe("indeterminate");
    expect(empty.reasons).toContain("log_empty");
    expect(empty.cutStanding).toBe("provisional");
  });

  test("without CORE 0070 it is unavailable and computes nothing", async () => {
    const answer = body(await ask({ account: WORLD_NO_GUARD }));
    expect(answer).toMatchObject({
      status: "unavailable",
      reasons: ["economic_guard_missing"],
      reconstruction: null,
      manifest: null,
    });
  });

  test("an explicit cut, by sequence and by instant, and a pinned set version", async () => {
    const latest = body(await ask());
    const epoch = latest.cut!.resolved.coreEpoch;
    const bySeq = body(await ask({ coreEpoch: epoch, commitSeq: "1" }));
    expect(bySeq.cut!.resolved.commitSeq).toBe(1);
    // Before the purchase's commit: the same account answer, another set.
    expect(bySeq.knowledge!.setVersion).not.toBe(latest.knowledge!.setVersion);
    const byInstant = body(await ask({ coreEpoch: epoch, instant: "2026-04-01T12:00:00.000Z" }));
    expect(byInstant.cut!.resolved.commitSeq).toBe(1);
    expect(byInstant.knowledge!.setVersion).toBe(bySeq.knowledge!.setVersion);
    expect(byInstant.cutStanding).toBe("final");
    const pinned = await ask({ setVersion: latest.knowledge!.setVersion });
    expect(body(pinned).contextId).toBe(latest.contextId);
    expect(refusal(await ask({ setVersion: bySeq.knowledge!.setVersion }))).toBe(
      "set_version_changed",
    );
    expect(refusal(await ask({ coreEpoch: epoch, commitSeq: "9" }))).toBe("cut_after_log_end");
    expect(refusal(await ask({ coreEpoch: "core-epoch-0", commitSeq: "1" }))).toBe(
      "cut_epoch_not_current",
    );
  });

  test("it writes nothing", async () => {
    const world = worlds.get(WORLD_BANK)!;
    const counts = () =>
      world.db
        .query(
          `SELECT (SELECT count(*) FROM economic_event_revisions) AS revisions,
            (SELECT count(*) FROM economic_commit_log) AS commits,
            (SELECT count(*) FROM decision_revisions) AS decisions,
            (SELECT count(*) FROM economic_claims) AS claims`,
        )
        .get();
    const before = counts();
    await ask();
    await ask({ account: WORLD_CARD });
    expect(counts()).toEqual(before);
  });
});

describe("refusals", () => {
  const worlds = reconstructedStateWorlds();
  const ask = (fields: Record<string, string> = {}) =>
    reconstructedStateOutcome(worlds, params(fields), NOW);

  test("dates, range and basis", async () => {
    expect(refusal(await ask({ from: "2026-02-30" }))).toBe("invalid_date");
    expect(refusal(await ask({ to: "20260331" }))).toBe("invalid_date");
    expect(refusal(await ask({ from: WORLD_TO, to: WORLD_FROM }))).toBe("invalid_range");
    expect(refusal(await ask({ from: WORLD_TO, to: WORLD_TO }))).toBe("invalid_range");
    expect(refusal(await ask({ from: "2025-03-01" }))).toBe("range_too_long");
    expect(refusal(await ask({ from: "2025-03-30" }))).toBe("answered");
    expect(refusal(await ask({ to: "2026-05-01" }))).toBe("range_in_future");
    expect(refusal(await ask({ basis: "trade-date" }))).toBe("basis_unsupported");
    expect(refusal(await ask({ basis: "cash" }))).toBe("answered");
  });

  test("the scope: one known account, never instruments or several accounts", async () => {
    expect(refusal(await ask({ account: "acct-nowhere" }))).toBe("unknown_account");
    expect(refusal(await ask({ account: " x" }))).toBe("invalid_account");
    expect(refusal(await ask({ instrument: "inst-1" }))).toBe("scope_unsupported");
    const two = params();
    two.append("account", WORLD_CARD);
    expect(refusal(await reconstructedStateOutcome(worlds, two, NOW))).toBe("scope_unsupported");
    expect(refusal(await ask({ offset: "0" }))).toBe("invalid_query");
  });

  test("the cut", async () => {
    expect(refusal(await ask({ commitSeq: "1" }))).toBe("invalid_cut");
    expect(refusal(await ask({ coreEpoch: "core-epoch-1" }))).toBe("invalid_cut");
    expect(refusal(await ask({ coreEpoch: "core-epoch-1", commitSeq: "1", instant: NOW }))).toBe(
      "invalid_cut",
    );
    expect(refusal(await ask({ coreEpoch: "core-epoch-1", commitSeq: "-1" }))).toBe("invalid_cut");
    // A sequence names a commit; the cut before the log is asked as an instant.
    expect(refusal(await ask({ coreEpoch: "core-epoch-1", commitSeq: "0" }))).toBe("invalid_cut");
    expect(refusal(await ask({ coreEpoch: "core-epoch-1", instant: "2026-04-01" }))).toBe(
      "invalid_cut",
    );
    expect(
      refusal(await ask({ coreEpoch: "core-epoch-1", instant: "2026-05-01T00:00:00.000Z" })),
    ).toBe("cut_in_future");
    expect(refusal(await ask({ setVersion: "abc" }))).toBe("invalid_query");
  });

  test("a body that is not an object, an unknown key, an empty or repeated parameter", () => {
    expect(parseReconstructedStateRequest(null, NOW)).toMatchObject({ refusal: "invalid_query" });
    expect(parseReconstructedStateRequest([], NOW)).toMatchObject({ refusal: "invalid_query" });
    expect(
      parseReconstructedStateRequest(
        { account: WORLD_BANK, from: WORLD_FROM, to: WORLD_TO, extra: 1 },
        NOW,
      ),
    ).toEqual({ ok: false, refusal: "invalid_query", refs: [] });
    expect(
      parseReconstructedStateRequest(
        { account: [WORLD_BANK], from: WORLD_FROM, to: WORLD_TO },
        NOW,
      ),
    ).toMatchObject({ refusal: "scope_unsupported" });
    expect(reconstructedStateBodyFromQuery(new URLSearchParams("account="))).toMatchObject({
      refusal: "invalid_query",
    });
    expect(
      reconstructedStateBodyFromQuery(new URLSearchParams("from=2026-03-01&from=2026-03-02")),
    ).toMatchObject({ refusal: "invalid_query" });
  });

  test("the grant: records.read over the whole store, checked before anything is read", async () => {
    const world = reconstructedStateWorlds().get(WORLD_BANK)!;
    let reads = 0;
    const sql = storeExecutor(world.db);
    const counted = {
      all: <T>(text: string, args: readonly unknown[]) => {
        reads += 1;
        return sql.all<T>(text, args);
      },
      first: <T>(text: string, args: readonly unknown[]) => {
        reads += 1;
        return sql.first<T>(text, args);
      },
    };
    const request = { account: WORLD_BANK, from: WORLD_FROM, to: WORLD_TO };
    const summaryOnly = await readReconstructedState({
      grant: { ...WORLD_GRANT, capabilities: ["summary.read"] },
      sql: counted,
      body: request,
      now: NOW,
    });
    expect(summaryOnly).toEqual({
      ok: false,
      refusal: "capability_missing",
      refs: ["capability:records.read"],
    });
    const narrowed = await readReconstructedState({
      grant: { ...WORLD_GRANT, scopes: { sources: ["smbc-bank"], accounts: [WORLD_BANK] } },
      sql: counted,
      body: request,
      now: NOW,
    });
    expect(narrowed).toEqual({
      ok: false,
      refusal: "scope_restricted",
      refs: ["scope:source", "scope:account"],
    });
    expect(reads).toBe(0);
  });

  test("each refusal has one status and an agent error carrying the code", () => {
    for (const [code, { status, category }] of Object.entries(RECONSTRUCTED_STATE_REFUSALS)) {
      expect([400, 403, 404, 409, 413]).toContain(status);
      const error = reconstructedStateError(code as never, "reconstructed-state.read", ["x"]);
      expect(error).toMatchObject({ code: category, refs: [`refusal:${code}`, "x"] });
      expect(ERROR_STATUS[category]).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("refusals read nothing, bounds are refused, and today is Tokyo's", () => {
  /** An executor that fails the test on any read. */
  const unread = {
    all: async () => {
      throw new Error("read before a request refusal");
    },
    first: async () => {
      throw new Error("read before a request refusal");
    },
  };
  const base = { account: WORLD_BANK, from: WORLD_FROM, to: WORLD_TO };

  test("every request refusal is decided before the store is read", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, from: "2026-02-30" }, "invalid_date"],
      [{ ...base, from: WORLD_TO, to: WORLD_FROM }, "invalid_range"],
      [{ ...base, from: "2025-01-01" }, "range_too_long"],
      [{ ...base, to: "2026-05-01" }, "range_in_future"],
      [{ ...base, basis: "trade-date" }, "basis_unsupported"],
      [{ ...base, cut: { coreEpoch: "core-epoch-1", commitSeq: 0 } }, "invalid_cut"],
      [
        { ...base, cut: { coreEpoch: "core-epoch-1", instant: "2026-05-01T00:00:00Z" } },
        "cut_in_future",
      ],
      [{ ...base, instrument: "inst-1" }, "scope_unsupported"],
      [{ ...base, extra: true }, "invalid_query"],
      [{ ...base, account: " x" }, "invalid_account"],
      [{ ...base, setVersion: "abc" }, "invalid_query"],
    ];
    for (const [body, code] of cases)
      expect([
        code,
        refusal(await readReconstructedState({ grant: WORLD_GRANT, sql: unread, body, now: NOW })),
      ]).toEqual([code, code]);
  });

  test("a reported state past its row bound is refused with result_limit_exceeded", async () => {
    const world = reconstructedStateWorlds().get(WORLD_BANK)!;
    const sql = storeExecutor(world.db);
    const overfull = {
      all: async <T>(text: string, args: readonly unknown[]) =>
        text === DATED_BALANCES_SQL
          ? (Array.from({ length: DATED_STATE_ROW_BOUND + 1 }, (_, id) => ({ id })) as T[])
          : sql.all<T>(text, args),
      first: sql.first.bind(sql),
    };
    expect(
      await readReconstructedState({ grant: WORLD_GRANT, sql: overfull, body: base, now: NOW }),
    ).toEqual({ ok: false, refusal: "result_limit_exceeded", refs: ["reportedState"] });
  });

  test("a selector or fold bound refused inside the query is result_limit_exceeded", () => {
    for (const code of [
      "selector_bound_exceeded",
      "event_budget_exceeded",
      "reported_budget_exceeded",
      "coverage_budget_exceeded",
    ]) {
      const error = Object.assign(new Error(code), { name: "ReconstructedStateRefusedError" });
      expect(reconstructedStateRefusalOf(error)).toEqual({
        refusal: "result_limit_exceeded",
        refs: [code],
      });
    }
    // Any other refusal of the fold is a programming error, never a 4xx.
    const other = Object.assign(new Error("invalid_request"), {
      name: "ReconstructedStateRefusedError",
    });
    expect(reconstructedStateRefusalOf(other)).toBeNull();
  });

  test("today is the caller's date in Asia/Tokyo", async () => {
    const worlds = reconstructedStateWorlds();
    const ask = (now: string) =>
      reconstructedStateOutcome(
        worlds,
        new URLSearchParams({ account: WORLD_BANK, from: WORLD_FROM, to: "2026-05-01" }),
        now,
      );
    // 16:00 UTC on 4/30 is 01:00 on 5/1 in Tokyo; 14:59:59 UTC is still 4/30.
    expect(refusal(await ask("2026-04-30T16:00:00Z"))).toBe("answered");
    expect(refusal(await ask("2026-04-30T14:59:59Z"))).toBe("range_in_future");
  });
});
