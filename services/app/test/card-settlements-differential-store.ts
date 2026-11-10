// The synthetic store and the comparison the card settlement route's
// differential tests share: the route as an adapter over the shared service
// against the handler it replaced (`card-settlements-api-frozen.ts`).
// Native Worker/D1 only; no production data.
import { env } from "cloudflare:test";
import { expect } from "vitest";
import { settlementFacts } from "../../../packages/application/test/card-settlement-fixture";
import { seedRegistry, seedRun, publishParse } from "./fixtures";
import { cardSettlementsApi } from "../src/card-settlements-api";
import { HttpError } from "../src/http";
import { frozenCardSettlementsApi } from "./card-settlements-api-frozen";

export const PATH = "/api/v2/reconciliation/card-settlements";
const SUBJECT = "synthetic-operator";
const environment = {
  ...env,
  OPERATOR_SUBJECTS: JSON.stringify([SUBJECT]),
  AGENT_GRANTS: '["synthetic-agent"]',
} as Env;

/** A candidate row of the synthetic store; `period` overrides the statement month. */
export interface CandidateRow {
  id: string;
  statementKey: string;
  bankKey: string;
  createdAt: string;
  period?: string;
}

/**
 * Seeds one card statement and one bank debit observation and, over them, the
 * given candidates, each with the same synthetic facts.
 */
export async function seedCandidates(rows: readonly CandidateRow[]): Promise<void> {
  await seedRegistry();
  for (const source of ["myjcb", "smbc-bank"])
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO producer_sources (producer_id,source_id) VALUES ('evidence-test',?)",
      ).bind(source),
      env.DB.prepare(
        "INSERT OR IGNORE INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
      ).bind(source),
    ]);
  const cardRun = await seedRun({ source: "myjcb", count: 1 });
  const bankRun = await seedRun({ source: "smbc-bank", count: 1 });
  async function parse(artifactId: number) {
    const row = await env.DB.prepare(
      `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES(?,'card-settlement-differential-fixture','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`,
    )
      .bind(artifactId)
      .first<{ id: number }>();
    await publishParse(row!.id);
    return row!.id;
  }
  const cardParse = await parse(cardRun.artifacts[0]!.id);
  const bankParse = await parse(bankRun.artifacts[0]!.id);
  const card = await env.DB.prepare(
    `INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json)
    VALUES(?,'synthetic-card','credit_statement_payment_amount','JPY','synthetic-card','{}') RETURNING id`,
  )
    .bind(cardParse)
    .first<{ id: number }>();
  const bank = await env.DB.prepare(
    `INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json)
    VALUES(?,'synthetic-bank','JPY','synthetic-bank','{}') RETURNING id`,
  )
    .bind(bankParse)
    .first<{ id: number }>();
  const facts = settlementFacts(true);
  facts.statement.ref = {
    kind: "balance",
    id: `balance:${card!.id}`,
    revision: `parse_run:${cardParse}`,
  };
  facts.bankDebit.ref = {
    kind: "transaction",
    id: `transaction:${bank!.id}`,
    revision: `parse_run:${bankParse}`,
  };
  facts.bankDebit.sourceId = "smbc-bank";
  for (let start = 0; start < rows.length; start += 100)
    await env.DB.batch(
      rows.slice(start, start + 100).map((row, index) =>
        env.DB.prepare(
          `INSERT INTO card_settlement_candidates
          (id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
          VALUES(?,?,?,?,?,?,?,'card-statement-settlement-v1',?,?,?)`,
        ).bind(
          row.id,
          row.statementKey,
          row.bankKey,
          card!.id,
          cardParse,
          bank!.id,
          bankParse,
          JSON.stringify(
            row.period === undefined
              ? facts
              : { ...facts, statement: { ...facts.statement, period: row.period } },
          ),
          (start + index).toString(16).padStart(64, "0"),
          row.createdAt,
        ),
      ),
    );
}

