import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { isLiteralRowsScan } from "./literal-row-scan.ts";

test("literal VALUES scans are distinct from scans of growing relations", () => {
  const db = new Database(":memory:");
  try {
    const literals = db.query("EXPLAIN QUERY PLAN SELECT * FROM (VALUES (1), (2))").all() as Array<{
      detail: string;
    }>;
    expect(
      literals.some(
        (step) => step.detail === "SCAN 2 CONSTANT ROWS" && isLiteralRowsScan(step.detail),
      ),
    ).toBe(true);
    db.exec("CREATE TABLE growing(value INTEGER); INSERT INTO growing VALUES(1),(2)");
    const relation = db.query("EXPLAIN QUERY PLAN SELECT * FROM growing").all() as Array<{
      detail: string;
    }>;
    expect(relation.some((step) => step.detail.startsWith("SCAN "))).toBe(true);
    expect(relation.every((step) => !isLiteralRowsScan(step.detail))).toBe(true);
    expect(isLiteralRowsScan("SCAN 0-ROW VALUES CLAUSE")).toBe(true);
    expect(isLiteralRowsScan("SCAN 2 USING COVERING INDEX growing_index")).toBe(false);
  } finally {
    db.close();
  }
});
