// Where the two migration directories are, named once so no consumer has to
// spell a relative path to somebody else's package (unified plan 06 §2,
// decision D3).
//
// CORE is the existing database: the files moved here from
// `services/raw-evidence/migrations/` byte for byte, keeping their numbers and
// their applied history. READ is the second database U11 introduces; its
// directory exists and is empty on purpose, so that a job can never be pointed
// at the wrong one by accident.

/** Absolute URL of the CORE migration directory (trailing slash). */
export const CORE_MIGRATIONS_URL = new URL("../migrations/core/", import.meta.url);

/** Absolute URL of the READ migration directory (trailing slash). Empty until U11. */
export const READ_MIGRATIONS_URL = new URL("../migrations/read/", import.meta.url);

/** Repository-relative path of the CORE directory, for wrangler configs and docs. */
export const CORE_MIGRATIONS_PATH = "packages/storage-d1/migrations/core";
/** Repository-relative path of the READ directory. */
export const READ_MIGRATIONS_PATH = "packages/storage-d1/migrations/read";

/** `NNNN_snake_name.sql`: the only shape wrangler's migration ordering accepts. */
export const MIGRATION_FILENAME = /^(\d{4})_[a-z0-9_]+\.sql$/u;

/** The migration number a filename declares, or null if it is not a migration. */
export function migrationNumber(filename: string): number | null {
  const match = MIGRATION_FILENAME.exec(filename);
  return match ? Number.parseInt(match[1] as string, 10) : null;
}
