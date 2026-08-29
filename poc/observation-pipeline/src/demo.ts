// End-to-end demo: ingest the fixtures, run every parser, print what the
// store now contains. Run with `bun run demo` (then `bun run ui` to browse).

import { join } from "node:path";
import { ingestFixtures } from "./ingest.ts";
import { runParsers } from "./parse.ts";
import { openStore } from "./store.ts";

const store = openStore();
ingestFixtures(store, join(import.meta.dir, "..", "fixtures"));
const summary = runParsers(store);
console.log(
  `parse: ${summary.parsed} parsed, ${summary.skipped} already current, ` +
    `${summary.superseded} superseded, ${summary.observations} observations, ` +
    `${summary.errors} errors`,
);

const counts = (table: string): number =>
  (store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

for (const table of [
  "sources",
  "fetch_runs",
  "raw_objects",
  "fetch_artifacts",
  "parse_runs",
  "transaction_observations",
  "balance_observations",
  "position_observations",
  "valuation_observations",
]) {
  console.log(`${table.padEnd(26)} ${counts(table)}`);
}
