import { ImportError } from "./error";
import { parse, type DefaultTreeAdapterMap } from "parse5";

const SOURCE = "moneyforward-me" as const;
const SCHEMA_VERSION = "moneyforward-worker-poc-v1" as const;
const MAX_ACCOUNTS = 64;
const MONTHS_PER_ACCOUNT = 12;
const MAX_ARTIFACTS = 1 + MAX_ACCOUNTS * (1 + MONTHS_PER_ACCOUNT);
const MAX_FAILURES = MAX_ARTIFACTS;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MANIFEST_KEY =
  /^raw\/moneyforward\/(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/manifest\.json$/u;
const STAGES = new Set([
  "credential-load",
  "login-entry",
  "passkey-options",
  "passkey-sign",
  "passkey-assert",
  "auth-redirect",
  "accounts-index",
  "account-selector",
  "account-detail",
  "monthly-detail",
  "artifact-store",
  "manifest-store",
]);
const ERROR_TYPES = new Set([
  "UnknownError",
  "MoneyForwardHttpError",
  "MoneyForwardProtocolError",
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "AbortError",
  "TimeoutError",
]);
const FAILURE_CODES = new Set([
  "operation_failed",
  "credential_configuration_required",
  "provider_http_failed",
  "provider_protocol_failed",
]);
const REASON_CODES = new Set([
  "unexpected-redirect",
  "redirect-limit",
  "missing-location",
  "invalid-response",
  "missing-csrf",
  "missing-account-context",
  "session-not-authenticated",
]);
const COLLECT_FAILURE_STAGES = new Map<string, ReadonlySet<string>>([
  ["credential_configuration_required", new Set(["credential-load"])],
  [
    "operation_failed",
    new Set([
      "login-entry",
      "passkey-options",
      "passkey-sign",
      "passkey-assert",
      "auth-redirect",
      "accounts-index",
      "account-selector",
      "account-detail",
      "monthly-detail",
    ]),
  ],
  [
    "provider_http_failed",
    new Set(["passkey-options", "passkey-assert", "account-detail", "monthly-detail"]),
  ],
  [
    "provider_protocol_failed",
    new Set([
      "login-entry",
      "passkey-options",
      "passkey-assert",
      "auth-redirect",
      "accounts-index",
      "account-selector",
      "account-detail",
    ]),
  ],
]);
const PROTOCOL_REASONS_BY_STAGE = new Map<string, ReadonlySet<string>>([
  [
    "login-entry",
    new Set(["unexpected-redirect", "redirect-limit", "missing-location", "missing-csrf"]),
  ],
  ["passkey-options", new Set(["invalid-response"])],
  ["passkey-assert", new Set(["invalid-response"])],
  ["auth-redirect", new Set(["unexpected-redirect", "redirect-limit", "missing-location"])],
  [
    "accounts-index",
    new Set([
      "unexpected-redirect",
      "redirect-limit",
      "missing-location",
      "session-not-authenticated",
    ]),
  ],
  [
    "account-selector",
    new Set(["unexpected-redirect", "redirect-limit", "missing-location", "invalid-response"]),
  ],
  ["account-detail", new Set(["missing-csrf", "missing-account-context"])],
]);
const PROTOCOL_HTTP_STATUS_STAGES = new Set(["login-entry", "auth-redirect", "account-selector"]);

type JsonObject = Record<string, unknown>;
type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

export type MoneyForwardStatus = "success" | "partial" | "failed";
export type MoneyForwardArtifactKind = "accounts-index" | "account-detail" | "monthly";

export interface MoneyForwardArtifactManifest {
  dataset: "accounts-index" | "account-detail" | "monthly-transactions";
  key: string;
  mediaType: "text/html; charset=utf-8";
  sha256: string;
  bytes: number;
  filename: string;
  kind: MoneyForwardArtifactKind;
  accountOrdinal?: number;
  month?: string;
}

export interface MoneyForwardFailure {
  operation: string;
  errorType: string;
  message: string;
  stage: string;
  failureCode: string;
  httpStatus?: number;
  reasonCode?: string;
}

export interface MoneyForwardManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  source: typeof SOURCE;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: MoneyForwardStatus;
  accountDetailCount: number;
  monthlyFragmentCount: number;
  artifacts: MoneyForwardArtifactManifest[];
  failures: MoneyForwardFailure[];
}

