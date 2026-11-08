import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { openStore, type Store } from "../src/store.ts";

// Every store a test builds is thrown away with the test, so it opens as a
// disposable store: SQLite skips the fsync on each commit. Applying the schema
// alone commits about 180 times, and on a loaded CI runner those fsyncs, not
// the work, decided whether a test met its deadline. Nothing a test asserts
// depends on durability across a crash.

const EXPERIMENT_ROOT = dirname(import.meta.dir);

function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * Open a test's own store in `directory`, which must be a directory the test
 * created under the system temporary directory: never `state/` or any store an
 * operator keeps.
 */
export function openTestStore(directory: string): Store {
  if (!inside(tmpdir(), directory) || inside(EXPERIMENT_ROOT, directory)) {
    throw new Error("a test store must live in its own directory under the system temporary root");
  }
  return openStore(directory, { disposable: true });
}

/** A fresh test store in a new temporary directory named with `prefix`. */
export function freshTestStore(prefix: string): Store {
  return openTestStore(mkdtempSync(join(tmpdir(), prefix)));
}
