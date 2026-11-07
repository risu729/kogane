// The `holdings` intent of `kogane.financial.query` over the READ database:
// the same published snapshot the v2 balance routes serve, under the same
// rules (05 §7). A snapshot the routes refuse — CORE restored under a new
// epoch, a use restriction recorded after it was built, a READ database of
// another contract — is refused here too: the answer is `unavailable` with
// the routes' own closed code, never a figure summed from rows that no longer
// describe the context.
//
// Every value is synthetic. No real account number, name or balance appears.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { runBalanceProjection } from "../../processor/src/balance-projection-job";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test','smbc-bank')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test','smbc-bank')",
    ),
  ]);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://holdings-read-test-${++sequence}.cloudflareaccess.com`;
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

interface HoldingsResult {
  completeness: string;
  data: { intent: string; units: { unitRef: string; coefficient: string }[] };
  coverage: { gaps: { reasonCode: string }[] };
  quality: Record<string, { state: string; reasonCodes: string[] }>;
  warnings: { code: string; severity: string }[];
}

/** `holdings` through the human UI's shared-query route: the agent's own service. */
async function holdings(): Promise<HoldingsResult> {
  const response = await worker.fetch(
    new Request("https://fixture.test/api/v2/query?intent=holdings", {
      headers: { "cf-access-jwt-assertion": await token() },
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      READ_PROJECTION_ENABLED: "true",
    } as Env,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: HoldingsResult }).result;
}

/** One build into the READ database, through the processor's own job. */
async function build() {
  return runBalanceProjection(
    { ...env, BALANCE_PROJECTION_ENABLED: "1", READ_PROJECTION_ENABLED: "true" } as never,
    { writeBudget: 20_000 },
  );
}

