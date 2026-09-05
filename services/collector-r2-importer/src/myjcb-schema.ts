import { ImportError } from "./error";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

const SOURCE = "myjcb" as const;
const SCHEMA_VERSION = "myjcb-worker-poc-v1" as const;
const MAX_ARTIFACTS_PER_CONNECTION = 109;
const MAX_MANIFEST_ARTIFACTS = 512;
const MAX_MANIFEST_FAILURES = MAX_ARTIFACTS_PER_CONNECTION * 16;
const MAX_CONNECTIONS = 16;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}(?:Error)?$/u;
const MANIFEST_KEY =
  /^raw\/myjcb\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const CREDIT_PERIOD =
  /^(?:detailMonth-(?:[0-9]|1[0-7])|[0-9０-９年月日度お支払い分／/().（）.\-\s]{1,32})$/u;
const UNOBSERVED_DATASETS = new Set([
  "debit-menu",
  "debit-detail",
  "credit-csv",
  "credit-pdf",
  "credit-ofx",
]);

type JsonObject = Record<string, unknown>;
type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

export type MyJcbStatementState = "confirmed" | "unconfirmed" | "debit" | "unknown";
export type MyJcbConnectionStatus = "success" | "partial" | "failed" | "human-required";

export interface MyJcbArtifactManifest {
  dataset: string;
  key: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  statementState?: MyJcbStatementState;
  period?: string;
  connectionId: string;
  filename: string;
  ordinal?: number;
}

export interface MyJcbConnection {
  connectionId: string;
  bootstrapMode: "password" | "session" | "passkey";
  status: MyJcbConnectionStatus;
  cardCount: number;
  periodCount: number;
  artifactCount: number;
  blocker?: string;
}

export interface MyJcbFailure {
  connectionId: string;
  operation: string;
  errorType: string;
  message: string;
}

export interface MyJcbManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  source: typeof SOURCE;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  trigger: "scheduled" | "manual";
  connections: MyJcbConnection[];
  artifacts: MyJcbArtifactManifest[];
  failures: MyJcbFailure[];
}

export interface VerifiedMyJcbArtifact {
  artifact: MyJcbArtifactManifest;
  centralBytes: Uint8Array;
  centralSha256: string;
}

export function myJcbManifestKeyMatch(key: string): RegExpExecArray | null {
  return MANIFEST_KEY.exec(key);
}

export function parseMyJcbManifest(bytes: Uint8Array, manifestKey: string): MyJcbManifest {
  const key = MANIFEST_KEY.exec(manifestKey);
  if (!key) invalid("manifest_key_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("manifest_json_invalid");
  }
  const input = record(parsed, "manifest_shape_invalid");
  exactKeys(input, [
    "schemaVersion",
    "source",
    "runId",
    "startedAt",
    "completedAt",
    "status",
    "trigger",
    "connections",
    "artifacts",
    "failures",
  ]);
  if (input.schemaVersion !== SCHEMA_VERSION) invalid("manifest_schema_invalid");
  if (input.source !== SOURCE) invalid("manifest_source_invalid");
  if (input.runId !== key[4]) invalid("manifest_run_id_mismatch");
  const startedAt = instant(input.startedAt, "manifest_started_at_invalid");
  const completedAt = instant(input.completedAt, "manifest_completed_at_invalid");
  if (completedAt < startedAt) invalid("manifest_time_reversed");
  if (startedAt.slice(0, 10) !== `${key[1]}-${key[2]}-${key[3]}`) {
    invalid("manifest_date_mismatch");
  }
  const status = oneOf(
    input.status,
    ["success", "partial", "failed"] as const,
    "manifest_status_invalid",
  );
  const trigger = oneOf(
    input.trigger,
    ["scheduled", "manual"] as const,
    "manifest_trigger_invalid",
  );
  if (
    !Array.isArray(input.connections) ||
    input.connections.length < 1 ||
    input.connections.length > MAX_CONNECTIONS
  )
    invalid("manifest_connections_invalid");
  if (!Array.isArray(input.artifacts) || input.artifacts.length > MAX_MANIFEST_ARTIFACTS) {
    invalid("manifest_artifacts_invalid");
  }
  if (!Array.isArray(input.failures) || input.failures.length > MAX_MANIFEST_FAILURES) {
    invalid("manifest_failures_invalid");
  }
  const connections = input.connections.map(parseConnection);
  if (
    new Set(connections.map((connection) => connection.connectionId)).size !== connections.length
  ) {
    invalid("manifest_duplicate_connection");
  }
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const knownConnections = new Set(connections.map((connection) => connection.connectionId));
  const artifacts = input.artifacts.map((value) => parseArtifact(value, prefix, knownConnections));
  if (new Set(artifacts.map((artifact) => artifact.key)).size !== artifacts.length) {
    invalid("manifest_duplicate_artifact_key");
  }
  const failures = input.failures.map((value) => parseFailure(value, knownConnections));
  validateManifestRelationships(status, connections, artifacts, failures);
  return {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    runId: input.runId as string,
    startedAt,
    completedAt,
    status,
    trigger,
    connections,
    artifacts,
    failures,
  };
}

