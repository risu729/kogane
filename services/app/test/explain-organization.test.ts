// `kogane.explain` over the served Worker reads the organization the
// observation detail route reads, so a mapped observation's graph has its
// adopted-claim and identity-decision levels (ADR 0081 amendment 2026-11-21).
// A synthetic store: nothing here is a real account, name, amount or token.
//
// What these checks pin:
// - agent HTTP and MCP answer the same graph, and its mapping refs name the
//   revision the detail route shows for the same observation;
// - the levels sit at the depths `explain` gives them, and a depth bound cuts
//   them like any other level;
// - under `latest` a mapping correction changes the graph's refs and not the
//   `contextId`, which pins the identity mode and release, not revisions;
// - ids only: no label, reason, account entity or identifier value;
// - a scoped grant sees its own row's mapping and nothing of a row outside
//   it, whose refusal equals an absent ref's (SC18).
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { evidenceReader } from "../src/observations";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";
import {
  explain,
  fullGrant,
  type Grant,
  openContext,
  organizedExplainReader,
} from "../../../packages/application/src/index";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import {
  interpretationContext,
  LATEST_IDENTITY_RELEASE,
  type SqlExecutor,
} from "../../../packages/read-model/src/index";

const MCP_AUDIENCE = "fixture-mcp-audience";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

beforeAll(async () => {
  await seedRegistry();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://explain-org-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function call(path: string, body?: unknown): Promise<Response> {
  const jwt = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(path === "/mcp" ? MCP_AUDIENCE : "fixture-audience")
    .setSubject("explain-principal")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "cf-access-jwt-assertion": jwt,
        ...(path === "/mcp" ? MCP_CLIENT_HEADERS : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
    } as Env,
  );
}

interface Graph {
  contextId: string;
  rootRef: string;
  depth: number;
  truncated: boolean;
  restricted: string[];
  nodes: { ref: string; kind: string; depth: number; parents: string[] }[];
}

async function agentExplain(ref: string, depth?: number): Promise<Graph> {
  const response = await call("/api/agent/v1/explain", depth ? { ref, depth } : { ref });
  expect(response.status).toBe(200);
  return (await response.json()) as Graph;
}

async function mcpExplain(ref: string, depth?: number): Promise<Graph> {
  const response = await call("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "kogane.explain", arguments: depth ? { ref, depth } : { ref } },
  });
  const message = (await response.json()) as {
    result: { isError?: boolean; structuredContent: Graph };
  };
  expect(message.result.isError ?? false).toBe(false);
  return message.result.structuredContent;
}

/**
 * One published transaction organized by a sealed identity run, with a rule
 * account mapping and a rule unit mapping at revision 1. `entity` lets two
 * source accounts map onto one account entity.
 */
async function seedMapped(tag: string, entity = `${tag}-entity`) {
  const run = await seedRun({ count: 1, source: "other-test" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'explain-org-fixture','1','2099','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  const account = `${tag}-account`;
  const observation = await env.DB.prepare(
    `INSERT INTO transaction_observations (parse_run_id,source_account,currency,raw_locator,extra_json) VALUES (?,?,'JPY','synthetic','{}') RETURNING id`,
  )
    .bind(parse!.id, account)
    .first<{ id: number }>();
  const id = (name: string) => `${tag}-${name}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO source_accounts VALUES (?,'other-test','evidence-test',?)`).bind(
      id("ref"),
      JSON.stringify([account]),
    ),
    env.DB.prepare(
      `INSERT INTO accounts SELECT ?,'合成口座ラベル','cash','provider-local' WHERE NOT EXISTS(SELECT 1 FROM accounts WHERE id=?)`,
    ).bind(entity, entity),
    env.DB.prepare(
      `INSERT INTO account_mappings VALUES (?,?,1,?,'rule','synthetic-rule-reason',1,'2099','合成口座ラベル','provider-local')`,
    ).bind(id("am1"), id("ref"), entity),
    env.DB.prepare(`INSERT INTO instruments VALUES (?,'money','JPY','identified')`).bind(
      id("instrument"),
    ),
    env.DB.prepare(`INSERT INTO instrument_identifiers VALUES (?,'iso4217',?,'JPY','{}')`).bind(
      id("ident"),
      id("scope"),
    ),
    env.DB.prepare(
      `INSERT INTO instrument_mappings VALUES (?,?,1,?,'rule','synthetic-unit-reason',1,'2099','合成通貨ラベル','identified')`,
    ).bind(id("im1"), id("ident"), id("instrument")),
    env.DB.prepare(`INSERT INTO identity_runs VALUES (?,?,1,'2099')`).bind(id("run"), parse!.id),
    env.DB.prepare(`INSERT INTO identity_observations VALUES (?,?,'transaction',?,?,?,'[]')`).bind(
      id("io"),
      id("run"),
      observation!.id,
      id("ref"),
      id("am1"),
    ),
    env.DB.prepare(`INSERT INTO identity_instrument_uses VALUES (?,'unit',?,?)`).bind(
      id("io"),
      id("ident"),
      id("im1"),
    ),
    env.DB.prepare(`INSERT INTO identity_run_seals VALUES (?,1,'2099')`).bind(id("run")),
  ]);
  return {
    account,
    observationRef: `observation:transaction:${String(observation!.id)}`,
    detailPath: `/api/observations/transaction/${String(observation!.id)}`,
    accountRef: id("ref"),
    identifierRef: id("ident"),
    entity,
    /** A manual correction of the account mapping: revision 2. */
    correct: () =>
      env.DB.prepare(
        `INSERT INTO account_mappings VALUES (?,?,2,?,'manual','synthetic-manual-reason',2,'2100','合成口座ラベル','identified')`,
      )
        .bind(id("am2"), id("ref"), entity)
        .run(),
  };
}

