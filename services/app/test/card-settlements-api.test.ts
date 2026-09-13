import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementFacts } from "../../../packages/application/test/card-settlement-fixture";
import { seedRegistry, seedRun, publishParse } from "./fixtures";
import worker from "../src/worker";

const PATH = "/api/v2/reconciliation/card-settlements";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
beforeAll(async () => {
  await seedRegistry();
  for (const source of ["myjcb", "smbc-bank"])
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test',?)",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
      ).bind(source),
    ]);
  const cardRun = await seedRun({ source: "myjcb", count: 1 });
  const bankRun = await seedRun({ source: "smbc-bank", count: 1 });
  async function parse(artifactId: number) {
    const row =
      await env.DB.prepare(`INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES(?,'card-settlement-api-fixture','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`)
        .bind(artifactId)
        .first<{ id: number }>();
    await publishParse(row!.id);
    return row!.id;
  }
  const cardParse = await parse(cardRun.artifacts[0]!.id);
  const bankParse = await parse(bankRun.artifacts[0]!.id);
  const card =
    await env.DB.prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json)
    VALUES(?,'synthetic-card','credit_statement_payment_amount','JPY','synthetic-card','{}') RETURNING id`)
      .bind(cardParse)
      .first<{ id: number }>();
  const bank =
    await env.DB.prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json)
    VALUES(?,'synthetic-bank','JPY','synthetic-bank','{}') RETURNING id`)
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
  await env.DB.prepare(`INSERT INTO card_settlement_candidates
    (id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
    VALUES('card-settlement-synthetic','statement-synthetic','bank-synthetic',?,?,?,?,'card-statement-settlement-v1',?,?,'2026-09-11T00:00:00Z')`)
    .bind(card!.id, cardParse, bank!.id, bankParse, JSON.stringify(facts), "a".repeat(64))
    .run();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://settlement-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());
async function call(
  path = PATH,
  options: { subject?: string | null; method?: string; enabled?: boolean } = {},
) {
  const subject = options.subject === undefined ? "synthetic-operator" : options.subject;
  const token =
    subject === null
      ? null
      : await new SignJWT({ type: "app" })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" })
          .setIssuer(issuer)
          .setAudience("fixture-audience")
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(keys.privateKey);
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: options.method ?? "GET",
      headers: token
        ? { "cf-access-jwt-assertion": token, "x-kogane-verified-actor": "synthetic-operator" }
        : {},
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      EVENTS_V2_ENABLED: options.enabled === false ? "0" : "true",
      OPERATOR_SUBJECTS: '["synthetic-operator"]',
      AGENT_GRANTS: '["synthetic-agent"]',
    } as Env,
  );
}
describe("card settlement review boundary", () => {
  it("allows a verified operator and preserves unknown ownership without adding a bank movement", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      apiVersion: 2,
      items: [
        {
          proposalId: "card-settlement-synthetic",
          facts: { ownership: "unknown" },
          impact: {
            addedCashMovement: { value: { value: { coefficient: "0" } } },
            netWorthDelta: null,
          },
        },
      ],
    });
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM card_settlement_decisions").first(),
    ).toEqual({ count: 0 });
  });
  it("denies anonymous, ungranted and agent subjects despite a caller-supplied operator header", async () => {
    for (const [subject, status] of [
      [null, 401],
      ["ungranted", 403],
      ["synthetic-agent", 403],
    ] as const)
      expect((await call(PATH, { subject })).status).toBe(status);
  });
  it("honors disabled capability and remains read-only", async () => {
    expect((await call(PATH, { enabled: false })).status).toBe(404);
    expect((await call(PATH, { method: "POST" })).status).toBe(405);
  });
  it("validates exact-id and offset requests without allowing mixed or repeated filters", async () => {
    for (const query of [
      "?offset=-1",
      "?offset=01",
      "?offset=1000001",
      "?source=myjcb",
      "?proposalId=a&proposalId=b",
      "?proposalId=a&offset=0",
      "?proposalId=%2Fetc",
    ])
      expect((await call(PATH + query)).status).toBe(400);
    expect((await call(PATH + "?proposalId=card-settlement-synthetic")).status).toBe(200);
    expect((await call(PATH + "?offset=50")).status).toBe(200);
  });
  it("does not turn a missing candidate into an empty successful detail", async () => {
    expect((await call(PATH + "?proposalId=missing")).status).toBe(404);
  });
});
