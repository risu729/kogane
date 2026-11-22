// The `summary` detail of the v1 grouped balance list (`GET /api/balances`,
// `kogane.observations.list {kind: "balances"}`; ADR 0123, amendment of
// 2026-11-20), on synthetic rows: latest and history taken in turn, accounts
// and metrics named once per page, every id and closed code kept, a value
// that is not exact kept as its status, each list's next offset, and a page
// under its byte budget however long the names on it are.
import { expect, test } from "bun:test";
import { BalanceListSummaryLimitError, balanceListSummary } from "../src/query/read-detail.ts";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import {
  BALANCE_LIST_SUMMARY_BYTES,
  BALANCE_LIST_SUMMARY_LINES,
  type BalanceListPage,
  type BalanceListSummaryPage,
} from "../../observation-shared/src/api-contract.ts";

const PATH = "/api/balances";
/** What the owner's client shows of a tool result (#1414). */
const CLIENT_BYTES = 8 * 1024;
/** The tool result a client receives: the page read envelope around the route's body. */
const toolBytes = (data: unknown) =>
  new TextEncoder().encode(JSON.stringify({ schemaVersion: "kogane-page-read-v1", data })).length;

const CONTEXT = {
  mode: "latest",
  snapshotId: null,
  identityRelease: "identity-synthetic-1",
  productCatalogueRelease: "catalogue-synthetic-1",
  productResolverRelease: "resolver-synthetic-1",
  measurePolicyRelease: "measure-synthetic-1",
  decimalPolicyRelease: "decimal-v1",
};

interface RowOptions {
  source?: string;
  account?: string;
  label?: string | null;
  metric?: string;
  value?: string | null;
  evidence?: number[];
  conflict?: boolean;
  kind?: "asset" | "liability";
}

/** One v1 balance row as the central store lists it: organized, interpreted, with its stored decimal. */
function row(id: number, options: RowOptions = {}) {
  const value = options.value === undefined ? "125000" : options.value;
  const label = options.label === undefined ? "合成普通預金口座" : options.label;
  const evidence = options.evidence ?? [id];
  return {
    id,
    source_id: options.source ?? "synthetic-source",
    source_account: options.account ?? "synthetic-account",
    metric: options.metric ?? "synthetic_balance",
    instrument: "JPY",
    amount_minor: value,
    amount_text: value === null ? "－" : `${value}円`,
    as_of: "2026-01-31",
    observed_at: null,
    parser: "synthetic-parser@1",
    normalized:
      value === null
        ? {
            policyVersion: "decimal-v1",
            status: "unparsed",
            coefficient: null,
            scale: null,
            basis: "none",
          }
        : {
            policyVersion: "decimal-v1",
            status: "exact",
            coefficient: value,
            scale: 0,
            basis: "minor_units",
          },
    organization:
      label === null
        ? { state: "unavailable", lineage: null, account: null, instruments: [] }
        : {
            state: "organized",
            lineage: "current",
            account: {
              referenceId: `ref-${options.account ?? "synthetic-account"}`,
              targetId: `acc_${"ab".repeat(32)}`,
              label,
              status: "provider-local",
              revision: 1,
              method: "rule",
              reason: "provider-scope",
            },
            instruments: [],
          },
    interpretation: {
      policyVersion: "financial-measures-v2",
      semantic: {
        kind: options.kind ?? "asset",
        label: "合成残高",
        netAssetEligible: false,
        reason: "A synthetic reason text that the summary leaves to the full answer.",
        measurementKind: "balance",
        assetClass: "cash",
        timeBasis: "reported_snapshot",
      },
      evidence: evidence.map((member) => ({
        id: member,
        metric: options.metric ?? "synthetic_balance",
      })),
      duplicateCount: evidence.length - 1,
      conflict: options.conflict ?? false,
    },
  };
}