export function normalizeMyJcbManifestForCentral(manifest: MyJcbManifest): Uint8Array {
  const connections = manifest.connections.map((connection) => ({
    ...connection,
    ...(connection.blocker === undefined
      ? {}
      : {
          blocker: connection.status === "human-required" ? "human-required" : "collector-failure",
        }),
  }));
  const statusByConnection = new Map(
    manifest.connections.map((connection) => [connection.connectionId, connection.status]),
  );
  const failures = manifest.failures.map((failure) => ({
    ...failure,
    message: failure.operation.startsWith("r2:")
      ? "r2-write-failure"
      : statusByConnection.get(failure.connectionId) === "human-required"
        ? "human-required"
        : "collector-failure",
  }));
  return new TextEncoder().encode(JSON.stringify({ ...manifest, connections, failures }));
}

export function normalizeMyJcbArtifactPayload(
  artifact: MyJcbArtifactManifest,
  bytes: Uint8Array,
  connection: MyJcbConnection,
): Uint8Array {
  switch (artifact.dataset) {
    case "credit-menu":
      return normalizeHtml(bytes, artifact.dataset);
    case "credit-detail":
      return normalizeHtml(bytes, artifact.dataset);
    case "credit-past-months":
      validatePastMonths(bytes);
      return bytes;
    case "credit-ledger":
      validateLedger(bytes, artifact);
      return bytes;
    case "discovery":
      validateDiscovery(bytes, connection);
      return bytes;
    case "debit-menu":
    case "debit-detail":
    case "credit-csv":
    case "credit-pdf":
    case "credit-ofx":
      invalid("artifact_dataset_unobserved");
    default:
      invalid("artifact_dataset_invalid");
  }
}

function parseConnection(value: unknown): MyJcbConnection {
  const input = record(value, "manifest_connection_invalid");
  exactKeys(input, [
    "connectionId",
    "bootstrapMode",
    "status",
    "cardCount",
    "periodCount",
    "artifactCount",
    "blocker",
  ]);
  if (typeof input.connectionId !== "string" || !SEGMENT.test(input.connectionId)) {
    invalid("manifest_connection_id_invalid");
  }
  const bootstrapMode = oneOf(
    input.bootstrapMode,
    ["password", "session", "passkey"] as const,
    "manifest_bootstrap_mode_invalid",
  );
  const status = oneOf(
    input.status,
    ["success", "partial", "failed", "human-required"] as const,
    "manifest_connection_status_invalid",
  );
  const cardCount = integer(input.cardCount, 0, 16, "manifest_card_count_invalid");
  const periodCount = integer(input.periodCount, 0, 33, "manifest_period_count_invalid");
  const artifactCount = integer(
    input.artifactCount,
    0,
    MAX_ARTIFACTS_PER_CONNECTION,
    "manifest_artifact_count_invalid",
  );
  const blocker =
    input.blocker === undefined
      ? undefined
      : boundedString(input.blocker, 1, 100, "manifest_connection_blocker_invalid");
  if ((status === "failed" || status === "human-required") !== (blocker !== undefined)) {
    invalid("manifest_connection_blocker_mismatch");
  }
  if (
    (status === "failed" || status === "human-required") &&
    (cardCount !== 0 || periodCount !== 0 || artifactCount !== 0)
  ) {
    invalid("manifest_failed_connection_counts_invalid");
  }
  if (status === "success" && (cardCount < 1 || periodCount < 1 || artifactCount < 1)) {
    invalid("manifest_success_connection_counts_invalid");
  }
  if (status === "partial" && (cardCount < 1 || periodCount < 1)) {
    invalid("manifest_partial_connection_counts_invalid");
  }
  return {
    connectionId: input.connectionId,
    bootstrapMode,
    status,
    cardCount,
    periodCount,
    artifactCount,
    ...(blocker ? { blocker } : {}),
  };
}

