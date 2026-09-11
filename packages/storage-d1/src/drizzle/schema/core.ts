// The CORE tables the Drizzle pilot touches, as `sqliteTable` definitions
// (unified plan 09 §3, decision D11).
//
// **This file is a mirror, not a source.** The database is created by the SQL
// migrations in `../../../migrations/core/`, which are immutable and applied
// by wrangler alone; nothing here is ever generated from, or applied to, a
// database. What a table declaration can express — column names, storage
// classes, NOT NULL, primary keys — is repeated here so queries can be typed,
// and `../../../test/drizzle-schema-parity.test.ts` re-reads the real schema
// with `PRAGMA table_info` on every CI run and fails if the two disagree in
// either direction (G2-17). That test is the reason this mirror can be
// trusted; without it, a `sqliteTable` is a comment that compiles.
//
// What a declaration cannot express stays in SQL and is checked by behaviour
// instead: `STRICT`, every CHECK constraint, the append-only triggers, the
// partial and unique indexes, the views and the foreign keys. In particular
// the `*_no_update` / `*_no_delete` triggers are what make most of these
// tables append-only, and they apply to an ORM statement exactly as they do
// to a native one — `../../../test/drizzle-immutability.test.ts` (G2-16).
//
// Columns whose JS type must not be JavaScript's default — money, date-only,
// flags, row ids — are declared with the codec-backed types of `../columns.ts`
// rather than with `text()` / `integer()`.
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  dateOnly,
  decimalCoefficient,
  decimalScale,
  flag,
  rowId,
  valueStatus,
} from "../columns.ts";

// ── registry (migration 0001) ───────────────────────────────────────────

/** Declared sources. `active` is a row, not a deployment: revocation is data. */
export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  displayName: text("display_name").notNull(),
  active: flag("active").notNull().default(true),
});

/** Ingest clients. Authentication is the adapter's; "still active" is CORE's. */
export const ingestClients = sqliteTable("ingest_clients", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  active: flag("active").notNull().default(true),
});

// ── runs and reports (migration 0001) ───────────────────────────────────

export const acquisitionSessions = sqliteTable("acquisition_sessions", {
  id: integer("id").primaryKey(),
  producerId: text("producer_id").notNull(),
  firstRecordedByClientId: text("first_recorded_by_client_id").notNull(),
  externalIdNamespace: text("external_id_namespace").notNull(),
  externalSessionId: text("external_session_id").notNull(),
  firstRecordedAtMs: integer("first_recorded_at_ms").notNull(),
});

export const fetchRuns = sqliteTable("fetch_runs", {
  id: integer("id").primaryKey(),
  acquisitionSessionId: integer("acquisition_session_id").notNull(),
  producerId: text("producer_id").notNull(),
  sourceId: text("source_id").notNull(),
  firstRecordedByClientId: text("first_recorded_by_client_id").notNull(),
  sourceRunKey: text("source_run_key").notNull().default("default"),
  firstRecordedAtMs: integer("first_recorded_at_ms").notNull(),
});

export const fetchRunReports = sqliteTable("fetch_run_reports", {
  id: integer("id").primaryKey(),
  fetchRunId: integer("fetch_run_id").notNull(),
  reportKey: text("report_key").notNull(),
  reportKind: text("report_kind").notNull(),
  recordedByClientId: text("recorded_by_client_id").notNull(),
  producerVersion: text("producer_version"),
  producerRevision: text("producer_revision"),
  manifestSchemaVersion: text("manifest_schema_version"),
  producerStatus: text("producer_status"),
  normalizedOutcome: text("normalized_outcome").notNull().default("unknown"),
  startedAtMs: integer("started_at_ms"),
  startedAtBasis: text("started_at_basis"),
  completedAtMs: integer("completed_at_ms"),
  completedAtBasis: text("completed_at_basis"),
  declaredArtifactCount: integer("declared_artifact_count"),
  artifactCountScope: text("artifact_count_scope"),
  recordedAtMs: integer("recorded_at_ms").notNull(),
});

// ── objects and catalogue (migration 0001) ──────────────────────────────

export const rawObjects = sqliteTable("raw_objects", {
  sha256: text("sha256").primaryKey(),
  byteSize: integer("byte_size").notNull(),
  blobKey: text("blob_key").notNull(),
  firstStoredAtMs: integer("first_stored_at_ms").notNull(),
});

export const rawObjectVerificationEvents = sqliteTable("raw_object_verification_events", {
  id: integer("id").primaryKey(),
  sha256: text("sha256").notNull(),
  checkedAtMs: integer("checked_at_ms").notNull(),
  result: text("result").notNull(),
  observedSize: integer("observed_size"),
  observedSha256: text("observed_sha256"),
  detailCode: text("detail_code"),
  checkedByClientId: text("checked_by_client_id").notNull(),
  recordedAtMs: integer("recorded_at_ms").notNull(),
});

