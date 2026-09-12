// The v2 balance routes served from the READ database (unified plan 04, 05;
// U11) over HTTP, with the read migrations applied to a local D1.
//
// What is proved here:
//   G3-01  no published snapshot is `unavailable` (503 with a code), never an
//          empty success;
//   G3-02  a CORE restored under a new epoch invalidates the snapshot;
//   G3-03  a cursor from another read model — a rebuilt READ database, or the
//          CORE projection this deployment no longer reads — is 410
//          `context_expired`;
//   G3-04  a new use restriction refuses the whole snapshot, subtotals
//          included, instead of filtering rows out of a stale aggregate;
//   G0-11  a saved report keeps its fixed body in CORE and DATA: it answers
//          with every READ table dropped.
//
// Every value is synthetic. No real account number, name or balance appears.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { reportsApi } from "../src/reports-api";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { runBalanceProjection } from "../../processor/src/balance-projection-job";
import { decodeReadCursor, encodeReadCursor } from "../../../packages/storage-d1/src/read/index";
import { canonicalJson, type ReportBody } from "../../../packages/domain/src/index";

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
  issuer = `https://balances-read-test-${++sequence}.cloudflareaccess.com`;
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

/** `read` switches the store the routes read; it never changes authentication. */
async function call(path: string, options: { read?: boolean } = {}) {
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      headers: { "cf-access-jwt-assertion": await token() },
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      BALANCE_PROJECTION_ENABLED: "1",
      READ_PROJECTION_ENABLED: options.read === false ? "false" : "true",
    } as Env,
  );
}

/** One build into the READ database, through the processor's own job. */
async function build(options: { read?: boolean } = {}) {
  return runBalanceProjection(
    {
      ...env,
      BALANCE_PROJECTION_ENABLED: "1",
      READ_PROJECTION_ENABLED: options.read === false ? "false" : "true",
    } as never,
    { writeBudget: 20_000 },
  );
}

let nextAccount = 0;