function parseArtifact(
  value: unknown,
  prefix: string,
  knownConnections: Set<string>,
): MyJcbArtifactManifest {
  const input = record(value, "manifest_artifact_invalid");
  exactKeys(input, ["dataset", "key", "mediaType", "sha256", "bytes", "statementState", "period"]);
  const dataset = boundedString(input.dataset, 1, 64, "manifest_dataset_invalid");
  if (UNOBSERVED_DATASETS.has(dataset)) invalid("manifest_dataset_unobserved");
  const key = boundedString(input.key, 1, 500, "manifest_artifact_key_invalid");
  const match = key.startsWith(prefix)
    ? /^([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9.-]+)$/u.exec(key.slice(prefix.length))
    : null;
  if (!match || !knownConnections.has(match[1]!)) invalid("manifest_artifact_key_invalid");
  const connectionId = match[1]!;
  const filename = match[2]!;
  const shape = artifactShape(dataset, filename);
  const mediaType = boundedString(input.mediaType, 1, 100, "manifest_media_type_invalid");
  if (mediaType !== shape.mediaType) invalid("manifest_media_type_mismatch");
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    invalid("manifest_artifact_sha_invalid");
  }
  const bytes = integer(input.bytes, 1, MAX_ARTIFACT_BYTES, "manifest_artifact_size_invalid");
  const statementState =
    input.statementState === undefined
      ? undefined
      : oneOf(
          input.statementState,
          ["confirmed", "unconfirmed", "debit", "unknown"] as const,
          "manifest_statement_state_invalid",
        );
  const period =
    input.period === undefined
      ? undefined
      : boundedString(input.period, 1, 64, "manifest_period_invalid");
  if (
    shape.stateful !== (statementState !== undefined) ||
    shape.periodic !== (period !== undefined)
  ) {
    invalid("manifest_artifact_optional_fields_mismatch");
  }
  if (shape.kind === "credit") {
    if (statementState === "debit" || !period || !CREDIT_PERIOD.test(period)) {
      invalid("manifest_credit_period_invalid");
    }
    if (
      shape.dataset === "credit-detail" &&
      shape.ordinal === 0 &&
      statementState !== "unconfirmed"
    ) {
      invalid("manifest_unconfirmed_state_mismatch");
    }
    if (shape.export && statementState !== "confirmed") invalid("manifest_export_state_invalid");
  }
  if (shape.kind === "debit" && statementState !== "debit") {
    invalid("manifest_debit_state_invalid");
  }
  return {
    dataset,
    key,
    mediaType,
    sha256: input.sha256,
    bytes,
    ...(statementState ? { statementState } : {}),
    ...(period ? { period } : {}),
    connectionId,
    filename,
    ...(shape.ordinal === undefined ? {} : { ordinal: shape.ordinal }),
  };
}

function artifactShape(
  dataset: string,
  filename: string,
): {
  dataset: string;
  mediaType: string;
  stateful: boolean;
  periodic: boolean;
  kind?: "credit" | "debit";
  ordinal?: number;
  export?: boolean;
} {
  if (dataset === "credit-menu" && filename === "credit-menu.html") {
    return { dataset, mediaType: "text/html; charset=utf-8", stateful: false, periodic: false };
  }
  if (dataset === "credit-past-months" && filename === "credit-past-months.json") {
    return { dataset, mediaType: "application/json", stateful: false, periodic: false };
  }
  if (dataset === "discovery" && filename === "discovery.json") {
    return { dataset, mediaType: "application/json", stateful: false, periodic: false };
  }
  if (dataset === "debit-menu" && filename === "debit-menu.html") {
    return {
      dataset,
      mediaType: "text/html; charset=utf-8",
      stateful: true,
      periodic: false,
      kind: "debit",
    };
  }
  let match = /^credit-detail-(\d{2})\.html$/u.exec(filename);
  if (dataset === "credit-detail" && match && Number(match[1]) <= 17) {
    return {
      dataset,
      mediaType: "text/html; charset=utf-8",
      stateful: true,
      periodic: true,
      kind: "credit",
      ordinal: Number(match[1]),
    };
  }
  match = /^credit-ledger-(\d{2})\.json$/u.exec(filename);
  if (dataset === "credit-ledger" && match && Number(match[1]) <= 17) {
    return {
      dataset,
      mediaType: "application/json",
      stateful: true,
      periodic: true,
      kind: "credit",
      ordinal: Number(match[1]),
    };
  }
  match = /^credit-(\d{2})\.(csv|pdf|ofx)$/u.exec(filename);
  if (match && Number(match[1]) <= 17 && dataset === `credit-${match[2]}`) {
    const mediaType =
      match[2] === "csv"
        ? "text/csv; charset=windows-31j"
        : match[2] === "pdf"
          ? "application/pdf"
          : "application/x-ofx";
    return {
      dataset,
      mediaType,
      stateful: true,
      periodic: true,
      kind: "credit",
      ordinal: Number(match[1]),
      export: true,
    };
  }
  match = /^debit-detail-(\d{2})\.html$/u.exec(filename);
  if (dataset === "debit-detail" && match && Number(match[1]) <= 14) {
    return {
      dataset,
      mediaType: "text/html; charset=utf-8",
      stateful: true,
      periodic: true,
      kind: "debit",
      ordinal: Number(match[1]),
    };
  }
  invalid("manifest_dataset_filename_mismatch");
}

