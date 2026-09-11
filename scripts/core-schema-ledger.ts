// Generator for the schema ledgers of both databases (unified plan U01 /
// chapters 04 and 06):
//
//   CORE — `infra/schema/core-ledger.{json,md}` from
//          `packages/storage-d1/migrations/core`;
//   READ — `infra/schema/read-ledger.{json,md}` from
//          `packages/storage-d1/migrations/read` (U11).
//
// A ledger is produced by applying every migration of its directory to an
// in-memory `bun:sqlite` database and reading `sqlite_master` and the PRAGMAs
// back out, so it describes the schema the migrations actually build rather
// than what anyone believes they build. The two directories are never mixed:
// each profile names its own, which is the same separation the wrangler
// configurations keep (06 §2).
//
// Chapter 04 §2 divides the tables into what stays in CORE, what may move to
// READ and what is operational state, and states the rule this file exists to
// keep: **a table nobody classified is kept**. `scripts/core-schema-ledger.test.ts`
// fails when a table has no classification, so a new migration cannot add a
// table that silently falls outside the retention decision (acceptance test
// G0-01), and it fails when the committed ledger differs from a fresh dump.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MIGRATIONS_DIR = "packages/storage-d1/migrations/core";
export const LEDGER_JSON_PATH = "infra/schema/core-ledger.json";
export const LEDGER_MARKDOWN_PATH = "infra/schema/core-ledger.md";
export const READ_MIGRATIONS_DIR = "packages/storage-d1/migrations/read";
export const READ_LEDGER_JSON_PATH = "infra/schema/read-ledger.json";
export const READ_LEDGER_MARKDOWN_PATH = "infra/schema/read-ledger.md";

export type Classification =
  | "core-keep"
  | "read-candidate"
  | "operational-mutable"
  | "unclassified-keep"
  // READ-side (U11): what the projection is, and the state that drives a build.
  | "read-projection"
  | "read-operational";

interface ClassificationEntry {
  classification: Classification;
  /** The row of chapter 04 §2 this table was read from, or why it has none. */
  planRow: string;
}

/**
 * Chapter 04 §2, transcribed table by table.
 *
 * The chapter itself says it lists the groups whose names could be confirmed
 * and not the full schema, and that the default for anything unlisted is to
 * keep it. `unclassified-keep` is therefore a real answer, not a gap: those
 * tables are kept and are out of scope for any cleanup until someone classifies
 * them on purpose.
 */