export interface VerifiedMoneyForwardArtifact {
  artifact: MoneyForwardArtifactManifest;
  bytes: Uint8Array;
}

export function moneyForwardManifestKeyMatch(key: string): RegExpExecArray | null {
  return MANIFEST_KEY.exec(key);
}

export function parseMoneyForwardManifest(
  bytes: Uint8Array,
  manifestKey: string,
): MoneyForwardManifest {
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
    "accountDetailCount",
    "monthlyFragmentCount",
    "artifacts",
    "failures",
  ]);
  if (input.schemaVersion !== SCHEMA_VERSION) invalid("manifest_schema_invalid");
  if (input.source !== SOURCE) invalid("manifest_source_invalid");
  if (input.runId !== key[4] || typeof input.runId !== "string" || !UUID.test(input.runId)) {
    invalid("manifest_run_id_mismatch");
  }
  const startedAt = instant(input.startedAt, "manifest_started_at_invalid");
  const completedAt = instant(input.completedAt, "manifest_completed_at_invalid");
  if (Date.parse(completedAt) < Date.parse(startedAt)) invalid("manifest_time_reversed");
  if (startedAt.slice(0, 10) !== `${key[1]}-${key[2]}-${key[3]}`) {
    invalid("manifest_date_mismatch");
  }
  const status = oneOf(
    input.status,
    ["success", "partial", "failed"] as const,
    "manifest_status_invalid",
  );
  const accountDetailCount = integer(
    input.accountDetailCount,
    0,
    MAX_ACCOUNTS,
    "manifest_account_count_invalid",
  );
  const monthlyFragmentCount = integer(
    input.monthlyFragmentCount,
    0,
    MAX_ACCOUNTS * MONTHS_PER_ACCOUNT,
    "manifest_month_count_invalid",
  );
  if (!Array.isArray(input.artifacts) || input.artifacts.length > MAX_ARTIFACTS) {
    invalid("manifest_artifacts_invalid");
  }
  if (!Array.isArray(input.failures) || input.failures.length > MAX_FAILURES) {
    invalid("manifest_failures_invalid");
  }
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  const artifacts = input.artifacts.map((value) => parseArtifact(value, prefix));
  if (new Set(artifacts.map((artifact) => artifact.key)).size !== artifacts.length) {
    invalid("manifest_duplicate_artifact_key");
  }
  const failures = input.failures.map(parseFailure);
  validateRelationships({
    status,
    accountDetailCount,
    monthlyFragmentCount,
    artifacts,
    failures,
    startedAt,
    completedAt,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    runId: input.runId,
    startedAt,
    completedAt,
    status,
    accountDetailCount,
    monthlyFragmentCount,
    artifacts,
    failures,
  };
}