function parseFailure(value: unknown, knownConnections: Set<string>): MyJcbFailure {
  const input = record(value, "manifest_failure_invalid");
  exactKeys(input, ["connectionId", "operation", "errorType", "message"]);
  const connectionId = boundedString(
    input.connectionId,
    1,
    64,
    "manifest_failure_connection_invalid",
  );
  if (!knownConnections.has(connectionId)) invalid("manifest_failure_connection_invalid");
  const operation = boundedString(input.operation, 1, 80, "manifest_failure_operation_invalid");
  if (operation !== "collect" && !/^r2:[a-z0-9-]{1,64}$/u.test(operation)) {
    invalid("manifest_failure_operation_invalid");
  }
  const errorType = boundedString(input.errorType, 1, 64, "manifest_failure_type_invalid");
  if (!ERROR_NAME.test(errorType)) invalid("manifest_failure_type_invalid");
  const message = boundedString(input.message, 1, 100, "manifest_failure_message_invalid");
  return { connectionId, operation, errorType, message };
}

function validateManifestRelationships(
  status: MyJcbManifest["status"],
  connections: MyJcbConnection[],
  artifacts: MyJcbArtifactManifest[],
  failures: MyJcbFailure[],
): void {
  let previousConnection = -1;
  for (const artifact of artifacts) {
    const connectionIndex = connections.findIndex(
      (connection) => connection.connectionId === artifact.connectionId,
    );
    if (connectionIndex < previousConnection) invalid("manifest_connection_artifact_order_invalid");
    previousConnection = connectionIndex;
  }
  for (const connection of connections) {
    const connectionArtifacts = artifacts.filter(
      (artifact) => artifact.connectionId === connection.connectionId,
    );
    const connectionFailures = failures.filter(
      (failure) => failure.connectionId === connection.connectionId,
    );
    if (connectionArtifacts.length !== connection.artifactCount) {
      invalid("manifest_connection_artifact_count_mismatch");
    }
    const collectFailures = connectionFailures.filter((failure) => failure.operation === "collect");
    const r2Failures = connectionFailures.filter((failure) => failure.operation.startsWith("r2:"));
    if (connection.status === "success") {
      if (connectionFailures.length !== 0) invalid("manifest_success_connection_failure_mismatch");
    } else if (connection.status === "partial") {
      if (collectFailures.length !== 0 || r2Failures.length === 0) {
        invalid("manifest_partial_connection_failure_mismatch");
      }
    } else {
      if (
        collectFailures.length !== 1 ||
        r2Failures.length !== 0 ||
        connectionArtifacts.length !== 0
      ) {
        invalid("manifest_failed_connection_failure_mismatch");
      }
      const failure = collectFailures[0]!;
      if (connection.blocker !== failure.message)
        invalid("manifest_connection_blocker_message_mismatch");
      if (
        (connection.status === "human-required") !==
        (failure.errorType === "HumanRequiredError")
      ) {
        invalid("manifest_human_required_failure_mismatch");
      }
    }
    for (const failure of r2Failures) {
      const dataset = failure.operation.slice(3);
      if (UNOBSERVED_DATASETS.has(dataset)) invalid("manifest_dataset_unobserved");
      if (!isKnownDataset(dataset)) invalid("manifest_r2_failure_dataset_invalid");
    }
    validateConnectionArtifacts(connection, connectionArtifacts, r2Failures);
  }
  const expectedStatus =
    failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial";
  if (status !== expectedStatus) invalid("manifest_status_mismatch");
  if (status === "success" && connections.some((connection) => connection.status !== "success")) {
    invalid("manifest_success_connection_status_mismatch");
  }
}

