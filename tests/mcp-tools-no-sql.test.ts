// ADR 0081 point 2: an MCP tool never issues SQL. It passes the store it was
// given to a shared service in packages/application, so the screen and the
// tool answer from one query. This guard follows the App's relative imports
// from the MCP entry (`mcp.ts`, which reaches every `*-tools.ts` adapter and
// the agent service) and fails on a store call or a SQL statement in any
// module it reaches, unless the module is listed below with the reason MCP
// never runs its SQL.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const source = resolve(import.meta.dir, "../services/app/src");
// `import … from`, `export … from`, `import "./x"` and `import("./x")`.
const IMPORT =
  /(?:(?:import|export)\s[^;]*?\sfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/gsu;

/** Every module of services/app/src reachable from `entry` by relative imports. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(source, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const target = resolve(dirname(file), match[1]!.replace(/\.ts$/u, "") + ".ts");
      if (target.startsWith(`${source}/`) && existsSync(target)) queue.push(target);
    }
  }
  return [...seen].map((file) => relative(source, file)).sort();
}

/**
 * Modules on the import graph whose SQL only the screens run. Each is
 * imported for a function that issues none; the SQL that remains is in
 * functions the MCP path never calls. A module drops off this list when its
 * SQL moves into packages/application.
 */
const SCREEN_ONLY_SQL: Record<string, string> = {
  "normalized-decimals.ts": "balances-v2's page functions, which no MCP tool calls",
  "observation-organization.ts": "balances-v2's page functions, which no MCP tool calls",
  "read.ts": "the evidence routes; page-read-tools imports only catalogue",
  "reports-api.ts": "the report routes; capabilities imports only reportArtifactsAvailable",
};

/**
 * Modules whose SQL an MCP tool does run today, still to move into
 * packages/application (ADR 0081 Verification). Nothing may join this list:
 * a new entry is new SQL on the MCP path.
 */
const MCP_SQL_TO_MOVE: Record<string, string> = {
  "identity-api.ts": "kogane.identity.read shares readIdentityCollection with GET /api/identity/*",
  "account-connections.ts": "readIdentityCollection's connections and account labels",
  "preferred-instrument-names.ts": "readIdentityCollection's instrument labels",
};

const EXEMPT: Record<string, string> = { ...SCREEN_ONLY_SQL, ...MCP_SQL_TO_MOVE };

/**
 * What the graph may import from a module whose other exports run SQL a
 * screen route needs: the functions here issue none, or only through
 * packages/application. Importing anything else from it fails the guard, so
 * a screen-only exemption cannot quietly start covering an MCP call.
 */
const ALLOWED_IMPORTS: Record<string, readonly string[]> = {
  "balances-v2.ts": ["balanceProjectionReader", "balanceReadConfigured", "readTarget"],
  "read.ts": ["catalogue"],
  "reports-api.ts": ["reportArtifactsAvailable"],
};

const modules = reachable("mcp.ts");
const adapters = modules.filter((name) => !(name in EXEMPT));
// A CommandStore, SqlExecutor or D1 call: `store.first<…>(`, `db\n  .prepare(`, …
// `Promise.all(` is not a store call.
const STORE_CALL = /(?<!Promise\s*)\??\.\s*(?:first|all|batch|prepare|run|raw)\s*[<(]/gu;
// Any use of the D1 binding other than handing it to d1CommandStore/d1Executor.
const D1_MEMBER = /\bDB\s*\??\.\s*\w/gu;
// A string literal that starts a SQL statement, possibly on the next line.
// Upper case only, with the clause that follows, so prose ("Update a job") passes.
const SQL_TEXT =
  /["'`]\s*(?:SELECT\s|INSERT\s+INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s|REPLACE\s+INTO\s|WITH\s+\w+\s+AS\s*\()/gu;

function offending(text: string) {
  const found: { line: number; text: string }[] = [];
  for (const pattern of [STORE_CALL, D1_MEMBER, SQL_TEXT])
    for (const match of text.matchAll(pattern))
      found.push({
        line: text.slice(0, match.index).split("\n").length,
        text: match[0].replace(/\s+/gu, " ").trim(),
      });
  return found.sort((a, b) => a.line - b.line);
}

describe("MCP tools issue no SQL of their own (ADR 0081)", () => {
  test("the import graph reaches every tool adapter and the agent service", () => {
    for (const name of readdirSync(source).filter((file) => file.endsWith("-tools.ts")))
      expect(modules).toContain(name);
    for (const name of ["agent-api.ts", "agent-service.ts", "capabilities.ts"])
      expect(modules).toContain(name);
  });
  test("the graph imports only the SQL-free functions of the screen-only modules", () => {
    for (const [target, allowed] of Object.entries(ALLOWED_IMPORTS)) {
      const specifier = target.replace(/\.ts$/u, "");
      const named = new RegExp(
        String.raw`(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']\./${specifier}(?:\.ts)?["']`,
        "gu",
      );
      const names = new Set<string>();
      for (const name of adapters) {
        const text = readFileSync(resolve(source, name), "utf8");
        // A namespace, side-effect, dynamic or star re-export brings in everything.
        expect(text).not.toMatch(
          new RegExp(
            String.raw`(?:import\s*(?:\*|["']|\(\s*["'])|export\s*\*)[^;]*\./${specifier}(?:\.ts)?["']`,
            "u",
          ),
        );
        for (const match of text.matchAll(named))
          for (const part of match[1]!.split(",")) {
            const id = part
              .trim()
              .replace(/^type\s+/u, "")
              .split(/\s+as\s+/u)[0];
            if (id) names.add(id);
          }
      }
      expect([...names].filter((id) => !allowed.includes(id))).toEqual([]);
    }
  });
  test("every exemption is on the graph and still holds SQL", () => {
    for (const name of Object.keys(EXEMPT)) {
      expect(modules).toContain(name);
      expect(offending(readFileSync(resolve(source, name), "utf8")).length).toBeGreaterThan(0);
    }
  });
  for (const name of adapters)
    test(name, () => {
      expect(offending(readFileSync(resolve(source, name), "utf8"))).toEqual([]);
    });
  test("the guard catches the shapes it names", () => {
    const hit = (text: string) => offending(text).length > 0;
    expect(hit("await store.first<{ n: number }>(")).toBe(true);
    expect(hit("context.store.all(")).toBe(true);
    expect(hit("await db\n  .prepare(sql)")).toBe(true);
    expect(hit("await env.DB.exec(sql)")).toBe(true);
    expect(hit("const q = `\n  SELECT id FROM t`;")).toBe(true);
    expect(hit('"SELECT source_id FROM ops_requests"')).toBe(true);
    expect(hit("d1CommandStore(env.DB)")).toBe(false);
    expect(hit("await Promise.all([a, b])")).toBe(false);
    expect(hit('description: "Update a schedule job, with care."')).toBe(false);
    expect(hit('"selected"')).toBe(false);
  });
});