export function validateMoneyForwardArtifactPayload(
  artifact: MoneyForwardArtifactManifest,
  bytes: Uint8Array,
  manifest: MoneyForwardManifest,
): void {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("artifact_utf8_invalid");
  }
  if (html.length === 0 || html.includes("\0")) invalid("artifact_html_invalid");
  const document = parse(html);
  const elements = allElements(document);
  if (elements.length === 0) invalid("artifact_html_invalid");
  if (artifact.kind === "accounts-index") {
    const paths = new Set<string>();
    for (const element of elements) {
      const href = attribute(element, "href");
      const match = href ? /^\/accounts\/show\/([A-Za-z0-9_-]+)(?:[?#].*)?$/u.exec(href) : null;
      if (match) paths.add(match[1]!);
    }
    if (paths.size !== manifest.accountDetailCount) invalid("accounts_index_count_mismatch");
    return;
  }
  if (artifact.kind === "account-detail") {
    const csrf = elements.filter(
      (element) =>
        element.tagName === "meta" &&
        attribute(element, "name") === "csrf-token" &&
        safeOpaque(attribute(element, "content")),
    );
    const account = elements.filter(
      (element) =>
        element.tagName === "input" &&
        attribute(element, "name") === "account[id_hash]" &&
        safeOpaque(attribute(element, "value")),
    );
    const service = elements.filter(
      (element) =>
        element.tagName === "input" &&
        attribute(element, "name") === "service[id]" &&
        safeOpaque(attribute(element, "value")),
    );
    if (csrf.length !== 1 || account.length !== 1 || service.length !== 1) {
      invalid("account_detail_shape_invalid");
    }
    return;
  }
  if (/<(?:!doctype|html)(?:\s|>)/iu.test(html)) invalid("monthly_fragment_shape_invalid");
}

export function normalizeMoneyForwardManifestForCentral(
  manifest: MoneyForwardManifest,
): Uint8Array {
  const failures = manifest.failures.map((failure) => ({
    ...failure,
    message: failure.failureCode,
  }));
  return new TextEncoder().encode(JSON.stringify({ ...manifest, failures }));
}

function parseArtifact(value: unknown, prefix: string): MoneyForwardArtifactManifest {
  const input = record(value, "manifest_artifact_invalid");
  exactKeys(input, ["dataset", "key", "mediaType", "sha256", "bytes"]);
  const dataset = oneOf(
    input.dataset,
    ["accounts-index", "account-detail", "monthly-transactions"] as const,
    "manifest_dataset_invalid",
  );
  const key = boundedString(input.key, 1, 500, "manifest_artifact_key_invalid");
  if (!key.startsWith(prefix)) invalid("manifest_artifact_key_invalid");
  const filename = key.slice(prefix.length);
  if (filename.includes("/")) invalid("manifest_artifact_key_invalid");
  const shape = artifactShape(dataset, filename);
  if (input.mediaType !== "text/html; charset=utf-8") invalid("manifest_media_type_mismatch");
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    invalid("manifest_artifact_sha_invalid");
  }
  const bytes = integer(input.bytes, 1, MAX_ARTIFACT_BYTES, "manifest_artifact_size_invalid");
  return {
    dataset,
    key,
    mediaType: "text/html; charset=utf-8",
    sha256: input.sha256,
    bytes,
    filename,
    kind: shape.kind,
    ...(shape.accountOrdinal === undefined ? {} : { accountOrdinal: shape.accountOrdinal }),
    ...(shape.month === undefined ? {} : { month: shape.month }),
  };
}

function artifactShape(
  dataset: MoneyForwardArtifactManifest["dataset"],
  filename: string,
): {
  kind: MoneyForwardArtifactKind;
  accountOrdinal?: number;
  month?: string;
} {
  if (dataset === "accounts-index" && filename === "accounts.html") {
    return { kind: "accounts-index" };
  }
  let match = /^account-detail-(\d{2})\.html$/u.exec(filename);
  if (dataset === "account-detail" && match) {
    const accountOrdinal = Number(match[1]);
    if (accountOrdinal >= 1 && accountOrdinal <= MAX_ACCOUNTS) {
      return { kind: "account-detail", accountOrdinal };
    }
  }
  match = /^account-(\d{2})-month-(\d{4}-(?:0[1-9]|1[0-2]))\.html$/u.exec(filename);
  if (dataset === "monthly-transactions" && match) {
    const accountOrdinal = Number(match[1]);
    if (accountOrdinal >= 1 && accountOrdinal <= MAX_ACCOUNTS) {
      return { kind: "monthly", accountOrdinal, month: match[2]! };
    }
  }
  invalid("manifest_dataset_filename_mismatch");
}

