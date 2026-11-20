// A synthetic CORE store for the "changes since a time" digest (ADR 0127):
// every migration, foreign keys on, never analyzed, written the way the
// ingest Worker, the Processor and the event writers write it (each row
// stamped with its recording time, in recording order). Sources are the
// registered ids; every key, run id, time and count is invented, and no
// amount, merchant or provider text is written anywhere. Each statement is
// also kept, so a test can replay the same store into D1.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { migratedDatabase } from "./sqlite-store.ts";

const CLIENT = "synthetic-changes";
const PRODUCER = "collector-r2-importer";
const SHA = "d".repeat(64);
const hex = (n: number) => n.toString(16).padStart(64, "0");

export type RunState =
  | "success"
  | "partial"
  | "failed"
  | "human_required"
  | "cancelled"
  | "unknown"
  | "open";
export type ParseState = "published" | "superseded" | "unadopted" | "failed" | "pending";
export interface Rows {
  transaction?: number;
  balance?: number;
  position?: number;
  valuation?: number;
}

export interface Statement {
  sql: string;
  values: SQLQueryBindings[];
}

export class ChangesWorld {
  readonly db: Database = migratedDatabase();
  /** Every statement, in order, for a replay into another store. */
  readonly statements: Statement[] = [];
  private next: number;
  private readonly routes = new Set<string>();

  /** `firstId` leaves the ids below it to rows another writer adds. */
  constructor(firstId = 10_000) {
    this.next = firstId;
    this.exec("INSERT INTO ingest_clients(id,display_name,active) VALUES(?,'Changes client',1)", [
      CLIENT,
    ]);
    this.exec("INSERT OR IGNORE INTO producers(id) VALUES(?)", [PRODUCER]);
    this.exec(
      "INSERT OR IGNORE INTO ingest_client_producers(ingest_client_id,producer_id) VALUES(?,?)",
      [CLIENT, PRODUCER],
    );
    this.exec(
      "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?,3,'objects/synthetic-changes',0)",
      [SHA],
    );
  }

  private exec(sql: string, values: SQLQueryBindings[] = []): void {
    this.statements.push({ sql, values });
    this.db.query<unknown, SQLQueryBindings[]>(sql).run(...values);
  }

  private id(): number {
    this.next += 1;
    return this.next;
  }

  private route(source: string): void {
    if (this.routes.has(source)) return;
    this.routes.add(source);
    this.exec("INSERT OR IGNORE INTO producer_sources(producer_id,source_id) VALUES(?,?)", [
      PRODUCER,
      source,
    ]);
    this.exec(
      "INSERT OR IGNORE INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES(?,?,?)",
      [CLIENT, PRODUCER, source],
    );
  }

