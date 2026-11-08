// Phase 2 unit 2g.2 (ADR 0081 point 1, ADR 0084): the カード照合 page's
// decisions — card settlement accept, withdraw and reject, and the ownership
// review it plans first — also work over MCP, through the same change
// lifecycle. The page posts to `/api/command/v1/*`; an MCP client calls
// `kogane.command.plan`, `.simulate`, `.approve` and `.commit`. Both are
// adapters that forward to the Processor's one command route, which runs the
// `packages/application` plan, simulate, approve and commit services; neither
// adapter writes a decision itself.
//
// Real App Worker, real CORE migrations, the Processor's real command route
// over the same store, the real identity projection and the real settlement
// sweep. Every identity, amount and date is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardOwnershipReview } from "../../../packages/domain/src/card-ownership-review";
import { canonicalDigest } from "../../../packages/domain/src/context";
import { smbcDirectTransactions } from "../../../packages/parsers/src/parsers/smbc-direct";
import {
  identifyParse,
  type IdentityResolver,
} from "../../../packages/storage-d1/src/core/identity-store";
import { cardSettlementSweep } from "../../processor/src/card-settlement-job";
import { changeCommandRoute } from "../../processor/src/change-commands";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const OWNER = "owner-settlement-parity-synthetic";
const MCP_PRINCIPAL = `mcp-client:${OWNER}`;
const APP_AUD = "fixture-browser-audience";
const MCP_AUD = "fixture-mcp-audience";
const ISSUER = "https://settlement-parity.cloudflareaccess.com";
const PARTY = "party:synthetic-owner";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let rpc = 0;
/** The candidate the sweep proposes once both ownership claims are recorded. */
let owned = "";

const pipeline = {
  fetch: vi.fn(async (request: Request) => {
    const response = await changeCommandRoute(
      env as Parameters<typeof changeCommandRoute>[0],
      request,
      new URL(request.url).pathname,
    );
    if (!response) throw new Error("unexpected pipeline route");
    return response;
  }),
};