function historyRow(
  id: number,
  parse: { superseded_by_parse_run_id: number | null; parse_status: string },
  options: RowOptions = {},
) {
  return { ...row(id, options), ...parse };
}

const OK = { superseded_by_parse_run_id: null, parse_status: "ok" };

function list(
  latest: ReturnType<typeof row>[],
  history: ReturnType<typeof historyRow>[],
  coverage: Partial<BalanceListPage["coverage"]> = {},
): BalanceListPage {
  return {
    latest,
    history,
    interpretationContext: CONTEXT,
    coverage: {
      limit: 500,
      truncated: false,
      nextOffset: null,
      latestNextOffset: null,
      ...coverage,
    },
  } as unknown as BalanceListPage;
}

test("takes latest and history in turn, naming each account and metric once across both", () => {
  const full = list(
    [
      row(1, { evidence: [1, 9] }),
      row(2, { metric: "利用可能額", value: null, conflict: true }),
      row(3, { account: "synthetic-card", label: null, kind: "liability" }),
    ],
    [
      historyRow(1, OK),
      historyRow(9, { superseded_by_parse_run_id: 40, parse_status: "ok" }),
      historyRow(11, { superseded_by_parse_run_id: null, parse_status: "error" }, { value: null }),
    ],
  );
  expect(validApiResponse(PATH, full, "full")).toBe(true);
  const summary = balanceListSummary(full, { offset: 0, latestOffset: 0 });
  expect(summary).toEqual({
    detail: "summary",
    accounts: [
      {
        ref: "a1",
        source: "synthetic-source",
        sourceAccount: "synthetic-account",
        account: `acc_${"ab".repeat(32)}`,
        label: "合成普通預金口座",
        status: "provider-local",
        lineage: "current",
      },
      {
        ref: "a2",
        source: "synthetic-source",
        sourceAccount: "synthetic-card",
        account: null,
        label: null,
        status: null,
        lineage: null,
      },
    ],
    metrics: [
      {
        ref: "m1",
        source: "synthetic-source",
        providerMetric: "synthetic_balance",
        kind: "asset",
        measurementKind: "balance",
        assetClass: "cash",
        timeBasis: "reported_snapshot",
      },
      {
        ref: "m2",
        source: "synthetic-source",
        providerMetric: "利用可能額",
        kind: "asset",
        measurementKind: "balance",
        assetClass: "cash",
        timeBasis: "reported_snapshot",
      },
      {
        ref: "m3",
        source: "synthetic-source",
        providerMetric: "synthetic_balance",
        kind: "liability",
        measurementKind: "balance",
        assetClass: "cash",
        timeBasis: "reported_snapshot",
      },
    ],
    latest: [
      {
        observationId: 1,
        account: "a1",
        metric: "m1",
        amount: { value: "125000", unit: "JPY", status: "exact", scale: 0 },
        asOf: "2026-01-31",
        duplicates: [9],
        reasons: [],
      },
      {
        observationId: 2,
        account: "a1",
        metric: "m2",
        amount: { value: null, unit: "JPY", status: "unparsed", scale: null },
        asOf: "2026-01-31",
        duplicates: [],
        reasons: ["interpretation:conflict"],
      },
      {
        observationId: 3,
        account: "a2",
        metric: "m3",
        amount: { value: "125000", unit: "JPY", status: "exact", scale: 0 },
        asOf: "2026-01-31",
        duplicates: [],
        reasons: [],
      },
    ],
    history: [
      {
        observationId: 1,
        account: "a1",
        metric: "m1",
        amount: { value: "125000", unit: "JPY", status: "exact", scale: 0 },
        asOf: "2026-01-31",
        reasons: [],
      },
      {
        observationId: 9,
        account: "a1",
        metric: "m1",
        amount: { value: "125000", unit: "JPY", status: "exact", scale: 0 },
        asOf: "2026-01-31",
        reasons: ["parse:superseded"],
      },
      {
        observationId: 11,
        account: "a1",
        metric: "m1",
        amount: { value: null, unit: "JPY", status: "unparsed", scale: null },
        asOf: "2026-01-31",
        reasons: ["parse:error"],
      },
    ],
    coverage: {
      limit: BALANCE_LIST_SUMMARY_LINES,
      truncated: false,
      nextOffset: null,
      latestNextOffset: null,
      next: null,
    },
  } satisfies BalanceListSummaryPage);
  // No text of the interpretation, no provider amount text, no release.
  const text = JSON.stringify(summary);
  for (const dropped of ["合成残高", "synthetic reason", "－", "円", "catalogue-synthetic-1"])
    expect(text).not.toContain(dropped);
  // Each shape passes under its own detail only.
  expect(validApiResponse(PATH, summary)).toBe(true);
  expect(validApiResponse(PATH, summary, "summary")).toBe(true);
  expect(validApiResponse(PATH, summary, "full")).toBe(false);
  expect(validApiResponse(PATH, full, "summary")).toBe(false);
});

