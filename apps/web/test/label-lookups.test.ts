// A label, message or tone table is a plain object, so indexing it with a code
// the server or the URL supplied also finds inherited members: `constructor`
// would read as "function Object() { [native code] }". Every lookup that
// expects an unknown code (it has a fallback) goes through `ownEntry` or
// `displayLabel` (src/labels.ts), which answer only the table's own keys.
//
// Limit: the guard sees only a constant-named table (`UPPER_CASE`) read with
// a fallback (`??`, `||`) or optionally (`?.`). A lookup with no fallback
// (`TABLE[state]` on a table keyed by a closed union the transport schema
// already parsed) is not checked, nor is a table with a lower-case name.
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

// A constant table indexed by an expression (one level of nested brackets,
// possibly over several lines) and then given a fallback (`TABLE[code] ?? code`,
// `TABLE[code] || code`) or read optionally (`TABLE[code]?.label`).
const UNGUARDED = /\b[A-Z][A-Z0-9_]*\[(?:[^[\]]|\[[^[\]]*\])+\]\s*(?:\?\?|\?\.|\|\|)/gu;

test("the guard pattern finds fallback reads and leaves own-key reads alone", () => {
  const matches = (text: string): boolean => text.match(UNGUARDED) !== null;
  for (const text of [
    "LABELS[code] ?? code",
    "LABELS[code] || code",
    "STATE[receipt.status]?.tone",
    "TONES[row[key]] ?? 'neutral'",
    "MESSAGES[\n  code\n] ??\n  fallback",
  ])
    expect([text, matches(text)]).toEqual([text, true]);
  for (const text of [
    "displayLabel(LABELS, code)",
    "ownEntry(TONES, code) ?? 'neutral'",
    "Object.hasOwn(LABELS, code) ? LABELS[code]! : code",
    "LABELS[code]",
    "labels[code] ?? code",
  ])
    expect([text, matches(text)]).toEqual([text, false]);
});

test("no label table is read with a fallback outside the own-key helpers", () => {
  const found: string[] = [];
  for (const file of sourceFiles(SOURCE)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(UNGUARDED)) {
      const line = text.slice(0, match.index).split("\n").length;
      found.push(`${relative(SOURCE, file)}:${String(line)}: ${match[0]}`);
    }
  }
  expect(found).toEqual([]);
});
