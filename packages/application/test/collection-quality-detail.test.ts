// The `summary` detail of the collection quality reads (ADR 0123) over the
// synthetic CORE store of packages/read-model: a line collapses sources or
// cells, never a code. Every state, reason and closed code of what a line
// collapses is on that line, and every cell is counted once. Every key, run
// id, unit and time is invented; no amount or provider text is written.
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_SUMMARY_BYTES,
  ACCOUNT_SUMMARY_LINE_PAGE,
  type AccountCoverage,
  type AccountCoverageSummary,
  CELL_REASONS,
  COLLECTION_QUALITY_LINE_PAGE,
  COLLECTION_QUALITY_SUMMARY_BYTES,
  type CollectionQualityCellSummary,
  type CollectionQualitySummary,
  type CollectionQualitySummaryLines,
  OBSERVATION_KINDS,
  pageReadAnswerBytes,
  validCollectionQualityResponse,
  type CollectionQualityCell,
  type CollectionQualityCells,
} from "../../observation-shared/src/collection-quality-contract.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { QualityStore } from "../../read-model/test/collection-quality-fixture.ts";
import {
  CollectionQualityLimitError,
  queryCollectionQualityCells,
  queryCollectionQualitySummary,
} from "../src/query/collection-quality.ts";
import {
  accountCoverageSummary,
  collectionQualityCellSummary,
  collectionQualitySummaryLines,
} from "../src/query/collection-quality-detail.ts";
import { REALISTIC_ACCOUNT_SCALE, syntheticAccountCoverage } from "./account-coverage-scale.ts";

/** Every age is counted to this instant (collection-freshness-v1); after every synthetic capture. */
const AS_OF = "2099-03-01T00:00:00.000Z";
function executor(store: QualityStore): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}
const nonNull = (values: readonly (string | null)[]) =>
  values.filter((value): value is string => value !== null);

