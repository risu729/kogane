// A synthetic CORE store for the activity filters (ADR 0081, amendment of
// 2026-11-20): every migration, foreign keys on, never analyzed. Captures of
// registered sources with a parse run each, and event revisions written the
// way the card purchase and card settlement writers write them (a decision,
// the revision, its legs; a later revision supersedes the earlier one). Every
// id, time, account and amount is invented; no provider text is written.
// Each statement is also kept, so a test can replay the same store into D1.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { fullCoreDatabase } from "../../storage-d1/test/sqlite.ts";

const CLIENT = "synthetic-events";
const PRODUCER = "collector-r2-importer";
const SHA = "e".repeat(64);
const hex = (n: number) => n.toString(16).padStart(64, "0");

/** Registered source ids (CORE 0002) the captures are recorded under. */
export const WORLD_SOURCES = ["vpass", "myjcb", "sony-bank", "smbc-bank"] as const;

export interface Statement {
  sql: string;
  values: SQLQueryBindings[];
}

interface WorldLeg {
  subjectRef: string;
  basis: string;
  role?: "increase" | "decrease" | "fee" | "unresolved";
}

export interface WorldEvent {
  eventId: string;
  revision: number;
  kind?: "purchase" | "card_settlement";
  createdAt: string;
  /** The evidence array as stored: usually SourceFactRefs, any JSON array element otherwise. */
  evidence: unknown[];
  legs: WorldLeg[];
  /** The live revisions this one replaces (each one's `superseded_by` is set to this revision). */
  supersedes?: { eventId: string; revision: number }[];
}

export class EventsWorld {
  readonly db: Database;
  /** Every statement, in order, for a replay into another store. */
  readonly statements: Statement[] = [];
  private next: number;
  private readonly routes = new Set<string>();
  private readonly record: boolean;

  /** `record` keeps every statement for a replay; a large store leaves it off. */
  constructor(options: { record?: boolean; firstId?: number } = {}) {
    this.db = fullCoreDatabase();
    this.record = options.record ?? false;
    this.next = options.firstId ?? 10_000;
    this.exec("INSERT INTO ingest_clients(id,display_name,active) VALUES(?,'Events client',1)", [
      CLIENT,
    ]);
    this.exec("INSERT OR IGNORE INTO producers(id) VALUES(?)", [PRODUCER]);
    this.exec(
      "INSERT OR IGNORE INTO ingest_client_producers(ingest_client_id,producer_id) VALUES(?,?)",
      [CLIENT, PRODUCER],
    );
    this.exec(
      "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?,3,'objects/synthetic-events',0)",
      [SHA],
    );
  }

  exec(sql: string, values: SQLQueryBindings[] = []): void {
    if (this.record) this.statements.push({ sql, values });
    this.db.query<unknown, SQLQueryBindings[]>(sql).run(...values);
  }

  private id(): number {
    this.next += 1;
    return this.next;
  }

  /** One sealed-or-not capture of `source` with one pending parse run; answers the parse run id. */
  capture(source: string): number {
    if (!this.routes.has(source)) {
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
    const session = this.id();
    this.exec(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?,?,?,'synthetic-events',?,0)`,
      [session, PRODUCER, CLIENT, `events-session-${session}`],
    );
    const run = this.id();
    this.exec(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,?,?,'default',0)`,
      [run, session, PRODUCER, source, CLIENT],
    );
    const artifact = this.id();
    this.exec(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
        payload_fidelity,container_kind,lineage_disposition,dataset,declared_media_type,media_type_basis,
        fetched_at_ms,fetched_at_basis,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
       VALUES(?,?,?,?,?,'capture.json','provider_response','exact','single','not_applicable','synthetic',
        'application/json','response_header',0,'response',?,3,'v1',?,0)`,
      [artifact, run, source, PRODUCER, CLIENT, SHA, hex(artifact)],
    );
    const parse = this.id();
    this.exec(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'synthetic-parser','1.0.0','2099-01-01T00:00:00.000Z','pending','[]')",
      [parse, artifact],
    );
    return parse;
  }

  /** One event revision with its decision and legs; a supersession is the one permitted update. */
  event(event: WorldEvent): void {
    const decision = `dr_${event.eventId}_${event.revision}`;
    this.exec(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation',?,1,'accept','rule','rule:synthetic',NULL,'synthetic','[]',NULL,NULL,'2099-01-01T00:00:00.000Z')`,
      [decision, `event:${event.eventId}`],
    );
    const kind = event.kind ?? "purchase";
    this.exec(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
       VALUES(?,?,?,?,NULL,'{"kind":"local-date","value":"2099-01-01","zone":null,"basis":"provider"}',?,?,?,NULL,?)`,
      [
        event.eventId,
        event.revision,
        kind,
        kind === "purchase" ? "captured" : "debited",
        kind === "purchase" ? "purchase-recognition" : "cash-movement",
        JSON.stringify(event.evidence),
        decision,
        event.createdAt,
      ],
    );
    event.legs.forEach((leg, index) =>
      this.exec(
        `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
         VALUES(?,?,?,?,'XXX','exact',?,0,NULL,?,?)`,
        [
          event.eventId,
          event.revision,
          index,
          leg.subjectRef,
          String(index + 1),
          leg.role ?? "decrease",
          leg.basis,
        ],
      ),
    );
    for (const replaced of event.supersedes ?? [])
      this.exec(
        "UPDATE economic_event_revisions SET superseded_by=? WHERE event_id=? AND revision=?",
        [`${event.eventId}@${event.revision}`, replaced.eventId, replaced.revision],
      );
  }
}

/** A transaction fact read in parse run `parse`, as the card writers cite one. */
export const transactionRef = (observation: number, parse: number | string) => ({
  kind: "transaction",
  id: `transaction:${observation}`,
  revision: typeof parse === "number" ? `parse_run:${parse}` : parse,
});

/** A small deterministic generator (mulberry32), so a failing store can be rebuilt from its seed. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