function parseFailure(value: unknown): MoneyForwardFailure {
  const input = record(value, "manifest_failure_invalid");
  exactKeys(input, [
    "operation",
    "errorType",
    "message",
    "stage",
    "failureCode",
    "httpStatus",
    "reasonCode",
  ]);
  const operation = boundedString(input.operation, 1, 96, "manifest_failure_operation_invalid");
  if (
    operation !== "collect" &&
    !/^r2:(?:accounts-index|account-detail|monthly-transactions)$/u.test(operation)
  ) {
    invalid("manifest_failure_operation_invalid");
  }
  const errorType = boundedString(input.errorType, 1, 64, "manifest_failure_type_invalid");
  const message = boundedString(input.message, 1, 64, "manifest_failure_message_invalid");
  const stage = boundedString(input.stage, 1, 32, "manifest_failure_stage_invalid");
  const failureCode = boundedString(input.failureCode, 1, 64, "manifest_failure_code_invalid");
  if (
    !ERROR_TYPES.has(errorType) ||
    !STAGES.has(stage) ||
    !FAILURE_CODES.has(failureCode) ||
    message !== failureCode
  ) {
    invalid("manifest_failure_contract_invalid");
  }
  const httpStatus =
    input.httpStatus === undefined
      ? undefined
      : integer(input.httpStatus, 100, 599, "manifest_failure_http_status_invalid");
  const reasonCode =
    input.reasonCode === undefined
      ? undefined
      : boundedString(input.reasonCode, 1, 40, "manifest_failure_reason_invalid");
  if (reasonCode !== undefined && !REASON_CODES.has(reasonCode)) {
    invalid("manifest_failure_reason_invalid");
  }
  const isR2Failure = operation.startsWith("r2:");
  const isCredentialFailure = failureCode === "credential_configuration_required";
  const isHttpFailure = errorType === "MoneyForwardHttpError";
  const isProtocolFailure = errorType === "MoneyForwardProtocolError";
  const allowedCollectStages = COLLECT_FAILURE_STAGES.get(failureCode);
  const allowedProtocolReasons = PROTOCOL_REASONS_BY_STAGE.get(stage);
  if (
    isHttpFailure !== (failureCode === "provider_http_failed") ||
    isProtocolFailure !== (failureCode === "provider_protocol_failed") ||
    isProtocolFailure !== (reasonCode !== undefined) ||
    (isHttpFailure && httpStatus === undefined) ||
    (!isHttpFailure && !isProtocolFailure && httpStatus !== undefined) ||
    (isProtocolFailure && !allowedProtocolReasons?.has(reasonCode!)) ||
    (isProtocolFailure &&
      httpStatus !== undefined &&
      (reasonCode !== "unexpected-redirect" || !PROTOCOL_HTTP_STATUS_STAGES.has(stage))) ||
    (isCredentialFailure && errorType !== "Error") ||
    (isR2Failure &&
      (stage !== "artifact-store" ||
        failureCode !== "operation_failed" ||
        reasonCode !== undefined ||
        httpStatus !== undefined)) ||
    (!isR2Failure && !allowedCollectStages?.has(stage)) ||
    (!isR2Failure && (stage === "credential-load") !== isCredentialFailure)
  ) {
    invalid("manifest_failure_contract_invalid");
  }
  return {
    operation,
    errorType,
    message,
    stage,
    failureCode,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  };
}