describe("the summary's lines", () => {
  test("keep each source's reasons, its jobs' receipt codes and its terminals' codes", async () => {
    const store = new QualityStore();
    const vpassRun = store.run({
      source: "vpass",
      at: "2099-01-02T00:00:00Z",
      artifacts: [{ key: "evidence.json", dataset: null }],
    }).run;
    store.occurrence("vpass", {
      nominalAt: "2099-01-02T21:00:00.000Z",
      status: "failed",
      failureCode: "human_required",
      runIds: ["run-a", "run-b", "run-c"],
    });
    store.terminal({ source: "vpass", runId: "run-a", outcome: "success", fetchRun: vpassRun });
    store.terminal({
      source: "vpass",
      runId: "run-b",
      outcome: "failed",
      coverage: "partial",
      blockedCode: "registration_refused",
      providerFailureCode: "login_rejected",
    });
    store.occurrence("vpoint", {
      nominalAt: "2099-01-02T21:15:00.000Z",
      status: "completed",
      runIds: ["run-v"],
    });
    store.terminal({
      source: "v-point",
      runId: "run-v",
      outcome: "success",
      stage: { state: "retryable", failureCode: "operation_budget" },
    });
    const full = await queryCollectionQualitySummary(executor(store), { asOf: AS_OF });
    const summary = collectionQualitySummaryLines(full);
    expect(validCollectionQualityResponse("/api/collection-quality", summary, "summary")).toBe(
      true,
    );
    // A page that asked for the full summary does not take the lines for it.
    expect(validCollectionQualityResponse("/api/collection-quality", summary, "full")).toBe(false);
    expect(validCollectionQualityResponse("/api/collection-quality", full, "summary")).toBe(false);
    // Every source is on exactly one line, and that line says what its full entry says.
    expect(summary.sources.flatMap((line) => line.sourceIds).sort()).toEqual(
      full.sources.map((source) => source.sourceId).sort(),
    );
    for (const source of full.sources) {
      const line = summary.sources.find((entry) => entry.sourceIds.includes(source.sourceId))!;
      expect(line.reasons, source.sourceId).toEqual(source.reasons);
      expect(line.unregistered).toBe(source.unregistered.length);
      for (const entry of source.unregistered)
        for (const code of nonNull([entry.blockedCode, entry.failureCode]))
          expect(line.unregisteredCodes, source.sourceId).toContain(code);
      expect(line.schedules.map((job) => job.id)).toEqual(source.schedules.map((job) => job.id));
      for (const [index, job] of source.schedules.entries()) {
        const latest = line.schedules[index]!.latest;
        if (job.latest === null) {
          expect(latest).toBeNull();
          continue;
        }
        expect(latest).toMatchObject({
          status: job.latest.status,
          failureCode: job.latest.failureCode,
        });
        for (const terminal of job.latest.terminals)
          for (const code of nonNull([terminal.blockedCode, terminal.failureCode]))
            expect(latest!.terminalCodes, job.id).toContain(code);
      }
      if (source.dataTypes !== null)
        expect(
          line.dataTypes!.collected + line.dataTypes!.partial + line.dataTypes!.notCollected,
        ).toBe(source.dataTypes.length);
    }
    const vpass = summary.sources.find((line) => line.sourceIds.includes("vpass"))!;
    expect(vpass.sourceIds).toEqual(["vpass"]);
    expect(vpass.schedules[0]!.latest).toEqual({
      nominalAt: "2099-01-02T21:00:00.000Z",
      status: "failed",
      failureCode: "human_required",
      terminalCodes: ["registration_refused", "login_rejected"],
    });
    expect(vpass.unregisteredCodes).toEqual(["registration_refused", "login_rejected"]);
    const vpoint = summary.sources.find((line) => line.sourceIds.includes("v-point"))!;
    expect(vpoint.schedules[0]!.latest!.terminalCodes).toEqual(["operation_budget"]);
  });

  test("collapse a source's cells over periods with every state, reason and code", async () => {
    const s = new QualityStore();
    const month = (value: string) => ({
      key: `activity-${value}.html`,
      dataset: "globalpass-activity",
    });
    const first = s.run({
      source: "global-pass",
      at: "2099-02-01T00:00:00Z",
      artifacts: [month("2099-01"), month("2098-12")],
    });
    for (const artifact of first.artifacts)
      s.parse(artifact, "global-pass-activity", { kind: "published" });
    const second = s.run({
      source: "global-pass",
      at: "2099-02-02T00:00:00Z",
      artifacts: [month("2099-01"), month("2098-12"), month("2098-11")],
    });
    s.parse(second.artifacts[0]!, "global-pass-activity", {
      kind: "published",
      claim: { completeness: "partial", cause: "page_missing" },
    });
    s.parse(second.artifacts[1]!, "global-pass-activity", { kind: "pending" });
    s.parse(second.artifacts[2]!, "global-pass-activity", {
      kind: "failed",
      code: "parser_rejected",
    });
    const page = (await queryCollectionQualityCells(executor(s), {
      sourceId: "global-pass",
      offset: 0,
      asOf: AS_OF,
    }))!;
    const cells: CollectionQualityCell[] = page.cells;
    expect(cells).toHaveLength(3);
    const summary = collectionQualityCellSummary([page], 0);
    expect(
      validCollectionQualityResponse("/api/collection-quality/global-pass", summary, "summary"),
    ).toBe(true);
    expect(
      validCollectionQualityResponse("/api/collection-quality/global-pass", summary, "full"),
    ).toBe(false);
    expect(
      validCollectionQualityResponse("/api/collection-quality/global-pass", page, "summary"),
    ).toBe(false);
    expect(summary.coverage).toMatchObject({ cells: 3, lines: 1, truncated: false });
    const [line] = summary.lines;
    expect(line).toMatchObject({
      dataset: "globalpass-activity",
      parser: "global-pass-activity",
      cells: 3,
      current: 1,
      olderCurrent: 1,
      noCurrent: 1,
      periods: { first: "2098-11", last: "2099-01" },
      failureCodes: ["parser_rejected"],
      coverageCauses: ["page_missing"],
    });
    for (const cell of cells) {
      for (const reason of cell.reasons) expect(line!.reasons).toContain(reason);
      for (const code of nonNull([cell.newest.unitFailureCode, ...cell.newest.failureCodes]))
        expect(line!.failureCodes).toContain(code);
      for (const cause of cell.newest.coverageCauses) expect(line!.coverageCauses).toContain(cause);
    }
  });

  test("keep a failed unit's closed code", async () => {
    const s = new QualityStore();
    s.run({
      source: "vpass",
      at: "2099-02-01T00:00:00Z",
      outcome: "partial",
      artifacts: [],
      units: {
        "synthetic-card-a": { outcome: "failed", code: "stated_total_mismatch" },
        "synthetic-card-b": { outcome: "human_required", code: "human_required_reauth" },
      },
    });
    const page = (await queryCollectionQualityCells(executor(s), {
      sourceId: "vpass",
      offset: 0,
      asOf: AS_OF,
    }))!;
    const summary = collectionQualityCellSummary([page], 0);
    const codes = Object.fromEntries(
      summary.lines.map((line) => [line.unitKey, line.failureCodes]),
    );
    for (const cell of page.cells)
      expect(codes[cell.unitKey!]).toEqual(nonNull([cell.newest.unitFailureCode]));
    expect(codes["synthetic-card-a"]).toEqual(["stated_total_mismatch"]);
  });
});