export const CLASSIFICATION: Readonly<Record<string, ClassificationEntry>> = {
  // acquisition_sessions, fetch_runs/units/reports/ranges/page groups → CORE
  acquisition_sessions: { classification: "core-keep", planRow: "acquisition and fetch history" },
  artifact_ranges: { classification: "core-keep", planRow: "acquisition and fetch history" },
  fetch_page_groups: { classification: "core-keep", planRow: "acquisition and fetch history" },
  fetch_run_ranges: { classification: "core-keep", planRow: "acquisition and fetch history" },
  fetch_run_reports: { classification: "core-keep", planRow: "acquisition and fetch history" },
  fetch_runs: { classification: "core-keep", planRow: "acquisition and fetch history" },
  fetch_unit_reports: { classification: "core-keep", planRow: "acquisition and fetch history" },
  fetch_units: { classification: "core-keep", planRow: "acquisition and fetch history" },
  // raw_objects, fetch_artifacts, origin/transform/artifact relations → CORE + DATA R2
  artifact_email_metadata: { classification: "core-keep", planRow: "raw objects and origin" },
  artifact_file_metadata: { classification: "core-keep", planRow: "raw objects and origin" },
  artifact_http_metadata: { classification: "core-keep", planRow: "raw objects and origin" },
  artifact_relations: { classification: "core-keep", planRow: "raw objects and origin" },
  artifact_storage_metadata: { classification: "core-keep", planRow: "raw objects and origin" },
  artifact_transform_steps: { classification: "core-keep", planRow: "raw objects and origin" },
  fetch_artifacts: { classification: "core-keep", planRow: "raw objects and origin" },
  raw_objects: { classification: "core-keep", planRow: "raw objects and origin" },
  // inventories, seals, ingestion_attempts, verification events → CORE
  fetch_run_seals: { classification: "core-keep", planRow: "inventories, seals and verification" },
  ingestion_attempts: {
    classification: "core-keep",
    planRow: "inventories, seals and verification",
  },
  raw_object_verification_events: {
    classification: "core-keep",
    planRow: "inventories, seals and verification",
  },
  run_inventories: { classification: "core-keep", planRow: "inventories, seals and verification" },
  run_inventory_items: {
    classification: "core-keep",
    planRow: "inventories, seals and verification",
  },
  // parse_runs, every observation, parse_coverage_claims → CORE
  balance_observations: { classification: "core-keep", planRow: "parse runs and observations" },
  parse_coverage_claims: { classification: "core-keep", planRow: "parse runs and observations" },
  parse_runs: { classification: "core-keep", planRow: "parse runs and observations" },
  position_observations: { classification: "core-keep", planRow: "parse runs and observations" },
  transaction_observations: { classification: "core-keep", planRow: "parse runs and observations" },
  valuation_observations: { classification: "core-keep", planRow: "parse runs and observations" },
  // metadata_projections/inputs, parse_input_references → CORE
  metadata_projection_inputs: { classification: "core-keep", planRow: "metadata projections" },
  metadata_projections: { classification: "core-keep", planRow: "metadata projections" },
  parse_input_references: { classification: "core-keep", planRow: "metadata projections" },
  // parser_releases, parse_run_candidates, comparisons, activations → CORE
  active_releases: { classification: "core-keep", planRow: "parser releases and activations" },
  parse_run_candidates: {
    classification: "core-keep",
    planRow: "parser releases and activations",
  },
  parser_releases: { classification: "core-keep", planRow: "parser releases and activations" },
  release_activation_events: {
    classification: "core-keep",
    planRow: "parser releases and activations",
  },
  release_comparisons: { classification: "core-keep", planRow: "parser releases and activations" },
  // published_parse_runs, publication_events → CORE
  publication_events: { classification: "core-keep", planRow: "publication pointer and history" },
  published_parse_runs: {
    classification: "core-keep",
    planRow: "publication pointer and history",
  },
  // observation_decimal_values → CORE initially
  observation_decimal_values: {
    classification: "core-keep",
    planRow: "observation_decimal_values (CORE for now; columns may be copied to READ)",
  },
  // source_accounts, identifiers, identity runs/seals, mapping revisions → CORE
  account_mappings: { classification: "core-keep", planRow: "identity and mappings" },
  accounts: { classification: "core-keep", planRow: "identity and mappings" },
  identity_instrument_uses: { classification: "core-keep", planRow: "identity and mappings" },
  identity_observations: { classification: "core-keep", planRow: "identity and mappings" },
  identity_run_policies: { classification: "core-keep", planRow: "identity and mappings" },
  identity_run_seals: { classification: "core-keep", planRow: "identity and mappings" },
  identity_runs: { classification: "core-keep", planRow: "identity and mappings" },
  identity_vpass_bindings: { classification: "core-keep", planRow: "identity and mappings" },
  instrument_identifiers: { classification: "core-keep", planRow: "identity and mappings" },
  instrument_mappings: { classification: "core-keep", planRow: "identity and mappings" },
  instruments: { classification: "core-keep", planRow: "identity and mappings" },
  source_accounts: { classification: "core-keep", planRow: "identity and mappings" },
  source_external_ids: { classification: "core-keep", planRow: "identity and mappings" },
  // decision_operations/revisions, entity_relations, connection reviews → CORE
  account_connection_reviews: { classification: "core-keep", planRow: "decisions and relations" },
  decision_operations: { classification: "core-keep", planRow: "decisions and relations" },
  decision_revisions: { classification: "core-keep", planRow: "decisions and relations" },
  entity_relations: { classification: "core-keep", planRow: "decisions and relations" },
  // change_plans, approvals, operation_receipts, decision_outbox → CORE
  approvals: { classification: "core-keep", planRow: "change plans, approvals and receipts" },
  change_plans: { classification: "core-keep", planRow: "change plans, approvals and receipts" },
  decision_outbox: { classification: "core-keep", planRow: "change plans, approvals and receipts" },
  operation_receipts: {
    classification: "core-keep",
    planRow: "change plans, approvals and receipts",
  },
  // The operations API's own acceptance records (0040) sit in the same row:
  // an accepted request is the promise of follow-up work, and its stage rows
  // are the evidence that work happened. Both stay in CORE.
  ops_requests: { classification: "core-keep", planRow: "change plans, approvals and receipts" },
  ops_request_stages: {
    classification: "core-keep",
    planRow: "change plans, approvals and receipts",
  },
  // The shared-R2 terminal registration records (0039) sit in the same row as
  // the rest of the acquisition history: `collection_runs` is the fact that a
  // terminal was seen for one run under one registration contract, and its
  // stage rows are the evidence of what happened to it (03 §5). Both are CORE
  // and neither is derivable from a `last_success_at`.
  collection_runs: { classification: "core-keep", planRow: "acquisition and fetch history" },
  collection_run_stages: {
    classification: "core-keep",
    planRow: "acquisition and fetch history",
  },
  // The bounded terminal scan's R2 cursor: a checkpoint, resettable, and
  // excluded from anything that treats a row as evidence.
  collection_scan_state: {
    classification: "operational-mutable",
    planRow:
      "parse jobs, replay plans, work items, lane state (CORE until checkpoints are split out)",
  },
  // parse jobs, replay plans, work items, lane state → CORE for now, mutable
  observation_lane_state: {
    classification: "operational-mutable",
    planRow:
      "parse jobs, replay plans, work items, lane state (CORE until checkpoints are split out)",
  },
  observation_parse_jobs: {
    classification: "operational-mutable",
    planRow:
      "parse jobs, replay plans, work items, lane state (CORE until checkpoints are split out)",
  },
  observation_replay_plans: {
    classification: "operational-mutable",
    planRow:
      "parse jobs, replay plans, work items, lane state (CORE until checkpoints are split out)",
  },
  observation_work_items: {
    classification: "operational-mutable",
    planRow:
      "parse jobs, replay plans, work items, lane state (CORE until checkpoints are split out)",
  },
  // reconciliation_proposals → CORE
  reconciliation_proposals: { classification: "core-keep", planRow: "reconciliation proposals" },
  // economic_event_revisions, legs, allocations, obligations, settlements → CORE
  allocations: { classification: "core-keep", planRow: "economic events" },
  economic_event_revisions: { classification: "core-keep", planRow: "economic events" },
  economic_legs: { classification: "core-keep", planRow: "economic events" },
  obligation_revisions: { classification: "core-keep", planRow: "economic events" },
  settlement_relations: { classification: "core-keep", planRow: "economic events" },
  // reward_programs, expiry_rules, conversion_offers → CORE
  conversion_offers: { classification: "core-keep", planRow: "reward reference claims" },
  expiry_rules: { classification: "core-keep", planRow: "reward reference claims" },
  reward_programs: { classification: "core-keep", planRow: "reward reference claims" },
  // reward_bucket_claims, membership_state_claims → CORE
  membership_state_claims: {
    classification: "core-keep",
    planRow: "provider/self-reported claims",
  },
  reward_bucket_claims: { classification: "core-keep", planRow: "provider/self-reported claims" },
  // price_observations, calculation_policies → CORE
  calculation_policies: { classification: "core-keep", planRow: "prices and calculation policies" },
  price_observations: { classification: "core-keep", planRow: "prices and calculation policies" },
  // calculation_runs/results, report_artifacts/events → CORE + DATA R2
  calculation_results: { classification: "core-keep", planRow: "calculation runs and reports" },
  calculation_runs: { classification: "core-keep", planRow: "calculation runs and reports" },
  report_artifacts: { classification: "core-keep", planRow: "calculation runs and reports" },
  report_events: { classification: "core-keep", planRow: "calculation runs and reports" },
  // evidence_use_restrictions, retention, grant/revocation → CORE
  evidence_use_restrictions: {
    classification: "core-keep",
    planRow: "evidence use restrictions and retention",
  },
  retention_classes: {
    classification: "core-keep",
    planRow: "evidence use restrictions and retention",
  },
  // sources/producers, routes, applied configuration state → CORE
  http_scope_rules: { classification: "core-keep", planRow: "sources, producers and routes" },
  ingest_client_producers: {
    classification: "core-keep",
    planRow: "sources, producers and routes",
  },
  ingest_client_routes: { classification: "core-keep", planRow: "sources, producers and routes" },
  ingest_clients: { classification: "core-keep", planRow: "sources, producers and routes" },
  origin_template_policies: {
    classification: "core-keep",
    planRow: "sources, producers and routes",
  },
  producer_sources: { classification: "core-keep", planRow: "sources, producers and routes" },
  producers: { classification: "core-keep", planRow: "sources, producers and routes" },
  sources: { classification: "core-keep", planRow: "sources, producers and routes" },
  // balance_read_snapshots, current_balance_projection, scope_relations → READ
  balance_read_snapshots: {
    classification: "read-candidate",
    planRow: "READ: rebuilt per fixed input and snapshot (U11)",
  },
  current_balance_projection: {
    classification: "read-candidate",
    planRow: "READ: rebuilt per fixed input and snapshot (U11)",
  },
  scope_relations: {
    classification: "read-candidate",
    planRow: "READ: rebuilt per fixed input and snapshot (U11); decision FK cannot cross databases",
  },
  // core_source_revision, projection_input_records, balance_snapshot_pointer → CORE (U10)
  balance_snapshot_pointer: {
    classification: "read-candidate",
    planRow: "READ: the active snapshot pointer moves with the projection (U11)",
  },
  core_source_revision: {
    classification: "core-keep",
    planRow:
      "CORE: the change detector every dependency write bumps (05 §2); operational in shape, but it is the ordering of CORE itself and a restore has to carry it",
  },
  projection_input_records: {
    classification: "core-keep",
    planRow:
      "CORE: the fixed input a build was made from (05 §3), referenced by the job and kept with the evidence it names",
  },
  // expiry_estimates, conversion_simulations → second-stage READ candidates
  conversion_simulations: {
    classification: "read-candidate",
    planRow: "second-stage READ candidate (U16): needs evaluation time, request and rule fixed",
  },
  expiry_estimates: {
    classification: "read-candidate",
    planRow: "second-stage READ candidate (U16): needs evaluation time, request and rule fixed",
  },
  // Not named in 04 §2. Default: keep (G0-01).
  dataset_snapshot_policies: {
    classification: "unclassified-keep",
    planRow: "not named in 04 §2; coverage policy configuration added by 0025",
  },
  fetch_run_annotations: {
    classification: "unclassified-keep",
    planRow: "not named in 04 §2; run annotations that the financial views read (0003)",
  },
  observation_artifact_metadata: {
    classification: "unclassified-keep",
    planRow: "not named in 04 §2; pipeline artifact metadata (0017)",
  },
  observation_scan_state: {
    classification: "unclassified-keep",
    planRow: "not named in 04 §2; single-row scan cursor (0017), same family as the checkpoint row",
  },
  parse_issues: {
    classification: "unclassified-keep",
    planRow: "not named in 04 §2; created with parse_coverage_claims (0025)",
  },
};