test("continues each list where its lines stop, and past the full window", () => {
  const latest = Array.from({ length: 14 }, (_, index) => row(100 + index));
  const history = Array.from({ length: 4 }, (_, index) => historyRow(200 + index, OK));
  const first = balanceListSummary(list(latest, history), { offset: 0, latestOffset: 0 });
  expect(first.latest.map((line) => line.observationId)).toEqual(
    latest.slice(0, BALANCE_LIST_SUMMARY_LINES).map((entry) => entry.id),
  );
  expect(first.history).toHaveLength(4);
  expect(first.coverage).toEqual({
    limit: BALANCE_LIST_SUMMARY_LINES,
    truncated: true,
    nextOffset: null,
    latestNextOffset: BALANCE_LIST_SUMMARY_LINES,
    // History has ended: the next page passes it at its end, never at 0.
    next: { offset: 4, latestOffset: BALANCE_LIST_SUMMARY_LINES },
  });
  const second = balanceListSummary(list(latest.slice(BALANCE_LIST_SUMMARY_LINES), []), {
    offset: 4,
    latestOffset: BALANCE_LIST_SUMMARY_LINES,
  });
  expect(second.latest.map((line) => line.observationId)).toEqual(
    latest.slice(BALANCE_LIST_SUMMARY_LINES).map((entry) => entry.id),
  );
  expect(second.history).toEqual([]);
  expect(second.coverage).toMatchObject({ truncated: false, next: null });
  // A window the full answer cut at 500 continues past it, at the line count.
  const cut = balanceListSummary(
    list(latest.slice(0, 3), history.slice(0, 2), {
      truncated: true,
      nextOffset: 1_000,
      latestNextOffset: 1_000,
    }),
    { offset: 500, latestOffset: 500 },
  );
  expect(cut.coverage).toEqual({
    limit: BALANCE_LIST_SUMMARY_LINES,
    truncated: true,
    nextOffset: 502,
    latestNextOffset: 503,
    next: { offset: 502, latestOffset: 503 },
  });
  // An empty list is an empty page, not a refusal.
  expect(balanceListSummary(list([], []), { offset: 0, latestOffset: 0 })).toEqual({
    detail: "summary",
    accounts: [],
    metrics: [],
    latest: [],
    history: [],
    coverage: {
      limit: BALANCE_LIST_SUMMARY_LINES,
      truncated: false,
      nextOffset: null,
      latestNextOffset: null,
      next: null,
    },
  });
});

