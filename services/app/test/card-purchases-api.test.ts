// `GET /api/v2/card-purchases`: behind Access, operator-only, GET-only, and
// absent unless the event reader flag is on and CORE 0047 is applied. One
// synthetic purchase is recognised through the same guarded builder the
// processor uses; every value is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cardPurchaseEventId,
  cardPurchaseRevision,
  type CardUsageFact,
} from "../../../packages/domain/src/card-purchase";
import { exactQuantity, integerDecimal } from "../../../packages/domain/src/values";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { cardPurchaseRecognitionWrites } from "../../../packages/storage-d1/src/atomic/card-purchase-recognition";
import { cardPurchasesAvailable } from "../src/card-purchases-api";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const PATH = "/api/v2/card-purchases";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
let eventId = "";

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test','vpass')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test','vpass')",
    ),
    env.DB.prepare(
      "INSERT INTO accounts(id,label,role,status) VALUES('acct-card','Synthetic card','liability','identified')",
    ),
  ]);
  const run = await seedRun({ source: "vpass", count: 1 });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'vpass-statement-page','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  const observation = await env.DB.prepare(
    `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,
      currency,description,counterparty,as_of,raw_locator,extra_json)
     VALUES(?,'vpass:card-001','vpass:card-001:202609:web:row-a:0','posted',-1234,'-1234',0,'JPY','１',
      'synthetic merchant','2026-08-15','json:$.rows[0]','{}') RETURNING id`,
  )
    .bind(parse!.id)
    .first<{ id: number }>();
  const fact: CardUsageFact = {
    observationId: observation!.id,
    parseRunId: parse!.id,
    sourceId: "vpass",
    producerId: "evidence-test",
    externalIdNamespace: "fixture",
    sourceAccount: "vpass:card-001",
    externalId: "vpass:card-001:202609:web:row-a:0",
    accountId: "acct-card",
    identityPolicyFamily: "vpass-card-binding",
    providerStatus: "posted",
    amount: exactQuantity("JPY", integerDecimal(-1234), "decimal-v1"),
    usageDate: "2026-08-15",
    paymentType: "１",
    statementPeriod: "202609",
    providerSaleCode: null,
    usageAmountText: null,
    paymentAmountText: null,
    newestRepresentation: true,
  };
  eventId = await cardPurchaseEventId("purchase", [
    "vpass",
    "evidence-test",
    "fixture",
    "vpass:card-001",
    "vpass:card-001:202609:web:row-a:0",
  ]);
  const draft = await cardPurchaseRevision({ action: "recognize", eventId, revision: 1, fact });
  await env.DB.batch(
    cardPurchaseRecognitionWrites({
      draft: draft!,
      expectedRevision: null,
      now: "2026-09-24T00:00:00.000Z",
    }).map((write) => env.DB.prepare(write.sql).bind(...write.binds)),
  );
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://purchase-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** The store with CORE 0047 not yet applied: the table and views are absent. */
function withoutPurchaseSchema(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("sqlite_master") && sql.includes("card_purchase_recognitions")
              ? "SELECT 0 AS present"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A store past the summary bound: the whole-filter selection yields one row
 * more than the bound it asks for (`?3`), as thousands of live events would.
 */
function overfull(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("FROM current_card_purchase_recognitions c") && sql.includes("LIMIT ?3")
              ? "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?3) SELECT i AS event_id,?1 AS period,?2 AS event FROM n"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function call(
  path = PATH,
  options: {
    subject?: string | null;
    method?: string;
    enabled?: boolean;
    schema?: boolean;
    full?: boolean;
  } = {},
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
      DB:
        options.schema === false
          ? withoutPurchaseSchema(env.DB)
          : options.full
            ? overfull(env.DB)
            : env.DB,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      EVENTS_V2_ENABLED: options.enabled === false ? "0" : "true",
      OPERATOR_SUBJECTS: '["synthetic-operator"]',
      AGENT_GRANTS: '["synthetic-agent"]',
    } as Env,
  );
}