// ── The account view's summary (ADR 0123, amendment 2026-11-20) ──

const ACCOUNTS_PATH = "/api/collection-quality/synthetic-source/accounts";

/** Every page of the account view's summary, from offset 0, each checked against the wire contract. */
function summaryPages(full: AccountCoverage): AccountCoverageSummary[] {
  const pages: AccountCoverageSummary[] = [];
  for (let offset = 0; ;) {
    const page = accountCoverageSummary(full, offset);
    expect(validCollectionQualityResponse(ACCOUNTS_PATH, page, "summary")).toBe(true);
    expect(validCollectionQualityResponse(ACCOUNTS_PATH, page, "full")).toBe(false);
    expect(validCollectionQualityResponse(ACCOUNTS_PATH, page)).toBe(true);
    expect(pageReadAnswerBytes(page)).toBeLessThanOrEqual(ACCOUNT_SUMMARY_BYTES);
    expect(page.coverage.offset).toBe(offset);
    pages.push(page);
    if (page.coverage.nextOffset === null) break;
    expect(page.coverage.nextOffset).toBe(offset + page.accounts.length + page.unattributed.length);
    offset = page.coverage.nextOffset;
  }
  return pages;
}

const counted = <T>(values: readonly T[], value: T) =>
  values.filter((entry) => entry === value).length;

/** The pages list every account and unattributed cell once, each line saying what its full entries say. */
function expectCollapsed(full: AccountCoverage, pages: readonly AccountCoverageSummary[]): void {
  const accounts = pages.flatMap((page) => page.accounts);
  expect(accounts.map((line) => line.accountId)).toEqual(
    full.accounts.map((account) => account.accountId),
  );
  for (const [index, account] of full.accounts.entries()) {
    const line = accounts[index]!;
    const periods = account.dataTypes.flatMap((type) => type.periods);
    const named = nonNull(periods.map((entry) => entry.period.value)).sort();
    const standings = periods.map((entry) => entry.standing);
    const states = periods.map((entry) => entry.cellState);
    expect(line).toEqual({
      accountId: account.accountId,
      label: account.label,
      statuses: account.statuses,
      freshness: account.freshness,
      kinds: OBSERVATION_KINDS.filter((kind) =>
        account.dataTypes.some((type) => type.kind === kind),
      ),
      dataTypes: account.dataTypes.length,
      providerTypes: expect.any(Array),
      periods: { count: periods.length, first: named[0] ?? null, last: named.at(-1) ?? null },
      standings: {
        current: counted(standings, "current"),
        olderCurrent: counted(standings, "older-current"),
        newestNotCurrent: counted(standings, "newest-not-current"),
      },
      cellStates: {
        current: counted(states, "current"),
        olderCurrent: counted(states, "older-current"),
        noCurrent: counted(states, "no-current"),
      },
      newestCapturedAt: expect.any(String),
      reasons: expect.any(Array),
    });
    // Every reason and provider type of what the line collapses, once.
    expect([...line.reasons].sort()).toEqual(
      [...new Set(periods.flatMap((entry) => entry.reasons))].sort(),
    );
    expect([...line.providerTypes].sort()).toEqual(
      [...new Set(account.dataTypes.flatMap((type) => type.providerTypes))].sort(),
    );
    expect(Date.parse(line.newestCapturedAt)).toBe(
      Math.max(...periods.map((entry) => Date.parse(entry.capture.capturedAt))),
    );
  }
  const apart = pages.flatMap((page) => page.unattributed);
  expect(apart.reduce((sum, line) => sum + line.cells, 0)).toBe(full.unattributed.length);
  for (const cell of full.unattributed) {
    const line = apart.find(
      (entry) =>
        entry.dataset === cell.dataset &&
        entry.parser === cell.parser &&
        entry.unitKey === cell.unitKey,
    )!;
    for (const reason of cell.reasons) expect(line.reasons).toContain(reason);
  }
  for (const line of apart)
    expect(line.current + line.olderCurrent + line.noCurrent).toBe(line.cells);
  for (const page of pages)
    expect(page.coverage).toMatchObject({
      accounts: full.accounts.length,
      unattributedCells: full.unattributed.length,
      lines: full.accounts.length + apart.length,
      limit: ACCOUNT_SUMMARY_LINE_PAGE,
    });
}

