// A migrated schema is built once per test process and every test gets a
// fresh copy of its bytes. Running the CORE migrations is most of what a test
// store costs, and CI runs every workspace's suite at once on one runner, so
// migrating inside each test crosses the 5 s default timeout under load. A
// deserialized copy is the same schema, views, triggers and rows, never
// analyzed; connection settings such as `PRAGMA foreign_keys` are not part of
// the bytes, so a caller that needs one sets it on the copy. The first build
// still migrates, so a suite whose template is the full CORE schema builds it
// in `beforeAll` with its own timeout rather than inside its first test.
import { Database } from "bun:sqlite";

const templates = new Map<string, Uint8Array>();

/**
 * A fresh database holding what `build` produces. `key` names the build: two
 * builds that differ need two keys. `build` runs once per process.
 */
export function fromTemplate(key: string, build: () => Database): Database {
  let bytes = templates.get(key);
  if (bytes === undefined) {
    const db = build();
    bytes = db.serialize();
    db.close();
    templates.set(key, bytes);
  }
  return Database.deserialize(bytes);
}