function validateRelationships(input: {
  status: MoneyForwardStatus;
  accountDetailCount: number;
  monthlyFragmentCount: number;
  artifacts: MoneyForwardArtifactManifest[];
  failures: MoneyForwardFailure[];
  startedAt: string;
  completedAt: string;
}): void {
  const expectedStatus =
    input.failures.length === 0 ? "success" : input.artifacts.length === 0 ? "failed" : "partial";
  if (input.status !== expectedStatus) invalid("manifest_status_mismatch");
  const collectFailures = input.failures.filter((failure) => failure.operation === "collect");
  const r2Failures = input.failures.filter((failure) => failure.operation.startsWith("r2:"));
  if (collectFailures.length > 1 || (collectFailures.length > 0 && r2Failures.length > 0)) {
    invalid("manifest_failure_relationship_invalid");
  }
  if (collectFailures.length > 0) {
    if (
      input.status !== "failed" ||
      input.artifacts.length !== 0 ||
      input.accountDetailCount !== 0 ||
      input.monthlyFragmentCount !== 0
    ) {
      invalid("manifest_collect_failure_counts_invalid");
    }
    return;
  }
  if (input.monthlyFragmentCount !== input.accountDetailCount * MONTHS_PER_ACCOUNT) {
    invalid("manifest_month_count_mismatch");
  }
  const fullCount = 1 + input.accountDetailCount + input.monthlyFragmentCount;
  if (input.artifacts.length + r2Failures.length !== fullCount) {
    invalid("manifest_artifact_failure_count_mismatch");
  }
  const expectedNames = expectedArtifactNames(
    input.accountDetailCount,
    acceptedMonthWindow(input.startedAt, input.completedAt),
  );
  let previous = -1;
  for (const artifact of input.artifacts) {
    const index = expectedNames.indexOf(artifact.filename);
    if (index < 0 || index <= previous) invalid("manifest_artifact_order_invalid");
    previous = index;
  }
  const expectedDatasetCounts = new Map<string, number>([
    ["accounts-index", 1],
    ["account-detail", input.accountDetailCount],
    ["monthly-transactions", input.monthlyFragmentCount],
  ]);
  for (const [dataset, count] of expectedDatasetCounts) {
    const stored = input.artifacts.filter((artifact) => artifact.dataset === dataset).length;
    const failed = r2Failures.filter((failure) => failure.operation === `r2:${dataset}`).length;
    if (stored + failed !== count) invalid("manifest_dataset_count_mismatch");
  }
}

function acceptedMonthWindow(startedAt: string, completedAt: string): string[] {
  const started = recentMonths(startedAt);
  const completed = recentMonths(completedAt);
  if (sameStrings(started, completed)) return started;
  invalid("manifest_collection_crossed_month_boundary");
}

function recentMonths(instantValue: string): string[] {
  const tokyo = new Date(Date.parse(instantValue) + 9 * 60 * 60 * 1_000);
  const result: string[] = [];
  for (let offset = 0; offset < MONTHS_PER_ACCOUNT; offset += 1) {
    const date = new Date(Date.UTC(tokyo.getUTCFullYear(), tokyo.getUTCMonth() - offset, 1));
    result.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return result;
}

function expectedArtifactNames(accountCount: number, months: string[]): string[] {
  const names = ["accounts.html"];
  for (let account = 1; account <= accountCount; account += 1) {
    const ordinal = String(account).padStart(2, "0");
    names.push(`account-detail-${ordinal}.html`);
    names.push(...months.map((month) => `account-${ordinal}-month-${month}.html`));
  }
  return names;
}

function allElements(root: HtmlNode): HtmlElement[] {
  const output: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if ("tagName" in node) output.push(node as HtmlElement);
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
    if ("content" in node && node.content) visit(node.content);
  };
  visit(root);
  return output;
}

function attribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((entry) => entry.name === name)?.value;
}

function safeOpaque(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\x00-\x20\x7f]/u.test(value)
  );
}

function record(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(code);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[]): void {
  const known = new Set(allowed);
  if (Object.keys(value).some((key) => !known.has(key))) invalid("manifest_unknown_field");
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  code: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(code);
  return value as T[number];
}

function boundedString(value: unknown, minimum: number, maximum: number, code: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) invalid(code);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(code);
  }
  return value as number;
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    invalid(code);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) invalid(code);
  return value;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(code: string): never {
  throw new ImportError(409, code);
}