/** One published deposit balance: a `sum-disjoint` currency stock, so it is summed. */
async function seedDeposit(): Promise<void> {
  const run = await seedRun({ source: "smbc-bank", count: 1, dataset: "balance-normalized" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'smbc-direct-balance','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.prepare(
    `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,
       amount_scale,instrument,as_of,raw_locator,extra_json)
     VALUES(?,'smbc-bank:synthetic-yen','account_balance',4321,'4321',0,'JPY','2026-09-11',
       'json:$.balance','{}')`,
  )
    .bind(parse!.id)
    .run();
}

/** The unavailable answer: a closed reason everywhere, a blocking warning, no figure. */
function expectRefused(result: HoldingsResult, code: string): void {
  expect(result.completeness).toBe("unavailable");
  expect(result.data.units).toEqual([]);
  expect(result.coverage.gaps.map((gap) => gap.reasonCode)).toEqual([code]);
  expect(result.quality["numeric"]!.reasonCodes).toEqual([code]);
  expect(result.warnings).toEqual([{ code, severity: "blocking" }]);
}

describe("holdings over the READ database", () => {
  it("serves the published snapshot while it describes the current context", async () => {
    expectRefused(await holdings(), "projection_not_built");
    await seedDeposit();
    expect((await build()).status).toBe("complete");
    const served = await holdings();
    expect(served.completeness).toBe("complete");
    expect(served.data.units).toEqual([
      { unitRef: "JPY", coefficient: "4321", scale: 0, adoptedCount: 1 },
    ]);
  });

  it("published evidence after a build marks holdings partial until the next build", async () => {
    await seedDeposit();
    const behind = await holdings();
    expect(behind.completeness).toBe("partial");
    expect(behind.quality["freshness"]!.state).toBe("partial");
    expect(behind.quality["freshness"]!.reasonCodes).toEqual([
      "snapshot:behind_published_evidence",
    ]);
    expect(behind.coverage.gaps.map((gap) => gap.reasonCode)).toContain(
      "snapshot:behind_published_evidence",
    );
    expect(behind.data.units).toEqual([
      { unitRef: "JPY", coefficient: "4321", scale: 0, adoptedCount: 1 },
    ]);
    expect(["complete", "unchanged"]).toContain((await build()).status);
    const current = await holdings();
    expect(current.completeness).toBe("complete");
    expect(current.quality["freshness"]!.reasonCodes).toEqual(["snapshot_current"]);
  });

  it("a use restriction recorded after the build refuses the snapshot until a build re-verifies it", async () => {
    // The restriction moves `visibility_revision` (migration 0038). Summing the
    // snapshot built before it would answer with the old figure.
    await env.DB.prepare(
      `INSERT INTO evidence_use_restrictions(evidence_ref,restriction,since,
        affected_manifests_json,actor,reason)
       VALUES('balance:synthetic-restricted','no-reuse','2026-09-12T00:00:00Z','[]','operator:1',
         'Synthetic: the evidence may no longer be reused.')`,
    ).run();
    expectRefused(await holdings(), "read_model_restriction_changed");
    // The next build re-captures the published content at the new revision,
    // and the answer is served again, exactly as the v2 routes do.
    expect((await build()).status).toBe("unchanged");
    expect((await holdings()).completeness).toBe("complete");
  });

  it("a CORE restored under a new epoch refuses the snapshot", async () => {
    await env.DB.prepare(
      "UPDATE core_source_revision SET core_epoch='core-epoch-restored-holdings' WHERE id=1",
    ).run();
    expectRefused(await holdings(), "read_model_context_changed");
  });

  it("a READ database of another contract is unavailable, not read through this one", async () => {
    // Runs last. The instance row is permanent by trigger, so the READ tables
    // are dropped and recreated from their migrations, the way a destructive
    // READ change is a new database (06 §2). A snapshot and pointer are then
    // written under an instance of another baseline, verified at the current
    // CORE revision: only the contract says it cannot be read.
    for (const table of await readTables())
      await env.READ.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    for (const migration of env.READ_TEST_MIGRATIONS)
      for (const query of migration.queries) await env.READ.prepare(query).run();
    const revision = (await env.DB.prepare(
      "SELECT source_revision, visibility_revision, core_epoch FROM core_source_revision WHERE id=1",
    ).first<{ source_revision: number; visibility_revision: number; core_epoch: string }>())!;
    const snapshotId = "b".repeat(64);
    const instance = "instance-other-contract";
    const at = "2026-09-12T00:00:00.000Z";
    await env.READ.batch([
      env.READ.prepare(
        `INSERT INTO read_instance(id,read_instance_id,created_at,contract_version)
         VALUES(1,?1,?2,'read-baseline-v0')`,
      ).bind(instance, at),
      env.READ.prepare(
        `INSERT INTO balance_read_snapshots(snapshot_id,content_key,attempt,input_digest,
           build_digest,contract_version,read_instance_id,source_revision,visibility_revision,
           core_epoch,status,row_count,output_digest,input_manifest_json,projection_release,
           created_at,completed_at)
         VALUES(?1,?1,1,?1,?1,'read-baseline-v0',?2,?3,?4,?5,'complete',0,?1,'{}',
           'balance-projection-v1',?6,?6)`,
      ).bind(
        snapshotId,
        instance,
        revision.source_revision,
        revision.visibility_revision,
        revision.core_epoch,
        at,
      ),
      env.READ.prepare(
        `INSERT INTO balance_snapshot_pointer(id,snapshot_id,source_revision,visibility_revision,
           core_epoch,read_instance_id,output_digest,switched_at)
         VALUES(1,?1,?2,?3,?4,?5,?1,?6)`,
      ).bind(
        snapshotId,
        revision.source_revision,
        revision.visibility_revision,
        revision.core_epoch,
        instance,
        at,
      ),
    ]);
    expectRefused(await holdings(), "read_model_unavailable");
  });
});

/**
 * Every table of the READ database, newest first so a referencing table is
 * dropped before the table it references; the reset needs no list of its own.
 */
async function readTables(): Promise<string[]> {
  const rows = await env.READ.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations'",
  ).all<{ name: string }>();
  return rows.results.map((row) => row.name).reverse();
}
