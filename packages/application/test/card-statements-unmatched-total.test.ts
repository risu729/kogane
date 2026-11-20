// A statement total that is not exact on the page of statements without a
// candidate (`reviewUnmatchedCardStatements`, docs/card-settlements.md,
// Statements without a candidate; ADR 0074, amendment 2026-11-19): it keeps its
// decimal-v1 status and reason, never null or zero (INV05), and still takes
// the code the sweep counts it under, with no window read. A row CORE 0024's
// CHECK never stores fails the read. The statement page is answered from
// rows shaped as `UNMATCHED_STATEMENTS_SQL` returns them; any other read
// fails the test. Every value is invented.
import { expect, test } from "bun:test";
import { validUnmatchedCardStatementsReview } from "../../observation-shared/src/card-statements-unmatched-contract.ts";
import type { Grant } from "../src/grants.ts";
import {
  reviewUnmatchedCardStatements,
  UNMATCHED_STATEMENTS_SQL,
} from "../src/query/card-statements-unmatched.ts";

const WHOLE: Grant = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};

/** One statement row as the page read returns it. */
const statementRow = (overrides: Record<string, unknown>) => ({
  id: 1,
  parse_run_id: 1,
  source_id: "myjcb",
  source_account: "myjcb:synthetic:root",
  unit_ref: "JPY",
  value_status: "exact",
  coefficient: "3000",
  scale: 0,
  // No due date: an exact total reads no window either.
  payment_date: null,
  as_of: null,
  period: "2098-01",
  statement_key: "synthetic-statement",
  account_id: null,
  owner_ref: null,
  evidence_refs_json: null,
  ...overrides,
});

async function pageOf(row: Record<string, unknown>) {
  return await reviewUnmatchedCardStatements({
    grant: WHOLE,
    request: { offset: 0 },
    sql: {
      all: async <T>(sql: string) => {
        if (sql !== UNMATCHED_STATEMENTS_SQL) throw new Error("unexpected read");
        return [row] as unknown as T[];
      },
      first: () => Promise.reject(new Error("unexpected read")),
    },
  });
}

test("a statement total that is not exact keeps its status and reason, never null or zero (INV05)", async () => {
  const cases: [Record<string, unknown>, unknown][] = [
    [
      statementRow({}),
      {
        unitRef: "JPY",
        value: {
          status: "exact",
          value: { coefficient: "3000", scale: 0 },
          normalizationVersion: "exact-arith-v1",
        },
      },
    ],
    ...(["missing", "unparsed", "conflict"] as const).map(
      (status): [Record<string, unknown>, unknown] => [
        statementRow({
          value_status: status,
          coefficient: null,
          scale: null,
          payment_date: "2098-01-10",
        }),
        { unitRef: "JPY", value: { status, reasonCode: `stored:${status}` } },
      ],
    ),
    // No decimal-v1 value recorded for the observation: the view's LEFT JOIN is null.
    [
      statementRow({
        value_status: null,
        coefficient: null,
        scale: null,
        payment_date: "2098-01-10",
      }),
      { unitRef: "JPY", value: { status: "missing", reasonCode: "decimal_not_projected" } },
    ],
  ];
  for (const [row, amount] of cases) {
    const outcome = await pageOf(row);
    if (!outcome.ok) throw new Error(outcome.error.code);
    const [item] = outcome.review.items;
    expect(item?.statement.amount).toEqual(amount as never);
    // The sweep cannot compare it: the same code, and no window was read.
    expect(item).toMatchObject({
      code: "statement_not_comparable",
      debitsInWindow: null,
      planner: null,
    });
    const wire: unknown = JSON.parse(JSON.stringify(outcome.review));
    expect(validUnmatchedCardStatementsReview(wire)).toBe(true);
  }
});

test("an exact total without its decimal-v1 columns, or an unknown status, fails the read", async () => {
  // CORE 0024's CHECK refuses each; a read that met one would show a value nobody stored.
  for (const row of [
    statementRow({ coefficient: null }),
    statementRow({ scale: null }),
    statementRow({ value_status: "estimated", coefficient: null, scale: null }),
  ])
    await expect(pageOf(row)).rejects.toThrow("card_statements_unmatched_row_invalid");
});
