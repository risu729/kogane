// `/api/v2/activity` and `/api/v2/obligations` (A10). The routes are 404 unless
// the reader flag is on, they are GET-only behind the existing Access gate, and
// every figure they return names its basis and its explanation refs.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { seedRegistry } from "./fixtures";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

beforeAll(async () => {
  await seedRegistry().catch(() => undefined);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  await seedProjection();
});
beforeEach(() => {
  issuer = `https://events-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

const DATE = '{"kind":"local-date","value":"2026-03-01","zone":null,"basis":"provider"}';

/** One synthetic purchase event with two bases, and one obligation with a settlement. */
async function seedProjection() {
  const decision = (id: string, subjectRef: string) =>
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation',?,1,'accept','rule','rule:test',NULL,'synthetic','[]',NULL,NULL,'2026-03-01T00:00:00Z')`,
    ).bind(id, subjectRef);
  await env.DB.batch([
    decision("dr_ev_1", "event:ev-1"),
    env.DB.prepare(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
       VALUES('ev-1',1,'purchase','captured',NULL,?,'purchase-recognition','[{"kind":"transaction","id":"transaction:1","revision":"parse_run:1"}]','dr_ev_1',NULL,'2026-03-01T00:00:00Z')`,
    ).bind(DATE),
    env.DB.prepare(
      "INSERT INTO economic_legs VALUES('ev-1',1,0,'account:card','JPY','exact','3000',0,NULL,'decrease','cash-movement')",
    ),
    env.DB.prepare(
      "INSERT INTO economic_legs VALUES('ev-1',1,1,'claim:cost','JPY','exact','3000',0,NULL,'increase','purchase-recognition')",
    ),
    decision("dr_obl_1", "obligation:obl-1"),
    env.DB.prepare(
      `INSERT INTO obligation_revisions(obligation_id,revision,creditor_ref,debtor_ref,principal_unit_ref,principal_status,principal_coefficient,principal_scale,fee_components_json,schedule_json,state,unknown_reason,state_evidence_refs_json,decision_revision_id,superseded_by,created_at)
       VALUES('obl-1',1,'party:issuer','party:self','JPY','exact','12000',0,'[]','[]','partially-settled',NULL,'["transaction:1"]','dr_obl_1',NULL,'2026-03-01T00:00:00Z')`,
    ),
    decision("dr_st_1", "settlement:st-1"),
    env.DB.prepare(
      `INSERT INTO settlement_relations(id,obligation_id,settlement_component_ref,unit_ref,coefficient,scale,occurred_json,unresolved_coefficient,unresolved_scale,decision_revision_id,superseded_by,created_at)
       VALUES('st-1','obl-1','leg:ev-1#0','JPY','4000',0,?,NULL,NULL,'dr_st_1',NULL,'2026-03-01T00:00:00Z')`,
    ).bind(DATE),
  ]);
}

async function token() {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience("fixture-audience")
    .setSubject("synthetic-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

async function call(
  path: string,
  options: { enabled?: boolean; jwt?: string | null; method?: string } = {},
) {
  const jwt = options.jwt === undefined ? await token() : options.jwt;
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: options.method ?? "GET",
      headers: jwt ? { "cf-access-jwt-assertion": jwt } : {},
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      EVENTS_V2_ENABLED: options.enabled === false ? "0" : "1",
    } as Env,
  );
}

describe("events v2 capability gate", () => {
  it("is off by default, and both routes are absent then", async () => {
    for (const path of ["/api/v2/activity", "/api/v2/obligations"]) {
      const response = await call(path, { enabled: false });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "not_found" });
    }
    const meta = await (await call("/api/meta", { enabled: false })).json();
    expect(meta).toMatchObject({ capabilities: { eventsV2: false } });
  });

  it("reports the capability as true only when the flag is on and the projection exists", async () => {
    const meta = await (await call("/api/meta")).json();
    expect(meta).toMatchObject({ capabilities: { eventsV2: true } });
  });

  it("stays behind the Access gate and stays GET-only", async () => {
    expect((await call("/api/v2/activity", { jwt: null })).status).toBe(401);
    expect((await call("/api/v2/activity", { method: "POST" })).status).toBe(405);
  });
});

describe("GET /api/v2/activity", () => {
  it("returns the page envelope with the basis and the explanation chain", async () => {
    const response = await call("/api/v2/activity?basis=cash-movement");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      apiVersion: number;
      basis: string;
      items: {
        eventId: string;
        kind: string;
        totals: { basis: string; quantity: { unitRef: string } }[];
        explanationRefs: string[];
      }[];
      nextCursor: string | null;
      dataCoverage: { scopeRef: string; truncated: boolean };
    };
    expect(body.apiVersion).toBe(2);
    expect(body.basis).toBe("cash-movement");
    expect(body.nextCursor).toBeNull();
    expect(body.dataCoverage).toMatchObject({ scopeRef: "activity:cash-movement" });
    const event = body.items.find((item) => item.eventId === "ev-1")!;
    expect(event.kind).toBe("purchase");
    // Cash out and cost recognised at purchase are separate totals.
    expect(event.totals.map((total) => total.basis)).toEqual([
      "cash-movement",
      "purchase-recognition",
    ]);
    expect(event.explanationRefs[0]).toBe("event:ev-1@1");
    expect(event.explanationRefs).toContain("decision_revision:dr_ev_1");
  });

  it("defaults to the cash-movement basis and refuses an unknown one", async () => {
    const body = (await (await call("/api/v2/activity")).json()) as { basis: string };
    expect(body.basis).toBe("cash-movement");
    expect((await call("/api/v2/activity?basis=tax")).status).toBe(400);
    expect((await call("/api/v2/activity?unknown=1")).status).toBe(400);
    expect((await call("/api/v2/activity?offset=-1")).status).toBe(400);
  });
});

describe("GET /api/v2/obligations", () => {
  it("computes the outstanding amount from settlements with exact values", async () => {
    const body = (await (await call("/api/v2/obligations")).json()) as {
      apiVersion: number;
      items: {
        obligationId: string;
        state: string;
        outstanding: { unitRef: string; value: { value: { coefficient: string } } } | null;
        outstandingReasonCode: string | null;
        explanationRefs: string[];
      }[];
    };
    expect(body.apiVersion).toBe(2);
    const obligation = body.items.find((item) => item.obligationId === "obl-1")!;
    expect(obligation.state).toBe("partially-settled");
    expect(obligation.outstanding?.value.value.coefficient).toBe("8000");
    expect(obligation.outstandingReasonCode).toBeNull();
    expect(obligation.explanationRefs).toContain("settlement:st-1");
  });

  it("accepts no query parameter other than offset", async () => {
    expect((await call("/api/v2/obligations?basis=cash-movement")).status).toBe(400);
    expect((await call("/api/v2/obligations?offset=0")).status).toBe(200);
  });
});
