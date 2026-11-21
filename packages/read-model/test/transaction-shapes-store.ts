// A CORE store of synthetic transactions with chosen `as_of` text, for the
// tests of what a `from`/`to` window places and what it leaves out. Sources,
// accounts, amounts and descriptions are placeholders; the `as_of` shapes are
// the ones docs/read-model.md lists, plus text no parser writes.
import type { SQLQueryBindings } from "bun:sqlite";
import { QualityStore } from "./collection-quality-fixture";

export interface SyntheticTransaction {
  asOf: string | null;
  account?: string;
  description?: string;
}

/**
 * One published parse of `parser` for `source`, holding one transaction per
 * entry. Each row has its own external id, so none is ranked away as a
 * duplicate of another.
 */
export function publishTransactions(
  store: QualityStore,
  source: string,
  parser: string,
  rows: readonly SyntheticTransaction[],
): void {
  const run = store.run({
    source,
    at: "2026-01-01T00:00:00Z",
    artifacts: [{ key: `${parser}-synthetic-${String(store.id())}`, dataset: null }],
  });
  const artifact = run.artifacts[0]!;
  const parse = store.id();
  store.db.run(
    "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1.0.0','2099-01-01','pending','[]')",
    [parse, artifact, parser],
  );
  const insert = store.db.query<unknown, SQLQueryBindings[]>(
    `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,amount_text,currency,as_of,description,raw_locator,extra_json)
     VALUES(?,?,?,'1','XTS',?,?,?,'{}')`,
  );
  rows.forEach((row, index) =>
    insert.run(
      parse,
      row.account ?? `${source}:synthetic`,
      `synthetic-${String(parse)}-${String(index)}`,
      row.asOf,
      row.description ?? "synthetic line",
      `row ${String(index)}`,
    ),
  );
  store.db.run("UPDATE parse_runs SET status='ok' WHERE id=?", [parse]);
  store.db.run(
    "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,?,NULL,?,'normal','pipeline','parse_ok','2099-01-01')",
    [artifact, parser, parse],
  );
  store.db.run(
    "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,?,?,'1.0.0','2099-01-01','normal')",
    [artifact, parser, parse],
  );
}

export { QualityStore };
