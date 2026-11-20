// The `summary` detail of the three large reads (ADR 0123), on a store at the
// scale #1414 describes: every default MCP read answer is measured, the three
// reads' default answers stay under the 8 KB a client shows, each summary is
// its own full answer line by line, cursors continue under either detail,
// and a refused cursor names what must repeat. Every value is invented
// (`realistic-store.ts`).
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { scheduleRoute } from "../../processor/src/schedule-store";
import { ScheduleAlarm } from "../../processor/src/schedule-alarm";
import {
  MAINTENANCE_SUMMARY_LINES,
  type MaintenanceRead,
  type MaintenanceReadSource,
  maintenanceReadSummary,
  scheduleSnapshotSummary,
} from "../../../packages/collection/src/schedule-model";
import { overviewSummary } from "../../../packages/application/src/query/overview-detail";
import type { OverviewPage } from "../../../packages/observation-shared/src/api-contract";
import {
  balanceHistorySummary,
  latestBalanceSummary,
} from "../../../packages/application/src/query/read-detail";
import {
  collectionQualityCellSummary,
  collectionQualitySummaryLines,
} from "../../../packages/application/src/query/collection-quality-detail";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import {
  COLLECTION_QUALITY_API_VERSION,
  COLLECTION_QUALITY_LINE_PAGE,
  type CollectionQualityCell,
  type CollectionQualityCells,
  validCollectionQualityCells,
} from "../../../packages/observation-shared/src/collection-quality-contract";
import {
  COLLECTION_FRESHNESS_POLICY,
  collectionFreshness,
} from "../../../packages/domain/src/collection-freshness";
import { pageReadHarness } from "./page-read-harness";
import { seedRegistry } from "./fixtures";
import { REALISTIC_BALANCES, seedRealisticStore } from "./realistic-store";

/** What the owner's client shows of a tool result (#1414). */
const CLIENT_BYTES = 8 * 1024;

const processorEnv: Record<string, unknown> = { ...env, SCHEDULES_ENABLED: "true" };
processorEnv["SCHEDULE_ALARMS"] = {
  getByName(name: string) {
    const storage = {
      async get() {
        return name;
      },
      async put() {},
      async getAlarm() {
        return null;
      },
      async setAlarm() {},
      async deleteAlarm() {},
    };
    return Object.assign(Object.create(ScheduleAlarm.prototype) as ScheduleAlarm, {
      ctx: { storage, blockConcurrencyWhile: <T>(action: () => Promise<T>) => action() },
      env: processorEnv,
    });
  },
};
const PIPELINE = {
  async fetch(request: Request) {
    return (
      (await scheduleRoute(request, processorEnv as unknown as Env, new URL(request.url))) ??
      Response.json({ error: "not_found" }, { status: 404 })
    );
  },
};
const page = pageReadHarness("answer-size", {
  SCHEDULES_ENABLED: "true",
  PIPELINE,
  READ_PROJECTION_ENABLED: "true",
  OPERATOR_SUBJECTS: '["synthetic-reader","synthetic-agent"]',
});

let balanceId = 0;
beforeAll(async () => {
  await seedRegistry();
  await seedRealisticStore();
  balanceId = (await env.DB.prepare("SELECT max(id) AS id FROM balance_observations").first<number>(
    "id",
  ))!;
}, 120_000);

/** The bytes a client receives as the tool result's text: the structured content, serialized. */
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const today = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

/** Each read tool's default call, and its other collections or views. */
function calls(): [string, Record<string, unknown>][] {
  return [
    ["kogane.capabilities", {}],
    ["kogane.context.open", {}],
    ["kogane.explain", { ref: `observation:balance:${balanceId}` }],
    ["kogane.instruments.candidates", {}],
    ["kogane.reported-state.read", { date: today() }],
    ["kogane.instruments.coverage", {}],
    ["kogane.accounts.candidates", {}],
    ["kogane.card-settlements.unmatched", {}],
    ["kogane.card-settlements.debit-accounts", {}],
    ["kogane.card-settlements.read", {}],
    ["kogane.card-settlements.statements", {}],
    ["kogane.audit.search", {}],
    ["kogane.identity.read", { collection: "connections" }],
    ["kogane.identity.read", { collection: "accounts" }],
    ["kogane.identity.read", { collection: "instruments" }],
    ["kogane.identity.read", { collection: "coverage" }],
    ["kogane.store.read", { page: "meta" }],
    ["kogane.store.read", { page: "overview" }],
    ["kogane.store.read", { page: "overview", detail: "full" }],
    ["kogane.store.read", { page: "filter-options", kind: "balances" }],
    ["kogane.observations.list", { kind: "transactions" }],
    ["kogane.observations.list", { kind: "balances" }],
    ["kogane.observations.list", { kind: "positions" }],
    ["kogane.observations.list", { kind: "artifacts" }],
    ["kogane.observations.get", { kind: "balance", id: balanceId }],
    ["kogane.balances.read", { collection: "latest" }],
    ["kogane.balances.read", { collection: "latest", detail: "full" }],
    ["kogane.balances.read", { collection: "history" }],
    ["kogane.balances.read", { collection: "history", detail: "full" }],
    ["kogane.rewards.read", { collection: "holdings" }],
    ["kogane.events.read", { collection: "activity" }],
    ["kogane.events.read", { collection: "obligations" }],
    ["kogane.reports.read", {}],
    ["kogane.collection-quality.read", {}],
    ["kogane.collection-quality.read", { detail: "full" }],
    ["kogane.collection-quality.read", { source: "sony-bank" }],
    ["kogane.collection-quality.read", { source: "sony-bank", detail: "full" }],
    ["kogane.collection-quality.read", { source: "sony-bank", view: "accounts" }],
    ["kogane.evidence.read", { page: "meta" }],
    ["kogane.schedules.read", {}],
    ["kogane.schedules.read", { detail: "full" }],
    ["kogane.schedules.maintenance.read", {}],
    ["kogane.schedules.maintenance.read", { detail: "full" }],
    ["kogane.schedules.survey.read", {}],
    ["kogane.purchases.explain", {}],
  ];
}

