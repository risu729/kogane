// The wire check of `GET /api/collection-quality/<sourceId>/accounts`
// (ADR 0088): the shape it accepts and what it refuses. Synthetic values only.
import { describe, expect, test } from "bun:test";
import {
  validAccountCoverage,
  validCollectionQualityResponse,
} from "../src/collection-quality-contract.ts";

const period = {
  unitKey: "synthetic-unit",
  period: { kind: "statement-month", value: "209901", state: null },
  currentRule: "vpass-card-month",
  cellState: "current",
  standing: "current",
  capture: { fetchRunId: 7, capturedAt: "2099-01-01T00:00:00.000Z" },
  observations: 2,
  reasons: ["retention_not_assessed"],
  // 2099-01-01T00:00Z is 2099-01-01 in Tokyo; the answer's date is 2099-01-03.
  freshness: { state: "recent", ageDays: 2 },
};
const NONE = { state: "no-capture", ageDays: null };
/** A group's freshness belongs to its newest named capture. */
function freshest(periods: unknown[]): unknown {
  const entries = periods as (typeof period)[];
  return (
    [...entries].sort(
      (a, b) => Date.parse(b.capture.capturedAt) - Date.parse(a.capture.capturedAt),
    )[0]?.freshness ?? NONE
  );
}
const account = (accountId: string, periods: unknown[] = [period]) => ({
  accountId,
  label: "Synthetic account",
  statuses: ["identified"],
  dataTypes: [
    {
      dataset: "statement-page",
      parser: "vpass-statement-page",
      providerTypes: ["card_usage", "card_statement"],
      kind: "transaction",
      periods,
      freshness: freshest(periods),
    },
  ],
  freshness: freshest(periods),
});
const answer = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 3,
  dataTypesVersion: "provider-data-types-v1",
  dataTypes: [
    { type: "card_usage", status: "collected", parsers: ["vpass-statement-page"], issue: null },
    { type: "card_statement", status: "collected", parsers: ["vpass-statement-page"], issue: null },
  ],
  freshnessAsOf: {
    policy: "collection-freshness-v1",
    at: "2099-01-03T00:00:00.000Z",
    date: "2099-01-03",
  },
  sourceId: "vpass",
  latestFetchRun: { id: 7, succeeded: true, completedAt: "2099-01-01T00:00:00.000Z" },
  cells: 2,
  accounts: [account("synthetic-a")],
  unattributed: [
    {
      dataset: null,
      parser: null,
      unitKey: "synthetic-unit-b",
      period: { kind: "latest", value: null, state: null },
      currentRule: "published-eligible",
      state: "no-current",
      reasons: ["unit_without_artifacts", "no_current_capture"],
    },
  ],
  ...overrides,
});