describe("the account view's summary", () => {
  test("pages a source with 62 accounts under 8 KB, every account and cell counted once", () => {
    const full = syntheticAccountCoverage(REALISTIC_ACCOUNT_SCALE);
    expect(validCollectionQualityResponse(ACCOUNTS_PATH, full, "full")).toBe(true);
    expect(validCollectionQualityResponse(ACCOUNTS_PATH, full, "summary")).toBe(false);
    expect(full.cells).toBe(2_000);
    const pages = summaryPages(full);
    expectCollapsed(full, pages);
    expect(pages[0]!.coverage.lines).toBe(62 + 28);
    // The measurement, for the amendment's table.
    console.log(
      `account summary, realistic worst: full ${pageReadAnswerBytes(full)} bytes; pages ${pages
        .map(
          (page) =>
            `${pageReadAnswerBytes(page)} (${page.accounts.length + page.unattributed.length} lines)`,
        )
        .join(", ")}`,
    );
    expect(pageReadAnswerBytes(full)).toBeGreaterThan(100 * ACCOUNT_SUMMARY_BYTES);
    // The catalogue keeps every type under its status, without parsers or issues.
    const typed = (status: string) =>
      full.dataTypes!.filter((entry) => entry.status === status).map((entry) => entry.type);
    expect(pages[0]!.dataTypes).toEqual({
      collected: typed("collected"),
      partial: typed("partial"),
      notCollected: typed("not_collected"),
    });
  });

  test("holds every page to 8 KB when every line carries every code and a long label", () => {
    const full = syntheticAccountCoverage({
      ...REALISTIC_ACCOUNT_SCALE,
      accounts: 25,
      typesPerAccount: 4,
      periodsPerType: 12,
      statuses: 4,
      kinds: 4,
      labelChars: 200,
      providerTypesPerParser: 12,
      reasons: [...CELL_REASONS],
      unattributedReasons: [...CELL_REASONS],
    });
    expect(validCollectionQualityResponse(ACCOUNTS_PATH, full, "full")).toBe(true);
    const pages = summaryPages(full);
    expectCollapsed(full, pages);
    // The bytes, not the line limit, end these pages.
    for (const page of pages.slice(0, -1)) {
      const listed = page.accounts.length + page.unattributed.length;
      expect(listed).toBeGreaterThan(0);
      expect(listed).toBeLessThan(ACCOUNT_SUMMARY_LINE_PAGE);
    }
    console.log(
      `account summary, every code and 200-character labels: ${pages
        .map(
          (page) =>
            `${pageReadAnswerBytes(page)} (${page.accounts.length + page.unattributed.length} lines)`,
        )
        .join(", ")}`,
    );
  });

  test("holds a page of short lines to its line limit, and answers an offset past the end empty", () => {
    // An unattributed line with no reason is about 250 bytes, so 20 fit; an
    // account line (a 64-hex id) is about 470 bytes at least, so the bytes
    // end a page of accounts first.
    const full = syntheticAccountCoverage({
      ...REALISTIC_ACCOUNT_SCALE,
      accounts: 0,
      unattributed: { units: 45, datasets: 1, periods: 1 },
      unattributedReasons: [],
    });
    const pages = summaryPages(full);
    expect(pages.map((page) => page.unattributed.length)).toEqual([20, 20, 5]);
    expectCollapsed(full, pages);
    const past = accountCoverageSummary(full, 200);
    expect(validCollectionQualityResponse(ACCOUNTS_PATH, past, "summary")).toBe(true);
    expect(past).toMatchObject({
      accounts: [],
      unattributed: [],
      coverage: { lines: 45, offset: 200, truncated: false, nextOffset: null },
    });
  });

  test("keeps an uncataloged source's data types null, and a source with no account as its cells", () => {
    const full = {
      ...syntheticAccountCoverage({ ...REALISTIC_ACCOUNT_SCALE, accounts: 0 }),
      dataTypes: null,
    } as AccountCoverage;
    expect(validCollectionQualityResponse(ACCOUNTS_PATH, full, "full")).toBe(true);
    const pages = summaryPages(full);
    expect(pages[0]!.dataTypes).toBeNull();
    expect(pages.flatMap((page) => page.accounts)).toEqual([]);
    expectCollapsed(full, pages);
    // Seven units of four datasets: 28 lines over two pages, 140 cells.
    expect(pages.flatMap((page) => page.unattributed)).toHaveLength(28);
    expect(pages.map((page) => page.unattributed.length)).toEqual([20, 8]);
    expect(pages[0]!.coverage).toMatchObject({ accounts: 0, unattributedCells: 140, lines: 28 });
  });

  test("refuses a page whose one line cannot fit, never cutting it", () => {
    const long = "長".repeat(512);
    const full = syntheticAccountCoverage({
      ...REALISTIC_ACCOUNT_SCALE,
      accounts: 0,
      unattributed: { units: 1, datasets: 1, periods: 2 },
    });
    full.unattributed = full.unattributed.map((cell, index) => ({
      ...cell,
      dataset: long,
      parser: long,
      unitKey: long,
      period: { ...cell.period, value: `${long.slice(1)}${String(index)}` },
    }));
    expect(validCollectionQualityResponse(ACCOUNTS_PATH, full, "full")).toBe(true);
    expect(() => accountCoverageSummary(full, 0)).toThrow(CollectionQualityLimitError);
  });

  test("fails the wire check when a page miscounts, misorders, mispages or passes 8 KB", () => {
    const page = accountCoverageSummary(syntheticAccountCoverage(REALISTIC_ACCOUNT_SCALE), 0);
    const passes = (change: (value: AccountCoverageSummary) => void) => {
      const value = structuredClone(page);
      change(value);
      return validCollectionQualityResponse(ACCOUNTS_PATH, value, "summary");
    };
    expect(passes(() => {})).toBe(true);
    expect(passes((value) => (value.accounts[0]!.standings.current += 1))).toBe(false);
    expect(passes((value) => (value.accounts[0]!.cellStates.noCurrent += 1))).toBe(false);
    expect(passes((value) => value.accounts.reverse())).toBe(false);
    expect(passes((value) => (value.coverage.nextOffset! += 1))).toBe(false);
    expect(passes((value) => (value.coverage.truncated = false))).toBe(false);
    expect(passes((value) => value.accounts.pop())).toBe(false);
    expect(passes((value) => (value.accounts[0]!.freshness.ageDays! += 1))).toBe(false);
    expect(passes((value) => (value.accounts[0]!.label = "テ".repeat(500)))).toBe(false);
    expect(passes((value) => (value.accounts[0]!.reasons = ["not_a_reason" as never]))).toBe(false);
    expect(passes((value) => (value.coverage.limit = 10 as never))).toBe(false);
    // An unattributed line on a page that has not listed every account it holds.
    expect(
      passes((value) => {
        value.accounts.pop();
        value.unattributed.push({
          dataset: null,
          parser: null,
          unitKey: null,
          cells: 1,
          periods: { first: null, last: null },
          current: 0,
          olderCurrent: 0,
          noCurrent: 1,
          reasons: [],
        });
      }),
    ).toBe(false);
  });
});

