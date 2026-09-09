// Parser coverage contract in the production Worker (design review D01/D13,
// PR-07): migration 0025 applies on top of 0017-0037, contract v2 rows are
// written in the pending phase and published with the parse run, legacy
// parsers write nothing, an invalid contract is a terminal parser failure,
// and the shadow comparison route exposes identifiers only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { parseJob, sweep } from "../src/worker.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";
import {
  SNAPSHOT_DATASETS,
  snapshotCtes,
} from "../../../poc/observation-pipeline/src/snapshot-query.ts";
import { smbcDirectBalance } from "../../../poc/observation-pipeline/src/parsers/smbc-direct.ts";
import type { ArtifactMeta } from "../../../poc/observation-pipeline/src/types.ts";

// The reader's relations on the production schema (packages/read-model concepts).
const RELATIONS = {
  fetchArtifacts: "observation_fetch_artifacts",
  fetchRuns: "observation_fetch_runs",
  parseRuns: "parse_runs",
  publishedParseRuns: "published_parse_runs",
};

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const BALANCE = { amount: 12345, currency: "JPY", observedAt: "2026-09-07T00:00:00.000Z" };
const first = <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...args)
    .first<T>();
const all = <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...args)
    .all<T>()
    .then((result) => result.results);

test("migration 0025 applied on the production chain with the legacy seed", async () => {
  const tables = await all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('parse_issues','parse_coverage_claims','dataset_snapshot_policies') ORDER BY name",
  );
  expect(tables.map((row) => row.name)).toEqual([
    "dataset_snapshot_policies",
    "parse_coverage_claims",
    "parse_issues",
  ]);
  const policies = await all<{ parser_name: string; policy_id: string; unit_scope: string }>(
    "SELECT parser_name,policy_id,unit_scope FROM dataset_snapshot_policies",
  );
  expect(policies).toHaveLength(SNAPSHOT_DATASETS.length);
  expect(policies.every((row) => row.policy_id === "legacy-warning-compat-v1")).toBe(true);
  expect(policies.every((row) => row.unit_scope === "run")).toBe(true);
});

test("a converted parser publishes its claim with the parse run; a legacy parser writes nothing", async () => {
  await seedArtifact(
    env,
    300,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    BALANCE,
  );
  await seedArtifact(
    env,
    301,
    "sbi-securities",
    "foreign-cash-balances",
    "foreign-cash-balances.json",
    {
      listForeignScheduleCashBalances: {
        foreignCashBalances: [
          {
            currencyCashBalances: [
              {
                currencyCode: "USD",
                foreignScheduleCashBalances: [{ keepCash: "10.00", totalBalance: "1" }],
              },
            ],
          },
        ],
      },
    },
  );
  await seedArtifact(
    env,
    302,
    "smbc-bank",
    "transactions-normalized",
    "transactions/20260901-20260907.normalized.json",
    {
      range: { start: "2026-09-01", end: "2026-09-07" },
      transactions: [],
      depositsTotal: 0,
      withdrawalsTotal: 0,
    },
  );
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await sweep(env);
  const runs = await all<{ fetch_artifact_id: number; status: string; id: number }>(
    "SELECT id,fetch_artifact_id,status FROM parse_runs WHERE fetch_artifact_id IN (300,301,302) ORDER BY fetch_artifact_id",
  );
  expect(runs.map((row) => row.status)).toEqual(["ok", "ok", "ok"]);
  const claims = await all<Record<string, unknown>>(
    "SELECT p.fetch_artifact_id,c.scope_key,c.completeness,c.membership_complete,c.observed_count,c.expected_count,c.policy_version,c.absence_meaning,c.parent_run_status,c.parent_run_failure_count FROM parse_coverage_claims c JOIN parse_runs p ON p.id=c.parse_run_id WHERE p.fetch_artifact_id IN (300,301,302) ORDER BY p.fetch_artifact_id",
  );
  expect(claims).toEqual([
    {
      fetch_artifact_id: 300,
      scope_key: "smbc-bank/balance-normalized",
      completeness: "complete",
      membership_complete: 1,
      observed_count: 1,
      expected_count: 1,
      policy_version: "coverage-v1",
      absence_meaning: "not-applicable",
      parent_run_status: "success",
      parent_run_failure_count: 0,
    },
    {
      fetch_artifact_id: 301,
      scope_key: "sbi-securities/foreign-cash-balances",
      completeness: "complete",
      membership_complete: 1,
      observed_count: 1,
      expected_count: null,
      policy_version: "coverage-v1",
      absence_meaning: "not-applicable",
      parent_run_status: "success",
      parent_run_failure_count: 0,
    },
  ]);
  const issues = await all<Record<string, unknown>>(
    "SELECT p.fetch_artifact_id,i.code,i.severity,i.impact FROM parse_issues i JOIN parse_runs p ON p.id=i.parse_run_id WHERE p.fetch_artifact_id IN (300,301,302)",
  );
  expect(issues).toEqual([
    { fetch_artifact_id: 301, code: "unknown_fields_preserved", severity: "info", impact: "none" },
  ]);
  // The warning string is stored as before, next to the typed issue.
  const published = await first<{ warnings_json: string }>(
    "SELECT warnings_json FROM parse_runs WHERE fetch_artifact_id=301 AND status='ok'",
  );
  expect(published!.warnings_json).toContain("totalBalance");
}, 30000);

