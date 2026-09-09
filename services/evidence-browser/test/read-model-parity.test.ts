// Parity proof for PR-04: the explicit read repository (packages/read-model)
// returns exactly what the regex-rewriting adapter returned, set and order,
// for every list and detail read, on one synthetic D1 fixture that mixes
// unsealed, pending, failed, superseded, synthetic, excluded, partial-run,
// shared-raw and empty-snapshot evidence. Every comparison is also checked
// against an independently written expected set so a shared mistake cannot be
// frozen in by the comparison alone.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/http";
import { evidenceReader } from "../src/observations";
import { seedRegistry, seedRun } from "./fixtures";
import * as legacy from "./legacy-read-path";

const OT = "other-test";
const SB = "sony-bank";

async function parse(
  artifactId: number,
  parser: string,
  version: string,
  status: "ok" | "error" | "pending",
  parsedAt = "2026-09-07T00:00:00Z",
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,error,warnings_json)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
  )
    .bind(
      artifactId,
      parser,
      version,
      parsedAt,
      status,
      status === "error" ? "synthetic failure" : null,
      status === "error" ? '["kept as text"]' : "[]",
    )
    .first<{ id: number }>();
  return row!.id;
}
async function supersede(oldId: number, newId: number): Promise<void> {
  await env.DB.prepare("UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE id=?")
    .bind(newId, oldId)
    .run();
}
async function tx(
  parseRunId: number,
  fields: {
    account: string;
    as_of?: string | null;
    description?: string | null;
    counterparty?: string | null;
    external_id?: string | null;
  },
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO transaction_observations
       (parse_run_id,source_account,external_id,as_of,amount_minor,currency,description,counterparty,raw_locator,extra_json)
     VALUES (?,?,?,?,9007199254740993,'JPY',?,?,'$','{}') RETURNING id`,
  )
    .bind(
      parseRunId,
      fields.account,
      fields.external_id ?? null,
      fields.as_of ?? null,
      fields.description ?? null,
      fields.counterparty ?? null,
    )
    .first<{ id: number }>();
  return row!.id;
}
async function bal(
  parseRunId: number,
  fields: { account: string; metric: string; instrument: string; as_of: string },
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO balance_observations
       (parse_run_id,source_account,metric,instrument,amount_minor,as_of,raw_locator,extra_json)
     VALUES (?,?,?,?,12345,?,'$','{}') RETURNING id`,
  )
    .bind(parseRunId, fields.account, fields.metric, fields.instrument, fields.as_of)
    .first<{ id: number }>();
  return row!.id;
}
async function pos(parseRunId: number, account: string, code: string): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO position_observations
       (parse_run_id,source_account,security_code,security_name,quantity_text,quantity_scale,raw_locator,extra_json)
     VALUES (?,?,?,'Synthetic share','1',0,'$.positions[0]','{}') RETURNING id`,
  )
    .bind(parseRunId, account, code)
    .first<{ id: number }>();
  return row!.id;
}
async function val(parseRunId: number, account: string, subject: string): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO valuation_observations
       (parse_run_id,source_account,subject,metric,amount_minor,currency,raw_locator,extra_json)
     VALUES (?,?,?,'evaluation_amount',777,'JPY','$.positions[0].value','{}') RETURNING id`,
  )
    .bind(parseRunId, account, subject)
    .first<{ id: number }>();
  return row!.id;
}

/** Runs the new reader and the frozen legacy path, asserts equality, returns the new result. */
async function same<T>(name: string, fresh: Promise<T>, old: Promise<T>): Promise<T> {
  const [a, b] = await Promise.all([fresh, old]);
  expect(a, name).toEqual(b);
  return a;
}
const ids = (rows: { id: number }[]) => rows.map((row) => row.id);

beforeAll(async () => {
  await seedRegistry();
});

