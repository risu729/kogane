import type { SqlWrite } from "../../../packages/storage-d1/src/core/operations.ts";

export interface BatchCase {
  name: string;
  writes: SqlWrite[];
  expect: "write" | "zero" | "reject" | "read";
  codes?: string[];
  rowCount?: number;
  verify?: { write: SqlWrite; row: Record<string, string | number | null> };
}
export interface RaceCase {
  name: string;
  race: [SqlWrite[], SqlWrite[]];
  expect: "exclusive" | "idempotent";
  codes?: string[];
  verify: SqlWrite;
}
export interface Corpus {
  version: "synthetic-d1-conformance-v1";
  baseCommit: string;
  migrationDigest: string;
  lastMigration: string;
  baselineCounts: Record<string, number>;
  seed: SqlWrite[];
  cases: (BatchCase | RaceCase)[];
}
