// An MCP client's decisions go through the same command layer
// (`kogane.command.approve` / `kogane.command.commit` → the change lifecycle),
// so a plan for an account pair (ADR 0077) is refused as stale over MCP when a
// decision was recorded under another of the pair's references in between,
// as it is on the confirmation screen (docs/change-lifecycle.md "Pair pins").
// Real Worker, official MCP transport and the real CORE migrations; every
// producer, connection key, account and identity here is synthetic.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { createPlan, d1CommandStore } from "../../../packages/application/src/index";
import { changeCommandRoute } from "../../processor/src/change-commands";
import { seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const OWNER = "owner-pair-pins-synthetic";
const APP_AUD = "fixture-browser-audience";
const MCP_AUD = "fixture-mcp-audience";
const ISSUER = "https://pair-pins.cloudflareaccess.com";
const KEY = `moneyforward-account-v2-${"e".repeat(64)}`;
const SECOND_PRODUCER = "evidence-test-second";
const OWN = `connection:evidence-test/${KEY}`;
const OTHER = `connection:${SECOND_PRODUCER}/${KEY}`;
const DIRECT = "source_account:sa-pair-pins-direct";
const triple = (fromRef: string) => `relation:connection_contains|${fromRef}|${DIRECT}`;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let id = 0;

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producers (id,kind,display_name) VALUES (?,'collector','Synthetic second fixture')",
    ).bind(SECOND_PRODUCER),
    env.DB.prepare(
      "INSERT INTO ingest_client_producers (ingest_client_id,producer_id) VALUES ('evidence-test',?)",
    ).bind(SECOND_PRODUCER),
    ...["evidence-test", SECOND_PRODUCER].flatMap((producer) => [
      env.DB.prepare(
        "INSERT INTO producer_sources(producer_id,source_id) VALUES(?,'moneyforward-me')",
      ).bind(producer),
      env.DB.prepare(
        "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test',?,'moneyforward-me')",
      ).bind(producer),
    ]),
  ]);
  // Two producers' reviews of one identity value: one connection, two
  // references a decision on the pair may be recorded under.
  for (const producer of ["evidence-test", SECOND_PRODUCER]) {
    const run = await seedRun({
      source: "moneyforward-me",
      count: 1,
      dataset: "account-detail",
      fetchUnitKey: KEY,
      producer,
    });
    await env.DB.prepare(`INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,
      reason,verifier_version,detail_artifact_id,direct_reference_ids_json,created_at)
      VALUES(?,?,1,'Synthetic bank (aggregator)','unresolved','synthetic','fixture',?,'[]','2099')`)
      .bind(producer, KEY, run.artifacts[0]!.id)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO source_accounts (id,source_id,producer_id,reference_json) VALUES ('sa-pair-pins-direct','sony-bank','evidence-test','[\"sa-pair-pins-direct\"]')",
  ).run();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
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
afterEach(() => vi.unstubAllGlobals());

const pipeline = {
  fetch: async (request: Request) => {
    const response = await changeCommandRoute(
      env as Parameters<typeof changeCommandRoute>[0],
      request,
      new URL(request.url).pathname,
    );
    if (!response) throw new Error("unexpected pipeline route");
    return response;
  },
};