describe("read-model parity with the legacy regex adapter", () => {
  it("returns identical sets and order for every read, matching the expected visibility", async () => {
    // ── fixture ──────────────────────────────────────────────────────────
    const R1 = await seedRun({ source: OT, count: 2 });
    const [A1, A2] = [R1.artifacts[0].id, R1.artifacts[1].id];
    const P1 = await parse(A1, "fixture-ledger", "1", "ok", "2026-09-01T00:00:00Z");
    const T1 = await tx(P1, {
      account: "acct",
      as_of: "2026-03-01",
      description: "see parse_runs table",
      counterparty: "fetch_artifacts co",
      external_id: "e1",
    });
    const T2 = await tx(P1, {
      account: "acct",
      as_of: "2026-03-05",
      description: "coffee",
      external_id: "e2",
    });
    const T3 = await tx(P1, { account: "acct-b" });
    const B1 = await bal(P1, {
      account: "acct",
      metric: "cash",
      instrument: "JPY",
      as_of: "2026-03-01",
    });
    const B2 = await bal(P1, {
      account: "acct",
      metric: "cash",
      instrument: "JPY",
      as_of: "2026-03-02",
    });
    const B3 = await bal(P1, {
      account: "acct",
      metric: "credit_statement_payment_amount",
      instrument: "JPY",
      as_of: "2026-03-02",
    });
    const PO1 = await pos(P1, "acct", "S1");
    const V1 = await val(P1, "acct", "S1");
    // A failed parse over the same artifact: recorded, never current.
    const P2 = await parse(A1, "fixture-ledger", "2", "error", "2026-09-02T00:00:00Z");
    const T4 = await tx(P2, {
      account: "acct",
      as_of: "2026-03-06",
      description: "from error parse",
    });
    // A pending parse: not a result at all.
    const P3 = await parse(A1, "fixture-ledger", "3", "pending");
    const T5 = await tx(P3, { account: "acct", as_of: "2026-03-07" });
    const B4 = await bal(P3, {
      account: "acct",
      metric: "cash",
      instrument: "JPY",
      as_of: "2026-03-07",
    });
    // Superseded parse on the second artifact.
    const P4 = await parse(A2, "fixture-ledger", "0", "ok", "2026-09-01T00:00:00Z");
    const P5 = await parse(A2, "fixture-ledger", "1", "ok", "2026-09-03T00:00:00Z");
    await supersede(P4, P5);
    const B5 = await bal(P4, {
      account: "acct-old",
      metric: "cash",
      instrument: "USD",
      as_of: "2026-02-01",
    });
    const B6 = await bal(P5, {
      account: "acct-old",
      metric: "cash",
      instrument: "USD",
      as_of: "2026-02-01",
    });
    // Unsealed run with a unique body: nothing of it is reachable.
    const R2 = await seedRun({ source: OT, count: 1, sealed: false, body: "unsealed-unique-body" });
    const A3 = R2.artifacts[0].id;
    const P6 = await parse(A3, "fixture-ledger", "1", "ok");
    const T6 = await tx(P6, { account: "acct", as_of: "2026-03-09" });
    const B7 = await bal(P6, {
      account: "acct",
      metric: "cash",
      instrument: "JPY",
      as_of: "2026-03-09",
    });
    // Synthetic source: excluded by the view from migration 0004.
    const R3 = await seedRun({ source: "kogane-synthetic", count: 1 });
    const A4 = R3.artifacts[0].id;
    const T7 = await tx(await parse(A4, "fixture-ledger", "1", "ok"), {
      account: "acct",
      as_of: "2026-03-10",
    });
    // Excluded run with a unique body: its raw object is unreachable.
    const R4 = await seedRun({
      source: OT,
      count: 1,
      excluded: true,
      body: "excluded-unique-body",
    });
    const A5 = R4.artifacts[0].id;
    const T8 = await tx(await parse(A5, "fixture-ledger", "1", "ok"), {
      account: "acct",
      as_of: "2026-03-11",
    });
    // One raw object referenced by two visible artifacts in two sources.
    const R5 = await seedRun({ source: SB, count: 1, body: "shared-body" });
    const R6 = await seedRun({ source: OT, count: 1, body: "shared-body" });
    const [A6, A7] = [R5.artifacts[0].id, R6.artifacts[0].id];
    // Snapshot dataset: a complete capture, then a later empty successful capture.
    const R7 = await seedRun({ source: OT, count: 1, dataset: "gross-balance" });
    const A8 = R7.artifacts[0].id;
    const P9 = await parse(A8, "sony-bank-gross-balance", "1", "ok");
    const B8 = await bal(P9, {
      account: "snap",
      metric: "gross",
      instrument: "JPY",
      as_of: "2026-01-01",
    });
    const R8 = await seedRun({ source: OT, count: 1, dataset: "gross-balance" });
    const A9 = R8.artifacts[0].id;
    const P10 = await parse(A9, "sony-bank-gross-balance", "1", "ok");
    // Sealed but partial collector outcome: visible evidence, not active state.
    const R9 = await seedRun({ source: OT, count: 1, outcome: "partial" });
    const A10 = R9.artifacts[0].id;
    const P11 = await parse(A10, "fixture-ledger", "1", "ok");
    const T9 = await tx(P11, { account: "failed-run-acct", as_of: "2026-03-08" });
    const B9 = await bal(P11, {
      account: "failed-run-acct",
      metric: "cash",
      instrument: "JPY",
      as_of: "2026-03-08",
    });
    // Position snapshot dataset, then an empty later capture.
    const R10 = await seedRun({ source: OT, count: 1, dataset: "domestic-cash-positions" });
    const A11 = R10.artifacts[0].id;
    const P12 = await parse(A11, "sbi-domestic-cash-positions", "1", "ok");
    const PO2 = await pos(P12, "snap", "S2");
    const V2 = await val(P12, "snap", "S2");
    const R11 = await seedRun({ source: OT, count: 1, dataset: "domestic-cash-positions" });
    const A12 = R11.artifacts[0].id;
    const P13 = await parse(A12, "sbi-domestic-cash-positions", "1", "ok");
    for (const [status, version, code] of [
      ["pending", "3", null],
      ["running", "4", null],
      ["failed", "2", null],
      ["failed", "1", "parser_version_retired"],
    ] as const)
      await env.DB.prepare(
        "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,last_error_code) VALUES(?,?,?,?,?)",
      )
        .bind(A1, "fixture-ledger", version, status, code)
        .run();
    // A failed job whose parser has since published a newer success is repaired.
    await env.DB.prepare(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,?)",
    )
      .bind(A2, "fixture-ledger", "0", "failed")
      .run();

    const visibleRuns = [R1, R5, R6, R7, R8, R9, R10, R11];
    const visibleArtifacts = visibleRuns.flatMap((run) => run.artifacts);
    const store = legacy.legacyObservationStore(env.DB);
    const reader = evidenceReader(env.DB);

    // ── overview and health ───────────────────────────────────────────────
    const overview = await same("overview", reader.overview(), legacy.legacyOverview(store));
    expect(Object.fromEntries(overview.counts.map((c) => [c.table, c.rows]))).toEqual({
      sources: overview.sources.length,
      fetch_runs: visibleRuns.length,
      raw_objects: new Set(visibleArtifacts.map((a) => a.sha256)).size,
      fetch_artifacts: visibleArtifacts.length,
      parse_runs: 9,
      transaction_observations: 5,
      balance_observations: 7,
      position_observations: 2,
      valuation_observations: 2,
    });
    expect(overview.sources.map((s) => s.id)).not.toContain("kogane-synthetic");
    expect(overview.sources.find((s) => s.id === OT)?.artifact_count).toBe(
      visibleArtifacts.length - 1,
    );
    expect(overview.fetchRuns.map((r) => r.id)).toEqual(
      visibleRuns.map((run) => run.id).sort((a, b) => b - a),
    );
    expect(overview.fetchRuns.find((r) => r.id === R9.id)?.status).toBe("partial");
    expect(overview.parseRuns.map((r) => r.id)).toEqual(
      [P1, P2, P4, P5, P9, P10, P11, P12, P13].sort((a, b) => b - a),
    );
    expect(overview.parseRuns.find((r) => r.id === P4)?.superseded_by_parse_run_id).toBe(P5);
    expect(overview.parseRuns.find((r) => r.id === P2)?.warnings).toEqual({
      list: ["kept as text"],
      raw: '["kept as text"]',
      parsed: true,
    });
    expect(
      await same("parsingHealth", reader.parsingHealth(), legacy.legacyParsingHealth(env.DB)),
    ).toEqual({ pending: 1, running: 1, failed: 1 });

    // ── transactions ──────────────────────────────────────────────────────
    const transactionCases: [string, Parameters<typeof reader.listTransactions>[0], number[]][] = [
      ["all", { offset: 0 }, [T2, T1, T3]],
      ["source", { source: OT, offset: 0 }, [T2, T1, T3]],
      ["other source", { source: SB, offset: 0 }, []],
      ["account", { account: "acct-b", offset: 0 }, [T3]],
      ["from", { from: "2026-03-02", offset: 0 }, [T2]],
      ["to", { to: "2026-03-01", offset: 0 }, [T1]],
      ["range", { from: "2026-03-01", to: "2026-03-05", offset: 0 }, [T2, T1]],
      ["q description literal", { q: "parse_runs", offset: 0 }, [T1]],
      ["q counterparty literal", { q: "FETCH_ARTIFACTS", offset: 0 }, [T1]],
      ["q account", { q: "acct-b", offset: 0 }, [T3]],
      ["offset", { offset: 1 }, [T1, T3]],
      ["offset past end", { offset: 3 }, []],
    ];
    for (const [name, query, expected] of transactionCases) {
      const { offset, ...scope } = query;
      const rows = await same(
        `transactions ${name}`,
        reader.listTransactions(query),
        legacy.legacyCurrentTransactions(store, { ...scope, offset }),
      );
      expect(ids(rows), `transactions ${name}`).toEqual(expected);
    }
    const literal = await reader.listTransactions({ q: "parse_runs", offset: 0 });
    expect(literal[0]).toMatchObject({
      id: T1,
      description: "see parse_runs table",
      counterparty: "fetch_artifacts co",
      amount_minor: "9007199254740993",
      parser: "fixture-ledger@1",
    });

    // ── latest balances (complete candidate set, as /api/balances asks) ───
    const latestCases: [string, Parameters<typeof reader.listLatestBalances>[0], number[]][] = [
      ["all", { offset: 0, limit: 5001 }, [B2, B3, B6]],
      ["page", { offset: 0, limit: 501 }, [B2, B3, B6]],
      ["view balances", { measureView: "balances", offset: 0, limit: 5001 }, [B2, B3, B6]],
      ["view summaries", { measureView: "summaries", offset: 0, limit: 5001 }, []],
      ["instrument", { instrument: "USD", offset: 0, limit: 5001 }, [B6]],
      ["metric", { metric: "cash", offset: 0, limit: 5001 }, [B2, B6]],
      ["account", { account: "acct", offset: 0, limit: 5001 }, [B2, B3]],
      ["snapshot account", { account: "snap", offset: 0, limit: 5001 }, []],
      ["offset", { offset: 2, limit: 501 }, [B6]],
    ];
    for (const [name, query, expected] of latestCases) {
      const { offset, limit, ...scope } = query;
      const rows = await same(
        `latest ${name}`,
        reader.listLatestBalances(query),
        legacy.legacyLatestBalances(store, { ...scope, offset }, limit === 5001),
      );
      expect(ids(rows), `latest ${name}`).toEqual(expected);
    }

    // ── balance history (visible parse results, superseded marked) ────────
    const historyCases: [string, Parameters<typeof reader.listBalanceHistory>[0], number[]][] = [
      ["all", { offset: 0 }, [B9, B3, B2, B1, B6, B5, B8]],
      ["metric", { metric: "cash", offset: 0 }, [B9, B2, B1, B6, B5]],
      ["instrument", { instrument: "USD", offset: 0 }, [B6, B5]],
      ["account", { account: "snap", offset: 0 }, [B8]],
      ["view balances", { measureView: "balances", offset: 0 }, [B9, B3, B2, B1, B6, B5, B8]],
      ["view summaries", { measureView: "summaries", offset: 0 }, []],
      ["offset", { offset: 2 }, [B2, B1, B6, B5, B8]],
    ];
    for (const [name, query, expected] of historyCases) {
      const { offset, ...scope } = query;
      const rows = await same(
        `history ${name}`,
        reader.listBalanceHistory(query),
        legacy.legacyBalanceHistory(store, { ...scope, offset }),
      );
      expect(ids(rows), `history ${name}`).toEqual(expected);
    }
    const history = await reader.listBalanceHistory({ offset: 0 });
    expect(history.find((row) => row.id === B5)).toMatchObject({
      superseded_by_parse_run_id: P5,
      parse_status: "ok",
    });
    expect(history.find((row) => row.id === B6)).toMatchObject({
      superseded_by_parse_run_id: null,
    });

    // ── positions with valuations ─────────────────────────────────────────
    const positions = await same(
      "positions",
      reader.listPositions({ offset: 0 }),
      legacy.legacyPositionsWithValuations(store, { offset: 0 }),
    );
    expect(positions.map((entry) => [entry.position.id, ids(entry.valuations)])).toEqual([
      [PO1, [V1]],
    ]);
    expect(
      await same(
        "positions account",
        reader.listPositions({ account: "snap", offset: 0 }),
        legacy.legacyPositionsWithValuations(store, { account: "snap", offset: 0 }),
      ),
    ).toEqual([]);

    // ── artifacts ─────────────────────────────────────────────────────────
    const artifactCases: [string, Parameters<typeof reader.listArtifacts>[0], number[]][] = [
      ["all", { before: Number.MAX_SAFE_INTEGER }, [A12, A11, A10, A9, A8, A7, A6, A2, A1]],
      [
        "source",
        { before: Number.MAX_SAFE_INTEGER, source: OT },
        [A12, A11, A10, A9, A8, A7, A2, A1],
      ],
      ["other source", { before: Number.MAX_SAFE_INTEGER, source: SB }, [A6]],
      ["cursor", { before: A2 }, [A1]],
    ];
    for (const [name, query, expected] of artifactCases) {
      const rows = await same(
        `artifacts ${name}`,
        reader.listArtifacts(query),
        legacy.legacyArtifacts(store, query.before, query.source),
      );
      expect(ids(rows), `artifacts ${name}`).toEqual(expected);
    }
    const artifacts = await reader.listArtifacts({ before: Number.MAX_SAFE_INTEGER });
    expect(artifacts.find((row) => row.id === A1)).toMatchObject({
      parse_run_count: 2,
      transaction_count: 4,
      balance_count: 3,
      position_count: 1,
      valuation_count: 1,
    });
    expect(artifacts.find((row) => row.id === A9)).toMatchObject({
      parse_run_count: 1,
      balance_count: 0,
    });

    // ── filter options ────────────────────────────────────────────────────
    const optionCases: [Parameters<typeof reader.filterOptions>[0], unknown][] = [
      [
        { kind: "transactions" },
        {
          sources: [OT, SB],
          accounts: [
            { source_id: OT, source_account: "acct" },
            { source_id: OT, source_account: "acct-b" },
          ],
          instruments: [],
          metrics: [],
        },
      ],
      [
        { kind: "balances" },
        {
          sources: [OT, SB],
          accounts: ["acct", "acct-old", "failed-run-acct", "snap"].map((source_account) => ({
            source_id: OT,
            source_account,
          })),
          instruments: ["JPY", "USD"],
          metrics: ["cash", "credit_statement_payment_amount", "gross"],
        },
      ],
      [
        { kind: "balances", measureView: "balances" },
        {
          sources: [OT],
          accounts: ["acct", "acct-old", "failed-run-acct", "snap"].map((source_account) => ({
            source_id: OT,
            source_account,
          })),
          instruments: ["JPY", "USD"],
          metrics: ["cash", "credit_statement_payment_amount", "gross"],
        },
      ],
      [
        { kind: "balances", measureView: "summaries" },
        { sources: [], accounts: [], instruments: [], metrics: [] },
      ],
      [
        { kind: "positions" },
        {
          sources: [OT, SB],
          accounts: [
            { source_id: OT, source_account: "acct" },
            { source_id: OT, source_account: "snap" },
          ],
          instruments: [],
          metrics: [],
        },
      ],
      [{ kind: "artifacts" }, { sources: [OT, SB], accounts: [], instruments: [], metrics: [] }],
    ];
    for (const [query, expected] of optionCases) {
      const options = await same(
        `filter-options ${query.kind} ${query.measureView ?? ""}`,
        reader.filterOptions(query),
        legacy.legacyFilterOptions(store, query.kind, query.measureView),
      );
      expect(options, `filter-options ${query.kind}`).toEqual(expected);
    }

    // ── artifact detail ───────────────────────────────────────────────────
    for (const id of [A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12])
      await same(`artifact ${id}`, reader.getArtifact(id), legacy.legacyArtifactDetail(store, id));
    const detail = await reader.getArtifact(A1);
    expect(detail?.parseRuns.map((run) => run.id)).toEqual([P1, P2]);
    expect(detail?.parseRuns[0].observations.map((ref) => [ref.kind, ref.id])).toEqual([
      ["transaction", T1],
      ["transaction", T2],
      ["transaction", T3],
      ["balance", B1],
      ["balance", B2],
      ["balance", B3],
      ["position", PO1],
      ["valuation", V1],
    ]);
    expect(detail?.parseRuns[0].observations[0].summary).toBe(
      "acct · 2026-03-01 · see parse_runs table",
    );
    expect(detail?.parseRuns[1]).toMatchObject({
      status: "error",
      error: "synthetic failure",
      observations: [{ kind: "transaction", id: T4 }],
    });
    expect((await reader.getArtifact(A10))?.artifact.fetch_status).toBe("partial");
    for (const hidden of [A3, A4, A5]) expect(await reader.getArtifact(hidden)).toBeUndefined();

    // ── observation detail ────────────────────────────────────────────────
    const visible = new Set([T1, T2, T3, T4, T9]);
    for (const id of [T1, T2, T3, T4, T5, T6, T7, T8, T9]) {
      const row = await same(
        `transaction ${id}`,
        reader.getObservation({ kind: "transaction", id }),
        legacy.legacyObservationDetail(store, "transaction", id),
      );
      expect(row !== undefined, `transaction ${id} visibility`).toBe(visible.has(id));
    }
    const visibleBalances = new Set([B1, B2, B3, B5, B6, B8, B9]);
    for (const id of [B1, B2, B3, B4, B5, B6, B7, B8, B9]) {
      const row = await same(
        `balance ${id}`,
        reader.getObservation({ kind: "balance", id }),
        legacy.legacyObservationDetail(store, "balance", id),
      );
      expect(row !== undefined, `balance ${id} visibility`).toBe(visibleBalances.has(id));
    }
    for (const [kind, id] of [
      ["position", PO1],
      ["position", PO2],
      ["valuation", V1],
      ["valuation", V2],
    ] as const)
      expect(
        await same(
          `${kind} ${id}`,
          reader.getObservation({ kind, id }),
          legacy.legacyObservationDetail(store, kind, id),
        ),
      ).toBeDefined();
    const t1 = await reader.getObservation({ kind: "transaction", id: T1 });
    expect(t1).toMatchObject({
      kind: "transaction",
      row: { id: T1, description: "see parse_runs table", amount_minor: "9007199254740993" },
      extra: {},
      extraParsed: true,
      provenance: {
        parse_run_id: P1,
        parse_status: "ok",
        artifact_id: A1,
        fetch_status: "success",
      },
    });
    expect(t1?.row).not.toHaveProperty("extra_json");
    expect(
      (await reader.getObservation({ kind: "transaction", id: T4 }))?.provenance,
    ).toMatchObject({ parse_status: "error", error: "synthetic failure" });
    expect((await reader.getObservation({ kind: "balance", id: B5 }))?.provenance).toMatchObject({
      superseded_by_parse_run_id: P5,
    });
    expect((await reader.getObservation({ kind: "balance", id: B9 }))?.provenance).toMatchObject({
      fetch_status: "partial",
    });

    // ── raw download reachability ─────────────────────────────────────────
    const shas = {
      shared: R1.artifacts[0].sha256,
      second: R1.artifacts[1].sha256,
      unsealed: R2.artifacts[0].sha256,
      excluded: R4.artifacts[0].sha256,
      twoRuns: R5.artifacts[0].sha256,
      missing: "f".repeat(64),
    };
    for (const [name, sha256] of Object.entries(shas)) {
      const row = await same(
        `raw ${name}`,
        reader.getRawDownload({ sha256 }),
        legacy.legacyRawDownload(env.DB, sha256).then((value) => value ?? undefined),
      );
      expect(row !== undefined, `raw ${name}`).toBe(
        !["unsealed", "excluded", "missing"].includes(name),
      );
    }
    expect(await reader.getRawDownload({ sha256: shas.twoRuns })).toMatchObject({
      sha256: shas.twoRuns,
      artifact_key: "synthetic-0.json",
      declared_media_type: "text/html",
    });
    expect(R6.artifacts[0].sha256).toBe(shas.twoRuns);

    // Storage persists across tests in this file: hide this fixture's runs.
    for (const run of visibleRuns)
      await env.DB.prepare(
        "INSERT INTO fetch_run_annotations VALUES (?, 'exclude_from_financial_views', 'test-finished', 0)",
      )
        .bind(run.id)
        .run();
  });

  it("refuses more than 5,000 candidates identically and pages positions before matching", async () => {
    const run = await seedRun({ source: OT, count: 1 });
    const parsed = await parse(run.artifacts[0].id, "large-fixture", "1", "ok");
    await env.DB.prepare(
      `INSERT INTO balance_observations (parse_run_id,source_account,metric,instrument,amount_minor,as_of,raw_locator,extra_json)
       WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001)
       SELECT ?,'wide',printf('metric-%04d',x),'JPY',1,'2026-09-07',CAST(x AS TEXT),'{}' FROM n`,
    )
      .bind(parsed)
      .run();
    await env.DB.prepare(
      `INSERT INTO position_observations (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
       WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001)
       SELECT ?,'wide',CAST(x AS TEXT),'1',0,CAST(x AS TEXT),'{}' FROM n`,
    )
      .bind(parsed)
      .run();
    await env.DB.prepare(
      `INSERT INTO valuation_observations (parse_run_id,source_account,subject,metric,amount_minor,currency,raw_locator,extra_json)
       SELECT parse_run_id,source_account,security_code,'value',1,'JPY',raw_locator,'{}'
       FROM position_observations WHERE parse_run_id=?`,
    )
      .bind(parsed)
      .run();
    const store = legacy.legacyObservationStore(env.DB);
    const reader = evidenceReader(env.DB);
    for (const attempt of [
      reader.listLatestBalances({ source: OT, account: "wide", offset: 0, limit: 5001 }),
      legacy.legacyLatestBalances(store, { source: OT, account: "wide", offset: 0 }, true),
    ]) {
      const error = await attempt.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 413, code: "result_limit_exceeded" });
    }
    const page = await same(
      "latest page",
      reader.listLatestBalances({ source: OT, account: "wide", offset: 0, limit: 501 }),
      legacy.legacyLatestBalances(store, { source: OT, account: "wide", offset: 0 }),
    );
    expect(page).toHaveLength(501);
    const positions = await same(
      "positions page",
      reader.listPositions({ source: OT, account: "wide", offset: 4600 }),
      legacy.legacyPositionsWithValuations(store, { source: OT, account: "wide", offset: 4600 }),
    );
    expect(positions).toHaveLength(401);
    expect(positions.every((entry) => entry.valuations.length === 1)).toBe(true);
    const first = await same(
      "positions first page",
      reader.listPositions({ source: OT, account: "wide", offset: 0 }),
      legacy.legacyPositionsWithValuations(store, { source: OT, account: "wide", offset: 0 }),
    );
    expect(first).toHaveLength(501);
    expect(first.slice(0, 500).every((entry) => entry.valuations.length === 1)).toBe(true);
    expect(first[500].valuations).toEqual([]);
  });
});
