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
import { scheduleSnapshotSummary } from "../../../packages/collection/src/schedule-model";
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
    ["kogane.schedules.survey.read", {}],
    ["kogane.purchases.explain", {}],
  ];
}

describe("MCP read answer sizes (ADR 0123)", () => {
  it("measures every read tool's default answer, and keeps the three summaries under 8 KB", async () => {
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
    ])
      expect(sizes.get(call), call).toBeLessThan(CLIENT_BYTES);
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
      const full = await page.route(`${path}?detail=full&limit=25`);
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
        (await page.mcp("kogane.balances.read", { collection, detail: "full", limit: 25 })).body
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
    expect(first.body.data.page.limit).toBe(25);
    const summary = await page.mcp("kogane.balances.read", { collection: "latest", cursor });
    const full = await page.mcp("kogane.balances.read", {
      collection: "latest",
      cursor,
      detail: "full",
      limit: 25,
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
    expect(ids(wider.body.data.items).slice(0, 25)).toEqual(ids(summary.body.data.items));
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
