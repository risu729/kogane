// The `GET /api/ops/v1/operations` contract (ADR 0086): exact keys, closed
// codes, the list's order (accepted time, then id, both descending), a page
// bound of 50, a cursor that is the last row's id, a `status` its
// `storedStatus` can read as (only a stored `running` request of a kind that
// derives `projected` may read `completed`), the filter basis named on the
// page, and rows whose kind and stored status agree with the filters the page
// asked for. Synthetic identifiers only.
import { describe, expect, test } from "bun:test";
import { validApiResponse } from "../src/api-validation.ts";
import {
  OPERATION_LIST_MAX_ROWS,
  OPERATION_LIST_PATH,
  OPERATION_PROJECTED_KINDS,
  OPERATION_RECORD_KINDS,
  OPERATION_RECORD_STATUSES,
  validOperationListPage,
  type OperationListPageWire,
  type OperationSummaryWire,
} from "../src/operation-contract.ts";

const id = (index: number) => `op_${index.toString(16).padStart(64, "0")}`;

const summary = (
  index: number,
  change: Partial<OperationSummaryWire> = {},
): OperationSummaryWire => ({
  operationId: id(index),
  kind: "collection",
  status: "running",
  storedStatus: "running",
  source: "synthetic-bank",
  dispatch: { state: "dispatched", attempts: 1 },
  failureCode: null,
  acceptedAt: `2026-09-11T00:${String(59 - index).padStart(2, "0")}:00.000Z`,
  updatedAt: "2026-09-11T01:00:00.000Z",
  ...change,
});

const page = (
  operations: OperationSummaryWire[],
  nextCursor: string | null = null,
): OperationListPageWire => ({
  schemaVersion: "kogane-operation-list-v2",
  statusFilterMatches: "storedStatus",
  operations,
  nextCursor,
});

