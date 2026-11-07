// ADR 0081 point 2: an MCP tool never issues SQL. It passes the store it was
// given to a shared service in packages/application, so the screen and the
// tool answer from one query. This guard reads the App's MCP adapters and
// fails on a store call or a SQL statement written in one of them.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve(import.meta.dir, "../services/app/src");
const adapters = [
  "mcp.ts",
  ...readdirSync(source)
    .filter((name) => name.endsWith("-tools.ts"))
    .sort(),
];
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
  test("the adapter list is not empty", () => {
    expect(adapters).toContain("ops-tools.ts");
    expect(adapters).toContain("delegated-schedule-tools.ts");
    expect(adapters).toContain("delegated-maintenance-tools.ts");
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