function validateConnectionArtifacts(
  connection: MyJcbConnection,
  artifacts: MyJcbArtifactManifest[],
  r2Failures: MyJcbFailure[],
): void {
  const byFilename = new Map(artifacts.map((artifact) => [artifact.filename, artifact]));
  const discovery = artifacts.filter((artifact) => artifact.dataset === "discovery");
  const creditMenus = artifacts.filter((artifact) => artifact.dataset === "credit-menu");
  const pastMonths = artifacts.filter((artifact) => artifact.dataset === "credit-past-months");
  const debitMenus = artifacts.filter((artifact) => artifact.dataset === "debit-menu");
  if (
    discovery.length > 1 ||
    creditMenus.length > 1 ||
    pastMonths.length > 1 ||
    debitMenus.length > 1
  ) {
    invalid("manifest_singleton_dataset_duplicate");
  }
  const details = artifacts.filter((artifact) => artifact.dataset === "credit-detail");
  const debitDetails = artifacts.filter((artifact) => artifact.dataset === "debit-detail");
  if (connection.status === "success" || connection.status === "partial") {
    if (artifacts.length + r2Failures.length > MAX_ARTIFACTS_PER_CONNECTION) {
      invalid("manifest_connection_attempt_count_invalid");
    }
    const attempted = (dataset: string) =>
      artifacts.filter((artifact) => artifact.dataset === dataset).length +
      r2Failures.filter((failure) => failure.operation === `r2:${dataset}`).length;
    const attemptedCreditDetails = attempted("credit-detail");
    const attemptedDebitDetails = attempted("debit-detail");
    if (
      attempted("discovery") !== 1 ||
      attemptedCreditDetails + attemptedDebitDetails !== connection.periodCount ||
      attempted("credit-menu") !== (attemptedCreditDetails > 0 ? 1 : 0) ||
      attempted("credit-past-months") !== (attemptedCreditDetails > 0 ? 1 : 0) ||
      attempted("debit-menu") !== (attemptedDebitDetails > 0 ? 1 : 0) ||
      attempted("credit-ledger") > attemptedCreditDetails ||
      attempted("credit-csv") > attemptedCreditDetails ||
      attempted("credit-pdf") > attemptedCreditDetails ||
      attempted("credit-ofx") > attemptedCreditDetails
    ) {
      invalid("manifest_artifact_failure_complement_invalid");
    }
    const failureStages = r2Failures.map((failure) => datasetStage(failure.operation.slice(3)));
    if (failureStages.some((stage, index) => index > 0 && stage < failureStages[index - 1]!)) {
      invalid("manifest_r2_failure_order_invalid");
    }
  }
  for (const artifact of artifacts) {
    if (
      artifact.dataset === "credit-ledger" ||
      artifact.dataset === "credit-csv" ||
      artifact.dataset === "credit-pdf" ||
      artifact.dataset === "credit-ofx"
    ) {
      const detailName = `credit-detail-${String(artifact.ordinal).padStart(2, "0")}.html`;
      if (!byFilename.has(detailName) && connection.status === "success") {
        invalid("manifest_credit_derivative_without_detail");
      }
      const detail = byFilename.get(detailName);
      if (
        detail &&
        (detail.period !== artifact.period ||
          (artifact.dataset === "credit-ledger" &&
            detail.statementState !== artifact.statementState))
      ) {
        invalid("manifest_credit_derivative_metadata_mismatch");
      }
    }
  }
  let lastCreditOrder = -1_000;
  let lastDebitOrder = -1_000;
  let reachedDebit = false;
  let reachedDiscovery = false;
  for (const artifact of artifacts) {
    if (reachedDiscovery) invalid("manifest_artifact_after_discovery");
    if (artifact.dataset === "discovery") {
      reachedDiscovery = true;
      continue;
    }
    if (artifact.dataset.startsWith("debit-")) reachedDebit = true;
    if (artifact.dataset.startsWith("credit-") && reachedDebit) {
      invalid("manifest_credit_after_debit");
    }
    if (artifact.dataset.startsWith("credit-")) {
      const order = creditArtifactOrder(artifact);
      if (order <= lastCreditOrder) invalid("manifest_credit_artifact_order_invalid");
      lastCreditOrder = order;
    }
    if (artifact.dataset.startsWith("debit-")) {
      const order = artifact.dataset === "debit-menu" ? -1 : artifact.ordinal!;
      if (order <= lastDebitOrder) invalid("manifest_debit_artifact_order_invalid");
      lastDebitOrder = order;
    }
  }
  if (connection.status === "success") {
    if (discovery.length !== 1) invalid("manifest_discovery_missing");
    const hasCredit = details.length > 0;
    const hasDebit = debitDetails.length > 0;
    if (!hasCredit && !hasDebit) invalid("manifest_statement_detail_missing");
    if (hasCredit && (creditMenus.length !== 1 || pastMonths.length !== 1)) {
      invalid("manifest_credit_catalogue_missing");
    }
    if (hasDebit && debitMenus.length !== 1) invalid("manifest_debit_menu_missing");
    if (connection.periodCount !== details.length + debitDetails.length) {
      invalid("manifest_period_count_mismatch");
    }
  }
}