describe("the account view's summary over random sources", () => {
  test("walks every page of each to the full answer's lines, once each, in order", () => {
    // A fixed seed, so a failure names the same source on every run.
    let seed = 20_261_120;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff) / 0x7f_ff_ff_ff;
    const below = (n: number) => Math.floor(random() * n);
    const some = <T>(values: readonly T[]) => values.filter(() => random() < 0.3);
    // Multi-byte, four-byte and JSON-escaped characters, so bytes differ from characters.
    const letters = ["a", "テ", "長", "😀", '"', "\\", "\u0001", "\n", " "];
    const text = (max: number) =>
      Array.from({ length: below(max) }, () => letters[below(letters.length)]!)
        .join("")
        .slice(0, max);
    for (let source = 0; source < 150; source++) {
      const full = syntheticAccountCoverage({
        ...REALISTIC_ACCOUNT_SCALE,
        accounts: below(30),
        typesPerAccount: 1 + below(3),
        periodsPerType: 1 + below(5),
        statuses: 1 + below(4),
        kinds: 1 + below(4),
        providerTypesPerParser: 1 + below(12),
        unattributed: { units: below(8), datasets: 1 + below(3), periods: 1 + below(4) },
      });
      for (const account of full.accounts) {
        account.label = text(random() < 0.1 ? 512 : 60);
        for (const type of account.dataTypes)
          for (const entry of type.periods) {
            entry.reasons = some(CELL_REASONS);
            if (random() < 0.2) entry.period = { kind: "latest", value: null, state: null };
          }
      }
      for (const cell of full.unattributed) {
        if (random() < 0.2) cell.dataset = null;
        if (random() < 0.3) cell.unitKey = text(40) || null;
        cell.reasons = some(CELL_REASONS);
      }
      expect(validCollectionQualityResponse(ACCOUNTS_PATH, full, "full"), String(source)).toBe(
        true,
      );
      const pages = summaryPages(full);
      expectCollapsed(full, pages);
      const lines = pages.flatMap((page) => [...page.accounts, ...page.unattributed]);
      const units = new Set(
        full.unattributed.map((cell) => JSON.stringify([cell.dataset, cell.parser, cell.unitKey])),
      );
      expect(lines, String(source)).toHaveLength(full.accounts.length + units.size);
      // A page from any offset lists the lines the walk from 0 has there.
      const offset = below(lines.length + 1);
      const page = accountCoverageSummary(full, offset);
      expect([...page.accounts, ...page.unattributed], String(source)).toEqual(
        lines.slice(offset, offset + page.accounts.length + page.unattributed.length),
      );
    }
  }, 60_000);
});