/**
 * The READ database of U11. Every table here is rebuildable by definition: the
 * projection of one fixed input, the references it was built from, and the
 * operational state of the builds. Nothing in it is a record of what a provider
 * reported, and nothing in it is the record of a decision (04 §1, §3).
 */
export const READ_CLASSIFICATION: Readonly<Record<string, ClassificationEntry>> = {
  balance_read_snapshots: {
    classification: "read-projection",
    planRow: "READ: one build of the projection, keyed by content and attempt (05 §4)",
  },
  current_balance_projection: {
    classification: "read-projection",
    planRow: "READ: the candidate measurements of one snapshot (04 §2)",
  },
  scope_relations: {
    classification: "read-projection",
    planRow: "READ: the typed scope relations of one snapshot (04 §2, §3)",
  },
  snapshot_input_refs: {
    classification: "read-projection",
    planRow: "READ: CORE references and digests copied from the fixed input (04 §3)",
  },
  balance_snapshot_pointer: {
    classification: "read-operational",
    planRow: "READ: the active snapshot, switched in the same batch as the seal (05 §5)",
  },
  read_build_checkpoints: {
    classification: "read-operational",
    planRow: "READ: where a bounded build got to, committed with its chunk (05 §4)",
  },
  read_instance: {
    classification: "read-operational",
    planRow: "READ: the identity of this physical database; a rebuild is a new one (05 §7)",
  },
  // The second stage of 04 §2: the reward tables, admitted to READ once the
  // evaluation time, the original request and the rule are fixed (U16).
  reward_expiry_snapshots: {
    classification: "read-projection",
    planRow: "READ: one reward build under one fixed evaluation input (04 §2, 05 §3)",
  },
  reward_expiry_estimates: {
    classification: "read-projection",
    planRow: "READ: the estimated deadlines of one snapshot (04 §2, second stage)",
  },
  reward_conversion_simulations: {
    classification: "read-projection",
    planRow: "READ: saved simulations replayed under the snapshot's fixed offers (04 §2, G2-20)",
  },
  reward_snapshot_input_refs: {
    classification: "read-projection",
    planRow: "READ: rules, offers and claims copied from the fixed reward input (04 §3)",
  },
  reward_snapshot_pointer: {
    classification: "read-operational",
    planRow: "READ: the active reward snapshot, switched in the same batch as the seal (05 §5)",
  },
  reward_build_checkpoints: {
    classification: "read-operational",
    planRow: "READ: where a bounded reward build got to, committed with its chunk (05 §4)",
  },
};

