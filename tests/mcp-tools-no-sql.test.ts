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
// A CommandStore, SqlExecutor or D1 call: `store.first<…>(`, `db.prepare(`, …
// `Promise.all(` is not a store call.
const STORE_CALL = /(?<!Promise)\.(?:first|all|batch|prepare|run|raw)\s*[<(]/u;
// A string literal that starts a SQL statement.
const SQL_TEXT = /["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\s/iu;

describe("MCP tools issue no SQL of their own (ADR 0081)", () => {
  test("the adapter list is not empty", () => {
    expect(adapters).toContain("ops-tools.ts");
    expect(adapters).toContain("delegated-schedule-tools.ts");
    expect(adapters).toContain("delegated-maintenance-tools.ts");
  });
  for (const name of adapters)
    test(name, () => {
      const lines = readFileSync(resolve(source, name), "utf8").split("\n");
      const offending = lines
        .map((line, index) => ({ line: index + 1, text: line.trim() }))
        .filter(({ text }) => STORE_CALL.test(text) || SQL_TEXT.test(text));
      expect(offending).toEqual([]);
    });
  test("the guard catches the shapes it names", () => {
    expect(STORE_CALL.test("await store.first<{ n: number }>(")).toBe(true);
    expect(STORE_CALL.test("context.store.all(")).toBe(true);
    expect(STORE_CALL.test("env.DB.prepare(")).toBe(true);
    expect(STORE_CALL.test("await Promise.all([a, b])")).toBe(false);
    expect(SQL_TEXT.test('"SELECT source_id FROM ops_requests"')).toBe(true);
    expect(SQL_TEXT.test("`select count(*) n FROM audit_records`")).toBe(true);
    expect(SQL_TEXT.test('"selected"')).toBe(false);
  });
});