export const fetchArtifacts = sqliteTable("fetch_artifacts", {
  id: integer("id").primaryKey(),
  fetchRunId: integer("fetch_run_id").notNull(),
  sourceId: text("source_id").notNull(),
  producerId: text("producer_id").notNull(),
  firstIngestedByClientId: text("first_ingested_by_client_id").notNull(),
  // Nullable parents: a NULL here means "no unit / no page group", and reading
  // it as 0 would name a row that does not exist (`rowId`).
  fetchUnitId: rowId("fetch_unit_id"),
  pageGroupId: rowId("page_group_id"),
  artifactKey: text("artifact_key").notNull(),
  artifactRole: text("artifact_role").notNull(),
  payloadFidelity: text("payload_fidelity").notNull(),
  containerKind: text("container_kind").notNull().default("single"),
  lineageDisposition: text("lineage_disposition").notNull(),
  dataset: text("dataset"),
  formatId: text("format_id"),
  formatVersion: text("format_version"),
  declaredMediaType: text("declared_media_type"),
  mediaTypeBasis: text("media_type_basis"),
  fetchedAtMs: integer("fetched_at_ms"),
  fetchedAtBasis: text("fetched_at_basis"),
  pageIndex: integer("page_index"),
  sequence: integer("sequence"),
  sha256: text("sha256").notNull(),
  byteSize: integer("byte_size").notNull(),
  descriptorVersion: text("descriptor_version").notNull(),
  descriptorSha256: text("descriptor_sha256").notNull(),
  recordedAtMs: integer("recorded_at_ms").notNull(),
});

// ── parses and their adoption (migrations 0017, 0026, 0028) ─────────────

export const parseRuns = sqliteTable("parse_runs", {
  id: integer("id").primaryKey(),
  fetchArtifactId: integer("fetch_artifact_id").notNull(),
  parserName: text("parser_name").notNull(),
  parserVersion: text("parser_version").notNull(),
  parsedAt: text("parsed_at").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  warningsJson: text("warnings_json"),
  supersededByParseRunId: rowId("superseded_by_parse_run_id"),
});

/** The adoption pointer: which parse of an (artifact, parser) readers see. */
export const publishedParseRuns = sqliteTable(
  "published_parse_runs",
  {
    fetchArtifactId: integer("fetch_artifact_id").notNull(),
    parserName: text("parser_name").notNull(),
    parseRunId: integer("parse_run_id").notNull(),
    parserVersion: text("parser_version").notNull(),
    publishedAt: text("published_at").notNull(),
    publicationKind: text("publication_kind").notNull(),
    releaseId: text("release_id"),
  },
  (table) => [primaryKey({ columns: [table.fetchArtifactId, table.parserName] })],
);

export const parserReleases = sqliteTable("parser_releases", {
  releaseId: text("release_id").primaryKey(),
  parserName: text("parser_name").notNull(),
  semanticVersion: text("semantic_version").notNull(),
  codeDigest: text("code_digest").notNull(),
  inputContractVersion: text("input_contract_version").notNull(),
  outputContractVersion: text("output_contract_version").notNull(),
  metadataExtractorRelease: text("metadata_extractor_release").notNull(),
  dependencyDigestsJson: text("dependency_digests_json").notNull(),
  registeredAt: text("registered_at").notNull(),
});

// ── derived decimals (migration 0024) ───────────────────────────────────

/**
 * The decimal-v1 triple, once, for every observation kind. `coefficient` is
 * text and `scale` an integer exponent; neither ever becomes a JS number for
 * the *value*, and a non-exact row holds NULL in both rather than a zero
 * (INV05). `../../codecs/decimal.ts` turns the triple into a `ValueState`.
 */
export const observationDecimalValues = sqliteTable(
  "observation_decimal_values",
  {
    kind: text("kind").notNull(),
    observationId: integer("observation_id").notNull(),
    parseRunId: integer("parse_run_id").notNull(),
    policyVersion: text("policy_version").notNull(),
    status: valueStatus("status").notNull(),
    coefficient: decimalCoefficient("coefficient"),
    scale: decimalScale("scale"),
    basis: text("basis").notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.observationId, table.policyVersion] })],
);

// ── replay plans (migrations 0035, 0040) ────────────────────────────────

/**
 * `fetched_from` / `fetched_to` are calendar bounds, not instants: they are
 * the date-only window an operator asked for, and they come back as
 * `CivilDate` rather than `Date` (G4-12).
 */
export const observationReplayPlans = sqliteTable("observation_replay_plans", {
  id: integer("id").primaryKey(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  sourceId: text("source_id").notNull(),
  dataset: text("dataset"),
  parserName: text("parser_name").notNull(),
  parserVersion: text("parser_version").notNull(),
  targetRelease: text("target_release"),
  artifactIdFrom: integer("artifact_id_from").notNull().default(0),
  artifactIdHighWater: integer("artifact_id_high_water").notNull(),
  fetchedFrom: dateOnly("fetched_from"),
  fetchedTo: dateOnly("fetched_to"),
  status: text("status").notNull(),
  estimatedArtifacts: integer("estimated_artifacts").notNull().default(0),
  alreadyParsed: integer("already_parsed").notNull().default(0),
  jobsCreated: integer("jobs_created").notNull().default(0),
  creationCursor: integer("creation_cursor").notNull().default(0),
  creationComplete: flag("creation_complete").notNull().default(false),
  reason: text("reason").notNull(),
  operationId: text("operation_id"),
});

// ── operations API records (migration 0040) ─────────────────────────────

export const opsRequests = sqliteTable("ops_requests", {
  operationId: text("operation_id").primaryKey(),
  kind: text("kind").notNull(),
  principal: text("principal").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadDigest: text("payload_digest").notNull(),
  sourceId: text("source_id"),
  requestJson: text("request_json").notNull(),
  status: text("status").notNull(),
  dispatchState: text("dispatch_state").notNull(),
  dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
  availableAtMs: integer("available_at_ms").notNull().default(0),
  targetRef: text("target_ref"),
  failureCode: text("failure_code"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const opsRequestStages = sqliteTable(
  "ops_request_stages",
  {
    operationId: text("operation_id").notNull(),
    stage: text("stage").notNull(),
    state: text("state").notNull(),
    evidenceRef: text("evidence_ref"),
    failureCode: text("failure_code"),
    attempts: integer("attempts").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.operationId, table.stage] })],
);