function creditArtifactOrder(artifact: MyJcbArtifactManifest): number {
  if (artifact.dataset === "credit-menu") return -2;
  if (artifact.dataset === "credit-past-months") return -1;
  if (artifact.ordinal === undefined) invalid("manifest_credit_artifact_order_invalid");
  const rank =
    artifact.dataset === "credit-detail"
      ? 0
      : artifact.dataset === "credit-ledger"
        ? 1
        : artifact.dataset === "credit-csv"
          ? 2
          : artifact.dataset === "credit-pdf"
            ? 3
            : artifact.dataset === "credit-ofx"
              ? 4
              : 9;
  return artifact.ordinal * 10 + rank;
}

function datasetStage(dataset: string): number {
  if (dataset === "credit-menu") return 0;
  if (dataset === "credit-past-months") return 1;
  if (dataset.startsWith("credit-")) return 2;
  if (dataset === "debit-menu") return 3;
  if (dataset === "debit-detail") return 4;
  if (dataset === "discovery") return 5;
  invalid("manifest_r2_failure_dataset_invalid");
}

function normalizeHtml(bytes: Uint8Array, dataset: string): Uint8Array {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("artifact_html_utf8_invalid");
  }
  if (!sameBytes(bytes, new TextEncoder().encode(html))) {
    invalid("artifact_html_utf8_round_trip_invalid");
  }
  const xmlDeclaration = /^\s*<\?xml\b([^?]{0,200})\?>/iu.exec(html);
  if (
    (/^\s*<\?xml\b/iu.test(html) &&
      (!xmlDeclaration ||
        !/\bversion=["']1\.0["']/iu.test(xmlDeclaration[1]!) ||
        !/\bencoding=["'](?:UTF-8|Shift_JIS|Windows-31J|CP932)["']/iu.test(xmlDeclaration[1]!))) ||
    !/^\s*(?:<!doctype\s+html(?:\s+[^>]*)?>\s*)?<html\b/iu.test(
      xmlDeclaration ? html.slice(xmlDeclaration[0].length) : html,
    ) ||
    !/<html\b/iu.test(html) ||
    !/<body\b/iu.test(html) ||
    !/<\/html\s*>\s*$/iu.test(html)
  ) {
    invalid("artifact_html_document_invalid");
  }
  if (!/MyJCB/iu.test(html) || !/details_inquiry/iu.test(html)) {
    invalid("artifact_html_surface_invalid");
  }
  if (
    /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/u.test(html) ||
    /<input\b[^>]*\btype=["']password["']/iu.test(html)
  ) {
    invalid("artifact_html_sensitive_value_invalid");
  }
  for (const tag of html.match(/<input\b[^>]*>/giu) ?? []) {
    if (/\bvalue\s*=/iu.test(tag) && !/\bvalue=["']\[redacted\]["']/iu.test(tag)) {
      invalid("artifact_html_input_redaction_invalid");
    }
  }
  for (const match of html.matchAll(
    /<textarea\b[^>]*(?:name|id)=["'][^"']*(?:token|csrf|password|userid|user_id|session|otp|secret)[^"']*["'][^>]*>([\s\S]*?)<\/textarea>/giu,
  )) {
    if (match[1]?.trim() !== "[redacted]") invalid("artifact_html_textarea_redaction_invalid");
  }
  if (
    dataset === "credit-menu" &&
    (!/\bdetailMonth\b/u.test(html) || !/\bgeneralJsonShikibetuId\b/u.test(html))
  ) {
    invalid("artifact_credit_menu_semantics_invalid");
  }
  if (dataset === "credit-detail" && !/\/iss-pc\/member\/details_inquiry\//u.test(html)) {
    invalid("artifact_credit_detail_semantics_invalid");
  }
  if (dataset === "debit-menu" && !/debitDetailMenu/iu.test(html)) {
    invalid("artifact_debit_menu_semantics_invalid");
  }
  if (dataset === "debit-detail" && !/(?:お振替日|差額発生日|デビット)/u.test(html)) {
    invalid("artifact_debit_detail_semantics_invalid");
  }
  const normalized = sanitizeHtmlForCentral(html);
  assertCentralHtmlSafe(normalized);
  return new TextEncoder().encode(normalized);
}

function sanitizeHtmlForCentral(html: string): string {
  const document = parse(html);
  sanitizeHtmlTree(document);
  return serialize(document);
}

const REMOVED_HTML_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "meta",
  "base",
  "link",
  "textarea",
]);

const REMOVED_HTML_ATTRIBUTES = new Set([
  "style",
  "srcdoc",
  "srcset",
  "integrity",
  "nonce",
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "ping",
  "manifest",
]);

function sanitizeHtmlTree(node: HtmlNode): void {
  if ("childNodes" in node) {
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index]!;
      if (
        child.nodeName === "#comment" ||
        (isHtmlElement(child) && REMOVED_HTML_ELEMENTS.has(child.tagName))
      ) {
        node.childNodes.splice(index, 1);
      } else {
        sanitizeHtmlTree(child);
      }
    }
  }
  if (isHtmlElement(node)) {
    node.attrs = node.attrs.flatMap((attribute) => {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name.startsWith("data-") ||
        name.endsWith(":href") ||
        REMOVED_HTML_ATTRIBUTES.has(name)
      ) {
        return [];
      }
      if (
        name === "value" ||
        /(?:token|csrf|session|auth|credential|secret|password|nonce|userid|user-id|user_id|cookie)/u.test(
          name,
        )
      ) {
        return [{ ...attribute, value: "[redacted]" }];
      }
      return [attribute];
    });
  } else if (node.nodeName === "#text") {
    node.value = node.value.replace(
      /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/gu,
      "[card-number-redacted]",
    );
  }
}

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function assertCentralHtmlSafe(html: string): void {
  const xmlDeclaration = /^\s*<\?xml\b([^?]{0,200})\?>/iu.exec(html);
  if (
    (xmlDeclaration && !/\bencoding=["']UTF-8["']/iu.test(xmlDeclaration[1]!)) ||
    /<(?:script|style|noscript|template|iframe|object|embed|meta|base|link)\b/iu.test(html) ||
    /\s(?:on[a-z0-9_-]+|style|srcdoc|srcset|integrity|nonce|data-[a-z0-9_-]+|href|src|action|formaction)\s*=/iu.test(
      html,
    ) ||
    /\svalue\s*=\s*(?!["']\[redacted\]["'])/iu.test(html) ||
    /\s[a-z0-9:_-]*(?:token|csrf|session|auth|credential|secret|password|nonce|userid|user-id|user_id|cookie)[a-z0-9:_-]*\s*=\s*(?!["']\[redacted\]["'])/iu.test(
      html,
    )
  ) {
    invalid("artifact_html_central_safety_invalid");
  }
}

function validatePastMonths(bytes: Uint8Array): void {
  const input = jsonObject(bytes, "artifact_past_months_json_invalid");
  exactKeys(input, ["jsonrpc", "id", "result"]);
  if (
    input.jsonrpc !== "2.0" ||
    typeof input.id !== "string" ||
    !/^0301006\d{2}$/u.test(input.id)
  ) {
    invalid("artifact_past_months_rpc_invalid");
  }
  const result = record(input.result, "artifact_past_months_result_invalid");
  exactKeys(result, ["errId", "errMessage", "detailPastJsonInfo"]);
  if (
    !(result.errId === null || result.errId === "" || result.errId === 0 || result.errId === "0") ||
    typeof result.errMessage !== "string" ||
    result.errMessage.length > 500 ||
    !Array.isArray(result.detailPastJsonInfo) ||
    result.detailPastJsonInfo.length > 18
  ) {
    invalid("artifact_past_months_result_invalid");
  }
  const months = new Set<number>();
  for (const itemValue of result.detailPastJsonInfo) {
    const item = record(itemValue, "artifact_past_months_item_invalid");
    exactKeys(item, [
      "detailAvailableFlag",
      "detailMonth",
      "payAmount",
      "payAmountDispFlag",
      "settlementYM",
    ]);
    if (
      typeof item.detailMonth !== "string" ||
      !/^(?:[0-9]|1[0-7])$/u.test(item.detailMonth) ||
      typeof item.detailAvailableFlag !== "boolean" ||
      typeof item.payAmountDispFlag !== "boolean" ||
      typeof item.payAmount !== "string" ||
      item.payAmount.length > 100 ||
      typeof item.settlementYM !== "string" ||
      !CREDIT_PERIOD.test(item.settlementYM)
    ) {
      invalid("artifact_past_months_item_invalid");
    }
    const month = Number(item.detailMonth);
    if (months.has(month)) invalid("artifact_past_months_duplicate_month");
    months.add(month);
  }
}

function validateLedger(bytes: Uint8Array, artifact: MyJcbArtifactManifest): void {
  const input = jsonObject(bytes, "artifact_ledger_json_invalid");
  exactKeys(input, ["schemaVersion", "detailMonth", "period", "state", "headers", "rows"]);
  if (
    input.schemaVersion !== 1 ||
    input.detailMonth !== artifact.ordinal ||
    input.period !== artifact.period ||
    input.state !== artifact.statementState ||
    !(input.state === "confirmed" || input.state === "unconfirmed")
  ) {
    invalid("artifact_ledger_header_invalid");
  }
  const expectedHeaders =
    input.state === "unconfirmed"
      ? ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"]
      : ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"];
  if (
    !Array.isArray(input.headers) ||
    !sameStrings(input.headers, expectedHeaders) ||
    !Array.isArray(input.rows) ||
    input.rows.length > 10_000
  ) {
    invalid("artifact_ledger_shape_invalid");
  }
  const allowedExpanded = new Set(
    input.state === "unconfirmed"
      ? ["今回のお支払い金額", "摘要", "今回回数", "備考", "訂正サイン"]
      : ["ご利用金額", "摘要", "今回回数", "備考", "訂正サイン"],
  );
  for (const rowValue of input.rows) {
    const row = record(rowValue, "artifact_ledger_row_invalid");
    exactKeys(row, ["summaryCells", "expanded"]);
    if (
      !Array.isArray(row.summaryCells) ||
      row.summaryCells.length !== 4 ||
      row.summaryCells.some((cell) => typeof cell !== "string" || cell.length > 5_000)
    ) {
      invalid("artifact_ledger_summary_cells_invalid");
    }
    const expanded = record(row.expanded, "artifact_ledger_expanded_invalid");
    if (
      Object.keys(expanded).some((key) => !allowedExpanded.has(key)) ||
      Object.values(expanded).some((value) => typeof value !== "string" || value.length > 5_000)
    ) {
      invalid("artifact_ledger_expanded_invalid");
    }
  }
}

function validateDiscovery(bytes: Uint8Array, connection: MyJcbConnection): void {
  const input = jsonObject(bytes, "artifact_discovery_json_invalid");
  exactKeys(input, [
    "schemaVersion",
    "bootstrapMode",
    "cards",
    "periodCount",
    "cookieCount",
    "limitations",
  ]);
  if (
    input.schemaVersion !== 1 ||
    input.bootstrapMode !== connection.bootstrapMode ||
    input.periodCount !== connection.periodCount ||
    !Number.isSafeInteger(input.cookieCount) ||
    (input.cookieCount as number) < 1 ||
    (input.cookieCount as number) > 100 ||
    !Array.isArray(input.cards) ||
    input.cards.length > 16
  ) {
    invalid("artifact_discovery_shape_invalid");
  }
  const localIds = new Set<string>();
  for (const cardValue of input.cards) {
    const card = record(cardValue, "artifact_discovery_card_invalid");
    exactKeys(card, ["localId", "productHint", "issuerHint", "switchCandidate"]);
    if (
      typeof card.localId !== "string" ||
      !/^card-(?:\d{3}|[0-9a-f]{8,32})$/u.test(card.localId) ||
      localIds.has(card.localId) ||
      typeof card.switchCandidate !== "boolean" ||
      card.issuerHint !== undefined ||
      (card.productHint !== undefined &&
        !["JCB W", "リクルートカード", "みずほJCBデビット", "京銀JCBデビット"].includes(
          card.productHint as string,
        ))
    ) {
      invalid("artifact_discovery_card_invalid");
    }
    localIds.add(card.localId);
  }
  if (connection.cardCount !== Math.max(input.cards.length, 1)) {
    invalid("artifact_discovery_card_count_mismatch");
  }
  const expectedSecond =
    connection.bootstrapMode === "passkey"
      ? "Passkey bootstrap uses an imported Bitwarden credential with a zero signature counter."
      : "Passkey renewal remains human-operated; session bootstrap is short-lived.";
  if (
    !Array.isArray(input.limitations) ||
    !sameStrings(input.limitations, [
      "Root-card switching remains discovery-only until its current POST contract is observed.",
      expectedSecond,
    ])
  )
    invalid("artifact_discovery_limitations_invalid");
}

function jsonObject(bytes: Uint8Array, code: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid(code);
  }
  return record(parsed, code);
}

function record(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(code);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid("unknown_field");
}

function boundedString(value: unknown, min: number, max: number, code: string): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid(code);
  }
  return value;
}

function integer(value: unknown, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    invalid(code);
  return value as number;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  code: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) invalid(code);
  return value as T[number];
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 40) invalid(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalid(code);
  return value;
}

function isKnownDataset(value: string): boolean {
  return [
    "credit-menu",
    "credit-past-months",
    "credit-detail",
    "credit-ledger",
    "credit-csv",
    "credit-pdf",
    "credit-ofx",
    "debit-menu",
    "debit-detail",
    "discovery",
  ].includes(value);
}

function sameStrings(left: unknown[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function invalid(code: string): never {
  throw new ImportError(409, code);
}