/** One published parse with `count` synthetic balances on one account. */
async function seedProjection(count = 3): Promise<void> {
  const account = `read-account-${++nextAccount}`;
  const run = await seedRun({ count: 1, source: "other-test" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,'read-fixture','1','2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.prepare(
    `INSERT INTO balance_observations
       (parse_run_id,source_account,metric,instrument,amount_minor,as_of,raw_locator,extra_json)
     WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?2)
     SELECT ?1,?3,printf('rm-%05d',x),'JPY',x,'2026-09-07',?3||CAST(x AS TEXT),'{}' FROM n`,
  )
    .bind(parse!.id, count, account)
    .run();
}

interface Page {
  items: { observationId: number }[];
  page: { hasMore: boolean; nextCursor: string | null; snapshotId: string };
  subtotals?: { knownAssetsSubtotal: unknown };
}

const READ_TABLES = [
  "read_build_checkpoints",
  "scope_relations",
  "snapshot_input_refs",
  "current_balance_projection",
  "balance_snapshot_pointer",
  "balance_read_snapshots",
  // The reward second stage of migration 0002 (U16) is in the same database:
  // "every READ table" includes it, and the reset re-applies both migrations.
  "reward_build_checkpoints",
  "reward_conversion_simulations",
  "reward_expiry_estimates",
  "reward_snapshot_input_refs",
  "reward_snapshot_pointer",
  "reward_expiry_snapshots",
  "read_instance",
];

describe("the v2 balance routes over the READ database", () => {
  it("G3-01: answers unavailable with a code while nothing is published, never an empty list", async () => {
    // Nothing has been built into READ: the capability is off and the route
    // says so with 503, not with `items: []`.
    const meta = (await (await call("/api/meta")).json()) as {
      capabilities: { balancesV2: boolean; balancesV2ReadModel: string };
    };
    expect(meta.capabilities.balancesV2).toBe(false);
    expect(meta.capabilities.balancesV2ReadModel).toBe("none");
    const empty = await call("/api/v2/balances/latest");
    expect(empty.status).toBe(503);
    expect(((await empty.json()) as { error: string }).error).toBe("read_model_unavailable");
    expect((await call("/api/v2/balances/history")).status).toBe(503);
  });

  it("serves a page from READ and advertises which store answered", async () => {
    await seedProjection(3);
    expect((await build()).status).toBe("complete");
    // The rows are in READ; CORE's retired projection tables are absent.
    expect(
      (await env.READ.prepare("SELECT count(*) AS n FROM current_balance_projection").first<{
        n: number;
      }>())!.n,
    ).toBe(3);
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='current_balance_projection'",
      ).first<{
        n: number;
      }>())!.n,
    ).toBe(0);

    const meta = (await (await call("/api/meta")).json()) as {
      capabilities: {
        balancesV2: boolean;
        balancesV2Pagination: string;
        balancesV2ReadModel: string;
      };
    };
    expect(meta.capabilities).toMatchObject({
      balancesV2: true,
      balancesV2Pagination: "keyset-v2",
      balancesV2ReadModel: "read-d1",
    });

    const response = await call("/api/v2/balances/latest?limit=50");
    expect(response.status).toBe(200);
    const page = (await response.json()) as Page;
    expect(page.items.length).toBe(3);
    expect(page.page.snapshotId).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("G3-03: a cursor names its read instance, and another one expires", async () => {
    // More rows than one page, so the server issues a real cursor and the test
    // forges nothing but the read instance.
    await seedProjection(60);
    expect((await build()).status).toBe("complete");
    const first = (await (await call("/api/v2/balances/latest?limit=50")).json()) as Page;
    expect(first.page.hasMore).toBe(true);
    const issued = decodeReadCursor(first.page.nextCursor!);
    expect(issued).not.toBeNull();

    const instance = (await env.READ.prepare(
      "SELECT read_instance_id FROM read_instance WHERE id=1",
    ).first<{ read_instance_id: string }>())!.read_instance_id;
    expect(issued!.readInstanceId).toBe(instance);
    // The cursor the server issued continues the same fixed list.
    const next = await call(
      `/api/v2/balances/latest?limit=50&cursor=${encodeURIComponent(first.page.nextCursor!)}`,
    );
    expect(next.status).toBe(200);
    expect(((await next.json()) as Page).items.length).toBeGreaterThan(0);

    const digest = issued!.filterDigest;
    // A cursor from another physical READ database: same snapshot id, same
    // query, another instance. It expires rather than being answered from
    // these rows.
    const foreign = encodeReadCursor({
      snapshotId: first.page.snapshotId,
      readInstanceId: `${instance}-other`,
      filterDigest: digest,
      position: 0,
      sortKey: "",
    });
    const expired = await call(
      `/api/v2/balances/latest?limit=50&cursor=${encodeURIComponent(foreign)}`,
    );
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as { error: string }).error).toBe("context_expired");

    // The retired storage flag cannot switch this cursor back to CORE.
    expect((await build({ read: false })).status).toBe("unchanged");
    const continued = await call(
      `/api/v2/balances/latest?limit=50&cursor=${encodeURIComponent(first.page.nextCursor!)}`,
      { read: false },
    );
    expect(continued.status).toBe(200);
  });

  it("G3-02: a CORE restored under a new epoch invalidates the published snapshot", async () => {
    await seedProjection(2);
    expect((await build()).status).toBe("complete");
    expect((await call("/api/v2/balances/latest")).status).toBe(200);
    // The restore case of 05 §2: the counters may have rewound, so the epoch
    // changes and rows built under the old one are another context.
    await env.DB.prepare(
      "UPDATE core_source_revision SET core_epoch='core-epoch-restored' WHERE id=1",
    ).run();
    const refused = await call("/api/v2/balances/latest");
    expect(refused.status).toBe(503);
    const body = (await refused.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("read_model_context_changed");
    // A refusal is not a page: no items, and no subtotal computed from rows
    // that were fixed under the other epoch.
    expect(Object.keys(body)).not.toContain("items");
    expect(Object.keys(body)).not.toContain("subtotals");
  });

  it("G3-04: a new use restriction refuses the snapshot, subtotals included", async () => {
    await seedProjection(2);
    expect((await build()).status).toBe("complete");
    const served = (await (await call("/api/v2/balances/latest")).json()) as Page;
    expect(served.subtotals).toBeDefined();

    // A restriction moves `visibility_revision` in the same transaction as the
    // write (migration 0038). Removing rows from the published snapshot would
    // leave its subtotal at the old figure, so the snapshot is refused whole
    // until the next build publishes one that accounts for the restriction.
    await env.DB.prepare(
      `INSERT INTO evidence_use_restrictions(evidence_ref,restriction,since,
        affected_manifests_json,actor,reason)
       VALUES('balance:synthetic-restricted','no-reuse','2026-09-12T00:00:00Z','[]','operator:1',
         'Synthetic: the evidence may no longer be reused.')`,
    ).run();
    const refused = await call("/api/v2/balances/latest");
    expect(refused.status).toBe(503);
    const refusal = (await refused.json()) as Record<string, unknown>;
    expect(refusal["error"]).toBe("read_model_restriction_changed");
    expect(Object.keys(refusal)).not.toContain("subtotals");

    // The next build re-captures at the new visibility revision. Its content
    // digests to the same snapshot — the restriction changed no candidate row
    // — so nothing is rebuilt, but the pointer's watermark now says the
    // published content was verified under the restriction, and the route
    // serves again (05 §5).
    expect((await build()).status).toBe("unchanged");
    expect(
      (await env.READ.prepare(
        "SELECT visibility_revision AS v FROM balance_snapshot_pointer WHERE id=1",
      ).first<{ v: number }>())!.v,
    ).toBe(
      (await env.DB.prepare(
        "SELECT visibility_revision AS v FROM core_source_revision WHERE id=1",
      ).first<{ v: number }>())!.v,
    );
    expect((await call("/api/v2/balances/latest")).status).toBe(200);
  });

  it("G0-11: a saved report keeps its fixed body in CORE and DATA, with every READ table dropped", async () => {
    const body: ReportBody = {
      schemaVersion: "report-holdings-v1",
      purpose: "holdings-view",
      contextId: "ctx-read-loss",
      calculationRunId: "run-read-loss",
      policyRefs: ["decimal-v1"],
      unitRef: "JPY",
      partition: "partial-verified-scope",
      subtotal: { coefficient: "10000", scale: 0 },
      rows: [
        {
          subjectRef: "instrument:synthetic:-:FUND",
          scopeRef: "scope:synthetic",
          metric: "holdings.valuation",
          unitRef: "JPY",
          valued: true,
          value: { coefficient: "10000", scale: 0 },
        },
      ],
      coverage: { scopeRef: "perimeter:test", coveredRef: "positions:1", truncated: false },
    };
    const bytes = new TextEncoder().encode(canonicalJson(body));
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const storageRef = `reports/${digest}`;
    await env.EVIDENCE.put(storageRef, bytes);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO calculation_runs(run_id,context_id,policy_refs_json,input_manifest_digest,
          status,replayability,started_at,completed_at)
         VALUES('run-read-loss','ctx-read-loss',?,?,'complete','replayable',
           '2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z')`,
      ).bind(JSON.stringify(body.policyRefs), "c".repeat(64)),
      env.DB.prepare(
        `INSERT INTO report_artifacts(report_id,context_id,purpose,schema_version,content_digest,
          storage_ref,created_by,created_at)
         VALUES('rpt-read-loss','ctx-read-loss','holdings-view',?,?,?,'report-job',
           '2026-09-12T00:00:00.000Z')`,
      ).bind(body.schemaVersion, digest, storageRef),
      env.DB.prepare(
        `INSERT INTO report_events(report_id,kind,actor,related_report_id,occurred_at)
         VALUES('rpt-read-loss','generated','report-job',NULL,'2026-09-12T00:00:00.000Z')`,
      ),
    ]);

    // The total loss of 15 §3, at its most brutal: every READ table is gone.
    for (const table of READ_TABLES) await env.READ.prepare(`DROP TABLE IF EXISTS ${table}`).run();

    const report = await reportsApi(
      { ...env, READ_PROJECTION_ENABLED: "true" } as Env,
      new URL("https://fixture.test/api/v2/reports/rpt-read-loss"),
    );
    expect(report?.status).toBe(200);
    const served = (await report!.json()) as {
      body: ReportBody;
      report: { contentDigest: string };
    };
    expect(served.body).toEqual(body);
    expect(served.report.contentDigest).toBe(digest);
  });

  it("a READ database of another baseline is unavailable, not read through this contract", async () => {
    // Runs last: the instance row is permanent by trigger, so it is written
    // into the database the previous test emptied, rebuilt from its own
    // migrations. 06 §2: a destructive READ change is a new empty database,
    // and a deployment pointed at one of the other shape must not read it as
    // if it were its own.
    // The directory's statements, run directly: `applyD1Migrations` would
    // skip a file the migration table already records as applied.
    for (const migration of env.READ_TEST_MIGRATIONS)
      for (const query of migration.queries) await env.READ.prepare(query).run();
    await env.READ.prepare(
      `INSERT INTO read_instance(id,read_instance_id,created_at,contract_version)
       VALUES(1,'instance-other-shape','2026-09-11T00:00:00.000Z','read-baseline-v0')`,
    ).run();
    await seedProjection(2);
    expect(await build()).toMatchObject({
      status: "refused",
      reasonCode: "read_contract_mismatch",
    });
    const meta = (await (await call("/api/meta")).json()) as {
      capabilities: { balancesV2: boolean };
    };
    expect(meta.capabilities.balancesV2).toBe(false);
    const refused = await call("/api/v2/balances/latest");
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error).toBe("read_model_unavailable");
  });
});