test("stops before its byte budget on a page whose every line names a long account and metric", () => {
  // The realistic worst: every line its own account (a 64-hex entity, a
  // 64-character Japanese label, a long provider key) and its own long
  // provider metric, every value exact and long, every reason set. Lines are
  // dropped from the end, never cut, and each list continues where it stops.
  const long = (index: number): RowOptions => ({
    source: "synthetic-source-with-a-long-identifier",
    account: `synthetic-provider-account-with-a-long-key-${String(index).padStart(6, "0")}`,
    label: `合成普通預金口座（本店営業部・支店番号${String(index).padStart(3, "0")}）`.padEnd(
      64,
      "合",
    ),
    metric: `合成お支払い予定額（リボ払い・分割払い・ボーナス払い）_synthetic_metric_${index}`,
    value: "123456789012345678",
  });
  const latest = Array.from({ length: 500 }, (_, index) =>
    row(10_000_000 + index, { ...long(index), conflict: true }),
  );
  const history = Array.from({ length: 500 }, (_, index) =>
    historyRow(
      20_000_000 + index,
      { superseded_by_parse_run_id: 1, parse_status: "pending" },
      long(1_000 + index),
    ),
  );
  const full = list(latest, history, {
    truncated: true,
    nextOffset: 1_500,
    latestNextOffset: 1_500,
  });
  const summary = balanceListSummary(full, { offset: 1_000, latestOffset: 1_000 });
  expect(validApiResponse(PATH, summary, "summary")).toBe(true);
  const size = new TextEncoder().encode(JSON.stringify(summary)).length;
  expect(size).toBeLessThanOrEqual(BALANCE_LIST_SUMMARY_BYTES);
  expect(toolBytes(summary)).toBeLessThan(CLIENT_BYTES);
  // It holds fewer lines than the cap, in turn, and every one it holds names its own entries.
  const lines = summary.latest.length + summary.history.length;
  expect(lines).toBeGreaterThan(2);
  expect(lines).toBeLessThan(2 * BALANCE_LIST_SUMMARY_LINES);
  expect(summary.latest.length - summary.history.length).toBeGreaterThanOrEqual(0);
  expect(summary.latest.length - summary.history.length).toBeLessThanOrEqual(1);
  expect(summary.accounts).toHaveLength(lines);
  expect(summary.metrics).toHaveLength(lines);
  expect(summary.coverage).toEqual({
    limit: BALANCE_LIST_SUMMARY_LINES,
    truncated: true,
    nextOffset: 1_000 + summary.history.length,
    latestNextOffset: 1_000 + summary.latest.length,
    next: {
      offset: 1_000 + summary.history.length,
      latestOffset: 1_000 + summary.latest.length,
    },
  });
  // Paged through by `next` alone, the window's every id is read exactly once, in order.
  const seen = { latest: [] as number[], history: [] as number[] };
  let at: { offset: number; latestOffset: number } | null = { offset: 0, latestOffset: 0 };
  for (let pages = 0; at !== null && pages < 1_000; pages++) {
    const page = balanceListSummary(
      list(full.latest.slice(at.latestOffset) as never, full.history.slice(at.offset) as never),
      at,
    );
    expect(toolBytes(page)).toBeLessThan(CLIENT_BYTES);
    seen.latest.push(...page.latest.map((line) => line.observationId));
    seen.history.push(...page.history.map((line) => line.observationId));
    at = page.coverage.next;
  }
  expect(at).toBeNull();
  expect(seen.latest).toEqual(full.latest.map((entry) => entry.id));
  expect(seen.history).toEqual(full.history.map((entry) => entry.id));
});

test("refuses a row it cannot state, never guessing a value, a reason or a code", () => {
  const at = { offset: 0, latestOffset: 0 };
  const { normalized: _normalized, ...undecimal } = row(1);
  expect(() => balanceListSummary(list([undecimal as never], []), at)).toThrow(
    "balance_list_decimal_missing",
  );
  const { interpretation: _interpretation, ...uninterpreted } = row(1);
  expect(() => balanceListSummary(list([uninterpreted as never], []), at)).toThrow(
    "balance_list_interpretation_missing",
  );
  expect(() =>
    balanceListSummary(
      list([], [historyRow(1, { superseded_by_parse_run_id: null, parse_status: "queued" })]),
      at,
    ),
  ).toThrow("balance_history_parse_status_unknown");
});