/** One ledger: which migrations it describes and how its tables are classified. */
export interface LedgerProfile {
  name: string;
  migrationsDir: string;
  classification: Readonly<Record<string, ClassificationEntry>>;
  /** The classification values this ledger reports, in order. */
  classifications: readonly Classification[];
  plan: string;
  jsonPath: string;
  markdownPath: string;
  /** The paragraph under the heading of the markdown ledger. */
  rule: readonly string[];
}

export const CORE_PROFILE: LedgerProfile = {
  name: "CORE",
  migrationsDir: MIGRATIONS_DIR,
  classification: CLASSIFICATION,
  classifications: ["core-keep", "read-candidate", "operational-mutable", "unclassified-keep"],
  plan: "unified plan U01; chapters 04 §2 and 06 §1; acceptance test G0-01",
  jsonPath: LEDGER_JSON_PATH,
  markdownPath: LEDGER_MARKDOWN_PATH,
  rule: [
    "Classification follows chapter 04 §2. That chapter lists the groups whose names could be",
    "confirmed, not the whole schema, and sets the rule this ledger exists to keep: **a table nobody",
    "classified is kept** (`unclassified-keep`) and is out of scope for any cleanup — acceptance",
    "test G0-01.",
  ],
};

export const READ_PROFILE: LedgerProfile = {
  name: "READ",
  migrationsDir: READ_MIGRATIONS_DIR,
  classification: READ_CLASSIFICATION,
  classifications: ["read-projection", "read-operational"],
  plan: "unified plan U11 and U16; chapters 04 §1–§3 and 05 §3–§7; acceptance tests G0-09, G3-01, G2-19, G2-20",
  jsonPath: READ_LEDGER_JSON_PATH,
  markdownPath: READ_LEDGER_MARKDOWN_PATH,
  rule: [
    "Every table here is rebuildable: the projection of one fixed input, the CORE references it was",
    "built from, and the operational state of the builds. No foreign key names a CORE table — two D1",
    "databases cannot be joined and cannot commit together (04 §1) — and losing this database costs a",
    "rebuild and every open cursor, never a piece of evidence, a decision or a receipt (G0-09).",
  ],
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * True while a `CREATE TRIGGER … BEGIN` body has not reached its closing `END`.
 *
 * `END` also closes a `CASE` expression, so the body is open until the `END`
 * that balances `BEGIN` once every `CASE … END` in between is paired off.
 * Quoted text is dropped before counting, so a string that says BEGIN or END
 * cannot open or close anything.
 */
function insideTriggerBody(statement: string): boolean {
  if (!/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/iu.test(statement)) return false;
  const bare = statement.replaceAll(/'[^']*'|"[^"]*"|`[^`]*`|\[[^\]]*\]/gu, " ");
  const words = (bare.match(/[A-Za-z_]+/gu) ?? []).map((word) => word.toUpperCase());
  const begin = words.indexOf("BEGIN");
  if (begin === -1) return true;
  let openCases = 0;
  for (const word of words.slice(begin + 1)) {
    if (word === "CASE") openCases += 1;
    else if (word === "END") {
      if (openCases === 0) return false;
      openCases -= 1;
    }
  }
  return true;
}

/**
 * Split a migration into top-level statements.
 *
 * The only subtlety is `CREATE TRIGGER … BEGIN … END;`: the semicolons inside
 * the body do not end the statement. Comments and quoted text are skipped so a
 * `;` or `--` inside a string never splits anything.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  const closers: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  while (index < sql.length) {
    const character = sql[index] as string;
    const closer = closers[character];
    if (closer !== undefined) {
      const start = index;
      index += 1;
      while (index < sql.length && sql[index] !== closer) index += 1;
      index += 1;
      current += sql.slice(start, Math.min(index, sql.length));
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (character === ";") {
      if (insideTriggerBody(current)) {
        current += character;
        index += 1;
        continue;
      }
      if (current.trim() !== "") statements.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  if (current.trim() !== "") statements.push(current.trim());
  return statements;
}

export interface MigrationRecord {
  file: string;
  statementCount: number;
  /** Top-level `INSERT` statements: seed rows and in-migration backfill (06 §1). */
  insertStatements: { table: string; kind: "seed-or-backfill" }[];
  sha256: string;
}