// ── Every summary page held to 8 KB (ADR 0123, amendment 2026-11-21) ──

const SUMMARY_PATH = "/api/collection-quality";
const CELLS_PATH = "/api/collection-quality/global-pass";

/** The full summary of a store whose Vpass job failed with its terminals' closed codes. */
async function failingSummary(): Promise<CollectionQualitySummary> {
  const store = new QualityStore();
  const run = store.run({
    source: "vpass",
    at: "2099-01-02T00:00:00Z",
    artifacts: [{ key: "evidence.json", dataset: null }],
  }).run;
  store.occurrence("vpass", {
    nominalAt: "2099-01-02T21:00:00.000Z",
    status: "failed",
    failureCode: "human_required",
    runIds: ["run-a", "run-b"],
  });
  store.terminal({ source: "vpass", runId: "run-a", outcome: "success", fetchRun: run });
  store.terminal({
    source: "vpass",
    runId: "run-b",
    outcome: "failed",
    coverage: "partial",
    blockedCode: "registration_refused",
    providerFailureCode: "login_rejected",
  });
  return queryCollectionQualitySummary(executor(store), { asOf: AS_OF });
}

/**
 * `sources` sources shaped like the failing Vpass one, each with `jobs` jobs
 * that failed with their own closed codes and its own newest fetch run, so no
 * two lines are equal and none is shared: every source with a collector
 * failing at once, the moment an agent asks which sources are failing.
 */
function crowdedSummary(
  base: CollectionQualitySummary,
  sources: number,
  jobs: number,
): CollectionQualitySummary {
  const template = base.sources.find((source) => source.sourceId === "vpass")!;
  const job = template.schedules[0]!;
  return {
    ...base,
    sources: Array.from({ length: sources }, (_, index) => {
      const sourceId = `synthetic-source-${String(index).padStart(2, "0")}`;
      return {
        ...structuredClone(template),
        sourceId,
        latestFetchRun: { ...template.latestFetchRun!, id: 10_000 + index },
        schedules: Array.from({ length: jobs }, (_, at) => ({
          ...structuredClone(job),
          id: `${sourceId}-job-${at}`,
          latest: {
            ...structuredClone(job.latest!),
            failureCode: `synthetic_failure_${index}`,
            terminals: job.latest!.terminals.map((terminal) => ({
              ...terminal,
              blockedCode: terminal.blockedCode && `synthetic_blocked_code_${index}_${at}`,
              failureCode: terminal.failureCode && `synthetic_provider_failure_${index}_${at}`,
            })),
          },
        })),
      };
    }),
  };
}

/** Every page of the summary's source lines from offset 0, each checked against the wire contract. */
function sourcePages(full: CollectionQualitySummary): CollectionQualitySummaryLines[] {
  const pages: CollectionQualitySummaryLines[] = [];
  for (let offset = 0; ;) {
    const page = collectionQualitySummaryLines(full, offset);
    expect(validCollectionQualityResponse(SUMMARY_PATH, page, "summary")).toBe(true);
    expect(validCollectionQualityResponse(SUMMARY_PATH, page, "full")).toBe(false);
    expect(pageReadAnswerBytes(page)).toBeLessThanOrEqual(COLLECTION_QUALITY_SUMMARY_BYTES);
    expect(page.coverage.offset).toBe(offset);
    expect(page.otherSchedules).toHaveLength(full.otherSchedules.length);
    pages.push(page);
    if (page.coverage.nextOffset === null) break;
    expect(page.coverage.nextOffset).toBe(offset + page.sources.length);
    offset = page.coverage.nextOffset;
  }
  return pages;
}

/** Every page of a source's cell summary from offset 0, each checked against the wire contract. */
function cellPages(cells: CollectionQualityCells): CollectionQualityCellSummary[] {
  const pages: CollectionQualityCellSummary[] = [];
  for (let offset = 0; ;) {
    const page = collectionQualityCellSummary([cells], offset);
    expect(validCollectionQualityResponse(CELLS_PATH, page, "summary")).toBe(true);
    expect(pageReadAnswerBytes(page)).toBeLessThanOrEqual(COLLECTION_QUALITY_SUMMARY_BYTES);
    pages.push(page);
    if (page.coverage.nextOffset === null) break;
    expect(page.coverage.nextOffset).toBe(offset + page.lines.length);
    offset = page.coverage.nextOffset;
  }
  return pages;
}