/** The organization levels of a graph, in graph order. */
const levels = (graph: Graph) =>
  graph.nodes.filter((node) => node.kind === "adopted-claim" || node.kind === "identity-decision");

describe("a served graph has the organization levels", () => {
  it("agent HTTP and MCP answer the same graph, at the detail route's revisions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const fixture = await seedMapped("served");
    const http = await agentExplain(fixture.observationRef);
    const mcp = await mcpExplain(fixture.observationRef);
    expect(mcp).toEqual(http);

    const claim = `account_mapping:${fixture.accountRef}@1`;
    expect(levels(http)).toEqual([
      { ref: claim, kind: "adopted-claim", depth: 2, parents: [fixture.observationRef] },
      {
        ref: `identity-decision:rule:${fixture.accountRef}@1`,
        kind: "identity-decision",
        depth: 3,
        parents: [claim],
      },
      {
        ref: `instrument_mapping:${fixture.identifierRef}@1`,
        kind: "adopted-claim",
        depth: 2,
        parents: [fixture.observationRef],
      },
    ]);
    // Every level is still there: the scope, the parse run and the locators.
    expect(new Set(http.nodes.map((node) => node.kind))).toEqual(
      new Set([
        "result-row",
        "scope",
        "adopted-claim",
        "identity-decision",
        "parse-run",
        "raw-locator",
      ]),
    );

    // The observation detail route organizes the same row with the same function.
    const detailResponse = await call(fixture.detailPath);
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      organization: {
        account: { referenceId: string; revision: number; method: string };
        instruments: { referenceId: string; revision: number }[];
      };
      interpretationContext: { mode: string; identityRelease: string };
    };
    const { account, instruments } = detail.organization;
    expect(claim).toBe(`account_mapping:${account.referenceId}@${String(account.revision)}`);
    expect(levels(http).map((node) => node.ref)).toContain(
      `identity-decision:${account.method}:${account.referenceId}@${String(account.revision)}`,
    );
    expect(levels(http).map((node) => node.ref)).toContain(
      `instrument_mapping:${instruments[0]!.referenceId}@${String(instruments[0]!.revision)}`,
    );
    expect(detail.interpretationContext).toMatchObject({
      mode: "latest",
      identityRelease: LATEST_IDENTITY_RELEASE,
    });
  });

  it("a depth bound cuts the decision level and keeps the claims", async () => {
    const fixture = await seedMapped("depth");
    for (const graph of [
      await agentExplain(fixture.observationRef, 2),
      await mcpExplain(fixture.observationRef, 2),
    ]) {
      expect(graph.truncated).toBe(true);
      expect(levels(graph).map((node) => node.kind)).toEqual(["adopted-claim", "adopted-claim"]);
      expect(graph.nodes.every((node) => node.depth <= 2)).toBe(true);
    }
  });

  it("ids only: no label, reason, account entity or identifier value", async () => {
    const fixture = await seedMapped("ids-only");
    for (const graph of [
      await agentExplain(fixture.observationRef),
      await mcpExplain(fixture.observationRef),
    ]) {
      const serialized = JSON.stringify(graph);
      for (const hidden of [
        "合成口座ラベル",
        "合成通貨ラベル",
        "synthetic-rule-reason",
        "synthetic-unit-reason",
        fixture.entity,
        `${"ids-only"}-instrument`,
        `${"ids-only"}-scope`,
        "iso4217",
        "provider-local",
      ])
        expect(serialized).not.toContain(hidden);
    }
  });

  it("under latest a correction moves the graph's revision and not the contextId", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const fixture = await seedMapped("corrected");
    const before = await agentExplain(fixture.observationRef);
    await fixture.correct();
    const after = await agentExplain(fixture.observationRef);
    // The context pins `identity:latest:current-mappings-v1`, not revisions:
    // the answer names the revision it read instead.
    expect(after.contextId).toBe(before.contextId);
    expect(levels(before).map((node) => node.ref)).toContain(
      `account_mapping:${fixture.accountRef}@1`,
    );
    expect(levels(after).map((node) => node.ref)).toEqual([
      `account_mapping:${fixture.accountRef}@2`,
      `identity-decision:manual:${fixture.accountRef}@2`,
      `instrument_mapping:${fixture.identifierRef}@1`,
    ]);
    expect(await mcpExplain(fixture.observationRef)).toEqual(after);
  });
});