async function invoke(name: string, args: unknown) {
  const token = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(ISSUER)
    .setAudience(MCP_AUD)
    .setSubject(OWNER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  const response = await worker.fetch(
    new Request("https://fixture.test/mcp", {
      method: "POST",
      headers: {
        ...MCP_CLIENT_HEADERS,
        "mcp-protocol-version": "2025-11-25",
        "cf-access-jwt-assertion": token,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    {
      ...env,
      ACCESS_ISSUER: ISSUER,
      ACCESS_AUDIENCE: APP_AUD,
      ACCESS_MCP_AUDIENCE: MCP_AUD,
      OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
      COMMANDS_ENABLED: "true",
      PIPELINE: pipeline,
    } as Env,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: { structuredContent: any; isError?: boolean } })
    .result;
}

async function plan(kind: "relation.accept" | "relation.reject", fromRef: string) {
  const planned = await createPlan(
    kind,
    {
      relationKind: "connection_contains",
      fromRef,
      toRef: DIRECT,
      validFrom: null,
      validTo: null,
      evidenceRefs: [],
      reason: "synthetic pair decision",
    },
    {
      actor: {
        id: OWNER,
        kind: "human",
        verification: "server",
        capabilities: ["interpretation.propose", "interpretation.accept"],
      },
      baseContextId: "account-candidates:mcp-test",
      now: new Date().toISOString(),
      ttlSeconds: 900,
    },
    d1CommandStore(env.DB),
  );
  if (!planned.ok) throw new Error(planned.error);
  return planned.plan;
}

/** `kogane.command.approve` through its prepare and confirm steps. */
async function approveOverMcp(target: { planId: string; planDigest: string }, key: string) {
  const body = {
    planId: target.planId,
    planDigest: target.planDigest,
    scope: [],
    idempotencyKey: key,
  };
  const prepared = await invoke("kogane.command.approve", { ...body, step: "prepare" });
  expect(prepared.isError).not.toBe(true);
  return invoke("kogane.command.approve", {
    ...body,
    step: "confirm",
    confirmationDigest: prepared.structuredContent.confirmation.digest,
  });
}

/** `kogane.command.commit` through its prepare and confirm steps. */
async function commitOverMcp(planId: string, approvalId: string, operationId: string) {
  const body = { planId, approvalId, operationId };
  const prepared = await invoke("kogane.command.commit", { ...body, step: "prepare" });
  if (prepared.isError) return prepared;
  return invoke("kogane.command.commit", {
    ...body,
    step: "confirm",
    confirmationDigest: prepared.structuredContent.confirmation.digest,
  });
}

const rowsOf = async (fromRef: string) =>
  (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM entity_relations WHERE kind='connection_contains' AND from_ref=? AND to_ref=?",
    )
      .bind(fromRef, DIRECT)
      .first<{ n: number }>()
  )?.n;

it("a decision under the pair's other reference makes an MCP approval and commit stale", async () => {
  // Planned, approved and prepared for commit over MCP before anything else
  // is recorded.
  const accept = await plan("relation.accept", OWN);
  expect(accept.expectedRevisions).toEqual({ [triple(OWN)]: 0, [triple(OTHER)]: 0 });
  const approved = await approveOverMcp(accept, "pair-pins-accept-approve");
  expect(approved.isError).not.toBe(true);
  const commitBody = {
    planId: accept.planId,
    approvalId: approved.structuredContent.approval.approvalId as string,
    operationId: "pair-pins-accept-commit",
  };
  const prepared = await invoke("kogane.command.commit", { ...commitBody, step: "prepare" });
  expect(prepared.isError).not.toBe(true);
  // Planned, not yet approved.
  const late = await plan("relation.reject", OWN);

  // The pair is kept apart under the other producer's reference, over MCP.
  const other = await plan("relation.reject", OTHER);
  const otherApproval = await approveOverMcp(other, "pair-pins-other-approve");
  expect(otherApproval.isError).not.toBe(true);
  const otherCommit = await commitOverMcp(
    other.planId,
    otherApproval.structuredContent.approval.approvalId as string,
    "pair-pins-other-commit",
  );
  expect(otherCommit.isError).not.toBe(true);
  expect(await rowsOf(OTHER)).toBe(1);

  // Confirming the prepared commit, or preparing it again, is refused as
  // stale, and nothing is written under the plan's own reference.
  const confirmed = await invoke("kogane.command.commit", {
    ...commitBody,
    step: "confirm",
    confirmationDigest: prepared.structuredContent.confirmation.digest,
  });
  expect(confirmed.isError).toBe(true);
  expect(confirmed.structuredContent.error).toBe("stale_context");
  const again = await invoke("kogane.command.commit", { ...commitBody, step: "prepare" });
  expect(again.isError).toBe(true);
  expect(again.structuredContent.error).toBe("stale_context");
  expect(await rowsOf(OWN)).toBe(0);

  // The plan made before that decision is refused at approval too.
  const body = { planId: late.planId, planDigest: late.planDigest, scope: [] };
  const lateApproval = await invoke("kogane.command.approve", {
    ...body,
    idempotencyKey: "pair-pins-late-approve",
    step: "prepare",
  });
  expect(lateApproval.isError).toBe(true);
  expect(lateApproval.structuredContent.error).toBe("stale_context");
  expect(await rowsOf(OWN)).toBe(0);
});
