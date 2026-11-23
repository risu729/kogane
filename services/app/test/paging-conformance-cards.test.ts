// The paging conformance walk (ADR 0128) over the カード照合 reads: the
// review list, the list grouped by statement and the statements without a
// candidate, each over `/mcp`, continuing only by merging `next.arguments`
// into the last call until `next` is null. Each walk lists every seeded item
// once and its pages carry `next` and `paging` that say what their deprecated
// `nextOffset` and `nextPage` say. Every row is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { walkPages } from "../../../packages/observation-shared/test-support/paging-walk";
import {
  validCardSettlementReviewPage,
  validCardSettlementStatementPage,
} from "../../../packages/observation-shared/src/card-settlement-contract";
import { validUnmatchedCardStatementsReview } from "../../../packages/observation-shared/src/card-statements-unmatched-contract";
import { seedCandidates } from "./card-settlements-differential-store";
import { publishParse, seedRun } from "./fixtures";
import { pageReadHarness } from "./page-read-harness";

const page = pageReadHarness("paging-conformance-cards");

/** Candidates, each of its own statement: two review pages, six grouped pages. */
const CANDIDATES = 55;
/** Statement totals no candidate cites: two pages of 50. */
const UNMATCHED = 51;
const candidateIds: string[] = [];
const statementKeys: string[] = [];
const unmatchedAccounts: string[] = [];

async function overMcp(tool: string, args: Record<string, unknown>) {
  const answer = await page.mcp(tool, args);
  expect({ tool, args, isError: answer.isError }).toEqual({ tool, args, isError: false });
  return answer.body as Record<string, any>;
}

beforeAll(async () => {
  const rows = Array.from({ length: CANDIDATES }, (_, n) => {
    const id = `cs-walk-${String(n).padStart(3, "0")}`;
    candidateIds.push(id);
    statementKeys.push(`statement-walk-${String(n).padStart(3, "0")}`);
    return {
      id,
      statementKey: statementKeys[n]!,
      bankKey: `bank-walk-${String(n)}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    };
  });
  // Registers the sources and the fixture producer as well.
  await seedCandidates(rows);

  const run = await seedRun({ source: "myjcb", count: 1 });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'myjcb-credit-statement-total','1','2099-01-12T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await env.DB.batch(
    Array.from({ length: UNMATCHED }, (_, n) => {
      const account = `myjcb:synthetic-walk-${String(n).padStart(3, "0")}:root`;
      unmatchedAccounts.push(account);
      return env.DB.prepare(
        `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
         VALUES(?,?,'credit_statement_payment_amount',4000,'4000',0,'JPY','2099-01-01','synthetic-total',?)`,
      ).bind(
        parse!.id,
        account,
        JSON.stringify({
          _kogane: {
            period: "2099-01",
            paymentDate: "2099-01-10",
            snapshotSemantics: "provider-reported-monthly-payment-amount",
          },
        }),
      );
    }),
  );
  await publishParse(parse!.id);
}, 120_000);

describe("the カード照合 reads, walked by next.arguments alone", () => {
  it("kogane.card-settlements.read: every review once across the 50-review page", async () => {
    const walk = await walkPages({
      first: {},
      call: async (args) => {
        const body = await overMcp("kogane.card-settlements.read", args);
        expect(validCardSettlementReviewPage(body)).toBe(true);
        return body;
      },
      items: (answer) => answer.items as { proposalId: string }[],
      id: (item) => item.proposalId,
    });
    expect(walk.calls).toEqual([{}, { offset: 50 }]);
    expect(walk.items.map((item) => item.proposalId).sort()).toEqual([...candidateIds].sort());
  });

  it("kogane.card-settlements.statements: every statement once across the 10-statement page", async () => {
    const walk = await walkPages({
      first: {},
      call: async (args) => {
        const body = await overMcp("kogane.card-settlements.statements", args);
        expect(validCardSettlementStatementPage(body)).toBe(true);
        return body;
      },
      items: (answer) => answer.statements as { statementKey: string }[],
      id: (item) => item.statementKey,
    });
    expect(walk.calls).toHaveLength(6);
    expect(walk.items.map((item) => item.statementKey).sort()).toEqual([...statementKeys].sort());
  });

  it("kogane.card-settlements.unmatched: every uncited statement once across the 50-statement page", async () => {
    const walk = await walkPages({
      first: {},
      call: async (args) => {
        const body = await overMcp("kogane.card-settlements.unmatched", args);
        expect(validUnmatchedCardStatementsReview(body)).toBe(true);
        return body;
      },
      items: (answer) => answer.items as { statement: { sourceAccount: string } }[],
      id: (item) => item.statement.sourceAccount,
    });
    expect(walk.calls).toEqual([{}, { offset: 50 }]);
    expect(walk.items.map((item) => item.statement.sourceAccount).sort()).toEqual(
      [...unmatchedAccounts].sort(),
    );
  });

  it("withholds a page past the grant's row budget, and says so, on the same rule", async () => {
    // Under a 50-row budget the first page is the last one the grant reaches;
    // with rows after it the next page is withheld (`stoppedBy: "budget"`),
    // never shown as the end.
    const deep = await page.direct(
      "kogane.card-settlements.read",
      { offset: 0 },
      {
        scopes: { sources: "*", accounts: "*" },
        capabilities: ["records.read"],
        budget: { maxRows: 50, maxProposalTargets: 1, maxExplainDepth: 1 },
      },
    );
    expect(deep.status).toBe(200);
    expect(deep.body).toMatchObject({
      nextOffset: null,
      nextPage: "budget_exceeded",
      next: null,
      paging: { limit: 50, returned: 50, hasMore: true, stoppedBy: "budget" },
    });
  });
});