describe("a scoped grant (SC18)", () => {
  async function scopedExplain(
    grant: Grant,
    ref: string,
    sql: SqlExecutor = d1Executor(env.DB),
    depth: number | null = null,
  ) {
    const opened = await openContext(grant, {
      now: "2026-09-09T00:00:00Z",
      publicationHighWater: "published-parse-runs@1",
      parserBuildDigest: "0".repeat(64),
      visibleSources: ["other-test"],
      interpretation: interpretationContext("latest", LATEST_IDENTITY_RELEASE),
    });
    return explain({
      grant,
      opened,
      reader: organizedExplainReader(evidenceReader(env.DB), sql),
      request: { ref, depth },
    });
  }

  /** The organization read's statements, so a test can say what one call read. */
  function countingExecutor(): SqlExecutor & { statements: string[] } {
    const inner = d1Executor(env.DB);
    const statements: string[] = [];
    return {
      statements,
      all: (sql, args) => {
        statements.push(sql);
        return inner.all(sql, args);
      },
      first: (sql, args) => {
        statements.push(sql);
        return inner.first(sql, args);
      },
    };
  }

  it("sees its own row's mapping and nothing of a row outside the grant", async () => {
    // Two source accounts mapped onto one account entity: the grant holds one.
    const inside = await seedMapped("scope-in", "scope-shared-entity");
    const outside = await seedMapped("scope-out", "scope-shared-entity");
    const base = fullGrant("scoped-principal");
    const grant: Grant = {
      ...base,
      scopes: { sources: ["other-test"], accounts: [inside.account] },
    };

    const shown = await scopedExplain(grant, inside.observationRef);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(levels(shown.graph).map((node) => node.ref)).toEqual([
      `account_mapping:${inside.accountRef}@1`,
      `identity-decision:rule:${inside.accountRef}@1`,
      `instrument_mapping:${inside.identifierRef}@1`,
    ]);
    // Neither the shared entity nor anything of the other source account.
    const serialized = JSON.stringify(shown.graph);
    for (const hidden of ["scope-shared-entity", "scope-out", outside.account])
      expect(serialized).not.toContain(hidden);

    // The row outside the grant answers as a ref that names nothing.
    const hidden = await scopedExplain(grant, outside.observationRef);
    const absent = await scopedExplain(grant, "observation:transaction:999999999");
    expect(hidden.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (hidden.ok || absent.ok) return;
    expect(hidden.error).toEqual(absent.error);
    expect(hidden.error.code).toBe("evidence_restricted");
  });

  it("a corrected second account on the shared entity changes neither the graph nor what it reads", async () => {
    // Baseline: one source account alone on its entity.
    const solo = await seedMapped("adv-solo");
    const soloGrant: Grant = {
      ...fullGrant("scoped-principal"),
      scopes: { sources: ["other-test"], accounts: [solo.account] },
    };
    const soloSql = countingExecutor();
    const baseline = await scopedExplain(soloGrant, solo.observationRef, soloSql);
    // The same shape with a second, out-of-scope source account on the
    // entity, whose mapping the owner has since corrected by hand (@2).
    const inside = await seedMapped("adv-in", "adv-shared-entity");
    const outside = await seedMapped("adv-out", "adv-shared-entity");
    await outside.correct();
    const grant: Grant = {
      ...fullGrant("scoped-principal"),
      scopes: { sources: ["other-test"], accounts: [inside.account] },
    };
    const insideSql = countingExecutor();
    const shown = await scopedExplain(grant, inside.observationRef, insideSql);
    if (!baseline.ok || !shown.ok) throw new Error("expected two graphs");
    // Same kinds, depths, parents and organization refs once the tags are
    // named alike: no node count or revision says the entity is shared.
    const shape = (nodes: Graph["nodes"], tag: string) =>
      nodes.map((node) => [
        node.kind,
        node.depth,
        node.parents.length,
        node.kind === "adopted-claim" || node.kind === "identity-decision"
          ? node.ref.replaceAll(tag, "TAG")
          : "",
      ]);
    expect(shape(shown.graph.nodes, "adv-in")).toEqual(shape(baseline.graph.nodes, "adv-solo"));
    const serialized = JSON.stringify(shown.graph);
    for (const hidden of ["adv-out", "adv-shared-entity", "@2", "manual"])
      expect(serialized).not.toContain(hidden);
    // The organization read runs the same statements for both rows.
    expect(insideSql.statements.length).toBeGreaterThan(0);
    expect(insideSql.statements).toEqual(soloSql.statements);

    // The out-of-scope row reads no organization at any depth, and answers as
    // a ref that names nothing.
    for (const depth of [1, 2, null]) {
      const hiddenSql = countingExecutor();
      const absentSql = countingExecutor();
      const hidden = await scopedExplain(grant, outside.observationRef, hiddenSql, depth);
      const absent = await scopedExplain(
        grant,
        "observation:transaction:999999999",
        absentSql,
        depth,
      );
      if (hidden.ok || absent.ok) throw new Error("expected two refusals");
      expect(hidden.error).toEqual(absent.error);
      expect(hiddenSql.statements).toEqual([]);
      expect(absentSql.statements).toEqual([]);
    }
  });
});