/** Global Pass's three cells, each with every reason, cloned into `units` units of `datasets` datasets. */
async function crowdedCells(
  units: number,
  datasets: number,
  name: (unit: number, dataset: number) => string,
): Promise<CollectionQualityCells> {
  const s = new QualityStore();
  const run = s.run({
    source: "global-pass",
    at: "2099-02-01T00:00:00Z",
    artifacts: [{ key: "activity-2099-01.html", dataset: "globalpass-activity" }],
  });
  s.parse(run.artifacts[0]!, "global-pass-activity", { kind: "failed", code: "parser_rejected" });
  const page = (await queryCollectionQualityCells(executor(s), {
    sourceId: "global-pass",
    offset: 0,
    asOf: AS_OF,
  }))!;
  const template = page.cells[0]!;
  const cells: CollectionQualityCell[] = [];
  for (let unit = 0; unit < units; unit++)
    for (let dataset = 0; dataset < datasets; dataset++)
      cells.push({
        ...structuredClone(template),
        dataset: name(unit, dataset),
        unitKey: `synthetic-unit-${unit}`,
        reasons: [...CELL_REASONS],
      });
  return { ...page, cells };
}

describe("the summary's source lines, paged under 8 KB", () => {
  test("page every source with a failing collector, once each and in order, each page within 8 KB", async () => {
    const base = await failingSummary();
    // Today's registry (37 sources), every one with two failing jobs.
    const full = crowdedSummary(base, base.sources.length, 2);
    const pages = sourcePages(full);
    // Unpaged, as the summary answered before this amendment, it passes what a client shows.
    const { coverage: _coverage, ...head } = pages[0]!;
    const everyLine = { ...head, sources: pages.flatMap((page) => page.sources) };
    expect(pageReadAnswerBytes(everyLine)).toBeGreaterThan(4 * COLLECTION_QUALITY_SUMMARY_BYTES);
    console.log(
      `source summary, ${full.sources.length} failing sources: unpaged ${pageReadAnswerBytes(everyLine)} bytes; pages ${pages
        .map((page) => `${pageReadAnswerBytes(page)} (${page.sources.length} lines)`)
        .join(", ")}`,
    );
    expect(pages.length).toBeGreaterThan(2);
    // The bytes, not the line limit, end every page but the last.
    for (const page of pages.slice(0, -1))
      expect(page.sources.length).toBeLessThan(COLLECTION_QUALITY_LINE_PAGE);
    const lines = pages.flatMap((page) => page.sources);
    expect(lines.flatMap((line) => line.sourceIds)).toEqual(
      full.sources.map((source) => source.sourceId),
    );
    for (const [index, source] of full.sources.entries()) {
      const line = lines[index]!;
      expect(line.reasons).toEqual(source.reasons);
      expect(line.schedules.map((entry) => entry.id)).toEqual(
        source.schedules.map((entry) => entry.id),
      );
      for (const [at, job] of source.schedules.entries())
        expect(line.schedules[at]!.latest).toEqual({
          nominalAt: job.latest!.nominalAt,
          status: job.latest!.status,
          failureCode: job.latest!.failureCode,
          terminalCodes: nonNull(
            job.latest!.terminals.flatMap((terminal) => [
              terminal.blockedCode,
              terminal.failureCode,
            ]),
          ),
        });
    }
    for (const page of pages)
      expect(page.coverage).toMatchObject({
        sources: full.sources.length,
        lines: full.sources.length,
        limit: COLLECTION_QUALITY_LINE_PAGE,
      });
    // A page from any offset lists the lines the walk from 0 has there.
    for (const offset of [1, 7, lines.length - 1]) {
      const page = collectionQualitySummaryLines(full, offset);
      expect(page.sources).toEqual(lines.slice(offset, offset + page.sources.length));
    }
  });

  test("keep today's synthetic summary on one page, and share equal lines as before", async () => {
    const full = await failingSummary();
    const [page, ...rest] = sourcePages(full);
    expect(rest).toEqual([]);
    expect(page!.coverage).toEqual({
      sources: full.sources.length,
      lines: page!.sources.length,
      limit: COLLECTION_QUALITY_LINE_PAGE,
      offset: 0,
      truncated: false,
      nextOffset: null,
    });
    // Sources no collector serves still share one line.
    expect(page!.sources.length).toBeLessThan(full.sources.length);
  });

  test("answer an offset past the last line as an empty last page", async () => {
    const full = await failingSummary();
    const lines = collectionQualitySummaryLines(full).coverage.lines;
    const page = collectionQualitySummaryLines(full, lines + 5);
    expect(page.sources).toEqual([]);
    expect(page.coverage).toMatchObject({ offset: lines + 5, truncated: false, nextOffset: null });
    expect(validCollectionQualityResponse(SUMMARY_PATH, page, "summary")).toBe(true);
  });

  test("refuse a page whose jobs under no source alone pass 8 KB, never cutting it", async () => {
    const base = await failingSummary();
    const job = base.sources.find((source) => source.sourceId === "vpass")!.schedules[0]!;
    const full = {
      ...base,
      otherSchedules: Array.from({ length: 60 }, (_, index) => ({
        ...structuredClone(job),
        id: `synthetic-processor-job-${index}`,
      })),
    };
    expect(() => collectionQualitySummaryLines(full, 0)).toThrow(CollectionQualityLimitError);
  });

  test("fail the wire check when a page passes 8 KB, mispages or names a source twice", async () => {
    const base = await failingSummary();
    const full = crowdedSummary(base, base.sources.length, 2);
    const [first, second] = sourcePages(full);
    const valid = (value: unknown) =>
      validCollectionQualityResponse(SUMMARY_PATH, value, "summary");
    expect(valid(first)).toBe(true);
    // Every line on one page: under the line limit's 20 but over 8 KB.
    const crowded = collectionQualitySummaryLines(crowdedSummary(base, 20, 2), 0);
    const all = Array.from({ length: 20 }, (_, index) =>
      collectionQualitySummaryLines(crowdedSummary(base, 20, 2), index),
    ).map((page) => page.sources[0]!);
    expect(
      valid({
        ...crowded,
        sources: all,
        coverage: { ...crowded.coverage, truncated: false, nextOffset: null },
      }),
    ).toBe(false);
    expect(valid({ ...first, coverage: { ...first!.coverage, nextOffset: 99 } })).toBe(false);
    expect(
      valid({ ...first, coverage: { ...first!.coverage, truncated: false, nextOffset: null } }),
    ).toBe(false);
    expect(valid({ ...first, sources: [...first!.sources.slice(0, -1), first!.sources[0]!] })).toBe(
      false,
    );
    expect(valid({ ...second, coverage: { ...second!.coverage, offset: 0 } })).toBe(false);
    const { coverage: _coverage, ...unpaged } = first!;
    expect(valid(unpaged)).toBe(false);
  });
});

