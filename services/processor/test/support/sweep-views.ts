// The views a sweep's code can read, for its gate policy (src/sweep-pass.ts).
//
// A migration that redefines a view moves no CORE revision, so a sweep that
// waits for a change would not see it. Each gated sweep pins a digest of the
// definitions of every view its module's import closure names (and the views
// those name, recursively) on the fully migrated schema; a test compares the
// pin with this digest, so such a migration fails until the pin, and with it
// the sweep's policy, changes. Naming a view the sweep never reads only makes
// the pin move more often.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MIGRATIONS = resolve(import.meta.dir, "../../../../packages/storage-d1/migrations/core");

/** The text of `entry` and every module it imports by a relative path. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    texts.push(text);
    for (const match of text.matchAll(/(?:from|import\()\s*"(\.{1,2}\/[^"]+\.ts)"/g))
      visit(resolve(dirname(file), match[1]!));
  };
  visit(resolve(entry));
  return texts;
}

/** The pinned digest of the views `entry`'s import closure can read. */
export function sweepViewsDigest(entry: string): string {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(`${MIGRATIONS}/${name}`, "utf8"));
  const views = new Map(
    (
      db.query("SELECT name, sql FROM sqlite_master WHERE type='view'").all() as {
        name: string;
        sql: string;
      }[]
    ).map((view) => [view.name, view.sql]),
  );
  db.close();
  const names = (text: string) =>
    [...views.keys()].filter((name) => new RegExp(`\\b${name}\\b`).test(text));
  const reached = new Set<string>();
  const queue = importClosure(entry).flatMap(names);
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    queue.push(...names(views.get(name)!));
  }
  const hash = createHash("sha256");
  for (const name of [...reached].sort()) hash.update(`${name}\n${views.get(name)}\n`);
  return hash.digest("hex").slice(0, 16);
}
