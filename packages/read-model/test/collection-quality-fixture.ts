// A synthetic CORE store for the collection quality read: every migration,
// foreign keys on, never analyzed, written the way the ingest Worker, the
// Processor and the schedule alarms write it. Sources, datasets and parsers
// are the registered ids; every key, unit, run id and time is invented, and no
// amount, merchant or provider text is written anywhere.
import type { Database } from "bun:sqlite";
import { fullCoreSchema } from "./card-usage-scale-fixture";

const CLIENT = "synthetic-quality";
const SHA = "c".repeat(64);

export interface ArtifactSpec {
  key: string;
  dataset: string | null;
  unit?: string;
  /** MyJCB credit-ledger metadata. */
  period?: string;
  state?: "confirmed" | "unconfirmed";
  role?: string;
}

export interface UnitSpec {
  outcome: "success" | "partial" | "failed" | "human_required" | "unknown";
  code?: string;
}

export interface RunSpec {
  source: string;
  /** Capture time of every artifact of the run (ISO). */
  at: string;
  outcome?: "success" | "partial" | "failed";
  producer?: string;
  units?: Record<string, UnitSpec>;
  artifacts: ArtifactSpec[];
}

export type ParseSpec =
  | { kind: "published"; version?: string; claim?: ClaimSpec }
  | { kind: "pending" | "running" }
  | { kind: "failed"; code: string; withRun?: boolean }
  | { kind: "error-run"; code: string }
  | { kind: "superseded" };

export interface ClaimSpec {
  completeness: "complete" | "partial" | "unknown";
  cause?: string | null;
  observed?: number;
  scopeKey?: string;
}

export class QualityStore {
  readonly db: Database = fullCoreSchema();
  private next = 5_000;
  private readonly routes = new Set<string>();

  constructor() {
    this.db.run("INSERT INTO ingest_clients(id,display_name,active) VALUES(?,'Quality client',1)", [
      CLIENT,
    ]);
    this.db.run(
      "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?,3,'objects/synthetic-quality',0)",
      [SHA],
    );
  }

  id(): number {
    this.next += 1;
    return this.next;
  }

  private route(producer: string, source: string): void {
    const key = `${producer}/${source}`;
    if (this.routes.has(key)) return;
    this.routes.add(key);
    this.db.run("INSERT OR IGNORE INTO producers(id) VALUES(?)", [producer]);
    this.db.run("INSERT OR IGNORE INTO producer_sources(producer_id,source_id) VALUES(?,?)", [
      producer,
      source,
    ]);
    this.db.run(
      "INSERT OR IGNORE INTO ingest_client_producers(ingest_client_id,producer_id) VALUES(?,?)",
      [CLIENT, producer],
    );
    this.db.run(
      "INSERT OR IGNORE INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES(?,?,?)",
      [CLIENT, producer, source],
    );
  }