  /**
   * One fetch run first recorded at `at` (epoch ms) with `artifacts`
   * provider captures; sealed with a terminal report of `state`, or neither
   * sealed nor reported when `open`. `excluded` annotates it out of the
   * financial views.
   */
  run(
    source: string,
    at: number,
    state: RunState,
    artifacts = 1,
    excluded = false,
  ): { run: number; artifacts: number[] } {
    this.route(source);
    const session = this.id();
    this.exec(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?,?,?,'synthetic-changes',?,?)`,
      [session, PRODUCER, CLIENT, `changes-session-${session}`, at],
    );
    const run = this.id();
    this.exec(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,?,?,'default',?)`,
      [run, session, PRODUCER, source, CLIENT, at],
    );
    const ids: number[] = [];
    for (let index = 0; index < artifacts; index += 1) {
      const artifact = this.id();
      this.exec(
        `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
          payload_fidelity,container_kind,lineage_disposition,dataset,declared_media_type,media_type_basis,
          fetched_at_ms,fetched_at_basis,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
         VALUES(?,?,?,?,?,?,'provider_response','exact','single','not_applicable','synthetic',
          'application/json','response_header',?,'response',?,3,'v1',?,?)`,
        [
          artifact,
          run,
          source,
          PRODUCER,
          CLIENT,
          `capture-${index}.json`,
          at,
          SHA,
          hex(artifact),
          at,
        ],
      );
      ids.push(artifact);
    }
    if (excluded)
      this.exec(
        "INSERT INTO fetch_run_annotations(fetch_run_id,annotation_kind,reason_code,recorded_at_ms) VALUES(?,'exclude_from_financial_views','synthetic',?)",
        [run, at],
      );
    if (state !== "open") {
      const inventory = this.id();
      this.exec(
        `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
         VALUES(?,?,?,?,'operator',?,?)`,
        [inventory, run, hex(inventory), ids.length, at, CLIENT],
      );
      ids.forEach((artifact, index) =>
        this.exec(
          "INSERT INTO run_inventory_items(inventory_id,fetch_run_id,artifact_key,sha256,descriptor_sha256) VALUES(?,?,?,?,?)",
          [inventory, run, `capture-${index}.json`, SHA, hex(artifact)],
        ),
      );
      this.exec(
        `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,
          started_at_ms,started_at_basis,completed_at_ms,completed_at_basis,recorded_at_ms)
         VALUES(?,'terminal','terminal',?,?,?,'manifest',?,'manifest',?)`,
        [run, CLIENT, state, at, at, at],
      );
      this.exec(
        "INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?,?,?,?)",
        [inventory, run, at, CLIENT],
      );
    }
    return { run, artifacts: ids };
  }

  private observations(parse: number, rows: Rows): void {
    for (let n = 0; n < (rows.transaction ?? 0); n += 1)
      this.exec(
        "INSERT INTO transaction_observations(parse_run_id,source_account,external_id,raw_locator,extra_json) VALUES(?,'synthetic-account',?,?,'{}')",
        [parse, `row-${parse}-${n}`, `json:$.rows[${n}]`],
      );
    for (let n = 0; n < (rows.balance ?? 0); n += 1)
      this.exec(
        "INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json) VALUES(?,'synthetic-account','synthetic','XXX',?,'{}')",
        [parse, `json:$.balances[${n}]`],
      );
    for (let n = 0; n < (rows.position ?? 0); n += 1)
      this.exec(
        "INSERT INTO position_observations(parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json) VALUES(?,'synthetic-account',?,'1',0,?,'{}')",
        [parse, `code-${n}`, `json:$.positions[${n}]`],
      );
    for (let n = 0; n < (rows.valuation ?? 0); n += 1)
      this.exec(
        "INSERT INTO valuation_observations(parse_run_id,source_account,subject,metric,currency,raw_locator,extra_json) VALUES(?,'synthetic-account',?,'synthetic','XXX',?,'{}')",
        [parse, `code-${n}`, `json:$.valuations[${n}]`],
      );
  }

  private parseRun(
    artifact: number,
    parser: string,
    at: string,
    rows: Rows,
    version = "1.0.0",
  ): number {
    const parse = this.id();
    this.exec(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,?,'pending','[]')",
      [parse, artifact, parser, version, at],
    );
    this.observations(parse, rows);
    return parse;
  }

  /**
   * One parse of `artifact`, recorded at `at` (an ISO instant), with its
   * observation rows, ending in `state`. A `superseded` parse is replaced by
   * a later unadopted one recorded at `supersededAt` (default `at`).
   */
  parse(
    artifact: number,
    at: string,
    state: ParseState,
    rows: Rows = {},
    options: { parser?: string; supersededAt?: string } = {},
  ): number {
    const parser = options.parser ?? `synthetic-parser-${this.next}`;
    const parse = this.parseRun(artifact, parser, at, rows);
    if (state === "pending") return parse;
    if (state === "failed") {
      this.exec("UPDATE parse_runs SET status='error',error='synthetic_failure' WHERE id=?", [
        parse,
      ]);
      return parse;
    }
    this.exec("UPDATE parse_runs SET status='ok' WHERE id=?", [parse]);
    if (state === "unadopted") return parse;
    if (state === "superseded") {
      const later = this.parseRun(artifact, parser, options.supersededAt ?? at, {}, "1.1.0");
      this.exec("UPDATE parse_runs SET status='ok' WHERE id=?", [later]);
      this.exec("UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE id=?", [later, parse]);
      return parse;
    }
    this.exec(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,'1.0.0','done')",
      [artifact, parser],
    );
    this.exec(
      "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,?,NULL,?,'normal','pipeline','parse_ok',?)",
      [artifact, parser, parse, at],
    );
    this.exec(
      "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,?,?,'1.0.0',?,'normal')",
      [artifact, parser, parse, at],
    );
    return parse;
  }

  /** One event revision created at `at` (an ISO instant), with the decision it needs. */
  event(eventId: string, revision: number, kind: string, at: string): void {
    const decision = `dr_${eventId}_${revision}`;
    this.exec(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation',?,1,'accept','rule','rule:synthetic',NULL,'synthetic','[]',NULL,NULL,?)`,
      [decision, `event:${eventId}`, at],
    );
    const state =
      kind === "purchase" || kind === "refund"
        ? "captured"
        : kind === "charge"
          ? "observed"
          : kind === "fee"
            ? "confirmed"
            : kind === "unknown"
              ? "unknown"
              : "debited";
    this.exec(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
       VALUES(?,?,?,?,?,'{"kind":"local-date","value":"2099-01-01","zone":null,"basis":"provider"}','cash-movement',
        '[{"kind":"transaction","id":"transaction:1","revision":"parse_run:1"}]',?,NULL,?)`,
      [eventId, revision, kind, state, state === "unknown" ? "kind_undecided" : null, decision, at],
    );
  }
}