describe("account coverage wire check", () => {
  test("accepts the shape, under the path of its own source only", () => {
    expect(validAccountCoverage(answer())).toBe(true);
    expect(validCollectionQualityResponse("/api/collection-quality/vpass/accounts", answer())).toBe(
      true,
    );
    expect(validCollectionQualityResponse("/api/collection-quality/myjcb/accounts", answer())).toBe(
      false,
    );
    // The cells route's path never accepts this shape.
    expect(validCollectionQualityResponse("/api/collection-quality/vpass", answer())).toBe(false);
  });

  test("refuses what the read never answers", () => {
    for (const bad of [
      answer({ apiVersion: 1 }),
      answer({ apiVersion: 2 }),
      answer({ dataTypesVersion: undefined }),
      answer({ dataTypesVersion: "unknown" }),
      answer({ dataTypes: undefined }),
      answer({ extra: true }),
      answer({ cells: 0 }),
      answer({ cells: 2_001 }),
      answer({ accounts: [account("synthetic-b"), account("synthetic-a")] }),
      answer({ accounts: [account("synthetic-a"), account("synthetic-a")] }),
      answer({ accounts: [account("synthetic-a", [])] }),
      answer({ accounts: [account("synthetic-a", [{ ...period, observations: 0 }])] }),
      answer({ accounts: [account("synthetic-a", [{ ...period, cellState: "older-current" }])] }),
      answer({ accounts: [account("synthetic-a", [{ ...period, standing: "unknown" }])] }),
      answer({ accounts: [account("synthetic-a", [{ ...period, reasons: ["not_a_reason"] }])] }),
      answer({ accounts: [{ ...account("synthetic-a"), statuses: [] }] }),
      answer({ accounts: [{ ...account("synthetic-a"), statuses: ["resolved"] }] }),
      // Freshness (ADR 0088's amendment of 2026-11-08).
      answer({ freshnessAsOf: undefined }),
      answer({
        freshnessAsOf: {
          policy: "collection-freshness-v1",
          at: "2099-01-03T00:00:00.000Z",
          date: "2099-01-02",
        },
      }),
      answer({ accounts: [account("synthetic-a", [{ ...period, freshness: undefined }])] }),
      answer({
        accounts: [
          account("synthetic-a", [{ ...period, freshness: { state: "recent", ageDays: 1 } }]),
        ],
      }),
      answer({
        accounts: [
          account("synthetic-a", [{ ...period, freshness: { state: "stale", ageDays: 2 } }]),
        ],
      }),
      answer({ accounts: [account("synthetic-a", [{ ...period, freshness: NONE }])] }),
      answer({ accounts: [{ ...account("synthetic-a"), freshness: NONE }] }),
      answer({
        accounts: [
          {
            ...account("synthetic-a"),
            dataTypes: [
              {
                ...account("synthetic-a").dataTypes[0]!,
                freshness: { state: "stale", ageDays: 5 },
              },
            ],
          },
        ],
      }),
    ])
      expect(validAccountCoverage(bad)).toBe(false);
  });

  test("a newest-not-current period may sit in a cell of any state", () => {
    for (const cellState of ["current", "older-current", "no-current"])
      expect(
        validAccountCoverage(
          answer({
            accounts: [
              account("synthetic-a", [{ ...period, cellState, standing: "newest-not-current" }]),
            ],
          }),
        ),
      ).toBe(true);
    // Standing does not erase the named capture's age.
    expect(
      validAccountCoverage(
        answer({
          accounts: [
            account("synthetic-a", [
              { ...period, standing: "newest-not-current", freshness: NONE },
            ]),
          ],
        }),
      ),
    ).toBe(false);
  });

  test("reverse parser membership is closed, distinct and self-contained", () => {
    const editType = (providerTypes: unknown) => {
      const value = answer();
      Object.assign(value.accounts[0]!.dataTypes[0]!, { providerTypes });
      return value;
    };
    for (const bad of [
      undefined,
      ["unknown"],
      ["card_usage", "card_usage"],
      [],
      ["card_usage"],
      ["balance"],
      ["card_statement", "card_usage"],
    ])
      expect(validAccountCoverage(editType(bad))).toBe(false);
    const unknown = answer({ dataTypes: null });
    Object.assign(unknown.accounts[0]!.dataTypes[0]!, {
      parser: "unknown-parser",
      providerTypes: [],
    });
    expect(validAccountCoverage(unknown)).toBe(true);
    expect(validAccountCoverage(answer({ dataTypes: null }))).toBe(false);
  });

  test("newest means capture instant, including wait state, even within one civil day", () => {
    const older = {
      ...period,
      capture: { fetchRunId: 6, capturedAt: "2099-01-01T00:00:00.000Z" },
      freshness: { state: "human-required", ageDays: 6 },
    };
    const newer = {
      ...period,
      capture: { fetchRunId: 7, capturedAt: "2099-01-01T01:00:00.000Z" },
      freshness: { state: "stale", ageDays: 6 },
    };
    const value = answer({
      freshnessAsOf: {
        policy: "collection-freshness-v1",
        at: "2099-01-07T00:00:00.000Z",
        date: "2099-01-07",
      },
      accounts: [account("synthetic-a", [older, newer])],
    });
    expect(validAccountCoverage(value)).toBe(true);
    value.accounts[0]!.freshness = older.freshness;
    expect(validAccountCoverage(value)).toBe(false);
  });

  test("a data type and an account carry their freshest period's age", () => {
    const older = {
      ...period,
      period: { kind: "statement-month", value: "209812", state: null },
      capture: { fetchRunId: 6, capturedAt: "2098-12-28T00:00:00.000Z" },
      cellState: "older-current",
      standing: "older-current",
      freshness: { state: "stale", ageDays: 6 },
    };
    const valid = answer({ accounts: [account("synthetic-a", [period, older])] });
    expect(validAccountCoverage(valid)).toBe(true);
    expect((valid.accounts as ReturnType<typeof account>[])[0]!.freshness).toEqual({
      state: "recent",
      ageDays: 2,
    });
    // The stalest period is not the group's age.
    const stalest = account("synthetic-a", [period, older]);
    stalest.dataTypes[0]!.freshness = older.freshness;
    expect(validAccountCoverage(answer({ accounts: [stalest] }))).toBe(false);
  });
});