describe("operation list contract", () => {
  test("accepts a page in the list's order, by its own path", () => {
    const value = page([summary(1), summary(2), summary(3)], id(3));
    expect(validOperationListPage(value)).toBe(true);
    expect(validApiResponse(OPERATION_LIST_PATH, value)).toBe(true);
    // The record path is another contract: a list page is no record.
    expect(validApiResponse(`${OPERATION_LIST_PATH}/${id(1)}`, value)).toBe(false);
  });

  test("accepts an empty last page and every closed kind and status", () => {
    expect(validOperationListPage(page([]))).toBe(true);
    const rows = OPERATION_RECORD_KINDS.flatMap((kind, k) =>
      OPERATION_RECORD_STATUSES.map((status, s) =>
        summary(k * OPERATION_RECORD_STATUSES.length + s, {
          kind,
          status,
          storedStatus: status,
          source: null,
        }),
      ),
    );
    expect(validOperationListPage(page(rows))).toBe(true);
  });

  test("rows that share an accepted time are ordered by id, descending", () => {
    const at = "2026-09-11T00:00:00Z";
    const higher = summary(9, { acceptedAt: at });
    const lower = summary(2, { acceptedAt: at });
    expect(validOperationListPage(page([higher, lower]))).toBe(true);
    expect(validOperationListPage(page([lower, higher]))).toBe(false);
    // A repeated row is out of order too.
    expect(validOperationListPage(page([higher, higher]))).toBe(false);
  });

  test("refuses rows out of the newest-first order", () => {
    expect(validOperationListPage(page([summary(3), summary(1)]))).toBe(false);
  });

  test("the cursor is the last row's id, or null", () => {
    const rows = [summary(1), summary(2)];
    expect(validOperationListPage(page(rows, id(2)))).toBe(true);
    expect(validOperationListPage(page(rows, id(1)))).toBe(false);
    expect(validOperationListPage(page(rows, id(7)))).toBe(false);
    expect(validOperationListPage(page([], id(1)))).toBe(false);
    expect(validOperationListPage(page(rows, "op_123"))).toBe(false);
  });

  test("refuses more rows than one page holds", () => {
    const rows = Array.from({ length: OPERATION_LIST_MAX_ROWS + 1 }, (_, index) =>
      summary(index, { acceptedAt: "2026-09-11T00:00:00Z", operationId: id(1000 - index) }),
    );
    expect(validOperationListPage(page(rows.slice(0, OPERATION_LIST_MAX_ROWS)))).toBe(true);
    expect(validOperationListPage(page(rows))).toBe(false);
  });

  test("refuses unknown keys, open vocabulary and the record's own fields", () => {
    const cases: unknown[] = [
      { ...page([summary(1)]), total: 1 },
      // v1's status was the stored one; a v1 page is another contract.
      { ...page([summary(1)]), schemaVersion: "kogane-operation-list-v1" },
      { ...page([summary(1)]), schemaVersion: "kogane-operation-list-v3" },
      // The filter basis is named on every page, and is only ever the stored status.
      (() => {
        const { statusFilterMatches: _, ...rest } = page([summary(1)]);
        return rest;
      })(),
      { ...page([summary(1)]), statusFilterMatches: "status" },
      // Each row carries the stored status beside the record's.
      page([
        (() => {
          const { storedStatus: _, ...rest } = summary(1);
          return rest as OperationSummaryWire;
        })(),
      ]),
      page([summary(1, { storedStatus: "done" as never })]),
      page([{ ...summary(1), principal: "operator" } as OperationSummaryWire]),
      page([{ ...summary(1), stages: [] } as OperationSummaryWire]),
      page([{ ...summary(1), targetRef: null } as OperationSummaryWire]),
      page([summary(1, { kind: "rebuild" as never })]),
      page([summary(1, { status: "done" as never, storedStatus: "done" as never })]),
      page([summary(1, { dispatch: { state: "queued" as never, attempts: 0 } })]),
      page([summary(1, { dispatch: { state: "dispatched", attempts: -1 } })]),
      page([summary(1, { failureCode: "Not A Code" })]),
      page([summary(1, { source: "Synthetic Bank" })]),
      page([summary(1, { acceptedAt: "yesterday" })]),
      page([summary(1, { operationId: "op_123" })]),
      {
        schemaVersion: "kogane-operation-list-v2",
        statusFilterMatches: "storedStatus",
        operations: {},
        nextCursor: null,
      },
    ];
    for (const value of cases) expect(validOperationListPage(value)).toBe(false);
  });

  test("a status differs from the stored one only as the record derives it", () => {
    // A stored running collection, import or replay reads completed once READ covers it.
    for (const kind of OPERATION_PROJECTED_KINDS)
      expect(
        validOperationListPage(page([summary(1, { kind, status: "completed" })]), {
          status: "running",
        }),
      ).toBe(true);
    // No other kind derives projected, and no other stored status moves.
    for (const kind of OPERATION_RECORD_KINDS.filter(
      (kind) => !OPERATION_PROJECTED_KINDS.includes(kind),
    ))
      expect(validOperationListPage(page([summary(1, { kind, status: "completed" })]))).toBe(false);
    for (const storedStatus of OPERATION_RECORD_STATUSES.filter((status) => status !== "running"))
      for (const status of OPERATION_RECORD_STATUSES.filter((status) => status !== storedStatus))
        expect(validOperationListPage(page([summary(1, { status, storedStatus })]))).toBe(false);
    // READ never turns a completed request back to running, nor running into anything but completed.
    for (const status of OPERATION_RECORD_STATUSES.filter(
      (status) => status !== "running" && status !== "completed",
    ))
      expect(validOperationListPage(page([summary(1, { status })]))).toBe(false);
  });

  test("the status filter is checked against the stored status the page says it matched", () => {
    const derived = summary(1, { status: "completed" });
    // Filtered as running, a row the record reads completed belongs on the page…
    expect(validOperationListPage(page([derived]), { status: "running" })).toBe(true);
    // …and not on a page filtered as completed, which matches the stored status.
    expect(validOperationListPage(page([derived]), { status: "completed" })).toBe(false);
    const stored = summary(2, { status: "completed", storedStatus: "completed" });
    expect(validOperationListPage(page([stored]), { status: "completed" })).toBe(true);
    expect(validOperationListPage(page([stored]), { status: "running" })).toBe(false);
  });

  test("with filters, every row is of the kind and stored status the page asked for", () => {
    const rows = [
      summary(1, {
        kind: "import",
        status: "failed",
        storedStatus: "failed",
        failureCode: "registration_blocked",
      }),
      summary(2, {
        kind: "import",
        status: "failed",
        storedStatus: "failed",
        failureCode: "registration_blocked",
      }),
    ];
    expect(validOperationListPage(page(rows), { kind: "import" })).toBe(true);
    expect(validOperationListPage(page(rows), { kind: "import", status: "failed" })).toBe(true);
    expect(validOperationListPage(page(rows), { kind: "replay" })).toBe(false);
    expect(validOperationListPage(page(rows), { status: "completed" })).toBe(false);
    const mixed = [
      rows[0]!,
      summary(2, { kind: "replay", status: "failed", storedStatus: "failed" }),
    ];
    expect(validOperationListPage(page(mixed), { status: "failed" })).toBe(true);
    expect(validOperationListPage(page(mixed), { kind: "import" })).toBe(false);
  });
});
