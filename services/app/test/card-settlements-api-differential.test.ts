// The page route `GET /api/v2/reconciliation/card-settlements` (and its
// `/ownership` and `/statements` reads) as an adapter over the shared service,
// against the handler it replaced (`card-settlements-api-frozen.ts`), on the
// same synthetic store and the same requests. They must answer byte for byte
// alike except for the two changes docs/card-settlements.md records (ADR 0081
// point 2): a malformed list or ownership request is the service's
// `400 invalid_query` (`financial-error-v1`) where the route said
// `invalid_offset` or `invalid_query`, and a list read deeper than the reader
// grant's `maxRows` is `413 budget_exceeded` where the route read on.
// Native Worker/D1 only; no production data.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { settlementFacts } from "../../../packages/application/test/card-settlement-fixture";
import { seedRegistry, seedRun, publishParse } from "./fixtures";
import { cardSettlementsApi } from "../src/card-settlements-api";
import { HttpError } from "../src/http";
import { frozenCardSettlementsApi } from "./card-settlements-api-frozen";

const PATH = "/api/v2/reconciliation/card-settlements";
const SUBJECT = "synthetic-operator";
/** Past one page at the reader grant's budget, so deep pages hold rows. */
const BULK = 1_100;
const environment = {
  ...env,
  OPERATOR_SUBJECTS: JSON.stringify([SUBJECT]),
  AGENT_GRANTS: '["synthetic-agent"]',
} as Env;

beforeAll(async () => {
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
  // One statement recaptured BULK times, each paired with its own debit key,
  // plus one candidate of another statement that shares nothing.
  const rows = [
    ...Array.from({ length: BULK }, (_, n) => ({
      id: `cs-${String(n).padStart(4, "0")}`,
      statementKey: "statement-bulk",
      bankKey: `bank-${n}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    })),
    {
      id: "cs-alone",
      statementKey: "statement-alone",
      bankKey: "bank-alone",
      createdAt: "2025-01-01T00:00:00.000Z",
    },
  ];
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
            row.id === "cs-alone"
              ? { ...facts, statement: { ...facts.statement, period: "2025-01" } }
              : facts,
          ),
          (start + index).toString(16).padStart(64, "0"),
          row.createdAt,
        ),
      ),
    );
});

interface Answer {
  status: number;
  /** The closed code of a refusal: `error` of the transport's body, `code` of the service's. */
  code: string | null;
  body: string;
}
async function answer(
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

const OFFSETS = [
  null,
  "0",
  "1",
  "50",
  "900",
  "950",
  "951",
  "1000",
  "1050",
  "1000000",
  "1000001",
  "99999999999999999999",
  "-1",
  "01",
  "abc",
  "1.5",
  "1e3",
  "+1",
  "",
];
const PROPOSALS = [null, "cs-0000", "cs-alone", "missing", "%2Fetc", ""];
const STATEMENTS = [null, "statement-bulk", "statement-none", "k".repeat(1025), ""];
const RELATED = [null, "cs-0000", "cs-alone", "missing", "a".repeat(129)];
const EXTRA = [null, "source=myjcb", "offset=0", "proposalId=cs-0000"];

function query(path: string, parts: Record<string, string | null>, extra: string | null): string {
  const pairs = Object.entries(parts)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}=${value}`);
  if (extra !== null) pairs.push(extra);
  return pairs.length === 0 ? path : `${path}?${pairs.join("&")}`;
}

/** A deterministic sample of the whole cross product, the same on every run. */
function sample<T>(all: readonly T[], size: number): T[] {
  let state = 0x2545f491;
  const picked: T[] = [];
  for (let n = 0; n < size; n++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    picked.push(all[state % all.length]!);
  }
  return picked;
}

function requests(): string[] {
  const paths = [PATH, `${PATH}/ownership`, `${PATH}/statements`];
  const structured: string[] = [];
  const product: string[] = [];
  for (const path of paths) {
    // Every offset alone and beside each one filter.
    for (const offset of OFFSETS)
      for (const filter of [
        {},
        { proposalId: "cs-0000" },
        { statementKey: "statement-bulk" },
        { relatedTo: "cs-0000" },
        { relatedTo: "missing" },
      ])
        structured.push(query(path, { offset, ...filter }, null));
    for (const offset of OFFSETS)
      for (const proposalId of PROPOSALS)
        for (const statementKey of STATEMENTS)
          for (const relatedTo of RELATED)
            for (const extra of EXTRA)
              product.push(query(path, { offset, proposalId, statementKey, relatedTo }, extra));
  }
  return [...structured, ...sample(product, 600)];
}

/** What the shipped route must answer, given what the frozen one answered. */
function expected(query: string, before: Answer): Answer | "budget_exceeded" | "invalid_query" {
  const url = new URL(`https://fixture.test${query}`);
  if (url.pathname.endsWith("/statements")) return before;
  if (before.status === 400) return "invalid_query";
  const offset = Number(url.searchParams.get("offset") ?? "0");
  if (
    url.pathname === PATH &&
    !url.searchParams.has("proposalId") &&
    (before.status === 200 || before.status === 404) &&
    offset + 50 > 1000
  )
    return "budget_exceeded";
  return before;
}

describe("the card settlement page route as an adapter over the shared service", () => {
  it("answers as the frozen handler did, except the two recorded changes", async () => {
    const seen = { same: 0, invalid: 0, budget: 0 };
    for (const request of requests()) {
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
      } else if (want === "budget_exceeded") {
        seen.budget++;
        expect({ request, after: JSON.parse(after.body) as unknown }).toEqual({
          request,
          after: {
            schemaVersion: "financial-error-v1",
            code: "budget_exceeded",
            requestId: "card-settlements.read",
            message: "narrow the scope or the page, or switch to a bounded job",
            refs: ["budget:maxRows=1000"],
          },
        });
        expect(after.status).toBe(413);
      } else {
        seen.same++;
        expect({ request, ...after }).toEqual({ request, ...want });
      }
    }
    // Every class was reached, deep pages that held rows included.
    expect(seen.same).toBeGreaterThan(100);
    expect(seen.invalid).toBeGreaterThan(100);
    expect(seen.budget).toBeGreaterThan(10);
    const deep = (await answer(frozenCardSettlementsApi, `${PATH}?offset=951`))!;
    expect((JSON.parse(deep.body) as { items: unknown[] }).items).toHaveLength(50);
  });

  it("keeps the transport's own answers: methods, non-operators and other paths", async () => {
    for (const path of [
      PATH,
      `${PATH}?offset=950`,
      `${PATH}/ownership?proposalId=cs-0000`,
      `${PATH}/statements`,
    ]) {
      for (const method of ["HEAD", "POST", "PUT", "DELETE"])
        expect({ path, method, after: await answer(cardSettlementsApi, path, method) }).toEqual({
          path,
          method,
          after: await answer(frozenCardSettlementsApi, path, method),
        });
      for (const subject of ["ungranted", "synthetic-agent", "mcp-client:synthetic-operator"])
        expect({
          path,
          subject,
          after: await answer(cardSettlementsApi, path, "GET", subject),
        }).toEqual({
          path,
          subject,
          after: await answer(frozenCardSettlementsApi, path, "GET", subject),
        });
    }
    for (const path of ["/api/v2/other", `${PATH}/other`, `${PATH}s`])
      expect(await answer(cardSettlementsApi, path)).toBeNull();
  });
});