  /** One sealed run with its units and artifacts; returns the run and artifact ids in order. */
  run(spec: RunSpec): { run: number; artifacts: number[] } {
    const db = this.db;
    const producer = spec.producer ?? "collector-r2-importer";
    this.route(producer, spec.source);
    const at = Date.parse(spec.at);
    const session = this.id();
    db.run(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?,?,?,'synthetic-quality',?,?)`,
      [session, producer, CLIENT, `quality-session-${session}`, at],
    );
    const run = this.id();
    db.run(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,?,?,'default',?)`,
      [run, session, producer, spec.source, CLIENT, at],
    );
    const units = new Map<string, number>();
    for (const [key, unit] of Object.entries(spec.units ?? {})) {
      const unitId = this.id();
      units.set(key, unitId);
      db.run(
        `INSERT INTO fetch_units(id,fetch_run_id,unit_kind,unit_key,recorded_by_client_id,recorded_at_ms)
         VALUES(?,?,'account',?,?,?)`,
        [unitId, run, key, CLIENT, at],
      );
      db.run(
        `INSERT INTO fetch_unit_reports(fetch_unit_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,safe_failure_code,recorded_at_ms)
         VALUES(?,'terminal','terminal',?,?,?,?)`,
        [unitId, CLIENT, unit.outcome, unit.code ?? null, at],
      );
    }
    const stored: { key: string; id: number }[] = [];
    for (const artifact of spec.artifacts) {
      const artifactId = this.id();
      const unit = artifact.unit === undefined ? null : units.get(artifact.unit);
      if (unit === undefined) throw new Error(`undeclared unit ${artifact.unit}`);
      const role = artifact.role ?? "provider_response";
      db.run(
        `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,fetch_unit_id,artifact_key,artifact_role,
          payload_fidelity,container_kind,lineage_disposition,dataset,format_id,format_version,declared_media_type,media_type_basis,
          fetched_at_ms,fetched_at_basis,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
         VALUES(?,?,?,?,?,?,?,?,?,'single','not_applicable',?,NULL,NULL,'application/json','response_header',?,'response',?,3,'v1',?,?)`,
        [
          artifactId,
          run,
          spec.source,
          producer,
          CLIENT,
          unit,
          artifact.key,
          role,
          // A collector's own record is generated; a provider response is kept exact.
          ["collector_manifest", "collector_error", "collector_summary"].includes(role)
            ? "generated"
            : "exact",
          artifact.dataset,
          at,
          SHA,
          artifactId.toString(16).padStart(64, "0"),
          at,
        ],
      );
      if (artifact.period !== undefined || artifact.state !== undefined)
        db.run(
          "INSERT INTO observation_artifact_metadata(fetch_artifact_id,statement_state,period) VALUES(?,?,?)",
          [artifactId, artifact.state ?? null, artifact.period ?? null],
        );
      stored.push({ key: artifact.key, id: artifactId });
    }
    const inventory = this.id();
    db.run(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
       VALUES(?,?,?,?,'operator',?,?)`,
      [inventory, run, inventory.toString(16).padStart(64, "0"), stored.length, at, CLIENT],
    );
    for (const { key, id } of stored)
      db.run(
        "INSERT INTO run_inventory_items(inventory_id,fetch_run_id,artifact_key,sha256,descriptor_sha256) VALUES(?,?,?,?,?)",
        [inventory, run, key, SHA, id.toString(16).padStart(64, "0")],
      );
    db.run(
      `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,
        started_at_ms,started_at_basis,completed_at_ms,completed_at_basis,recorded_at_ms)
       VALUES(?,'terminal','terminal',?,?,?,'manifest',?,'manifest',?)`,
      [run, CLIENT, spec.outcome ?? "success", at, at, at],
    );
    db.run(
      "INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?,?,?,?)",
      [inventory, run, at, CLIENT],
    );
    return { run, artifacts: stored.map((entry) => entry.id) };
  }

  /** One parse of `artifact` by `parser`, in the given state; returns the parse run id when one exists. */
  parse(artifact: number, parser: string, spec: ParseSpec): number | null {
    const db = this.db;
    const version = spec.kind === "published" ? (spec.version ?? "1.0.0") : "1.0.0";
    const job = (status: string, code: string | null = null) =>
      db.run(
        `INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,last_error_code,created_at_ms)
         VALUES(?,?,?,?,?,?)`,
        [artifact, parser, version, status, code, this.id()],
      );
    if (spec.kind === "pending" || spec.kind === "running") {
      job(spec.kind);
      return null;
    }
    if (spec.kind === "failed") {
      job("failed", spec.code);
      if (!spec.withRun) return null;
    }
    if (spec.kind === "failed" || spec.kind === "error-run") {
      const parse = this.id();
      db.run(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,error,warnings_json) VALUES(?,?,?,?,'2099-01-01','error',?,'[]')",
        [parse, artifact, parser, version, spec.code],
      );
      return parse;
    }
    const parse = this.id();
    db.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'2099-01-01','pending','[]')",
      [parse, artifact, parser, version],
    );
    if (spec.kind === "published" && spec.claim !== undefined)
      this.claim(parse, artifact, spec.claim);
    db.run("UPDATE parse_runs SET status='ok' WHERE id=?", [parse]);
    if (spec.kind === "superseded") {
      // Replaced by a later successful run that is not adopted (a candidate,
      // invisible to every read): the superseded run is a recorded,
      // unpublished result with no job pending or failed.
      const later = this.id();
      db.run(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1.1.0','2099-01-02','pending','[]')",
        [later, artifact, parser],
      );
      db.run("UPDATE parse_runs SET status='ok' WHERE id=?", [later]);
      db.run("UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE id=?", [later, parse]);
      return parse;
    }
    db.run(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'done')",
      [artifact, parser, version],
    );
    db.run(
      "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,?,NULL,?,'normal','pipeline','parse_ok','2099-01-01')",
      [artifact, parser, parse],
    );
    db.run(
      "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,?,?,?,'2099-01-01','normal')",
      [artifact, parser, parse, version],
    );
    return parse;
  }

  /** A coverage claim on `parse`, scoped to its artifact's container key. */
  private claim(parse: number, artifact: number, spec: ClaimSpec): void {
    const row = this.db
      .query(
        "SELECT source_id, dataset, fetch_unit_key FROM observation_fetch_artifacts WHERE id = ?",
      )
      .get(artifact) as {
      source_id: string;
      dataset: string | null;
      fetch_unit_key: string | null;
    };
    const scope =
      spec.scopeKey ??
      `${row.source_id}/${row.dataset ?? ""}${row.fetch_unit_key === null ? "" : `/unit=${row.fetch_unit_key}`}`;
    const observed = spec.observed ?? 1;
    const complete = spec.completeness === "complete" && (spec.cause ?? null) === null;
    this.db.run(
      `INSERT INTO parse_coverage_claims(parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,observed_count,
        evidence_refs_json,policy_version,failure_cause,absence_meaning,parent_run_status,parent_run_failure_count)
       VALUES(?,?,?,'complete-container',?,?,?,'[]','coverage-v1',?,?,'success',0)`,
      [
        parse,
        `claim-${parse}`,
        scope,
        spec.completeness,
        complete ? 1 : 0,
        observed,
        spec.cause ?? null,
        observed > 0 ? "not-applicable" : complete ? "complete-empty" : "not-observed",
      ],
    );
  }

  /** A schedule receipt of a configured job. */
  occurrence(
    schedule: string,
    spec: { nominalAt: string; status: string; failureCode?: string; runIds?: string[] },
  ): void {
    this.db.run(
      `INSERT INTO collection_schedule_occurrences(id,schedule_id,nominal_at,started_at,finished_at,status,run_ids_json,failure_code)
       VALUES(?,?,?,?,?,?,?,?)`,
      [
        `scheduled:${schedule}:${Date.parse(spec.nominalAt)}`,
        schedule,
        spec.nominalAt,
        spec.nominalAt,
        spec.status === "started" ? null : spec.nominalAt,
        spec.status,
        JSON.stringify(spec.runIds ?? []),
        spec.failureCode ?? null,
      ],
    );
  }

  lease(source: string, startedAt: string): void {
    this.db.run(
      "INSERT INTO collection_execution_leases(source,lease_ref,started_at) VALUES(?,?,?)",
      [source, "00000000-0000-4000-8000-000000000000", startedAt],
    );
  }

  /** A terminal the collection scan saw, optionally registered as `fetchRun` or blocked. */
  terminal(spec: {
    source: string;
    runId: string;
    outcome: "success" | "partial" | "failed" | null;
    coverage?: "complete" | "partial" | "unknown";
    blockedCode?: string;
    fetchRun?: number;
    contract?: string;
    seenAt?: string;
    stage?: { state: string; failureCode?: string };
  }): number {
    const id = this.id();
    const blocked = spec.blockedCode ?? (spec.outcome === null ? "manifest_invalid" : null);
    this.db.run(
      `INSERT INTO collection_runs(id,source,run_id,terminal_key,terminal_digest,registration_contract_version,provider_outcome,
        coverage_status,first_seen_at,blocked_code) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        spec.source,
        spec.runId,
        `runs/${spec.source}/${spec.runId}/terminal.json`,
        id.toString(16).padStart(64, "0"),
        spec.contract ?? "terminal-registration-v2",
        spec.outcome,
        spec.outcome === null ? null : (spec.coverage ?? "complete"),
        spec.seenAt ?? "2099-01-01T00:00:00.000Z",
        blocked,
      ],
    );
    if (spec.fetchRun !== undefined) {
      const session = this.db
        .query("SELECT acquisition_session_id AS s FROM fetch_runs WHERE id=?")
        .get(spec.fetchRun) as { s: number };
      this.db.run(
        "UPDATE collection_runs SET fetch_run_id=?,acquisition_session_id=?,registered_at='2099-01-01T00:00:00.000Z' WHERE id=?",
        [spec.fetchRun, session.s, id],
      );
    }
    if (spec.stage !== undefined)
      this.db.run(
        "INSERT INTO collection_run_stages(collection_run_id,stage,state,failure_code,recorded_at) VALUES(?,'registered',?,?,'2099-01-01T00:00:00.000Z')",
        [id, spec.stage.state, spec.stage.failureCode ?? null],
      );
    return id;
  }

  all<T>(sql: string, args: readonly (string | number | null)[] = []): T[] {
    return this.db.query(sql).all(...args) as T[];
  }
}