async function counts() {
  return env.DB.prepare(
    `SELECT (SELECT count(*) FROM economic_event_revisions) AS events,
      (SELECT count(*) FROM economic_legs) AS legs,
      (SELECT count(*) FROM allocations) AS allocations,
      (SELECT count(*) FROM decision_revisions) AS decisions,
      (SELECT count(*) FROM card_purchase_recognitions) AS recognitions,
      (SELECT count(*) FROM card_purchase_recognition_keys) AS keys,
      (SELECT count(*) FROM card_settlement_decisions) AS settlements,
      (SELECT source_revision FROM core_source_revision WHERE id=1) AS source_revision`,
  ).first();
}

describe("card purchase explanation boundary", () => {
  it("serves a verified operator the validated page and writes nothing", async () => {
    const before = await counts();
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(validApiResponse(PATH, body)).toBe(true);
    expect(body).toMatchObject({
      apiVersion: 2,
      items: [
        {
          eventId,
          kind: "purchase",
          state: "captured",
          amount: { unitRef: "JPY", value: { value: { coefficient: "1234", scale: 0 } } },
          statement: { status: "unlinked", reasonCode: "statement_not_collected" },
          settlement: null,
        },
      ],
      summary: { unresolved: 0, events: 1, settlementAddsPurchaseExpense: false },
      coverage: { scope: "card-purchase-recognition", completeTransactionHistory: false },
    });
    expect((await call(`${PATH}?eventId=${eventId}`)).status).toBe(200);
    expect((await call(`${PATH}?eventId=refund_${"0".repeat(64)}`)).status).toBe(404);
    expect(await counts()).toEqual(before);
  });

  it("denies anonymous, ungranted and agent subjects despite a caller-supplied operator header", async () => {
    for (const [subject, status] of [
      [null, 401],
      ["ungranted", 403],
      ["synthetic-agent", 403],
    ] as const)
      expect((await call(PATH, { subject })).status).toBe(status);
  });

  it("is GET-only", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await call(PATH, { method })).status).toBe(405);
    expect((await call(PATH, { method: "HEAD" })).status).toBe(200);
  });

  it("does not exist while the reader flag is off or CORE 0047 is absent", async () => {
    expect((await call(PATH, { enabled: false })).status).toBe(404);
    expect((await call(PATH, { schema: false })).status).toBe(404);
    expect(await cardPurchasesAvailable({ ...env, EVENTS_V2_ENABLED: "true" } as Env)).toBe(true);
    expect(
      await cardPurchasesAvailable({
        ...env,
        DB: withoutPurchaseSchema(env.DB),
        EVENTS_V2_ENABLED: "true",
      } as Env),
    ).toBe(false);
  });

  it("validates bounded paging, period and exact-id requests", async () => {
    for (const query of [
      "?offset=-1",
      "?offset=01",
      "?offset=1000001",
      "?period=2026-13",
      "?period=202609",
      "?period=2026-09&period=2026-10",
      "?eventId=purchase_1",
      `?eventId=${eventId}&offset=0`,
      `?eventId=${eventId}&period=2026-09`,
      "?source=vpass",
      "?offset=",
    ])
      expect((await call(PATH + query)).status).toBe(400);
    expect((await call(PATH + "?offset=50")).status).toBe(200);
    expect((await call(PATH + "?period=2026-09&offset=0")).status).toBe(200);
    const detail = await call(`${PATH}?eventId=${eventId}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await call(`${PATH}?eventId=refund_${"0".repeat(64)}`)).status).toBe(404);
  });

  it("refuses a filter past the summary bound with 413 rather than a partial sum", async () => {
    const before = await counts();
    const response = await call(PATH, { full: true });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "result_limit_exceeded" });
    // A statement period narrows the filter; the refusal writes nothing either.
    expect((await call(`${PATH}?period=2026-09`, { full: true })).status).toBe(413);
    expect(await counts()).toEqual(before);
  });

  it("advertises the capability only when the route is served", async () => {
    const meta = async (options: { enabled?: boolean; schema?: boolean }) =>
      ((await (await call("/api/meta", options)).json()) as { capabilities: unknown }).capabilities;
    expect(await meta({})).toMatchObject({ cardPurchaseRecognition: true });
    expect(await meta({ enabled: false })).toMatchObject({ cardPurchaseRecognition: false });
    expect(await meta({ schema: false })).toMatchObject({ cardPurchaseRecognition: false });
  });
});
