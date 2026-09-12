// The v2 balance read model over HTTP (review D10/D11, addendum A07).
//
// What is proved here: a fixed snapshot pages without duplicates or gaps even
// while new evidence is published between pages, a cursor is bound to its
// query and its snapshot, the compatibility route returns exactly what the
// current `/api/balances` returns, the 5,000 candidate bound and its 413 are
// unchanged, and no response ever carries a completed net worth.
//
// Every value is synthetic. No real account number, name or balance appears.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { runBalanceProjection } from "../../processor/src/balance-projection-job";
import { projectionPageSql } from "../../../packages/read-model/src/index";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";

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
  issuer = `https://balances-v2-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

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

/** `projection` switches the reader flag; it never changes authentication. */
async function call(path: string, options: { projection?: boolean } = {}) {
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      headers: { "cf-access-jwt-assertion": await token() },
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      BALANCE_PROJECTION_ENABLED: options.projection === false ? "0" : "1",
    } as Env,
  );
}

async function build() {
  return runBalanceProjection({ ...env, BALANCE_PROJECTION_ENABLED: "1" } as never, {
    writeBudget: 20_000,
  });
}

async function parseRun(artifactId: number, parser: string, version = "1"): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,?,?,'2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(artifactId, parser, version)
    .first<{ id: number }>();
  await publishParse(row!.id);
  return row!.id;
}

/** `count` synthetic balances on one account, one distinct metric each. */
async function seedBalances(parseId: number, account: string, count: number, prefix: string) {
  await env.DB.prepare(
    `INSERT INTO balance_observations
       (parse_run_id,source_account,metric,instrument,amount_minor,as_of,raw_locator,extra_json)
     WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?2)
     SELECT ?1,?3,printf('${prefix}-%05d',x),'JPY',x,'2026-09-07',?3||CAST(x AS TEXT),'{}' FROM n`,
  )
    .bind(parseId, count, account)
    .run();
}

interface LatestPage {
  schemaVersion: string;
  items: {
    observationId: number;
    row: { id: number; metric: string };
    quantity: { normalized: { status: string }; sourceRepresentation: Record<string, unknown> };
    metric: { metricId: string; aggregationRule: string };
    adoption: { state: string; reasonCode: string | null; evidenceCount: number };
    temporal: { role: string; time: { kind: string } };
    freshness: { state: string; reasonCode: string | null };
  }[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null; snapshotId: string };
  dataCoverage: { completeness: string; stale: boolean; reasons: string[] };
  subtotals: { liabilitiesCoverage: string; knownAssetsSubtotal: unknown };
}

describe("v2 balance read model", () => {
  it("advertises the v2 routes only once a snapshot exists, and reports rebuilding otherwise", async () => {
    // Before any build: the capability is off and the routes report rebuilding.
    const before = (await (await call("/api/meta")).json()) as {
      capabilities: {
        balancesV2: boolean;
        balancesV2Pagination: string;
        paginationVersion: string;
      };
    };
    expect(before.capabilities.balancesV2).toBe(false);
    expect(before.capabilities.balancesV2Pagination).toBe("none");
    expect((await call("/api/v2/balances/latest")).status).toBe(503);

    const run = await seedRun({ count: 1, source: "other-test" });
    const parse = await parseRun(run.artifacts[0].id, "v2-fixture");
    await seedBalances(parse, "v2-account", 3, "m");
    expect((await build()).status).toBe("complete");

    const after = (await (await call("/api/meta")).json()) as typeof before;
    expect(after.capabilities).toMatchObject({
      balancesV2: true,
      balancesV2Pagination: "keyset-v2",
      // The v1 routes keep their own pagination contract.
      paginationVersion: "offset-v1",
    });
    // With the reader flag off the capability is not advertised at all.
    const flagOff = (await (
      await call("/api/meta", { projection: false })
    ).json()) as typeof before;
    expect(flagOff.capabilities.balancesV2).toBe(false);
    expect((await call("/api/v2/balances/latest", { projection: false })).status).toBe(404);
  });

  it("returns typed quantities, measures, adoption and time, and never a net worth", async () => {
    const response = await call("/api/v2/balances/latest");
    expect(response.status).toBe(200);
    const body = (await response.json()) as LatestPage;
    expect(validApiResponse("/api/v2/balances/latest", body)).toBe(true);
    expect(body.schemaVersion).toBe("snapshot-page-v1");
    const item = body.items[0]!;
    expect(item.row.id).toBe(item.observationId);
    expect(item.quantity.normalized.status).toBe("exact");
    expect(Object.keys(item.quantity.sourceRepresentation).sort()).toEqual([
      "amountText",
      "legacyMinorUnitExponent",
      "legacyMinorUnits",
    ]);
    // An unknown provider column stays an unknown, non-additive measure.
    expect(item.metric).toMatchObject({ metricId: "unknown", aggregationRule: "non-additive" });
    expect(item.adoption.evidenceCount).toBe(1);
    expect(item.temporal).toEqual({
      role: "effective",
      time: { kind: "local-date", value: "2026-09-07", zone: null, basis: "provider" },
    });
    expect(item.freshness).toEqual({ state: "current", reasonCode: null });
    // Assets only, with liability coverage stated as unknown; never a total.
    expect(body.subtotals.liabilitiesCoverage).toBe("unknown");
    expect(JSON.stringify(body)).not.toContain("netWorth");
    expect(Object.hasOwn(body, "netWorth")).toBe(false);
  });

  it("pages 1,003 rows on a fixed snapshot with no duplicates or gaps while new evidence lands", async () => {
    const run = await seedRun({ count: 1, source: "other-test" });
    const parse = await parseRun(run.artifacts[0].id, "v2-paging-fixture");
    await seedBalances(parse, "v2-paging-account", 1003, "page");
    expect((await build()).status).toBe("complete");

    const base = "/api/v2/balances/latest?account=v2-paging-account&limit=500";
    const seen: number[] = [];
    let cursor: string | null = null;
    let snapshotId: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const suffix: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const body = (await (await call(`${base}${suffix}`)).json()) as LatestPage;
      expect(validApiResponse("/api/v2/balances/latest", body)).toBe(true);
      snapshotId ??= body.page.snapshotId;
      // Every page of the walk is the same fixed snapshot.
      expect(body.page.snapshotId).toBe(snapshotId);
      seen.push(...body.items.map((item) => item.observationId));
      cursor = body.page.nextCursor;
      if (page === 0) {
        // New evidence is published and a new snapshot is built between two
        // pages; the walk in progress must not see it.
        const later = await seedRun({ count: 1, source: "other-test" });
        const laterParse = await parseRun(later.artifacts[0].id, "v2-paging-later");
        await seedBalances(laterParse, "v2-paging-later-account", 5, "later");
        expect((await build()).status).toBe("complete");
      }
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(1003);
    expect(new Set(seen).size).toBe(1003);
    // Independent expected set: the ids of exactly those 1,003 observations.
    const expected = await env.DB.prepare(
      "SELECT id FROM balance_observations WHERE source_account='v2-paging-account' ORDER BY id",
    ).all<{ id: number }>();
    expect([...seen].sort((a, b) => a - b)).toEqual(expected.results.map((row) => row.id));
  });

  it("pages 5,002 history rows by keyset without duplicates or gaps", async () => {
    // History is larger than the latest list on purpose: one reparse of the
    // same 2,501 measures leaves 5,002 recorded observations and 2,501
    // current ones, which is exactly the split the two routes serve.
    const run = await seedRun({ count: 1, source: "other-test" });
    const first = await parseRun(run.artifacts[0].id, "v2-history-fixture");
    await seedBalances(first, "v2-history-account", 2501, "hist");
    const second = await parseRun(run.artifacts[0].id, "v2-history-fixture", "2");
    await env.DB.prepare("UPDATE parse_runs SET superseded_by_parse_run_id=?2 WHERE id=?1")
      .bind(first, second)
      .run();
    await seedBalances(second, "v2-history-account", 2501, "hist");
    expect((await build()).status).toBe("complete");
    const base = "/api/v2/balances/history?account=v2-history-account&limit=500";
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 12; page += 1) {
      const suffix: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const body = (await (await call(`${base}${suffix}`)).json()) as {
        items: { observationId: number }[];
        page: { nextCursor: string | null; snapshotId: string };
      };
      expect(validApiResponse("/api/v2/balances/history", body)).toBe(true);
      seen.push(...body.items.map((item) => item.observationId));
      cursor = body.page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(5002);
    expect(new Set(seen).size).toBe(5002);
    // The latest list of the same account is the current half only.
    const latest = (await (
      await call("/api/v2/balances/latest?account=v2-history-account&limit=500")
    ).json()) as LatestPage;
    expect(latest.page.hasMore).toBe(true);
    // The oversized run leaves the financial views so the remaining checks
    // read a store the projection can rebuild quickly.
    await env.DB.prepare(
      "INSERT INTO fetch_run_annotations VALUES (?, 'exclude_from_financial_views', 'synthetic-fixture', 0)",
    )
      .bind(run.id)
      .run();
    expect((await build()).status).toBe("complete");
  }, 180_000);

  it("keeps the 5,000 candidate bound and its 413 on the v1 list", async () => {
    const run = await seedRun({ count: 1, source: "other-test" });
    const parse = await parseRun(run.artifacts[0].id, "v2-oversized-fixture");
    await seedBalances(parse, "v2-oversized-account", 5002, "over");
    // The projection refuses to build rather than projecting a partial set,
    // and v1 still answers 413 with the flag on and with it off.
    expect((await build()).status).toBe("refused");
    for (const projection of [true, false])
      expect((await call("/api/balances", { projection })).status).toBe(413);
    await env.DB.prepare(
      "INSERT INTO fetch_run_annotations VALUES (?, 'exclude_from_financial_views', 'synthetic-fixture', 0)",
    )
      .bind(run.id)
      .run();
    expect((await build()).status).toBe("complete");
  }, 180_000);

  it("refuses a cursor from another query and an expired snapshot", async () => {
    const first = (await (await call("/api/v2/balances/latest?limit=50")).json()) as LatestPage;
    expect(first.page.nextCursor).not.toBeNull();
    const cursor = encodeURIComponent(first.page.nextCursor!);
    // A different filter set is a different query: the cursor is refused, not
    // reinterpreted against the new filter.
    const mismatch = await call(
      `/api/v2/balances/latest?limit=50&source=other-test&cursor=${cursor}`,
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: "cursor_mismatch" });
    // A different page size is also a different query.
    expect((await call(`/api/v2/balances/latest?limit=100&cursor=${cursor}`)).status).toBe(400);
    // A malformed cursor is refused before any read.
    const malformed = await call("/api/v2/balances/latest?cursor=not-a-cursor");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid_cursor" });

    // The snapshot the cursor names is retired and dropped: the reader is
    // told the context expired, never moved silently to a newer list.
    await env.READ.prepare(
      "UPDATE balance_read_snapshots SET status='retired' WHERE snapshot_id=?1",
    )
      .bind(first.page.snapshotId)
      .run();
    await env.READ.prepare("DELETE FROM current_balance_projection WHERE snapshot_id=?1")
      .bind(first.page.snapshotId)
      .run();
    const expired = await call(`/api/v2/balances/latest?limit=50&cursor=${cursor}`);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ error: "context_expired" });
  });

  it("shows a scope nobody re-observed as stale, with the failure alongside", async () => {
    const run = await seedRun({ count: 1, source: "other-test", dataset: "stale-fixture" });
    const parse = await parseRun(run.artifacts[0].id, "v2-stale-fixture");
    await seedBalances(parse, "v2-stale-account", 1, "stale");
    // A later published attempt over the same dataset failed to fetch, so it
    // observed nothing new: the previous row is kept and marked stale rather
    // than disappearing (SC15).
    const later = await seedRun({ count: 1, source: "other-test", dataset: "stale-fixture" });
    const laterParse = await parseRun(later.artifacts[0].id, "v2-stale-fixture", "2");
    await env.DB.prepare(
      `INSERT INTO parse_coverage_claims
         (parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,observed_count,
          expected_count,evidence_refs_json,policy_version,failure_cause,absence_meaning,
          parent_run_status,parent_run_failure_count)
       VALUES (?1,'cov:stale','other-test/stale-fixture','complete-container','unknown',0,0,NULL,
          '[]','coverage-v1','fetch_failed','not-observed','success',0)`,
    )
      .bind(laterParse)
      .run();
    expect((await build()).status).toBe("complete");
    const body = (await (
      await call("/api/v2/balances/latest?account=v2-stale-account")
    ).json()) as LatestPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.adoption.state).toBe("stale");
    expect(body.items[0]!.freshness).toEqual({ state: "stale", reasonCode: "no_new_observation" });
    expect(body.dataCoverage.stale).toBe(true);
    expect(body.dataCoverage.completeness).toBe("partial");
    expect(body.dataCoverage.reasons).toContain("stale:no_new_observation");
  });

  it("serves the v1 list from the projection with exactly the rows it serves today", async () => {
    const run = await seedRun({ count: 1, source: "other-test", dataset: "parity-fixture" });
    const parse = await parseRun(run.artifacts[0].id, "v2-parity-fixture");
    await seedBalances(parse, "v2-parity-account", 40, "parity");
    expect((await build()).status).toBe("complete");
    const base = "/api/balances?source=other-test&account=v2-parity-account";
    const legacy = (await (await call(base, { projection: false })).json()) as {
      latest: unknown[];
    };
    const viaProjection = (await (await call(base)).json()) as typeof legacy;
    expect(viaProjection.latest).toEqual(legacy.latest);
    // Independently of the comparison: the expected set is the 40 rows.
    expect(legacy.latest).toHaveLength(40);
    expect(validApiResponse("/api/balances", viaProjection)).toBe(true);
  });

  it("reads a page through the projection order index, not a re-grouping scan", async () => {
    const query = projectionPageSql("a".repeat(64), { account: "v2-parity-account" }, 100, -1);
    const plan = await env.READ.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...query.args)
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(" | ");
    expect(detail).toContain("current_balance_projection_order");
    // A page is a keyed range scan: no re-ranking, no grouping, no temporary
    // sort of the whole candidate set on every request.
    expect(detail).not.toContain("SCAN current_balance_projection");
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/u);
  });
});