describe("MCP read answer sizes (ADR 0123)", () => {
  it("measures every read tool's default answer, and keeps the five summaries under 8 KB", async () => {
    const listed = new Set(await page.listed());
    const rows: string[] = [];
    const sizes = new Map<string, number>();
    for (const [tool, args] of calls()) {
      expect(listed.has(tool), tool).toBe(true);
      const answer = await page.mcp(tool, args);
      const size = bytes(answer.body);
      sizes.set(`${tool} ${JSON.stringify(args)}`, size);
      rows.push(
        `| ${tool} | ${JSON.stringify(args)} | ${answer.isError ? `error ${String(answer.body?.error)}` : "ok"} | ${size} |`,
      );
    }
    // The measurement, for the ADR's table (`vitest --silent=false`).
    console.log(
      [
        `${REALISTIC_BALANCES} balances; MCP structured content bytes`,
        "| tool | arguments | outcome | bytes |",
        ...rows,
      ].join("\n"),
    );
    for (const call of [
      'kogane.balances.read {"collection":"latest"}',
      'kogane.balances.read {"collection":"history"}',
      "kogane.schedules.read {}",
      "kogane.collection-quality.read {}",
      'kogane.collection-quality.read {"source":"sony-bank"}',
      'kogane.store.read {"page":"overview"}',
      "kogane.schedules.maintenance.read {}",
    ])
      expect(sizes.get(call), call).toBeLessThan(CLIENT_BYTES);
    // The two reads the amendment of 2026-11-19 summarizes were over it in full.
    expect(sizes.get('kogane.store.read {"page":"overview","detail":"full"}')).toBeGreaterThan(
      CLIENT_BYTES,
    );
    expect(sizes.get('kogane.schedules.maintenance.read {"detail":"full"}')).toBeGreaterThan(
      CLIENT_BYTES,
    );
    // The full answers are what #1414 measured: far past what a client shows.
    expect(
      sizes.get('kogane.balances.read {"collection":"latest","detail":"full"}'),
    ).toBeGreaterThan(10 * CLIENT_BYTES);
    expect(sizes.get('kogane.schedules.read {"detail":"full"}')).toBeGreaterThan(CLIENT_BYTES);
    expect(sizes.get('kogane.collection-quality.read {"detail":"full"}')).toBeGreaterThan(
      CLIENT_BYTES,
    );
  });
});

