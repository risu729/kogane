import { expect, test } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../../../packages/storage-d1/src/migrations.ts";
import corpus, { corpusDigest } from "../src/corpus.generated.ts";
import { runConformance } from "../src/runner.ts";
import worker from "../src/worker.ts";

async function fixture() {
  // Existing locked Miniflare supports dates only through 2026-09-07.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response(null, {status:404}); } };",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    for (const file of migrationFiles(CORE_MIGRATIONS_URL))
      for (const [index, sql] of splitSqlStatements(
        migrationSql(CORE_MIGRATIONS_URL, file),
      ).entries()) {
        try {
          await db.prepare(sql).run();
        } catch (cause) {
          throw new Error(file + ":" + index, { cause });
        }
      }
    await db.prepare(readFileSync(new URL("../setup.sql", import.meta.url), "utf8")).run();
    return { mf, db };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
const controller = { scheduledTime: 0, cron: "0 0 9 10 *", noRetry() {} };

test("synthetic binding batches pass A1-A8, races, every-position faults and final integrity", async () => {
  const { mf, db } = await fixture();
  try {
    const report = await runConformance(db, "local-miniflare");
    expect(report.cases.filter((item) => !item.passed)).toEqual([]);
    expect(report.cases.length).toBe(corpus.cases.length);
    expect(report.passed).toBe(true);
    expect(report.foreignKeyViolations).toBe(0);
    expect(report.unloggedCount).toBe(0);
    expect(report.remoteGateSatisfied).toBe(false);
    expect(report.cpuMs).toBeNull();
    expect(report.queryBudgetUpperBound).toBeLessThanOrEqual(950);
    const metrics = report.cases.find((item) => item.name === "A8-1000-ids-one-bind")!.metrics[0]!;
    expect(metrics.statementsSubmitted).toBe(1);
    expect(metrics.statementsReturned).toBe(1);
    // A used/nonempty store is refused before reseeding or row snapshots.
    await expect(runConformance(db, "local-miniflare")).rejects.toThrow("baseline stage");
    mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
    writeFileSync(
      new URL("../dist/local-report.json", import.meta.url),
      JSON.stringify(
        {
          ...report,
          localCompatibilityDate: "2026-09-07",
          proposedRemoteCompatibilityDate: "2026-10-09",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      JSON.stringify({
        code: "local_conformance_passed",
        cases: report.cases.length,
        queryBudgetUpperBound: report.queryBudgetUpperBound,
      }),
    );
  } finally {
    await mf.dispose();
  }
}, 120_000);

test("local scheduled handler has closed HTTP, disabled activation and once-only execution", async () => {
  const { mf, db } = await fixture();
  try {
    expect(worker.fetch().status).toBe(404);
    await worker.scheduled(controller, { DB: db, RUN_AUTHORIZATION: "disabled" });
    expect(
      await db.prepare("SELECT count(*) AS n FROM conformance_run").first<{ n: number }>(),
    ).toEqual({ n: 0 });
    await worker.scheduled(controller, { DB: db, RUN_AUTHORIZATION: corpusDigest });
    const before = await db.prepare("SELECT * FROM conformance_run").all();
    expect(before.results).toHaveLength(1);
    expect(before.results[0]!.state).toBe("passed");
    const report = JSON.parse(String(before.results[0]!.report_json));
    // This is a local call of the remote handler: no hosted proof is claimed.
    expect(report.passed).toBe(true);
    expect(report.remoteGateSatisfied).toBe(false);
    await worker.scheduled(controller, { DB: db, RUN_AUTHORIZATION: corpusDigest });
    expect((await db.prepare("SELECT * FROM conformance_run").all()).results).toEqual(
      before.results,
    );
  } finally {
    await mf.dispose();
  }
}, 120_000);