test("the validator refuses a summary that drops a ref, folds its own id or miscounts its coverage", () => {
  const summary = balanceListSummary(
    list([row(1, { evidence: [1, 9] }), row(2, { metric: "利用可能額" })], [historyRow(1, OK)]),
    { offset: 0, latestOffset: 0 },
  );
  expect(validApiResponse(PATH, summary, "summary")).toBe(true);
  const broken: unknown[] = [
    { ...summary, accounts: [] },
    { ...summary, metrics: summary.metrics.slice(1) },
    { ...summary, metrics: [...summary.metrics, { ...summary.metrics[0]!, ref: "m9" }] },
    { ...summary, latest: [{ ...summary.latest[0]!, duplicates: [1] }] },
    { ...summary, latest: [{ ...summary.latest[0]!, duplicates: [9, 10] }] },
    { ...summary, latest: [{ ...summary.latest[0]!, reasons: ["interpretation:conflict"] }] },
    { ...summary, latest: [{ ...summary.latest[1]!, reasons: ["adoption:value_not_exact"] }] },
    { ...summary, history: [{ ...summary.history[0]!, reasons: ["parse:queued"] }] },
    { ...summary, coverage: { ...summary.coverage, truncated: true } },
    { ...summary, coverage: { ...summary.coverage, limit: 500 } },
    {
      ...summary,
      latest: Array.from({ length: BALANCE_LIST_SUMMARY_LINES + 1 }, () => summary.latest[1]!),
    },
    { ...summary, metrics: summary.metrics.map((metric) => ({ ...metric, kind: "net_worth" })) },
    {
      ...summary,
      latest: [
        {
          ...summary.latest[0]!,
          amount: { value: "0", unit: "JPY", status: "unparsed", scale: 0 },
        },
        summary.latest[1]!,
      ],
    },
    // `next` is there exactly while a list has more, and agrees with each list's own offset.
    (({ next: _next, ...coverage }) => ({ ...summary, coverage }))(summary.coverage),
    { ...summary, coverage: { ...summary.coverage, next: { offset: 1, latestOffset: 2 } } },
    {
      ...summary,
      coverage: {
        ...summary.coverage,
        truncated: true,
        nextOffset: 1,
        latestNextOffset: null,
        next: null,
      },
    },
    {
      ...summary,
      coverage: {
        ...summary.coverage,
        truncated: true,
        nextOffset: 1,
        latestNextOffset: 2,
        next: { offset: 1, latestOffset: 3 },
      },
    },
    {
      ...summary,
      coverage: {
        ...summary.coverage,
        truncated: true,
        nextOffset: 1,
        latestNextOffset: null,
        next: { offset: 2, latestOffset: 2 },
      },
    },
  ];
  for (const value of broken) expect(validApiResponse(PATH, value, "summary")).toBe(false);
});

/** An account label `characters` long, all three-byte characters. */
const longLabel = (id: number, characters: number): RowOptions => ({
  account: `synthetic-account-${id}`,
  label: "合".repeat(characters),
});
const named = (id: number, characters: number) => row(id, longLabel(id, characters));