describe("kogane.balances.read summary (ADR 0123)", () => {
  it("is the full page line by line, on the route and the tool alike", async () => {
    for (const collection of ["latest", "history"] as const) {
      const path = `/api/v2/balances/${collection}`;
      const summary = await page.route(path);
      expect(summary.status).toBe(200);
      expect(validApiResponse(path, summary.body)).toBe(true);
      const full = await page.route(`${path}?detail=full&limit=10`);
      expect(full.status).toBe(200);
      expect(validApiResponse(path, full.body)).toBe(true);
      // A reader that names the detail it asked for takes that shape only.
      expect(validApiResponse(path, full.body, "full")).toBe(true);
      expect(validApiResponse(path, summary.body, "summary")).toBe(true);
      expect(validApiResponse(path, summary.body, "full")).toBe(false);
      expect(validApiResponse(path, full.body, "summary")).toBe(false);
      // A full page says nothing about detail; it is today's page.
      expect(full.body).not.toHaveProperty("detail");
      const derived =
        collection === "latest"
          ? latestBalanceSummary(full.body as never)
          : balanceHistorySummary(full.body as never);
      // The cursor names a fresh read instance's snapshot, the same on both.
      expect(summary.body).toEqual(derived);
      expect(await page.http("kogane.balances.read", { collection })).toEqual({
        status: 200,
        body: { schemaVersion: "kogane-page-read-v1", data: summary.body },
      });
      expect((await page.mcp("kogane.balances.read", { collection })).body.data).toEqual(
        summary.body,
      );
      expect(
        (await page.mcp("kogane.balances.read", { collection, detail: "full", limit: 10 })).body
          .data,
      ).toEqual(full.body);
    }
  });

  it("keeps a value that is not exact as its status, never a zero, and every unit", async () => {
    const lines: {
      amount: { value: string | null; unit: string | null; status: string; scale: number | null };
    }[] = [];
    let cursor: string | null = null;
    do {
      const answer = await page.mcp("kogane.balances.read", {
        collection: "latest",
        ...(cursor ? { cursor } : {}),
      });
      lines.push(...answer.body.data.items);
      cursor = answer.body.data.page.nextCursor;
    } while (cursor !== null);
    expect(lines).toHaveLength(REALISTIC_BALANCES);
    const unparsed = lines.filter((line) => line.amount.status !== "exact");
    expect(unparsed.length).toBeGreaterThan(0);
    for (const line of unparsed)
      expect(line.amount).toEqual({ value: null, unit: "JPY", status: "unparsed", scale: null });
    for (const line of lines.filter((entry) => entry.amount.status === "exact")) {
      expect(line.amount.unit).toBe("JPY");
      expect(line.amount.value).toMatch(/^[1-9][0-9]*$/u);
    }
  });

  it("continues a cursor under either detail and at another offered size", async () => {
    const first = await page.mcp("kogane.balances.read", { collection: "latest" });
    const cursor = first.body.data.page.nextCursor as string;
    expect(first.body.data.page.limit).toBe(10);
    const summary = await page.mcp("kogane.balances.read", { collection: "latest", cursor });
    const full = await page.mcp("kogane.balances.read", {
      collection: "latest",
      cursor,
      detail: "full",
      limit: 10,
    });
    const ids = (items: { observationId: number }[]) => items.map((item) => item.observationId);
    expect(ids(full.body.data.items)).toEqual(ids(summary.body.data.items));
    expect(ids(summary.body.data.items)).not.toEqual(
      expect.arrayContaining(ids(first.body.data.items)),
    );
    const wider = await page.mcp("kogane.balances.read", {
      collection: "latest",
      cursor,
      limit: 50,
    });
    expect(ids(wider.body.data.items).slice(0, 10)).toEqual(ids(summary.body.data.items));
  });

  it("names the inputs a cursor must repeat when it belongs to another query", async () => {
    const first = await page.mcp("kogane.balances.read", { collection: "latest" });
    const cursor = first.body.data.page.nextCursor as string;
    const expected = {
      error: "cursor_mismatch",
      mustMatch: [
        "collection",
        "source",
        "account",
        "instrument",
        "metric",
        "view",
        "identityRead",
      ],
    };
    expect(
      (await page.mcp("kogane.balances.read", { collection: "latest", cursor, source: "vpass" }))
        .body,
    ).toEqual(expected);
    const route = await page.route(
      `/api/v2/balances/latest?source=vpass&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(route.status).toBe(400);
    expect(route.body).toMatchObject(expected);
  });

  it("refuses a detail it does not offer", async () => {
    expect((await page.route("/api/v2/balances/latest?detail=compact")).body).toMatchObject({
      error: "invalid_detail",
    });
    const answer = await page.mcp("kogane.balances.read", {
      collection: "latest",
      detail: "compact",
    });
    expect(answer.isError).toBe(true);
    expect(answer.body.error).toBe("invalid_request");
  });
});

describe("kogane.schedules.read summary (ADR 0123)", () => {
  it("is the full snapshot shaped by the one shared function, on the route and the tool alike", async () => {
    const summary = await page.route("/api/ops/v1/schedules");
    const full = await page.route("/api/ops/v1/schedules?detail=full");
    expect(summary.status).toBe(200);
    expect(full.status).toBe(200);
    expect(full.body).not.toHaveProperty("detail");
    expect(summary.body).toEqual(scheduleSnapshotSummary(full.body as never));
    const lines = (summary.body as { schedules: { latest: { failureCode: string | null } }[] })
      .schedules;
    // A failed job keeps its closed failure code.
    expect(lines.some((line) => line.latest?.failureCode === "collection_failed")).toBe(true);
    expect((await page.mcp("kogane.schedules.read", {})).body).toEqual({
      schemaVersion: "kogane-page-read-v1",
      data: summary.body,
    });
    const { survey: _survey, ...withoutSurvey } = full.body as Record<string, unknown>;
    expect((await page.mcp("kogane.schedules.read", { detail: "full" })).body.data).toEqual(
      withoutSurvey,
    );
    expect((await page.route("/api/ops/v1/schedules?detail=compact")).status).toBe(400);
    expect((await page.route("/api/ops/v1/schedules?other=1")).status).toBe(400);
  });
});

describe("kogane.collection-quality.read summary (ADR 0123)", () => {
  it("is the full summary and cells, collapsed, on the route and the tool alike", async () => {
    const summary = await page.route("/api/collection-quality");
    const full = await page.route("/api/collection-quality?detail=full");
    expect(full.body).not.toHaveProperty("detail");
    // Both answers count ages to their own instant, which can differ by a call.
    const { freshnessAsOf: _a, ...summaryRest } = summary.body as Record<string, unknown>;
    const { freshnessAsOf: _b, ...derived } = collectionQualitySummaryLines(
      full.body as never,
    ) as unknown as Record<string, unknown>;
    expect(summaryRest).toEqual(derived);
    const tool = await page.mcp("kogane.collection-quality.read", {});
    expect(Object.keys(tool.body.data)).toEqual(Object.keys(summary.body as object));
    const cells = await page.route("/api/collection-quality/sony-bank");
    expect(cells.body).toMatchObject({
      detail: "summary",
      coverage: { cells: 1, lines: 1, limit: COLLECTION_QUALITY_LINE_PAGE, truncated: false },
    });
    expect((await page.route("/api/collection-quality/sony-bank?detail=full")).body).toMatchObject({
      cells: [expect.any(Object)],
    });
    // The account view has one detail.
    expect(
      (await page.route("/api/collection-quality/sony-bank/accounts?detail=full")).status,
    ).toBe(400);
    expect(
      (
        await page.mcp("kogane.collection-quality.read", {
          source: "sony-bank",
          view: "accounts",
          detail: "full",
        })
      ).body,
    ).toEqual({ error: "invalid_request", refs: ["detail"] });
  });

  it("collapses a source the size of the Vpass cells (about 300) into pages under 8 KB", () => {
    const at = "2026-11-19T02:00:00.000Z";
    const date = "2026-11-19";
    const capture = (fetchRunId: number, capturedAt: string) => ({ fetchRunId, capturedAt });
    const cells: CollectionQualityCell[] = [];
    // Seven card units: 36 statement months each, never current since an
    // older capture, and seven single-period datasets that are current.
    for (let unit = 1; unit <= 7; unit++) {
      const unitKey = `synthetic-card-${String(unit).padStart(3, "0")}`;
      for (let month = 0; month < 36; month++) {
        const value = `${2023 + Math.floor((month + 11) / 12)}-${String(((month + 11) % 12) + 1).padStart(2, "0")}`;
        cells.push({
          dataset: "statement-page",
          // No parse job names a capture that is not parse-eligible.
          parser: null,
          unitKey,
          period: { kind: "statement-month", value, state: null },
          currentRule: "vpass-card-month",
          newest: {
            fetchRunId: 900 + unit,
            capturedAt: "2026-11-18T21:01:10.000Z",
            runSucceeded: false,
            unitFailed: true,
            unitFailureCode: "stated_total_mismatch",
            artifacts: 1,
            observations: 0,
            unresolvedIdentities: 0,
            rawStored: 1,
            parses: {
              published: 0,
              pending: 0,
              failed: 0,
              unpublished: 0,
              notQueued: 0,
              notEligible: 1,
            },
            failureCodes: [],
            incompleteCoverage: 0,
            coverageCauses: [],
          },
          current: capture(700 + unit, "2026-09-10T21:01:10.000Z"),
          state: "older-current",
          reasons: [
            "run_not_successful",
            "unit_failed",
            "not_parse_eligible",
            "newer_capture_not_current",
          ],
          freshness: collectionFreshness("2026-09-10T21:01:10.000Z", date, null),
        } as unknown as CollectionQualityCell);
      }
      for (let dataset = 1; dataset <= 7; dataset++)
        cells.push({
          dataset: `synthetic-dataset-${dataset}`,
          parser: `synthetic-parser-${dataset}`,
          unitKey,
          period: { kind: "latest", value: null, state: null },
          currentRule: "container-snapshot",
          newest: {
            fetchRunId: 1000 + unit,
            capturedAt: "2026-11-18T21:02:00.000Z",
            runSucceeded: true,
            unitFailed: false,
            unitFailureCode: null,
            artifacts: 2,
            observations: 4,
            unresolvedIdentities: 0,
            rawStored: 2,
            parses: {
              published: 2,
              pending: 0,
              failed: 0,
              unpublished: 0,
              notQueued: 0,
              notEligible: 0,
            },
            failureCodes: [],
            incompleteCoverage: 0,
            coverageCauses: [],
          },
          current: capture(1000 + unit, "2026-11-18T21:02:00.000Z"),
          state: "current",
          reasons: [],
          freshness: collectionFreshness("2026-11-18T21:02:00.000Z", date, null),
        } as unknown as CollectionQualityCell);
    }
    const answer: CollectionQualityCells = {
      apiVersion: COLLECTION_QUALITY_API_VERSION,
      freshnessAsOf: { policy: COLLECTION_FRESHNESS_POLICY, at, date },
      sourceId: "vpass",
      latestFetchRun: { id: 1007, succeeded: true, completedAt: "2026-11-18T21:05:00.000Z" },
      cells,
      coverage: { limit: 500, truncated: false, nextOffset: null },
    } as unknown as CollectionQualityCells;
    expect(validCollectionQualityCells(answer)).toBe(true);
    expect(cells).toHaveLength(301);
    expect(bytes(answer)).toBeGreaterThan(20 * CLIENT_BYTES);
    const pages = [];
    for (let offset = 0; ; offset += COLLECTION_QUALITY_LINE_PAGE) {
      const summary = collectionQualityCellSummary([answer], offset);
      pages.push(summary);
      expect(bytes({ schemaVersion: "kogane-page-read-v1", data: summary })).toBeLessThan(
        CLIENT_BYTES,
      );
      if (summary.coverage.nextOffset === null) break;
    }
    const lines = pages.flatMap((entry) => entry.lines);
    expect(lines).toHaveLength(56);
    expect(pages[0]!.coverage).toMatchObject({ cells: 301, lines: 56 });
    // Every cell is counted once, under its state; no reason is dropped.
    expect(lines.reduce((sum, line) => sum + line.cells, 0)).toBe(301);
    for (const line of lines)
      expect(line.current + line.olderCurrent + line.noCurrent).toBe(line.cells);
    const statements = lines.find((line) => line.dataset === "statement-page")!;
    expect(statements).toMatchObject({
      cells: 36,
      olderCurrent: 36,
      periods: { first: "2023-12", last: "2026-11" },
      freshness: { state: "stale", ageDays: 69 },
      reasons: [
        "run_not_successful",
        "unit_failed",
        "not_parse_eligible",
        "newer_capture_not_current",
      ],
      // The unit's closed failure code is kept, as its reason is.
      failureCodes: ["stated_total_mismatch"],
      coverageCauses: [],
    });
  });
});

// ── The amendment of 2026-11-19: the overview and the maintenance read ──

/** Two-digit index, for synthetic names. */
const nn = (index: number) => String(index).padStart(2, "0");
const instant = (minutes: number) =>
  new Date(Date.UTC(2026, 10, 18, 21) - minutes * 60_000).toISOString();

/**
 * Every code the Processor writes to `parse_runs.error` today (its pipeline
 * and metadata errors, the failing stage, `parse_interrupted`), and the
 * `unclassified` the summary writes for a value that is not a code.
 */
const PARSE_FAILURE_CODES = [
  "artifact_not_eligible",
  "artifact_too_large",
  "metadata_release_unknown",
  "observation_limit_exceeded",
  "observation_payload_too_large",
  "observation_row_too_large",
  "parse_contract_invalid",
  "parse_lease_expired",
  "parse_run_insert_failed",
  "parser_no_longer_accepts",
  "parser_release_conflict",
  "parser_version_invalid",
  "raw_checksum_mismatch",
  "raw_object_missing",
  "raw_size_mismatch",
  "release_manifest_mismatch",
  "manifest_artifact_ambiguous",
  "manifest_artifact_mismatch",
  "manifest_dataset_mismatch",
  "manifest_media_type_mismatch",
  "manifest_period_invalid",
  "manifest_shape_invalid",
  "manifest_state_invalid",
  "metadata_manifest_missing",
  "metadata_projection_missing",
  "metadata_or_raw_read_failed",
  "parser_rejected",
  "persistence_failed",
  "parse_interrupted",
  "unclassified",
] as const;

/**
 * A full overview at the worst its window allows: 38 sources (as many as the
 * registry declares today), every one with artifacts and runs among the
 * newest 500 fetch runs, `partialSources` of them with partial runs, and the
 * newest 500 parse runs over 57 parsers (as many as the parser registry has),
 * `failingParsers` of them failing (their runs taking `codes` in turn) and
 * three pending, with warnings; and `unitLines` sources' datasets with three
 * partial-unit updates each.
 */
function worstOverview(options: {
  partialSources: number;
  failingParsers: number;
  unitLines: number;
  codes: readonly string[];
}): OverviewPage {
  const sources = Array.from({ length: 38 }, (_, index) => `synthetic-source-${nn(index)}`);
  const parsers = Array.from(
    { length: 57 },
    (_, index) => `synthetic-provider-${nn(index)}-statement-parser`,
  );
  return {
    counts: [
      "sources",
      "fetch_runs",
      "raw_objects",
      "fetch_artifacts",
      "parse_runs",
      "transaction_observations",
      "balance_observations",
      "position_observations",
      "valuation_observations",
    ].map((table, index) => ({ table, rows: 1_000_000 + index * 7_919 })),
    sources: sources.map((id, index) => ({
      id,
      provider: `Synthetic Provider ${index}`,
      ingestion: "collector-r2",
      artifact_count: 10_000 + index * 101,
    })),
    fetchRuns: Array.from({ length: 500 }, (_, index) => {
      const source = index % sources.length;
      const partial = source < options.partialSources && index % 3 === 0;
      return {
        id: 900_500 - index,
        source_id: sources[source]!,
        tool: "synthetic-collector",
        external_run_id: crypto.randomUUID(),
        status: partial ? "partial" : "success",
        started_at: instant(index * 30 + 5),
        completed_at: partial && index % 2 === 0 ? null : instant(index * 30),
      };
    }),
    parseRuns: Array.from({ length: 500 }, (_, index) => {
      const parser = index % parsers.length;
      const failing = parser < options.failingParsers;
      const pending = !failing && parser < options.failingParsers + 3;
      const status =
        failing && index % 2 === 0 ? "error" : pending && index % 5 === 0 ? "pending" : "ok";
      return {
        id: 700_500 - index,
        fetch_artifact_id: 800_500 - index,
        parser_name: parsers[parser]!,
        parser_version: "3",
        parsed_at: instant(index * 30),
        status,
        warnings:
          index % 4 === 0
            ? { list: ["synthetic warning text"], raw: '["synthetic warning text"]', parsed: true }
            : { list: [], raw: "[]", parsed: true },
        // The Processor writes a closed code here, never the parser's text.
        error: status === "error" ? options.codes[(index / 2) % options.codes.length]! : null,
        superseded_by_parse_run_id: index % 9 === 0 ? 700_600 - index : null,
      };
    }),
    unitUpdates: Array.from({ length: options.unitLines * 3 }, (_, index) => ({
      source_id: sources[index % options.unitLines]!,
      dataset: `synthetic-dataset-${nn(index % options.unitLines)}`,
      fetch_run_id: 900_500 - index * 3,
      fetched_at: instant(index * 90),
      updated_units: 3,
      stale_units: 1,
    })),
    coverage: { limit: 500, truncated: true },
  };
}

/**
 * A full overview at the summary's bound: every part the caps leave growing
 * at its largest. 38 sources, each with its own artifact count and with
 * partial runs; every fetch run completed; all three parse statuses, every
 * one of 57 parsers failing, the five newest lines each with the three
 * longest codes and more, every code the Processor writes on the error
 * line, three parsers' pending lines and the older failing ones left out;
 * every run superseded and half of them with warnings, half unreadable; and
 * 76 source and dataset lines of unit updates. Source ids, parser names and
 * datasets are as long as the longest the source and parser registries and
 * the collectors use today (17, 40 and 37 characters); counts and ids are as
 * wide as `worstOverview`'s.
 */
function boundOverview(): OverviewPage {
  const sources = Array.from({ length: 38 }, (_, index) => `synthetic-feed-${nn(index)}`);
  const parsers = Array.from(
    { length: 57 },
    (_, index) => `synthetic-provider-${nn(index)}-card-statement-pdf`,
  );
  const longest = [...PARSE_FAILURE_CODES].sort((left, right) => right.length - left.length);
  return {
    counts: worstOverview({ partialSources: 0, failingParsers: 0, unitLines: 0, codes: [] }).counts,
    sources: sources.map((id, index) => ({
      id,
      provider: `Synthetic Provider ${index}`,
      ingestion: "collector-r2",
      artifact_count: 10_000 + index * 101,
    })),
    fetchRuns: Array.from({ length: 500 }, (_, index) => ({
      id: 900_500 - index,
      source_id: sources[index % sources.length]!,
      tool: "synthetic-collector",
      external_run_id: crypto.randomUUID(),
      status: index % 3 === 0 ? "success" : "partial",
      started_at: instant(index * 30 + 5),
      completed_at: instant(index * 30),
    })),
    parseRuns: Array.from({ length: 500 }, (_, index) => {
      const parser = index % parsers.length;
      // Seven rounds of every parser failing, then three pending and the rest ok.
      const round = Math.floor(index / parsers.length);
      const status = round < 7 ? "error" : parser < 3 ? "pending" : "ok";
      return {
        id: 700_500 - index,
        fetch_artifact_id: 800_500 - index,
        parser_name: parsers[parser]!,
        parser_version: "3",
        parsed_at: instant(index * 30),
        status,
        warnings:
          index % 2 === 0
            ? { list: ["synthetic warning text"], raw: '["synthetic warning text"]', parsed: true }
            : { list: [], raw: "not json", parsed: false },
        // The newest three rounds the longest codes, the older ones every code.
        error:
          status !== "error"
            ? null
            : round < 3
              ? longest[round]!
              : PARSE_FAILURE_CODES[index % PARSE_FAILURE_CODES.length]!,
        superseded_by_parse_run_id: 700_600 - index,
      };
    }),
    unitUpdates: Array.from({ length: 500 }, (_, index) => ({
      source_id: sources[index % sources.length]!,
      dataset: `synthetic-dataset-${nn(Math.floor(index / sources.length) % 2)}-statement-detail`,
      fetch_run_id: 900_500 - index,
      fetched_at: instant(index * 30),
      updated_units: 3,
      stale_units: 1,
    })),
    coverage: { limit: 500, truncated: true },
  };
}

describe("kogane.store.read overview summary (ADR 0123, amendment 2026-11-19)", () => {
  it("is the full overview shaped by the one shared function, on the route and the tool alike", async () => {
    const summary = await page.route("/api/overview");
    const full = await page.route("/api/overview?detail=full");
    expect(summary.status).toBe(200);
    expect(full.status).toBe(200);
    expect(full.body).not.toHaveProperty("detail");
    expect(summary.body).toEqual(overviewSummary(full.body as OverviewPage));
    expect(validApiResponse("/api/overview", summary.body, "summary")).toBe(true);
    expect(validApiResponse("/api/overview", full.body, "full")).toBe(true);
    expect(validApiResponse("/api/overview", summary.body, "full")).toBe(false);
    expect(validApiResponse("/api/overview", full.body, "summary")).toBe(false);
    expect(validApiResponse("/api/overview", summary.body)).toBe(true);
    expect(validApiResponse("/api/overview", full.body)).toBe(true);
    const envelope = (data: unknown) => ({ schemaVersion: "kogane-page-read-v1", data });
    expect((await page.mcp("kogane.store.read", { page: "overview" })).body).toEqual(
      envelope(summary.body),
    );
    expect(await page.http("kogane.store.read", { page: "overview" })).toEqual({
      status: 200,
      body: envelope(summary.body),
    });
    expect(
      (await page.mcp("kogane.store.read", { page: "overview", detail: "full" })).body,
    ).toEqual(envelope(full.body));
    // Every fetch and parse run of the window is counted under its status.
    const lines = summary.body as {
      fetchRuns: { byStatus: { runs: number }[] };
      parseRuns: { byStatus: { runs: number }[] };
    };
    const window = full.body as OverviewPage;
    expect(lines.fetchRuns.byStatus.reduce((sum, line) => sum + line.runs, 0)).toBe(
      window.fetchRuns.length,
    );
    expect(lines.parseRuns.byStatus.reduce((sum, line) => sum + line.runs, 0)).toBe(
      window.parseRuns.length,
    );
  });

  it("refuses a detail it does not offer, and a detail on the other pages", async () => {
    expect(await page.route("/api/overview?detail=compact")).toEqual({
      status: 400,
      body: expect.objectContaining({ error: "invalid_detail" }),
    });
    const tool = await page.mcp("kogane.store.read", { page: "overview", detail: "compact" });
    expect(tool.isError).toBe(true);
    expect(tool.body.error).toBe("invalid_request");
    // Only the overview has a detail: the other pages refuse it as the routes do.
    for (const [path, args] of [
      ["/api/meta?detail=full", { page: "meta", detail: "full" }],
      [
        "/api/filter-options?kind=balances&detail=full",
        { page: "filter-options", kind: "balances", detail: "full" },
      ],
    ] as const) {
      expect((await page.route(path)).body).toMatchObject({ error: "invalid_query" });
      expect((await page.mcp("kogane.store.read", args)).body).toMatchObject({
        error: "invalid_query",
      });
    }
  });

  it("stays under 7 KB at the window's realistic worst and under 8 KB at its bound", () => {
    const worst = worstOverview({
      partialSources: 10,
      failingParsers: 10,
      unitLines: 10,
      codes: ["parser_rejected"],
    });
    expect(validApiResponse("/api/overview", worst, "full")).toBe(true);
    expect(bytes(worst)).toBeGreaterThan(25 * CLIENT_BYTES);
    const summary = overviewSummary(worst);
    expect(validApiResponse("/api/overview", summary, "summary")).toBe(true);
    const size = bytes({ schemaVersion: "kogane-page-read-v1", data: summary });
    expect(size).toBeLessThan(7 * 1024);
    // Every run is counted once, under its status; each status that is not a
    // success names the five sources or parsers with the newest runs and
    // counts the rest, with their runs.
    expect(summary.fetchRuns.byStatus.map((line) => [line.status, line.runs])).toEqual([
      ["partial", worst.fetchRuns.filter((run) => run.status === "partial").length],
      ["success", worst.fetchRuns.filter((run) => run.status === "success").length],
    ]);
    expect(summary.fetchRuns.notSuccessful).toHaveLength(5);
    expect(summary.fetchRuns.notSuccessfulOmitted).toEqual([
      { status: "partial", lines: 5, runs: expect.any(Number) },
    ]);
    expect(summary.parseRuns.notOk).toHaveLength(5);
    // Ten failing parsers and three pending ones: thirteen lines.
    expect(
      summary.parseRuns.notOk.length +
        summary.parseRuns.notOkOmitted.reduce((lines, line) => lines + line.lines, 0),
    ).toBe(13);
    for (const line of summary.parseRuns.notOk)
      expect(line.failureCodes).toEqual(line.status === "error" ? ["parser_rejected"] : []);
    expect(summary.unitUpdates).toHaveLength(5);
    expect(summary.unitUpdatesOmitted).toEqual({ lines: 5, runs: 15 });
    expect(summary.sources).toHaveLength(38);
    // The bound: every list full and every part the caps leave growing at
    // its largest. Nothing grows further with the store; only the source
    // registry, the Processor's codes, longer names and wider numbers would.
    const boundFull = boundOverview();
    expect(validApiResponse("/api/overview", boundFull, "full")).toBe(true);
    const bound = overviewSummary(boundFull);
    expect(validApiResponse("/api/overview", bound, "summary")).toBe(true);
    expect(
      [
        boundFull.sources[0]!.id,
        boundFull.parseRuns[0]!.parser_name,
        boundFull.unitUpdates![0]!.dataset,
      ].map((name) => name.length),
    ).toEqual([17, 40, 37]);
    expect(bound.sources).toHaveLength(38);
    expect(bound.fetchRuns.notSuccessful).toHaveLength(5);
    expect(bound.fetchRuns.notSuccessful.every((line) => line.newest.completedAt !== null)).toBe(
      true,
    );
    expect(bound.parseRuns.byStatus.map((line) => line.status).sort()).toEqual([
      "error",
      "ok",
      "pending",
    ]);
    expect(bound.parseRuns.byStatus.find((line) => line.status === "error")?.failureCodes).toEqual(
      expect.arrayContaining([...PARSE_FAILURE_CODES]),
    );
    const longest = [...PARSE_FAILURE_CODES]
      .sort((left, right) => right.length - left.length)
      .slice(0, 3);
    expect(bound.parseRuns.notOk).toHaveLength(5);
    for (const line of bound.parseRuns.notOk) {
      expect(line.failureCodes).toEqual(longest);
      expect(line.moreFailureCodes).toBeGreaterThan(0);
    }
    expect(bound.parseRuns.notOkOmitted.map((entry) => entry.status).sort()).toEqual([
      "error",
      "pending",
    ]);
    expect(bound.unitUpdates).toHaveLength(5);
    expect(bound.unitUpdatesOmitted?.lines).toBe(76 - 5);
    const bounded = bytes({ schemaVersion: "kogane-page-read-v1", data: bound });
    expect(bounded).toBeLessThan(CLIENT_BYTES);
    console.log(
      `overview summary at the realistic worst: ${size} bytes (full ${bytes(worst)}); at its bound: ${bounded} (full ${bytes(boundFull)})`,
    );
  });
});

/** One synthetic rule's revisions, newest first, as the Processor lists them (at most 20). */
function revisions(
  count: number,
  weekly: boolean,
): MaintenanceReadSource["rules"][number]["revisions"] {
  const reasons = [
    "official-notice-added",
    "official-notice-changed",
    "outage-observed",
    null,
  ] as const;
  return Array.from({ length: count }, (_, index) => ({
    revision: count - index,
    timezone: "Asia/Tokyo",
    pattern: weekly
      ? { kind: "weekly" as const, weekdays: [0, 1, 2, 3, 4, 5, 6], start: "23:30", end: "06:00" }
      : {
          kind: "monthly" as const,
          weekday: 2,
          nth: 3,
          offsetDays: 0,
          start: "21:00",
          end: "07:00",
        },
    enabled: index % 3 !== 2,
    scope: "collection" as const,
    referenceUrl: "https://maintenance.synthetic.test/notices/a-realistically-long-path/index.html",
    verifiedAt: instant(index * 1_440),
    createdAt: instant(index * 1_440 - 5),
    actorKind:
      index === count - 1 ? null : index % 2 === 0 ? ("delegated" as const) : ("operator" as const),
    changeReason: reasons[index % reasons.length]!,
    byCaller: index % 4 === 0,
  }));
}

/**
 * A full maintenance read with many sources and rules: `sourceCount` sources,
 * each with two armed jobs whose newest receipt failed with a closed code,
 * and `rulesPerSource` rules of 20 revisions each.
 */
function worstMaintenance(sourceCount: number, rulesPerSource: number): MaintenanceRead {
  const sources: MaintenanceReadSource[] = Array.from({ length: sourceCount }, (_, index) => {
    const source = `synthetic-source-${nn(index)}`;
    return {
      source,
      reference: {
        status: "confirmed",
        referenceUrl:
          "https://maintenance.synthetic.test/notices/a-realistically-long-path/index.html",
        verifiedAt: instant(index),
      },
      schedules: ["", "-session-keepalive"].map((suffix, job) => ({
        id: `${source}${suffix}`,
        source,
        kind: job === 0 ? ("collection" as const) : ("keepalive" as const),
        enabled: true,
        supported: true,
        timezone: "Asia/Tokyo",
        pattern: { kind: "daily" as const, time: "06:25", weekdays: [0, 1, 2, 3, 4, 5, 6] },
        revision: 12,
        nextNominalAt: instant(-600),
        nextRunAt: instant(-660),
        actualAlarmAt: instant(-660),
        reservation: "armed" as const,
        latest: {
          nominalAt: instant(840),
          startedAt: instant(839),
          finishedAt: instant(835),
          status: "failed" as const,
          failureCode: "collection_failed",
        },
      })),
      rules: Array.from({ length: rulesPerSource }, (_, rule) => ({
        id: `${source}-maintenance-window-${rule}`,
        revisions: revisions(20, rule % 2 === 0),
      })),
    };
  });
  return {
    sources,
    limits: { maxDeferralHours: 168, writesPerDay: 30, writesUsedToday: 29 },
  };
}

/** Every page of the maintenance summary, from offset 0. */
function maintenancePages(read: MaintenanceRead) {
  const pages = [];
  for (let offset: number | null = 0; offset !== null;) {
    const summary = maintenanceReadSummary(read, offset);
    pages.push(summary);
    offset = summary.coverage.nextOffset;
  }
  return pages;
}

describe("kogane.schedules.maintenance.read summary (ADR 0123, amendment 2026-11-19)", () => {
  it("pages the full read by source, on the tool and the agent route alike, each page under 8 KB", async () => {
    const full = await page.mcp("kogane.schedules.maintenance.read", { detail: "full" });
    expect(full.isError).toBe(false);
    expect(full.body).not.toHaveProperty("detail");
    const read = full.body as MaintenanceRead;
    const pages = [];
    for (let offset: number | null = 0; offset !== null;) {
      const args = offset === 0 ? {} : { offset };
      const tool = await page.mcp("kogane.schedules.maintenance.read", args);
      expect(tool.isError).toBe(false);
      expect(tool.body).toEqual(maintenanceReadSummary(read, offset));
      expect(await page.http("kogane.schedules.maintenance.read", args)).toEqual({
        status: 200,
        body: tool.body,
      });
      expect(bytes(tool.body)).toBeLessThan(CLIENT_BYTES);
      pages.push(tool.body);
      offset = tool.body.coverage.nextOffset;
    }
    // Every source in order (one whose lines continue is listed on both
    // pages), with every job and rule once; no closed code dropped.
    const sources = pages.flatMap((entry) => entry.sources);
    expect(
      sources
        .map((entry: { source: string }) => entry.source)
        .filter((source: string, index: number, all: string[]) => all[index - 1] !== source),
    ).toEqual(read.sources.map((entry) => entry.source));
    const jobs = sources.flatMap((entry: { schedules: unknown[] }) => entry.schedules) as {
      latest: { failureCode: string | null } | null;
    }[];
    expect(jobs).toHaveLength(read.sources.flatMap((entry) => entry.schedules).length);
    expect(jobs.some((job) => job.latest?.failureCode === "collection_failed")).toBe(true);
    expect(sources.flatMap((entry: { rules: unknown[] }) => entry.rules)).toHaveLength(
      read.sources.flatMap((entry) => entry.rules).length,
    );
    expect(pages[0].coverage).toMatchObject({
      sources: read.sources.length,
      limit: MAINTENANCE_SUMMARY_LINES,
      offset: 0,
    });
    console.log(
      `maintenance summary pages: ${pages.map((entry) => bytes(entry)).join(", ")} bytes; full: ${bytes(read)}`,
    );
  });

  it("keeps every page under 8 KB with many sources and rules, and with one crowded source", () => {
    const worst = worstMaintenance(30, 4);
    expect(bytes(worst)).toBeGreaterThan(100 * CLIENT_BYTES);
    const pages = maintenancePages(worst);
    for (const summary of pages) expect(bytes(summary)).toBeLessThan(CLIENT_BYTES);
    const sources = pages.flatMap((summary) => summary.sources);
    expect(new Set(sources.map((source) => source.source)).size).toBe(30);
    expect(sources.flatMap((source) => source.schedules)).toHaveLength(60);
    const rules = sources.flatMap((source) => source.rules);
    expect(rules).toHaveLength(120);
    // A rule's revisions collapse to their count and distinct closed codes.
    expect(rules[0]).toMatchObject({
      revision: 20,
      revisions: 20,
      actorKinds: ["delegated", "operator", null],
      changeReasons: ["official-notice-added", "official-notice-changed", "outage-observed", null],
      byCaller: 5,
    });
    // One source with more lines than a page holds continues on the next
    // page, listed again with its counts.
    const crowded = maintenancePages(worstMaintenance(1, 30));
    expect(crowded).toHaveLength(2);
    for (const summary of crowded) {
      expect(bytes(summary)).toBeLessThan(CLIENT_BYTES);
      expect(summary.sources).toMatchObject([{ scheduleCount: 2, ruleCount: 30 }]);
    }
    expect(crowded.flatMap((summary) => summary.sources[0]!.rules)).toHaveLength(30);
    console.log(
      `maintenance summary at many sources and rules: largest page ${Math.max(...pages.map((summary) => bytes(summary)))} bytes over ${pages.length} pages (full ${bytes(worst)}); one source with 30 rules: ${crowded.map((summary) => bytes(summary)).join(", ")} bytes`,
    );
  });
});
