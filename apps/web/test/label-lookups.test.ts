// A label, message or tone table is a plain object, so indexing it with a code
// the server or the URL supplied also finds inherited members: `constructor`
// would read as "function Object() { [native code] }". Every lookup that
// expects an unknown code (it has a fallback) goes through `ownEntry` or
// `displayLabel` (src/labels.ts), which answer only the table's own keys.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE = join(import.meta.dir, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

// A constant table indexed by an expression and then given a fallback
// (`TABLE[code] ?? code`) or read optionally (`TABLE[code]?.label`).
const UNGUARDED = /\b[A-Z][A-Z0-9_]*\[[^\]\n]+\]\s*(?:\?\?|\?\.)/gu;

test("no label table is read with a fallback outside the own-key helpers", () => {
  const found: string[] = [];
  for (const file of sourceFiles(SOURCE)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(UNGUARDED))
        found.push(`${relative(SOURCE, file)}:${String(index + 1)}: ${match[0]}`);
    });
  }
  expect(found).toEqual([]);
});