test("refuses a page whose first line alone passes its byte budget, never answering past it", () => {
  const at = { offset: 0, latestOffset: 0 };
  // One line whose own account label is over the budget: refused, not answered over 8 KB.
  expect(() => balanceListSummary(list([named(1, 2_600)], []), at)).toThrow(
    BalanceListSummaryLimitError,
  );
  expect(() => balanceListSummary(list([], [historyRow(1, OK, longLabel(1, 2_600))]), at)).toThrow(
    BalanceListSummaryLimitError,
  );
  // The largest first line that fits is answered, at or under the budget.
  let fits = 0;
  for (let characters = 2_300; characters < 2_600; characters++) {
    try {
      const page = balanceListSummary(list([named(1, characters)], []), at);
      expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(
        BALANCE_LIST_SUMMARY_BYTES,
      );
      expect(toolBytes(page)).toBeLessThan(CLIENT_BYTES);
      fits = characters;
    } catch (error) {
      expect(error).toBeInstanceOf(BalanceListSummaryLimitError);
      break;
    }
  }
  expect(fits).toBeGreaterThan(2_300);
  // A later line that does not fit ends the page before it; the next page,
  // where it is first, is the one refused.
  const latest = [row(1), named(2, 2_600)];
  const first = balanceListSummary(list(latest, []), at);
  expect(first.latest.map((line) => line.observationId)).toEqual([1]);
  expect(first.coverage.next).toEqual({ offset: 0, latestOffset: 1 });
  expect(() => balanceListSummary(list(latest.slice(1), []), first.coverage.next!)).toThrow(
    BalanceListSummaryLimitError,
  );
});

test("following `next` alone reads every row of both lists once, as `full` lists them (fuzzed)", () => {
  let seed = 20_261_120;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const integer = (below: number) => Math.floor(random() * below);
  for (let round = 0; round < 300; round++) {
    // A store's two lists, sometimes past the route's 500-row window, with
    // names from short to long, so pages are cut by the line cap, by the
    // byte budget, or by the end of either list.
    const length = () => (random() < 0.1 ? 480 + integer(80) : integer(40));
    const options = (index: number): RowOptions => ({
      account: `synthetic-account-${integer(6)}`,
      label: random() < 0.2 ? null : "合".repeat(1 + integer(random() < 0.2 ? 400 : 20)),
      metric: `synthetic_metric_${integer(4)}_${"m".repeat(integer(random() < 0.2 ? 300 : 10))}`,
      value: random() < 0.1 ? null : String(1 + index),
      conflict: random() < 0.1,
    });
    const store = {
      latest: Array.from({ length: length() }, (_, index) =>
        row(1_000_000 + index, options(index)),
      ),
      history: Array.from({ length: length() }, (_, index) =>
        historyRow(
          2_000_000 + index,
          pick(random, [OK, OK, { superseded_by_parse_run_id: 7, parse_status: "error" }]),
          options(index),
        ),
      ),
    };
    // The route's full answer at these offsets: 500 rows a list.
    const route = (at: { offset: number; latestOffset: number }) =>
      list(
        store.latest.slice(at.latestOffset, at.latestOffset + 500),
        store.history.slice(at.offset, at.offset + 500),
        {
          limit: 500,
          truncated:
            store.latest.length > at.latestOffset + 500 || store.history.length > at.offset + 500,
          nextOffset: store.history.length > at.offset + 500 ? at.offset + 500 : null,
          latestNextOffset:
            store.latest.length > at.latestOffset + 500 ? at.latestOffset + 500 : null,
        },
      );
    const seen = { latest: [] as number[], history: [] as number[] };
    let at: { offset: number; latestOffset: number } | null = { offset: 0, latestOffset: 0 };
    let pages = 0;
    for (; at !== null; pages++) {
      expect(pages).toBeLessThan(500);
      const page = balanceListSummary(route(at), at);
      expect(validApiResponse(PATH, page, "summary")).toBe(true);
      expect(toolBytes(page)).toBeLessThan(CLIENT_BYTES);
      // Every page that has a row left answers at least one line.
      if (page.coverage.next !== null)
        expect(page.latest.length + page.history.length).toBeGreaterThan(0);
      seen.latest.push(...page.latest.map((line) => line.observationId));
      seen.history.push(...page.history.map((line) => line.observationId));
      at = page.coverage.next;
    }
    expect(seen.latest).toEqual(store.latest.map((entry) => entry.id));
    expect(seen.history).toEqual(store.history.map((entry) => entry.id));
  }
}, 60_000);

function pick<T>(random: () => number, choices: readonly T[]): T {
  return choices[Math.floor(random() * choices.length)]!;
}