async function assertion(audience: string): Promise<string> {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(OWNER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

async function send(path: string, init: RequestInit, audience: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", await assertion(audience));
  return worker.fetch(new Request(`https://fixture.test${path}`, { ...init, headers }), {
    ...env,
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: APP_AUD,
    ACCESS_MCP_AUDIENCE: MCP_AUD,
    OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
    COMMANDS_ENABLED: "true",
    PIPELINE: pipeline,
  } as Env);
}

/** One answer from either path: the failed flag and the JSON body. */
interface Answer {
  failed: boolean;
  body: any;
}

/** The page's path: the operator's browser session on `/api/command/v1/*`. */
async function http(operation: string, body: unknown): Promise<Answer> {
  const response = await send(
    `/api/command/v1/${operation}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    APP_AUD,
  );
  return { failed: response.status >= 400, body: await response.json() };
}

/** The MCP path: a `tools/call` from the MCP Access application's identity. */
async function mcp(name: string, args: unknown): Promise<Answer> {
  const response = await send(
    "/mcp",
    {
      method: "POST",
      headers: { ...MCP_CLIENT_HEADERS, "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpc,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    },
    MCP_AUD,
  );
  expect(response.status).toBe(200);
  const message = (await response.json()) as {
    result: { structuredContent: unknown; isError?: boolean };
  };
  return { failed: message.result.isError === true, body: message.result.structuredContent };
}

const count = async (table: string): Promise<number> =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

/** Plan, simulate, approve and commit on the page's path; stops at the first refusal. */
async function decideOverHttp(
  kind: string,
  payload: unknown,
  key: string,
  baseContextId?: string,
): Promise<Answer> {
  const planned = await http("plan", {
    kind,
    payload,
    ...(baseContextId ? { baseContextId } : {}),
  });
  if (planned.failed) return planned;
  const planId = planned.body.plan.planId as string;
  const simulated = await http("simulate", { planId });
  if (simulated.failed) return simulated;
  const approved = await http("approve", {
    planId,
    planDigest: planned.body.plan.planDigest,
    scope: [],
  });
  if (approved.failed) return approved;
  return http("commit", {
    planId,
    approvalId: approved.body.approval.approvalId,
    operationId: `${key}-commit`,
  });
}

/**
 * The same steps over MCP. Approve and commit are R2: each is prepared, then
 * confirmed with the prepared digest, and preparing writes no approval and no
 * decision (INV07: nothing is adopted before the approval step).
 */
async function decideOverMcp(
  kind: string,
  payload: unknown,
  key: string,
  baseContextId?: string,
): Promise<Answer> {
  const planned = await mcp("kogane.command.plan", {
    kind,
    payload,
    idempotencyKey: `${key}-plan`,
    ...(baseContextId ? { baseContextId } : {}),
  });
  if (planned.failed) return planned;
  const planId = planned.body.plan.planId as string;
  const simulated = await mcp("kogane.command.simulate", { planId });
  if (simulated.failed) return simulated;
  const approveArgs = {
    planId,
    planDigest: planned.body.plan.planDigest,
    scope: [],
    idempotencyKey: `${key}-approve`,
  };
  const approvals = await count("approvals");
  const prepared = await mcp("kogane.command.approve", { ...approveArgs, step: "prepare" });
  if (prepared.failed) return prepared;
  expect(await count("approvals")).toBe(approvals);
  const approved = await mcp("kogane.command.approve", {
    ...approveArgs,
    step: "confirm",
    confirmationDigest: prepared.body.confirmation.digest,
  });
  if (approved.failed) return approved;
  const commitArgs = {
    planId,
    approvalId: approved.body.approval.approvalId,
    operationId: `${key}-commit`,
  };
  const receipts = await count("operation_receipts");
  const commitPrepared = await mcp("kogane.command.commit", { ...commitArgs, step: "prepare" });
  if (commitPrepared.failed) return commitPrepared;
  expect(await count("operation_receipts")).toBe(receipts);
  return mcp("kogane.command.commit", {
    ...commitArgs,
    step: "confirm",
    confirmationDigest: commitPrepared.body.confirmation.digest,
  });
}

/**
 * A receipt without what names its caller, its operation, its plan or its
 * time: what is left is what the decision did, which must not depend on the
 * path that asked for it.
 */
function decided(answer: Answer) {
  expect(answer.failed).toBe(false);
  expect(answer.body.replayed).toBe(false);
  const {
    operationId: _operation,
    principal: _principal,
    planId: _plan,
    planDigest: _digest,
    payloadDigest: _payload,
    acceptedAt: _at,
    decisionRevisionId,
    expectedRevisions,
    result,
    ...rest
  } = answer.body.receipt;
  expect(typeof decisionRevisionId).toBe("string");
  const outcome = result as Record<string, unknown>;
  return {
    ...rest,
    expectedRevisions: Object.values(expectedRevisions as Record<string, number>).sort(),
    // The writer's own answer: which fields it names, the decision's status
    // and revision, and which of its references are absent.
    result: Object.fromEntries(
      Object.keys(outcome)
        .sort()
        .map((key) => [
          key,
          key === "status" || key === "revision" || outcome[key] === null ? outcome[key] : "set",
        ]),
    ),
  };
}

/** Clones the owned candidate under a new id, as a later sweep would propose a competitor. */
async function cloneCandidate(label: string): Promise<string> {
  const id = `synthetic-candidate-${label}`;
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await env.DB.prepare(
    `INSERT INTO card_settlement_candidates
 (id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
 SELECT ?,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,?,created_at
 FROM card_settlement_candidates WHERE id=?`,
  )
    .bind(id, digest, owned)
    .run();
  return id;
}

const statusOf = async (id: string): Promise<string> =>
  (await env.DB.prepare("SELECT status FROM card_settlement_reviews WHERE id=?")
    .bind(id)
    .first<{ status: string }>())!.status;
const currentAllocations = () => count("current_allocations");

const resolver: IdentityResolver = (input) => ({
  account: {
    key: [input.sourceAccount],
    label: "synthetic",
    role: input.sourceId === "myjcb" ? "card-statement" : "deposit",
    status: "provider-local",
    reason: "test",
  },
  instruments: [],
  issues: [],
});

/** One sealed run of `source` with one published parse run; returns the parse run. */
async function seedParse(source: "myjcb" | "smbc-bank", parser: string): Promise<number> {
  const run = await seedRun({ source, count: 1 });
  const artifact = await env.DB.prepare(
    "SELECT id,fetch_run_id,source_id,producer_id FROM fetch_artifacts WHERE id=?",
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number; fetch_run_id: number; source_id: string; producer_id: string }>();
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,?,'1','2026-09-12T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(artifact!.id, parser)
    .first<{ id: number }>();
  return parse!.id;
}

async function identify(parseId: number): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT p.id,a.id AS artifact_id,a.source_id,a.producer_id,a.fetch_run_id
     FROM parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE p.id=?`,
  )
    .bind(parseId)
    .first<{
      id: number;
      artifact_id: number;
      source_id: string;
      producer_id: string;
      fetch_run_id: number;
    }>();
  await identifyParse(env.DB, row!, resolver);
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  await seedRegistry();
  await env.DB.batch(
    ["myjcb", "smbc-bank"].flatMap((source) => [
      env.DB.prepare(
        "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test',?)",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
      ).bind(source),
    ]),
  );
  const statement = await seedParse("myjcb", "myjcb-credit-statement-total");
  await env.DB.prepare(
    `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
     VALUES(?,'myjcb:synthetic:root','credit_statement_payment_amount',3000,'3000',0,'JPY','2026-09-01','synthetic-total',?)`,
  )
    .bind(
      statement,
      JSON.stringify({
        _kogane: {
          period: "2026-09",
          paymentDate: "2026-09-10",
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
  // The debit as the SMBC parser stores it: provider id, direction and origin.
  const bank = await seedParse("smbc-bank", "smbc-direct-transactions");
  const parsed = await smbcDirectTransactions.parse(
    new TextEncoder().encode(
      JSON.stringify({
        range: { start: "2026-09-01", end: "2026-09-30" },
        depositsTotal: 0,
        withdrawalsTotal: 3000,
        transactions: [
          {
            id: "synthetic-provider-debit",
            date: "2026-09-10T00:00:00+09:00",
            amount: 3000,
            balanceAfter: 7000,
            description: "synthetic",
            direction: "debit",
          },
        ],
      }),
    ),
    {
      id: bank,
      sourceId: "smbc-bank",
      runStatus: "success",
      runFailureCount: 0,
      dataset: "transactions-normalized",
      artifactKey: "transactions/20260901-20260930.normalized.json",
      url: null,
      mime: "application/json",
      fetchedAt: "2026-09-12T00:00:00.000Z",
      sha256: "0".repeat(64),
    },
  );
  for (const row of parsed.observations) {
    if (row.kind !== "transaction") continue;
    await env.DB.prepare(
      `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        bank,
        row.sourceAccount,
        row.externalId ?? null,
        row.status ?? null,
        row.amountMinor ?? null,
        row.amountText ?? null,
        row.amountScale ?? null,
        row.currency ?? null,
        row.counterparty ?? null,
        row.asOf ?? null,
        row.rawLocator,
        JSON.stringify(row.extra),
      )
      .run();
  }
  for (const id of [statement, bank]) {
    await publishParse(id);
    await identify(id);
  }
});
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${ISSUER}/cdn-cgi/access/certs`) return new Response(JSON.stringify(jwks));
      throw new Error("unexpected external request");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("card settlement decisions over the page's path and MCP (ADR 0081, unit 2g.2)", () => {
  it("records the ownership review over either path, with the same receipt", async () => {
    expect(await cardSettlementSweep(env.DB)).toMatchObject({ proposed: 1, written: 1 });
    const unowned = await env.DB.prepare("SELECT id FROM card_settlement_reviews").first<{
      id: string;
    }>();
    const proposalId = unowned!.id;
    // Each path reads the ownership review the page shows, then plans one side.
    const read = await send(
      `/api/v2/reconciliation/card-settlements/ownership?proposalId=${proposalId}`,
      { method: "GET" },
      APP_AUD,
    );
    expect(read.status).toBe(200);
    const page = (await read.json()) as CardOwnershipReview;
    const tool = await mcp("kogane.card-settlements.ownership", { proposalId });
    expect(tool.failed).toBe(false);
    expect(tool.body).toEqual(page);
    const side = (role: string) => {
      const found = page.sides.find((s) => s.role === role)!;
      expect(found.blockers).toEqual([]);
      return {
        payload: {
          relationKind: found.role,
          fromRef: `account:${found.accountId}`,
          toRef: PARTY,
          validFrom: null,
          validTo: null,
          evidenceRefs: found.evidenceRefs,
          reason: "synthetic reviewed ownership evidence",
        },
        base: `card-ownership:${proposalId}:${found.role}`,
      };
    };
    const card = side("liable_party");
    const bank = side("beneficial_owner");
    const overHttp = await decideOverHttp("relation.accept", card.payload, "own-card", card.base);
    const overMcp = await decideOverMcp("relation.accept", bank.payload, "own-bank", bank.base);
    expect(decided(overMcp)).toEqual(decided(overHttp));
    expect(overHttp.body.receipt.principal).toBe(OWNER);
    expect(overMcp.body.receipt.principal).toBe(MCP_PRINCIPAL);
    // Recording ownership accepts no settlement: the next sweep proposes a
    // fresh candidate that cites both claims, still `proposed`.
    expect(await cardSettlementSweep(env.DB)).toMatchObject({ written: 1 });
    const fresh = await env.DB.prepare(
      "SELECT id FROM card_settlement_reviews WHERE json_extract(facts_json,'$.ownership')='established-same'",
    ).first<{ id: string }>();
    owned = fresh!.id;
    expect(await statusOf(owned)).toBe("proposed");
    expect(await currentAllocations()).toBe(0);
  });

  it("accepts and withdraws over either path with the same receipts, and refuses alike", async () => {
    const competitor = await cloneCandidate("competitor");
    const accept = (proposalId: string) => ({ proposalId, reason: "synthetic reviewed match" });
    const withdraw = (proposalId: string) => ({ proposalId, reason: "synthetic correction" });

    const acceptedOverHttp = await decideOverHttp("card-settlement.accept", accept(owned), "a1");
    expect(await statusOf(owned)).toBe("accepted");
    expect(await currentAllocations()).toBe(1);

    // The same competing acceptance is refused with the same answer on both
    // paths, and neither writes a plan, an approval or a receipt.
    const before = [await count("change_plans"), await count("operation_receipts")];
    const competingOverHttp = await decideOverHttp(
      "card-settlement.accept",
      accept(competitor),
      "c-http",
    );
    const competingOverMcp = await decideOverMcp(
      "card-settlement.accept",
      accept(competitor),
      "c-mcp",
    );
    expect(competingOverHttp).toMatchObject({ failed: true, body: { error: "stale_context" } });
    expect(competingOverHttp.body.refs).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(competingOverMcp).toEqual(competingOverHttp);
    expect([await count("change_plans"), await count("operation_receipts")]).toEqual(before);

    const withdrawnOverHttp = await decideOverHttp(
      "card-settlement.withdraw",
      withdraw(owned),
      "w1",
    );
    expect(await statusOf(owned)).toBe("withdrawn");
    expect(await currentAllocations()).toBe(0);

    const acceptedOverMcp = await decideOverMcp("card-settlement.accept", accept(competitor), "a2");
    expect(decided(acceptedOverMcp)).toEqual(decided(acceptedOverHttp));
    expect(await statusOf(competitor)).toBe("accepted");
    expect(await currentAllocations()).toBe(1);

    const withdrawnOverMcp = await decideOverMcp(
      "card-settlement.withdraw",
      withdraw(competitor),
      "w2",
    );
    expect(decided(withdrawnOverMcp)).toEqual(decided(withdrawnOverHttp));
    expect(await statusOf(competitor)).toBe("withdrawn");
    expect(await currentAllocations()).toBe(0);

    // A withdrawn candidate cannot be accepted again, on either path.
    const settled = [await count("change_plans"), await count("operation_receipts")];
    const againOverHttp = await decideOverHttp("card-settlement.accept", accept(owned), "r-http");
    const againOverMcp = await decideOverMcp("card-settlement.accept", accept(owned), "r-mcp");
    expect(againOverHttp).toMatchObject({ failed: true, body: { error: "stale_context" } });
    expect(againOverMcp).toEqual(againOverHttp);
    expect([await count("change_plans"), await count("operation_receipts")]).toEqual(settled);

    // Withdrawal retracts the interpretation only: both accepted and both
    // withdrawn revisions stay in history.
    expect(await count("allocations")).toBe(2);
  });

  it("rejects over either path with the same receipt", async () => {
    const first = await cloneCandidate("rejected-http");
    const second = await cloneCandidate("rejected-mcp");
    const reject = (proposalId: string) => ({ proposalId, reason: "synthetic wrong debit" });
    const allocations = await count("allocations");
    const overHttp = await decideOverHttp("card-settlement.reject", reject(first), "j1");
    const overMcp = await decideOverMcp("card-settlement.reject", reject(second), "j2");
    expect(decided(overMcp)).toEqual(decided(overHttp));
    expect([await statusOf(first), await statusOf(second)]).toEqual(["rejected", "rejected"]);
    expect(await count("allocations")).toBe(allocations);
  });

  it("records each decision under its own path and principal (ADR 0064)", async () => {
    const rows = await env.DB.prepare(
      `SELECT path,principal,principal_kind,step FROM audit_records
       WHERE operation='command.commit' AND result='applied' ORDER BY path,recorded_at`,
    ).all<{ path: string; principal: string; principal_kind: string; step: string }>();
    const byPath = (path: string) => rows.results.filter((row) => row.path === path);
    // Ownership, accept, withdraw and reject on each path.
    expect(byPath("ui")).toHaveLength(4);
    expect(byPath("mcp")).toHaveLength(4);
    for (const row of byPath("ui")) expect(row.principal).toBe(OWNER);
    for (const row of byPath("mcp"))
      expect(row).toMatchObject({
        principal: MCP_PRINCIPAL,
        principal_kind: "delegated",
        step: "confirm",
      });
  });
});

describe("a plan payload's keys reach the Processor as sent", () => {
  it("refuses a `__proto__` payload key on the page's path and over MCP alike", async () => {
    const plans = await count("change_plans");
    // JSON.parse keeps `__proto__` as an own key, as a client's body does.
    const payload = JSON.parse('{"proposalId":"synthetic-absent","reason":"r","__proto__":"x"}');
    const page = await http("plan", { kind: "card-settlement.accept", payload });
    expect(page).toEqual({ failed: true, body: { error: "invalid_command" } });
    const route = pipeline.fetch.getMockImplementation()!;
    let forwarded = "";
    pipeline.fetch.mockImplementationOnce(async (request: Request) => {
      forwarded = await request.clone().text();
      return route(request);
    });
    const tool = await mcp("kogane.command.plan", {
      kind: "card-settlement.accept",
      payload,
      idempotencyKey: "synthetic-proto-payload",
    });
    expect(tool).toEqual(page);
    expect(await count("change_plans")).toBe(plans);
    // The Processor received the key, and the delegated digest the audit
    // record binds is the digest of exactly the body it received.
    const sent = JSON.parse(forwarded) as { payload: object };
    expect(Object.hasOwn(sent.payload, "__proto__")).toBe(true);
    const rows = (
      await env.DB.prepare(
        "SELECT * FROM audit_records WHERE idempotency_key='synthetic-proto-payload' AND path='mcp'",
      ).all<Record<string, unknown>>()
    ).results;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row["payload_digest"]).toBe(
        await canonicalDigest({
          v: "kogane-delegated-payload-v1",
          operation: row["operation"],
          payload: sent,
        }),
      );
      // Closed codes and refs only: no payload text reaches the record.
      expect(JSON.stringify(row)).not.toMatch(/synthetic-absent|__proto__/u);
    }
  });

  it("binds an idempotency key to the payload with its `__proto__` key, never without it", async () => {
    // The rejection planned over MCP under `j2-plan` above, as the plan stored it.
    const stored = await env.DB.prepare(
      "SELECT payload_json FROM change_plans WHERE kind='card-settlement.reject' AND created_by=?1",
    )
      .bind(MCP_PRINCIPAL)
      .first<{ payload_json: string }>();
    const { proposalId, reason } = JSON.parse(stored!.payload_json) as {
      proposalId: string;
      reason: string;
    };
    const plan = (payload: unknown) =>
      mcp("kogane.command.plan", {
        kind: "card-settlement.reject",
        payload,
        idempotencyKey: "j2-plan",
      });
    // Key order is not part of the payload: the same key answers the same plan.
    expect(await plan({ reason, proposalId })).toMatchObject({
      failed: false,
      body: { created: false },
    });
    // The same payload plus a `__proto__` key is another payload under that key.
    const forwarded = pipeline.fetch.mock.calls.length;
    const proto = JSON.parse(
      `{"reason":${JSON.stringify(reason)},"proposalId":${JSON.stringify(proposalId)},"__proto__":"x"}`,
    );
    expect(await plan(proto)).toEqual({ failed: true, body: { error: "idempotency_conflict" } });
    expect(pipeline.fetch.mock.calls.length).toBe(forwarded);
  });
});
