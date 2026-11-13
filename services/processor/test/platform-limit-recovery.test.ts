// Synthetic binding failures through the actual parse and registration recovery paths.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { collectionScanStage, meteredInvocation, runScheduled, parseJob } from "../src/worker.ts";
import { collectionHarness, persistSyntheticRun } from "./collection-harness.ts";
import { seedArtifact, startPipeline } from "./harness.ts";
import { smbcDirectBalance } from "../../../packages/parsers/src/parsers/smbc-direct.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

interface Probe {
  d1PlatformLimitCalls: number;
  r2PlatformLimitCalls: number;
  limitErrors: number;
  lanes: Record<
    string,
    {
      d1PlatformLimitCalls: number;
      r2PlatformLimitCalls: number;
      runs: number;
      failed: number;
      limitErrors: number;
      resultCounts: Record<string, number>;
    }
  >;
}
const probe = (lines: string[]) => JSON.parse(lines.at(-1)!) as Probe;

// A one-shot failure below all the meters; every later call reaches the original binding.
function failRegistrationInsert(db: D1Database, error: Error) {
  let rejected = 0;
  const statement = (target: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(target, {
      get(inner, property) {
        if (property === "bind") return (...values: unknown[]) => statement(inner.bind(...values));
        if (property === "run")
          return () => {
            if (rejected === 0) {
              rejected += 1;
              return Promise.reject(error);
            }
            return inner.run();
          };
        const value: unknown = Reflect.get(inner, property, inner);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
  return {
    db: new Proxy(db, {
      get(inner, property) {
        if (property === "prepare")
          return (sql: string) => {
            const prepared = inner.prepare(sql);
            return sql.startsWith("INSERT INTO collection_runs (") ? statement(prepared) : prepared;
          };
        const value: unknown = Reflect.get(inner, property, inner);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    }),
    rejected: () => rejected,
  };
}

test("a platform limit recovered by executeParseJob remains visible without a failed lane", async () => {
  const payload = { amount: 1, currency: "JPY", observedAt: "2026-09-07T00:00:00.000Z" };
  const failedKey = await seedArtifact(
    env,
    9101,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    payload,
  );
  await seedArtifact(env, 9102, "smbc-bank", "balance-normalized", "balance.normalized.json", {
    ...payload,
    amount: 2,
  });
  await env.DB.batch(
    [9101, 9102].map((id) =>
      env.DB.prepare(
        "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
      ).bind(id, smbcDirectBalance.name, smbcDirectBalance.version),
    ),
  );
  let rejected = 0;
  const evidence = new Proxy(env.EVIDENCE, {
    get(inner, property) {
      if (property === "get")
        return (...args: Parameters<R2Bucket["get"]>) => {
          if (args[0] === failedKey && rejected === 0) {
            rejected += 1;
            return Promise.reject(new Error("Too many subrequests. private parse marker"));
          }
          return inner.get(...args);
        };
      const value: unknown = Reflect.get(inner, property, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
  const lines: string[] = [];
  let continued = false;
  await meteredInvocation(
    "scheduled",
    { ...env, EVIDENCE: evidence },
    (metered, context) =>
      runScheduled(
        metered,
        {
          parse: async (scoped) => {
            const outcomes = [];
            for (const id of [9101, 9102])
              outcomes.push(
                await parseJob(
                  scoped,
                  {
                    fetch_artifact_id: id,
                    parser_name: smbcDirectBalance.name,
                    parser_version: smbcDirectBalance.version,
                    attempts: 0,
                  },
                  smbcDirectBalance,
                ),
              );
            expect(outcomes).toEqual(["error", "parsed"]);
            return { error: outcomes.filter((outcome) => outcome === "error").length };
          },
          identity: async () => {
            continued = true;
            return {};
          },
          balanceProjection: async () => ({}),
        },
        (line) => lines.push(line),
        context,
      ),
    (line) => lines.push(line),
  );
  expect(rejected).toBe(1);
  expect(continued).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT status,last_error_code FROM observation_parse_jobs WHERE fetch_artifact_id=9101",
    ).first(),
  ).toMatchObject({ status: "pending", last_error_code: "metadata_or_raw_read_failed" });
  expect(
    await env.DB.prepare(
      "SELECT status,error FROM parse_runs WHERE fetch_artifact_id=9101",
    ).first(),
  ).toMatchObject({ status: "error", error: "metadata_or_raw_read_failed" });
  expect(
    await env.DB.prepare(
      "SELECT status FROM observation_parse_jobs WHERE fetch_artifact_id=9102",
    ).first(),
  ).toMatchObject({ status: "done" });
  expect(lines.some((line) => JSON.parse(line).event === "observation_sweep_failed")).toBe(false);
  expect(probe(lines)).toMatchObject({
    d1PlatformLimitCalls: 0,
    r2PlatformLimitCalls: 1,
    limitErrors: 0,
    lanes: {
      observation_sweep: {
        runs: 1,
        failed: 0,
        limitErrors: 0,
        d1PlatformLimitCalls: 0,
        r2PlatformLimitCalls: 1,
        resultCounts: { error: 1 },
      },
    },
  });
  expect(lines.join("\n")).not.toContain("private parse marker");
});

for (const limit of [true, false]) {
  test(`a ${limit ? "platform limit" : "non-limit failure"} recovered by collectionScan preserves progress`, async () => {
    const harness = collectionHarness();
    try {
      await persistSyntheticRun(harness, { run: { runId: "run-001" } });
      await persistSyntheticRun(harness, { run: { runId: "run-002" } });
      const fault = failRegistrationInsert(
        harness.env.DB as D1Database,
        new Error(
          `${limit ? "D1_ERROR: Too many API requests by single worker invocation." : "synthetic unavailable"} private registration marker`,
        ),
      );
      const lines: string[] = [];
      const registrationMeter: Record<string, unknown>[] = [];
      await meteredInvocation(
        "scheduled",
        { ...harness.env, DB: fault.db } as Env,
        (metered, context) =>
          runScheduled(
            metered,
            {
              parse: async () => ({}),
              identity: async () => ({}),
              balanceProjection: async () => ({}),
              collection: async (scoped, shared) => {
                const result = await collectionScanStage(scoped, shared, (line) =>
                  lines.push(line),
                );
                registrationMeter.push(shared.registration.meter.summary());
                expect(result).toMatchObject({
                  failed: 1,
                  registered: 1,
                  cycleComplete: true,
                  budgetExhausted: false,
                });
                return result;
              },
            },
            (line) => lines.push(line),
            context,
          ),
        (line) => lines.push(line),
      );
      expect(fault.rejected()).toBe(1);
      expect(harness.db.query("SELECT run_id FROM collection_runs ORDER BY run_id").all()).toEqual([
        { run_id: "run-002" },
      ]);
      expect(
        harness.db.query("SELECT cycles_completed FROM collection_scan_state").get(),
      ).toMatchObject({ cycles_completed: 1 });
      expect(
        lines
          .map((line) => JSON.parse(line))
          .filter((line) => line.event === "collection_scan_registration_failed"),
      ).toEqual([{ event: "collection_scan_registration_failed", code: "Error" }]);
      expect(probe(lines)).toMatchObject({
        d1PlatformLimitCalls: Number(limit),
        r2PlatformLimitCalls: 0,
        limitErrors: 0,
        lanes: {
          collection_scan: {
            runs: 1,
            failed: 0,
            limitErrors: 0,
            d1PlatformLimitCalls: Number(limit),
            r2PlatformLimitCalls: 0,
            resultCounts: { failed: 1 },
          },
        },
      });
      expect(registrationMeter).toMatchObject([
        { d1PlatformLimitCalls: Number(limit), r2PlatformLimitCalls: 0 },
      ]);
      expect(lines.join("\n")).not.toContain("private registration marker");
    } finally {
      harness.db.close();
    }
  });
}

test("a rejected binding call escaping its lane is one call alongside the existing lane failure", async () => {
  const error = new Error("Too many subrequests. private escaped marker");
  let rejected = 0;
  const evidence = new Proxy(env.EVIDENCE, {
    get(inner, property) {
      if (property === "head")
        return () => {
          rejected += 1;
          return Promise.reject(error);
        };
      const value: unknown = Reflect.get(inner, property, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
  const lines: string[] = [];
  await meteredInvocation(
    "scheduled",
    { ...env, EVIDENCE: evidence },
    (metered, context) =>
      runScheduled(
        metered,
        {
          parse: async (scoped) => {
            await scoped.EVIDENCE.head("synthetic");
            return {};
          },
          identity: async () => ({}),
          balanceProjection: async () => ({}),
        },
        (line) => lines.push(line),
        context,
      ),
    (line) => lines.push(line),
  );
  expect(rejected).toBe(1);
  expect(probe(lines)).toMatchObject({
    d1PlatformLimitCalls: 0,
    r2PlatformLimitCalls: 1,
    limitErrors: 1,
    lanes: {
      observation_sweep: {
        runs: 0,
        failed: 1,
        limitErrors: 1,
        d1PlatformLimitCalls: 0,
        r2PlatformLimitCalls: 1,
      },
    },
  });
  expect(lines.join("\n")).not.toContain("private escaped marker");
});
