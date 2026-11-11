// Local-only upgrade probe: use the installed Wrangler's own Miniflare and
// workerd, never the experiment's separately pinned historical Miniflare.
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../../../packages/storage-d1/src/migrations.ts";
import {
  CARD_SETTLEMENT_PAGE_SQL,
  CARD_SETTLEMENT_REVIEW_SQL,
} from "../../../packages/application/src/query/card-settlements.ts";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--toolchain-package"))
  throw new Error("usage: runtime-compatibility.mjs [--toolchain-package /path/to/package.json]");
const selected = args.length === 2 ? resolve(args[1]) : require.resolve("wrangler/package.json");
const selectedRequire = createRequire(realpathSync(selected));
const wranglerPath = selectedRequire.resolve("wrangler/package.json");
const wranglerRequire = createRequire(realpathSync(wranglerPath));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");

function packageInfo(from, name) {
  let directory = dirname(realpathSync(from.resolve(name)));
  for (;;) {
    try {
      const candidate = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (candidate.name === name) return { directory, version: candidate.version };
    } catch {
      // The entry point can be below the package root.
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`package root not found: ${name}`);
    directory = parent;
  }
}

const miniflare = packageInfo(wranglerRequire, "miniflare");
const runtimeRequire = createRequire(join(miniflare.directory, "package.json"));
const workerd = packageInfo(runtimeRequire, "workerd");
const versions = {
  wrangler: JSON.parse(readFileSync(wranglerPath, "utf8")).version,
  miniflare: miniflare.version,
  workerd: workerd.version,
};
const report = (item) => process.stdout.write(JSON.stringify(item) + "\n");
report({ kind: "versions", ...versions, target: "ephemeral-local-only" });
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response(null, {status:404}); } };",
    compatibilityDate: "2026-09-07",
    d1Databases: ["DB"],
  }),
);
let passed = true;
try {
  const db = await mf.getD1Database("DB");
  for (const references of [90, 98, 99, 100, 110]) {
    const terms = Array.from({ length: references }, () => "(SELECT x FROM q)").join(",");
    try {
      await db.prepare(`WITH q AS (SELECT 1 x) SELECT 1 WHERE 1 IN (${terms})`).all();
      report({ kind: "flat-cte", references, passed: true });
    } catch (error) {
      passed = false;
      report({ kind: "flat-cte", references, passed: false, error: String(error) });
    }
  }
  let migrated = true;
  for (const file of migrationFiles(CORE_MIGRATIONS_URL)) {
    const statements = splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file));
    try {
      await db.batch(statements.map((sql) => db.prepare(sql)));
      report({ kind: "migration", file, passed: true });
    } catch {
      migrated = false;
      passed = false;
      // A failed D1 batch rolled back: replay it one statement at a time only
      // in this disposable database to identify the first offending text.
      for (const [index, sql] of statements.entries()) {
        try {
          await db.prepare(sql).run();
        } catch (error) {
          report({
            kind: "migration-statement",
            file,
            statement: index + 1,
            sql: sql.slice(0, 400),
            passed: false,
            error: String(error),
          });
          break;
        }
      }
      break;
    }
  }
  if (migrated) {
    for (const [name, sql, binds] of [
      ["readiness-view", "SELECT 1 FROM card_settlement_readiness LIMIT 1", []],
      ["settlement-review", CARD_SETTLEMENT_REVIEW_SQL, ["synthetic", 51, 0]],
      ["settlement-page", CARD_SETTLEMENT_PAGE_SQL, [null, 51, 0]],
    ]) {
      try {
        await db
          .prepare(sql)
          .bind(...binds)
          .all();
        report({ kind: "read", name, passed: true });
      } catch (error) {
        passed = false;
        report({ kind: "read", name, passed: false, error: String(error) });
      }
    }
  } else report({ kind: "reads", skipped: "incomplete-core-schema" });
} finally {
  await mf.dispose();
}
report({ kind: "summary", passed, ...versions });
if (!passed) process.exitCode = 1;