describe("a source's cell summary, paged under 8 KB", () => {
  test("ends each page before the line that would pass 8 KB, every line once and in order", async () => {
    // Twelve units of four datasets, each line with every reason and an 80-character dataset.
    const cells = await crowdedCells(12, 4, (unit, dataset) =>
      `synthetic-dataset-${unit}-${dataset}-`.padEnd(80, "x"),
    );
    const pages = cellPages(cells);
    const lines = pages.flatMap((page) => page.lines);
    // At 20 lines a page, as before, the first page passed what a client shows.
    const twenty = { ...pages[0]!, lines: lines.slice(0, COLLECTION_QUALITY_LINE_PAGE) };
    console.log(
      `cell summary, 48 lines with every reason: 20 lines ${pageReadAnswerBytes(twenty)} bytes; pages ${pages
        .map((page) => `${pageReadAnswerBytes(page)} (${page.lines.length} lines)`)
        .join(", ")}`,
    );
    expect(lines).toHaveLength(48);
    expect(lines.map((line) => line.dataset)).toEqual(cells.cells.map((cell) => cell.dataset));
    for (const line of lines) expect(line.reasons).toEqual([...CELL_REASONS]);
    expect(pages[0]!.lines.length).toBeLessThan(COLLECTION_QUALITY_LINE_PAGE);
    expect(pageReadAnswerBytes(twenty)).toBeGreaterThan(COLLECTION_QUALITY_SUMMARY_BYTES);
    expect(validCollectionQualityResponse(CELLS_PATH, twenty, "summary")).toBe(false);
  });

  test("keeps short lines to the line limit", async () => {
    const cells = await crowdedCells(10, 3, (unit, dataset) => `d-${unit}-${dataset}`);
    for (const cell of cells.cells) cell.reasons = [];
    const pages = cellPages(cells);
    expect(pages.map((page) => page.lines.length)).toEqual([20, 10]);
  });

  test("refuses a page whose one line cannot fit, never cutting it", async () => {
    const cells = await crowdedCells(1, 1, () => "長".repeat(512));
    for (const cell of cells.cells) {
      cell.unitKey = "テ".repeat(512);
      cell.parser = "😀".repeat(256);
      cell.period = { ...cell.period, value: "長".repeat(512) };
    }
    expect(() => collectionQualityCellSummary([cells], 0)).toThrow(CollectionQualityLimitError);
  });
});