test("contract rows are append-only", async () => {
  await expect(
    env.DB.prepare("UPDATE parse_coverage_claims SET completeness='partial'").run(),
  ).rejects.toThrow(/append-only/);
  await expect(env.DB.prepare("DELETE FROM parse_issues").run()).rejects.toThrow(/append-only/);
});

test("a claim on a pending parse run is invisible to coverage-v1 until the run publishes", async () => {
  await env.DB.prepare(
    "UPDATE dataset_snapshot_policies SET policy_id='coverage-v1' WHERE parser_name='smbc-direct-balance'",
  ).run();
  await seedArtifact(env, 303, "smbc-bank", "balance-normalized", "balance.normalized.json", {
    ...BALANCE,
    amount: 1,
  });
  await env.DB.prepare(
    "UPDATE fetch_artifacts SET fetched_at_ms=fetched_at_ms+3600000 WHERE id=303",
  ).run();
  const pending = await first<{ id: number }>(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(303,'smbc-direct-balance','9.9.9','2026-09-08T00:00:00.000Z','pending','[]') RETURNING id",
  );
  await env.DB.prepare(
    "INSERT INTO parse_coverage_claims(parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,observed_count,expected_count,evidence_refs_json,policy_version,failure_cause,absence_meaning,parent_run_status,parent_run_failure_count) VALUES(?,'container:smbc-bank/balance-normalized','smbc-bank/balance-normalized','complete-container','complete',1,1,1,'[\"json:$\"]','coverage-v1',NULL,'not-applicable','success',0)",
  )
    .bind(pending!.id)
    .run();
  const current = async () =>
    (await mf
      .dispatchFetch("https://pipeline.internal/snapshot-policy/compare")
      .then((r) => r.json())) as {
      datasets: { parserName: string; coverageV1: { count: number }; differences: unknown[] }[];
      policies: { parser_name: string; policy_id: string }[];
    };
  const before = (await current()).datasets.find((d) => d.parserName === "smbc-direct-balance")!;
  expect(before.differences).toEqual([]);
  const artifact = () =>
    first<{ artifact_id: number }>(
      `WITH ${snapshotCtes(RELATIONS, { policy: "coverage-v1" })} SELECT artifact_id FROM current_snapshots WHERE parser_name='smbc-direct-balance'`,
    ).then((row) => row?.artifact_id);
  expect(await artifact()).toBe(300);
  // Publishing is what makes the claim count: status alone is not adoption
  // since the publication gate (docs/publication-gate.md).
  await env.DB.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(pending!.id).run();
  expect(await artifact()).toBe(300);
  // The writer's pointer move without its lease machinery; publicationStatements
  // itself is fenced on a live lease (docs/publication-gate.md).
  await publishParse(env.DB, pending!.id, "2026-09-08T00:00:00.000Z");
  expect(await artifact()).toBe(303);
  await env.DB.prepare(
    "UPDATE dataset_snapshot_policies SET policy_id='legacy-warning-compat-v1' WHERE parser_name='smbc-direct-balance'",
  ).run();
}, 30000);

test("the comparison route reports counts, ids and policies only", async () => {
  const response = await mf.dispatchFetch("https://pipeline.internal/snapshot-policy/compare");
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("12345");
  expect(text).not.toContain("warnings");
  const body = JSON.parse(text) as {
    policies: { parser_name: string; policy_id: string }[];
    datasets: {
      sourceId: string;
      parserName: string;
      legacy: { count: number };
      coverageV1: { count: number };
    }[];
    differingDatasets: number;
  };
  expect(body.policies).toHaveLength(SNAPSHOT_DATASETS.length);
  expect(body.datasets.find((d) => d.parserName === "smbc-direct-balance")).toMatchObject({
    sourceId: "smbc-bank",
    legacy: { count: 1 },
    coverageV1: { count: 1 },
  });
  expect(
    await mf
      .dispatchFetch("https://pipeline.internal/snapshot-policy/compare", { method: "POST" })
      .then((r) => r.status),
  ).toBe(404);
});

test("an invalid contract is a terminal parser failure that persists no rows", async () => {
  await seedArtifact(
    env,
    310,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    BALANCE,
  );
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(310,'smbc-direct-balance','1.0.1','pending')",
  ).run();
  const broken = {
    ...smbcDirectBalance,
    version: "1.0.1",
    parse: (bytes: Uint8Array, artifact: ArtifactMeta) => {
      const result = smbcDirectBalance.parse(bytes, artifact);
      // Complete membership on a partial claim violates the domain contract.
      return {
        ...result,
        coverage: [{ ...result.coverage![0]!, completeness: "partial" as const }],
      };
    },
  };
  expect(
    await parseJob(
      env,
      {
        fetch_artifact_id: 310,
        parser_name: "smbc-direct-balance",
        parser_version: "1.0.1",
        attempts: 0,
      },
      broken,
    ),
  ).toBe("error");
  expect(
    await first<{ status: string; last_error_code: string }>(
      "SELECT status,last_error_code FROM observation_parse_jobs WHERE fetch_artifact_id=310",
    ),
  ).toEqual({ status: "failed", last_error_code: "parse_contract_invalid" });
  expect(
    await first<{ status: string; error: string }>(
      "SELECT status,error FROM parse_runs WHERE fetch_artifact_id=310",
    ),
  ).toEqual({ status: "error", error: "parse_contract_invalid" });
  expect(
    await first<{ n: number }>(
      "SELECT count(*) AS n FROM parse_coverage_claims c JOIN parse_runs p ON p.id=c.parse_run_id WHERE p.fetch_artifact_id=310",
    ),
  ).toEqual({ n: 0 });
}, 30000);