export interface Answer {
  status: number;
  /** The closed code of a refusal: `error` of the transport's body, `code` of the service's. */
  code: string | null;
  body: string;
}
export async function answer(
  handler: typeof cardSettlementsApi,
  query: string,
  method = "GET",
  subject = SUBJECT,
): Promise<Answer | null> {
  const url = new URL(`https://fixture.test${query}`);
  try {
    const response = await handler(new Request(url, { method }), environment, url, subject);
    if (response === null) return null;
    const body = await response.text();
    const parsed = response.status >= 400 ? (JSON.parse(body) as { code?: string }) : null;
    return { status: response.status, code: parsed?.code ?? null, body };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { status: error.status, code: error.code, body: "" };
  }
}

/** What the shipped route must answer, given what the frozen one answered. */
function expected(
  query: string,
  before: Answer,
): Answer | { budget: "card-settlements.read" | "card-settlements.statements" } | "invalid_query" {
  const url = new URL(`https://fixture.test${query}`);
  if (before.status === 400) return "invalid_query";
  const offset = Number(url.searchParams.get("offset") ?? "0");
  // The grouped list pages ten statements at a time.
  if (url.pathname === `${PATH}/statements` && before.status === 200 && offset + 10 > 1000)
    return { budget: "card-settlements.statements" };
  if (
    url.pathname === PATH &&
    !url.searchParams.has("proposalId") &&
    (before.status === 200 || before.status === 404) &&
    offset + 50 > 1000
  )
    return { budget: "card-settlements.read" };
  return withinReaderBudget(query, before);
}

/**
 * The frozen page as the reader grant may follow it (ADR 0081, 2026-11-08
 * amendment): a `nextOffset` whose page would reach past `maxRows` 1000 is
 * withheld and said (`nextOffset: null`, `nextPage: "budget_exceeded"`), every
 * other byte unchanged. The frozen handler named that page, which the route
 * then refused.
 */
export function withinReaderBudget(query: string, before: Answer): Answer {
  const url = new URL(`https://fixture.test${query}`);
  const size = url.pathname === PATH ? 50 : url.pathname === `${PATH}/statements` ? 10 : undefined;
  if (before.status !== 200 || size === undefined || before.body === "") return before;
  const body = JSON.parse(before.body) as { nextOffset: number | null };
  if (body.nextOffset === null || body.nextOffset + size <= 1000) return before;
  return {
    ...before,
    body: JSON.stringify({ ...body, nextOffset: null, nextPage: "budget_exceeded" }),
  };
}

export interface Seen {
  same: number;
  invalid: number;
  budget: number;
  groupedBudget: number;
  groupedPages: number;
  /** Of `same`, the pages whose next page the reader grant may not read, withheld. */
  withheld: number;
}
/** Runs each request on both handlers and checks the shipped answer against `expected`. */
export async function compare(all: readonly string[]): Promise<Seen> {
  const seen = { same: 0, invalid: 0, budget: 0, groupedBudget: 0, groupedPages: 0, withheld: 0 };
  for (const request of all) {
    const before = (await answer(frozenCardSettlementsApi, request))!;
    const after = (await answer(cardSettlementsApi, request))!;
    const want = expected(request, before);
    if (want === "invalid_query") {
      seen.invalid++;
      expect({ request, status: after.status, code: after.code }).toEqual({
        request,
        status: 400,
        code: "invalid_query",
      });
      expect(JSON.parse(after.body)).toMatchObject({ schemaVersion: "financial-error-v1" });
    } else if (typeof want === "object" && "budget" in want) {
      seen.budget++;
      if (want.budget === "card-settlements.statements") seen.groupedBudget++;
      expect({ request, after: JSON.parse(after.body) as unknown }).toEqual({
        request,
        after: {
          schemaVersion: "financial-error-v1",
          code: "budget_exceeded",
          requestId: want.budget,
          message: "narrow the scope or the page, or switch to a bounded job",
          refs: ["budget:maxRows=1000"],
        },
      });
      expect(after.status).toBe(413);
    } else {
      seen.same++;
      if (request.startsWith(`${PATH}/statements`) && after.status === 200) seen.groupedPages++;
      if (want !== before) seen.withheld++;
      expect({ request, ...after }).toEqual({ request, ...want });
    }
  }
  return seen;
}