export interface TableRecord {
  name: string;
  classification: Classification;
  planRow: string;
  strict: boolean;
  withoutRowid: boolean;
  columns: { name: string; type: string; notNull: boolean; default: string | null; pk: number }[];
  primaryKey: string[];
  foreignKeys: { column: string; references: string; onDelete: string; onUpdate: string }[];
  indexes: { name: string; unique: boolean; partial: boolean; columns: string[] }[];
  triggers: string[];
  noUpdateTriggers: string[];
  noDeleteTriggers: string[];
  appendOnly: boolean;
  sqlSha256: string;
}

export interface SchemaLedger {
  generatedBy: string;
  plan: string;
  migrationsDir: string;
  migrations: MigrationRecord[];
  tables: TableRecord[];
  views: { name: string; columns: string[]; sqlSha256: string }[];
  triggers: { name: string; table: string; timing: string; event: string; sqlSha256: string }[];
  indexes: { name: string; table: string; sqlSha256: string }[];
  summary: {
    tableCount: number;
    viewCount: number;
    triggerCount: number;
    explicitIndexCount: number;
    byClassification: Record<Classification, string[]>;
    tablesWithoutAppendOnlyGuards: string[];
    nonStrictTables: string[];
    withoutRowidTables: string[];
    migrationsWithInserts: string[];
    schemaSha256: string;
  };
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** Apply every migration in order to a fresh in-memory database. */
export function applyMigrations(
  root: string,
  profile: LedgerProfile = CORE_PROFILE,
): { db: Database; migrations: MigrationRecord[] } {
  const directory = join(root, profile.migrationsDir);
  const db = new Database(":memory:");
  const migrations: MigrationRecord[] = [];
  for (const file of readdirSync(directory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(directory, file), "utf8");
    db.exec(sql);
    const statements = splitSqlStatements(sql);
    migrations.push({
      file,
      statementCount: statements.length,
      insertStatements: statements
        .filter((statement) => /^INSERT\b/iu.test(statement))
        .map((statement) => ({
          table:
            /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?<table>[A-Za-z_][A-Za-z0-9_]*)/iu.exec(statement)
              ?.groups?.["table"] ?? "(unknown)",
          kind: "seed-or-backfill" as const,
        })),
      sha256: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return { db, migrations };
}

export function buildSchemaLedger(
  root: string,
  profile: LedgerProfile = CORE_PROFILE,
): SchemaLedger {
  const { db, migrations } = applyMigrations(root, profile);
  const master = db
    .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name")
    .all() as MasterRow[];
  const objects = master.filter((row) => !row.name.startsWith("sqlite_"));
  const tableRows = objects.filter((row) => row.type === "table");
  const triggerRows = objects.filter((row) => row.type === "trigger");

  const tables: TableRecord[] = tableRows.map((row) => {
    const sql = row.sql ?? "";
    const tail = sql.slice(sql.lastIndexOf(")") + 1);
    const columns = db.query(`PRAGMA table_info(${JSON.stringify(row.name)})`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];
    const foreignKeys = db.query(`PRAGMA foreign_key_list(${JSON.stringify(row.name)})`).all() as {
      table: string;
      from: string;
      to: string | null;
      on_update: string;
      on_delete: string;
    }[];
    const indexes = (
      db.query(`PRAGMA index_list(${JSON.stringify(row.name)})`).all() as {
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }[]
    )
      .filter((index) => index.origin === "c")
      .map((index) => ({
        name: index.name,
        unique: index.unique === 1,
        partial: index.partial === 1,
        columns: (
          db.query(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as {
            name: string | null;
          }[]
        ).map((column) => column.name ?? "(expression)"),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const triggers = triggerRows
      .filter((trigger) => trigger.tbl_name === row.name)
      .map((trigger) => trigger.name)
      .sort();
    const entry = profile.classification[row.name];
    const noUpdateTriggers = triggers.filter((name) => name.endsWith("_no_update"));
    const noDeleteTriggers = triggers.filter((name) => name.endsWith("_no_delete"));
    return {
      name: row.name,
      classification: entry?.classification ?? "unclassified-keep",
      planRow: entry?.planRow ?? "MISSING from scripts/core-schema-ledger.ts classification",
      strict: /\bSTRICT\b/iu.test(tail),
      withoutRowid: /WITHOUT\s+ROWID/iu.test(tail),
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type,
        notNull: column.notnull === 1,
        default: column.dflt_value,
        pk: column.pk,
      })),
      primaryKey: columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
      foreignKeys: foreignKeys
        .map((key) => ({
          column: key.from,
          references: `${key.table}(${key.to ?? "rowid"})`,
          onDelete: key.on_delete,
          onUpdate: key.on_update,
        }))
        .sort(
          (a, b) => a.column.localeCompare(b.column) || a.references.localeCompare(b.references),
        ),
      indexes,
      triggers,
      noUpdateTriggers,
      noDeleteTriggers,
      appendOnly: noUpdateTriggers.length > 0 && noDeleteTriggers.length > 0,
      sqlSha256: digest(sql),
    };
  });

  const views = objects
    .filter((row) => row.type === "view")
    .map((row) => ({
      name: row.name,
      columns: (
        db.query(`PRAGMA table_info(${JSON.stringify(row.name)})`).all() as { name: string }[]
      ).map((column) => column.name),
      sqlSha256: digest(row.sql ?? ""),
    }));

  const triggers = triggerRows.map((row) => {
    const sql = row.sql ?? "";
    const match =
      /CREATE\s+TRIGGER\s+\S+\s+(?<timing>BEFORE|AFTER|INSTEAD\s+OF)\s+(?<event>INSERT|DELETE|UPDATE(?:\s+OF\s+[^\n]*?)?)\s+ON\b/iu.exec(
        sql,
      );
    return {
      name: row.name,
      table: row.tbl_name,
      timing: (match?.groups?.["timing"] ?? "unknown").toUpperCase().replaceAll(/\s+/gu, " "),
      event: (match?.groups?.["event"] ?? "unknown").toUpperCase().replaceAll(/\s+/gu, " "),
      sqlSha256: digest(sql),
    };
  });

  const indexes = objects
    .filter((row) => row.type === "index" && row.sql !== null)
    .map((row) => ({ name: row.name, table: row.tbl_name, sqlSha256: digest(row.sql ?? "") }));

  // Only the classifications this ledger reports, in the profile's order: the
  // CORE ledger keeps exactly the four keys it has always had.
  const byClassification = Object.fromEntries(
    profile.classifications.map((classification) => [classification, [] as string[]]),
  ) as Record<Classification, string[]>;
  for (const table of tables) (byClassification[table.classification] ??= []).push(table.name);

  db.close();
  return {
    generatedBy: "scripts/core-schema-ledger.ts",
    plan: profile.plan,
    migrationsDir: profile.migrationsDir,
    migrations,
    tables,
    views,
    triggers,
    indexes,
    summary: {
      tableCount: tables.length,
      viewCount: views.length,
      triggerCount: triggers.length,
      explicitIndexCount: indexes.length,
      byClassification,
      tablesWithoutAppendOnlyGuards: tables
        .filter((table) => !table.appendOnly)
        .map((table) => table.name),
      nonStrictTables: tables.filter((table) => !table.strict).map((table) => table.name),
      withoutRowidTables: tables.filter((table) => table.withoutRowid).map((table) => table.name),
      migrationsWithInserts: migrations
        .filter((migration) => migration.insertStatements.length > 0)
        .map((migration) => migration.file),
      schemaSha256: createHash("sha256")
        .update(objects.map((row) => `${row.type} ${row.name} ${row.sql ?? ""}`).join(""))
        .digest("hex"),
    },
  };
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.join(", ");
}

export function renderSchemaMarkdown(
  ledger: SchemaLedger,
  profile: LedgerProfile = CORE_PROFILE,
): string {
  const lines: string[] = [];
  lines.push(`# ${profile.name} schema ledger`);
  lines.push("");
  lines.push(
    `Generated by \`scripts/core-schema-ledger.ts\` by applying every migration in`,
    `\`${ledger.migrationsDir}\` to \`bun:sqlite\` and reading the schema back. Do not edit by hand:`,
    "`scripts/core-schema-ledger.test.ts` regenerates it and fails when this file and the migrations",
    "disagree, so a new migration has to update the ledger and the classification with it.",
  );
  lines.push("");
  lines.push(...profile.rule);
  lines.push("");
  lines.push(`Schema digest: \`${ledger.summary.schemaSha256}\``);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Migrations applied: ${ledger.migrations.length}`);
  lines.push(
    `- Tables: ${ledger.summary.tableCount} (all \`STRICT\`: ${ledger.summary.nonStrictTables.length === 0 ? "yes" : "no"})`,
  );
  lines.push(`- Views: ${ledger.summary.viewCount}`);
  lines.push(`- Triggers: ${ledger.summary.triggerCount}`);
  lines.push(`- Explicit indexes: ${ledger.summary.explicitIndexCount}`);
  lines.push(`- \`WITHOUT ROWID\` tables: ${list(ledger.summary.withoutRowidTables)}`);
  lines.push("");
  lines.push("| classification | count | tables |");
  lines.push("| --- | --- | --- |");
  for (const [classification, names] of Object.entries(ledger.summary.byClassification))
    lines.push(`| \`${classification}\` | ${names.length} | ${list(names)} |`);
  lines.push("");
  lines.push(
    "Tables without both an append-only `*_no_update` and `*_no_delete` guard (mutable by design —",
    "pointers, checkpoints, leases, configuration, and the READ-side projections):",
  );
  lines.push("");
  lines.push(`${list(ledger.summary.tablesWithoutAppendOnlyGuards)}`);
  lines.push("");

  lines.push("## Tables");
  lines.push("");
  lines.push(
    "| table | classification | plan row | STRICT | WITHOUT ROWID | append-only | `*_no_update` | `*_no_delete` | cols | FKs | idx | triggers |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const table of ledger.tables)
    lines.push(
      `| \`${table.name}\` | ${table.classification} | ${table.planRow} | ${table.strict ? "yes" : "**no**"} | ${table.withoutRowid ? "yes" : "no"} | ${table.appendOnly ? "yes" : "no"} | ${list(table.noUpdateTriggers)} | ${list(table.noDeleteTriggers)} | ${table.columns.length} | ${table.foreignKeys.length} | ${table.indexes.length} | ${table.triggers.length} |`,
    );
  lines.push("");
  lines.push(
    "Full column, foreign-key, index and trigger detail per table is in",
    `\`${profile.jsonPath}\`; the markdown keeps the retention decision readable.`,
  );
  lines.push("");

  lines.push("## Views");
  lines.push("");
  lines.push("| view | columns |");
  lines.push("| --- | --- |");
  for (const view of ledger.views) lines.push(`| \`${view.name}\` | ${list(view.columns)} |`);
  lines.push("");

  lines.push("## Migrations that INSERT rows");
  lines.push("");
  lines.push(
    "Chapter 06 §1 does not forbid `INSERT` in a migration; it forbids mixing schema, operational",
    "configuration, versioned reference claims and data repair. These are the migrations that write",
    "rows, listed so that the config work of 06 §3 and the backfill work of 06 §4 start from facts.",
  );
  lines.push("");
  lines.push("| migration | statements | rows written into |");
  lines.push("| --- | --- | --- |");
  for (const migration of ledger.migrations) {
    if (migration.insertStatements.length === 0) continue;
    const targets = [...new Set(migration.insertStatements.map((entry) => entry.table))].sort();
    lines.push(`| \`${migration.file}\` | ${migration.statementCount} | ${list(targets)} |`);
  }
  lines.push("");
  lines.push(
    `Migrations with no \`INSERT\`: ${list(
      ledger.migrations
        .filter((migration) => migration.insertStatements.length === 0)
        .map((migration) => migration.file),
    )}`,
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function main(root = REPO_ROOT): Promise<void> {
  for (const profile of [CORE_PROFILE, READ_PROFILE]) {
    const ledger = buildSchemaLedger(root, profile);
    await Bun.write(join(root, profile.jsonPath), `${JSON.stringify(ledger, null, 2)}\n`);
    await Bun.write(join(root, profile.markdownPath), renderSchemaMarkdown(ledger, profile));
    console.log(
      `wrote ${profile.jsonPath} and ${profile.markdownPath} (${ledger.summary.tableCount} tables, ${ledger.migrations.length} migrations)`,
    );
  }
}

if (import.meta.main) await main();
