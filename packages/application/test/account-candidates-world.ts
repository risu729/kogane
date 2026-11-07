// The synthetic store behind the account correspondence candidate tests
// (ADR 0077): CORE 0017+ on the Layer A stub, connection reviews inserted
// through the review table's own evidence triggers, and source accounts with
// rule mappings. Shared by account-candidates.test.ts and the web contract
// test. Every producer, connection key, account id and label is synthetic.
import type { Database } from "bun:sqlite";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { stubDatabase } from "./instrument-resolution-world.ts";
export const MF = "moneyforward-me";
// The only direct source a confirmed review may name (CORE 0023 CHECK).
export const BANK = "sbi-shinsei-bank";
export const MF_PRODUCER = "synthetic-mf-collector";
export const DIRECT_PRODUCER = "synthetic-direct";
export const KEY_A = `moneyforward-account-v2-${"a".repeat(64)}`;
export const KEY_B = `moneyforward-account-v2-${"b".repeat(64)}`;
export const KEY_C = `moneyforward-account-v2-${"c".repeat(64)}`;

export class Store {
  readonly db: Database = stubDatabase();
  readonly sql: SqlExecutor;
  private sequence = 0;

  constructor() {
    this.db.exec(`INSERT INTO sources VALUES('${MF}','synthetic'),('${BANK}','synthetic');
      INSERT INTO producers VALUES('${MF_PRODUCER}'),('${DIRECT_PRODUCER}');`);
    const db = this.db;
    this.sql = {
      all: async <T>(text: string, args: readonly unknown[]) =>
        db.query(text).all(...(args as never[])) as T[],
      first: async <T>(text: string, args: readonly unknown[]) =>
        (db.query(text).get(...(args as never[])) as T | null) ?? null,
    };
  }

  private id(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /** A sealed, successful run of `source` with one unit keyed `unitKey`. */
  run(source: string, producer: string, unitKey: string): { run: number; unit: number } {
    const run = this.id();
    this.db.run(
      "INSERT INTO acquisition_sessions(id,external_session_id,producer_id,external_id_namespace) VALUES(?,?,?,'synthetic')",
      [run, `synthetic-session-${String(run)}`, producer],
    );
    this.db.run(
      "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(?,?,?,?,0)",
      [run, source, run, producer],
    );
    this.db.run("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',0,0)", [run]);
    this.db.run("INSERT INTO fetch_run_seals(fetch_run_id) VALUES(?)", [run]);
    const unit = this.id();
    this.db.run(
      "INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,'account')",
      [unit, run, unitKey],
    );
    return { run, unit };
  }

  artifact(run: number, unit: number, source: string, dataset: string): number {
    const id = this.id();
    this.db.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,fetched_at_ms,recorded_at_ms,sha256,artifact_role)
       VALUES(?,?,?,?,'synthetic.html',?,0,0,?,'provider_response')`,
      [id, run, source, dataset, unit, id.toString(16).padStart(64, "0")],
    );
    return id;
  }

  /** A source account with a rule mapping to its own account entity. */
  sourceAccount(id: string, source: string, producer: string, reference: string[], label: string) {
    this.db.run(
      "INSERT INTO source_accounts(id,source_id,producer_id,reference_json) VALUES(?,?,?,?)",
      [id, source, producer, JSON.stringify(reference)],
    );
    this.db.run(
      "INSERT INTO accounts(id,label,role,status) VALUES(?,?,'deposit','provider-local')",
      [`account-${id}`, label],
    );
    this.db.run(
      `INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
       VALUES(?,?,1,?,'rule','synthetic-rule',1,'2099-01-01T00:00:00.000Z',?,'provider-local')`,
      [`mapping-${id}`, id, `account-${id}`, label],
    );
  }

  /** The aggregator source account of identity value `key`. */
  aggregator(id: string, key: string): void {
    this.sourceAccount(id, MF, MF_PRODUCER, [`${MF}:${key}`], "Synthetic aggregator connection");
  }

  /**
   * A current connection review of `key`: confirmed with the exact direct
   * source accounts (evidence from one successful direct run), or unresolved.
   * Returns the direct run, so a test can exclude it.
   */
  review(key: string, directs: string[], label = "Synthetic bank (aggregator)"): number | null {
    const mf = this.run(MF, MF_PRODUCER, key);
    const detail = this.artifact(mf.run, mf.unit, MF, "account-detail");
    if (directs.length === 0) {
      this.db.run(
        `INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,reason,verifier_version,detail_artifact_id,direct_reference_ids_json,created_at)
         VALUES(?,?,1,?,'unresolved','synthetic','synthetic-v1',?,'[]','2099-01-01T00:00:00.000Z')`,
        [MF_PRODUCER, key, label, detail],
      );
      return null;
    }
    const direct = this.run(BANK, DIRECT_PRODUCER, "bank");
    const overview = this.artifact(
      direct.run,
      direct.unit,
      BANK,
      "top-accounts-balance-and-activity",
    );
    const branch = this.artifact(direct.run, direct.unit, BANK, "balance-summary-and-stage");
    this.db.run(
      `INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,related_source_id,direct_producer_id,reason,verifier_version,detail_artifact_id,direct_artifact_id,branch_artifact_id,direct_reference_ids_json,created_at)
       VALUES(?,?,1,?,'confirmed',?,?,'synthetic','synthetic-v1',?,?,?,?,'2099-01-01T00:00:00.000Z')`,
      [
        MF_PRODUCER,
        key,
        label,
        BANK,
        DIRECT_PRODUCER,
        detail,
        overview,
        branch,
        JSON.stringify(directs),
      ],
    );
    return direct.run;
  }

  exclude(run: number): void {
    this.db.run("INSERT INTO fetch_run_annotations VALUES(?,'exclude_from_financial_views')", [
      run,
    ]);
  }

  /** Every row of the tables a read must never write. */
  snapshot(): string {
    return JSON.stringify(
      [
        "entity_relations",
        "decision_revisions",
        "decision_operations",
        "change_plans",
        "account_mappings",
      ].map((table) => this.db.query(`SELECT * FROM ${table} ORDER BY 1`).all()),
    );
  }
}

/**
 * The synthetic world:
 * - connection A (key A) confirmed with two direct accounts (ordinary and
 *   time deposit), and its aggregator source account;
 * - connection B (key B) confirmed with the ordinary account too: a displayed
 *   number that both registrations share, so the ordinary account is claimed
 *   twice;
 * - connection C (key C) unresolved, labelled exactly like the direct
 *   ordinary account;
 * - an aggregator source account no review names.
 */
export function world(): Store {
  const s = new Store();
  s.sourceAccount(
    "sa-direct-ordinary",
    BANK,
    DIRECT_PRODUCER,
    [`${BANK}:ordinary`],
    "Synthetic ordinary",
  );
  s.sourceAccount(
    "sa-direct-time",
    BANK,
    DIRECT_PRODUCER,
    [`${BANK}:time`],
    "Synthetic time deposit",
  );
  s.aggregator("sa-mf-a", KEY_A);
  s.aggregator("sa-mf-b", KEY_B);
  s.aggregator("sa-mf-c", KEY_C);
  s.aggregator("sa-mf-unreviewed", `moneyforward-account-v2-${"d".repeat(64)}`);
  s.review(KEY_A, ["sa-direct-ordinary", "sa-direct-time"]);
  s.review(KEY_B, ["sa-direct-ordinary"]);
  s.review(KEY_C, [], "Synthetic ordinary");
  return s;
}