// The summary detail (ADR 0123, amendment 2026-11-20): one line per account,
// then per unit of unattributed cells, paged by line.
const summary = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 3,
  detail: "summary",
  freshnessAsOf: answer().freshnessAsOf,
  dataTypesVersion: "provider-data-types-v1",
  dataTypes: { collected: ["card_usage", "card_statement"], partial: [], notCollected: [] },
  sourceId: "vpass",
  latestFetchRun: answer().latestFetchRun,
  cells: 2,
  accounts: [
    {
      accountId: "synthetic-a",
      label: "Synthetic account",
      statuses: ["identified"],
      freshness: period.freshness,
      kinds: ["transaction"],
      dataTypes: 1,
      providerTypes: ["card_usage", "card_statement"],
      periods: { count: 1, first: "209901", last: "209901" },
      standings: { current: 1, olderCurrent: 0, newestNotCurrent: 0 },
      cellStates: { current: 1, olderCurrent: 0, noCurrent: 0 },
      newestCapturedAt: period.capture.capturedAt,
      reasons: ["retention_not_assessed"],
    },
  ],
  unattributed: [
    {
      dataset: null,
      parser: null,
      unitKey: "synthetic-unit-b",
      cells: 1,
      periods: { first: null, last: null },
      current: 0,
      olderCurrent: 0,
      noCurrent: 1,
      reasons: ["unit_without_artifacts", "no_current_capture"],
    },
  ],
  coverage: {
    accounts: 1,
    unattributedCells: 1,
    lines: 2,
    limit: 20,
    offset: 0,
    truncated: false,
    nextOffset: null,
  },
  ...overrides,
});

describe("account coverage summary wire check", () => {
  test("each detail passes only where it was asked for, under its own source's path", () => {
    const path = "/api/collection-quality/vpass/accounts";
    expect(validCollectionQualityResponse(path, summary())).toBe(true);
    expect(validCollectionQualityResponse(path, summary(), "summary")).toBe(true);
    expect(validCollectionQualityResponse(path, summary(), "full")).toBe(false);
    expect(validCollectionQualityResponse(path, answer(), "full")).toBe(true);
    expect(validCollectionQualityResponse(path, answer(), "summary")).toBe(false);
    expect(
      validCollectionQualityResponse("/api/collection-quality/myjcb/accounts", summary()),
    ).toBe(false);
    // The cell route's summary path never takes it.
    expect(validCollectionQualityResponse("/api/collection-quality/vpass", summary())).toBe(false);
  });

  test("refuses a page that miscounts or mispages", () => {
    const path = "/api/collection-quality/vpass/accounts";
    const base = summary();
    for (const bad of [
      summary({ coverage: { ...base.coverage, lines: 3 } }),
      summary({ coverage: { ...base.coverage, truncated: true, nextOffset: 2 } }),
      summary({ coverage: { ...base.coverage, accounts: 2 } }),
      summary({ unattributed: [{ ...base.unattributed[0]!, cells: 2 }] }),
      summary({
        dataTypes: { collected: ["card_usage"], partial: ["card_usage"], notCollected: [] },
      }),
      summary({
        accounts: [{ ...base.accounts[0]!, periods: { count: 2, first: null, last: null } }],
      }),
      summary({ accounts: [{ ...base.accounts[0]!, freshness: { state: "stale", ageDays: 9 } }] }),
      summary({ detail: "full" }),
    ])
      expect(validCollectionQualityResponse(path, bad, "summary")).toBe(false);
  });
});
