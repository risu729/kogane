// Runtime checks for the shared HTTP contract; no database or UI dependencies.
// Shape<T> requires a validator for every declared field when contracts evolve.
import { isDecimalMinorUnit } from "../src/money.ts";
import { validIdentityResponse } from "./identity-contract.ts";
import { validAccountConnection } from "./account-connection-contract.ts";
import { validFinancialProductClaimWire } from "./financial-products.ts";
import { validBalanceInterpretation } from "./balance-semantics.ts";
import {
  IDENTITY_READ_MODES,
  MEASURE_VIEWS,
  OBSERVATION_API_CONTRACT_VERSION,
  PAGINATION_VERSIONS,
  validInterpretationContext,
  type ApiCapabilities,
  type InterpretationContext,
} from "./api-schema.ts";
import type {
  ObservationOrganization,
  OrganizedAccount,
  OrganizedInstrument,
} from "./organization-contract.ts";
import type {
  ApiMetadata,
  ArtifactDetail,
  ArtifactRow,
  BalanceHistoryRow,
  BalanceRow,
  ObservationDetail,
  ObservationKind,
  ObservationRef,
  Overview,
  ParseRunDetail,
  PositionRow,
  PositionWithValuations,
  Provenance,
  TransactionRow,
  ValuationRow,
  Warnings,
} from "./api-contract.ts";

type Check<T> = (value: unknown) => value is T;
type Shape<T> = { [K in keyof T]-?: Check<T[K]> };
const text: Check<string> = (value): value is string => typeof value === "string";
const number: Check<number> = (value): value is number =>
  typeof value === "number" && Number.isFinite(value);
const identifier: Check<number> = (value): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hash: Check<string> = (value): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const boolean: Check<boolean> = (value): value is boolean => typeof value === "boolean";
const unknown: Check<unknown> = (_value): _value is unknown => true;
const record: Check<Record<string, unknown>> = (value): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function nullable<T>(check: Check<T>): Check<T | null> {
  return (value): value is T | null => value === null || check(value);
}
function optional<T>(check: Check<T>): Check<T | undefined> {
  return (value): value is T | undefined => value === undefined || check(value);
}
function array<T>(check: Check<T>): Check<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(check);
}
function literal<T extends string | number | boolean>(...choices: T[]): Check<T> {
  return (value): value is T => choices.some((choice) => choice === value);
}
function object<T>(shape: Shape<T>): Check<T> {
  return (value): value is T =>
    record(value) &&
    (Object.keys(shape) as (keyof T & string)[]).every((key) => shape[key](value[key]));
}
const nullableText = nullable(text);
const nullableNumber = nullable(number);
const nullableIdentifier = nullable(identifier);
const minorUnit = nullable(isDecimalMinorUnit);
const observationKind = literal<ObservationKind>("transaction", "balance", "position", "valuation");
const organizationAccountFields = {
  referenceId: text,
  targetId: text,
  label: text,
  status: literal("identified", "provider-local", "aggregate", "unresolved"),
  revision: (value: unknown): value is number => identifier(value) && value > 0,
  method: literal("rule", "manual"),
  reason: text,
} satisfies Shape<Omit<OrganizedAccount, "connection">>;
const organizationShape = object<ObservationOrganization>({
  product: optional(validFinancialProductClaimWire),
  mappingRevision: optional((value: unknown): value is number => identifier(value) && value > 0),
  identityRelease: optional(text),
  state: literal("organized", "unavailable"),
  lineage: nullable(literal("current", "historical")),
  account: nullable(
    object<OrganizedAccount>({
      ...organizationAccountFields,
      connection: optional(validAccountConnection),
    }),
  ),
  instruments: array(
    object<OrganizedInstrument>({
      ...organizationAccountFields,
      role: literal("unit", "security", "trade-unit", "usage-unit"),
      namespace: text,
      scope: text,
      value: text,
      nameEvidence: optional(
        object<NonNullable<OrganizedInstrument["nameEvidence"]>>({
          reason: literal("manual", "provider-current", "observed-japanese-script"),
          origin: nullable(object({ kind: observationKind, id: identifier })),
        }),
      ),
    }),
  ),
});
const organization: Check<ObservationOrganization> = (value): value is ObservationOrganization =>
  organizationShape(value) &&
  (value.state === "organized"
    ? value.account !== null &&
      value.lineage !== null &&
      new Set(value.instruments.map((i) => i.role)).size === value.instruments.length
    : value.account === null &&
      value.lineage === null &&
      value.instruments.length === 0 &&
      value.product === undefined);
const warnings = object<Warnings>({
  list: array(text),
  raw: nullableText,
  parsed: boolean,
});
/** A distinct list of members drawn from a closed set of names. */
function subset<T extends string>(choices: readonly T[]): Check<readonly T[]> {
  return (value): value is readonly T[] =>
    Array.isArray(value) &&
    value.every((member) => choices.includes(member)) &&
    new Set(value).size === value.length;
}
/** A connection name is an identifier for labels; it never selects behaviour. */
const sourceKind: Check<string> = (value): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
export const validApiCapabilities: Check<ApiCapabilities> = object<ApiCapabilities>({
  contractVersion: literal(OBSERVATION_API_CONTRACT_VERSION),
  readOnly: literal(true),
  rawEvidence: literal(true),
  liveCollectors: literal(false),
  measureViews: subset(MEASURE_VIEWS),
  identityReadModes: subset(IDENTITY_READ_MODES),
  paginationVersion: literal(...PAGINATION_VERSIONS),
  collectionFilters: boolean,
  organizedDisplay: boolean,
  financialProducts: boolean,
  evidenceHistory: boolean,
  commands: boolean,
});
const metadata = object<ApiMetadata>({
  parsingHealth: optional(
    object<NonNullable<ApiMetadata["parsingHealth"]>>({
      pending: identifier,
      running: identifier,
      failed: identifier,
    }),
  ),
  apiVersion: literal(1),
  source: object<ApiMetadata["source"]>({
    kind: sourceKind,
    classification: literal("unknown", "synthetic", "financial"),
  }),
  capabilities: validApiCapabilities,
});
function ownProduct<T extends { id: number; organization?: ObservationOrganization }>(
  kind: ObservationKind,
  shape: Check<T>,
): Check<T> {
  return (value): value is T =>
    shape(value) &&
    (value.organization?.product === undefined ||
      (value.organization.product.origin.kind === kind &&
        value.organization.product.origin.id === value.id));
}
import { validActivityMeaning } from "./activity-semantics.ts";
import { validNormalizedDecimal } from "./normalized-decimal.ts";
const transaction = ownProduct(
  "transaction",
  object<TransactionRow>({
    normalized: optional(validNormalizedDecimal),
    interpretation: optional(validActivityMeaning),
    organization: optional(organization),
    id: identifier,
    source_id: text,
    source_account: text,
    as_of: nullableText,
    amount_minor: minorUnit,
    amount_text: nullableText,
    currency: nullableText,
    description: nullableText,
    counterparty: nullableText,
    external_id: nullableText,
    status: nullableText,
    parser: text,
  }),
);
const balanceFields = {
  normalized: optional(validNormalizedDecimal),
  interpretation: optional(validBalanceInterpretation),
  organization: optional(organization),
  id: identifier,
  source_id: text,
  source_account: text,
  metric: text,
  instrument: text,
  amount_minor: minorUnit,
  amount_text: nullableText,
  as_of: nullableText,
  observed_at: nullableText,
  parser: text,
} satisfies Shape<BalanceRow>;
function ownBalanceInterpretation<T extends BalanceRow>(shape: Check<T>): Check<T> {
  return (value): value is T =>
    shape(value) &&
    (value.interpretation === undefined ||
      value.interpretation.evidence.some(
        (evidence) => evidence.id === value.id && evidence.metric === value.metric,
      ));
}
const balance = ownBalanceInterpretation(ownProduct("balance", object<BalanceRow>(balanceFields)));
const balanceHistory = ownBalanceInterpretation(
  ownProduct(
    "balance",
    object<BalanceHistoryRow>({
      ...balanceFields,
      superseded_by_parse_run_id: nullableIdentifier,
      parse_status: text,
    }),
  ),
);
const position = ownProduct(
  "position",
  object<PositionRow>({
    normalized: optional(validNormalizedDecimal),
    organization: optional(organization),
    id: identifier,
    source_id: text,
    source_account: text,
    security_code: text,
    security_name: nullableText,
    market: nullableText,
    quantity_text: text,
    quantity_scale: number,
    currency: nullableText,
    as_of: nullableText,
    parser: text,
  }),
);
const valuation = ownProduct(
  "valuation",
  object<ValuationRow>({
    normalized: optional(validNormalizedDecimal),
    organization: optional(organization),
    id: identifier,
    source_id: text,
    source_account: text,
    subject: text,
    metric: text,
    amount_minor: minorUnit,
    amount_text: nullableText,
    currency: text,
    as_of: nullableText,
    parser: text,
  }),
);
const positionWithValuations = object<PositionWithValuations>({
  position,
  valuations: array(valuation),
});
const artifact = object<ArtifactRow>({
  id: identifier,
  source_id: text,
  dataset: nullableText,
  url: nullableText,
  mime: text,
  fetched_at: text,
  sha256: hash,
  parse_run_count: number,
  transaction_count: number,
  balance_count: number,
  position_count: number,
  valuation_count: number,
});
const parseFields = {
  id: identifier,
  parser_name: text,
  parser_version: text,
  parsed_at: text,
  status: text,
  warnings,
  error: nullableText,
  superseded_by_parse_run_id: nullableIdentifier,
};
const overview = object<Overview>({
  counts: array(object<Overview["counts"][number]>({ table: text, rows: number })),
  sources: array(
    object<Overview["sources"][number]>({
      id: text,
      provider: text,
      ingestion: text,
      artifact_count: number,
    }),
  ),
  fetchRuns: array(
    object<Overview["fetchRuns"][number]>({
      id: identifier,
      source_id: text,
      tool: text,
      external_run_id: nullableText,
      status: text,
      started_at: text,
      completed_at: nullableText,
    }),
  ),
  parseRuns: array(
    object<Overview["parseRuns"][number]>({
      ...parseFields,
      fetch_artifact_id: identifier,
    }),
  ),
});
const observationRef = object<ObservationRef>({
  kind: observationKind,
  id: identifier,
  summary: text,
});
const parseRun = object<ParseRunDetail>({
  ...parseFields,
  observations: array(observationRef),
});
const provenanceFields = {
  source_id: text,
  dataset: nullableText,
  url: nullableText,
  mime: text,
  fetched_at: text,
  sha256: hash,
  size: number,
  content_type: text,
  fetch_run_id: identifier,
  tool: text,
  external_run_id: nullableText,
  fetch_status: text,
  started_at: text,
  completed_at: nullableText,
};
const artifactDetail = object<ArtifactDetail>({
  artifact: object<ArtifactDetail["artifact"]>({
    ...provenanceFields,
    id: identifier,
    method: nullableText,
    http_status: nullableNumber,
  }),
  parseRuns: array(parseRun),
});
const provenance = object<Provenance>({
  ...provenanceFields,
  parse_run_id: identifier,
  parser_name: text,
  parser_version: text,
  parsed_at: text,
  parse_status: text,
  error: nullableText,
  warnings,
  superseded_by_parse_run_id: nullableIdentifier,
  artifact_id: identifier,
});
const observation = object<ObservationDetail>({
  normalized: optional(validNormalizedDecimal),
  organization: optional(organization),
  interpretationContext: optional(validInterpretationContext),
  kind: observationKind,
  row: (value): value is Record<string, unknown> =>
    record(value) &&
    identifier(value.id) &&
    (!Object.hasOwn(value, "amount_minor") || minorUnit(value.amount_minor)),
  extra: unknown,
  extraRaw: text,
  extraParsed: boolean,
  provenance: optional(provenance),
});
// A response may say which interpretation it was computed under; when it does,
// the context must be well-formed.
const context = optional(validInterpretationContext);
const endpoints: Record<string, Check<unknown>> = {
  "/api/meta": metadata,
  "/api/overview": overview,
  "/api/transactions": object<{
    transactions: TransactionRow[];
    interpretationContext?: InterpretationContext;
  }>({ transactions: array(transaction), interpretationContext: context }),
  "/api/balances": object<{
    latest: BalanceRow[];
    history: BalanceHistoryRow[];
    interpretationContext?: InterpretationContext;
  }>({ latest: array(balance), history: array(balanceHistory), interpretationContext: context }),
  "/api/positions": object<{
    positions: PositionWithValuations[];
    interpretationContext?: InterpretationContext;
  }>({ positions: array(positionWithValuations), interpretationContext: context }),
  "/api/artifacts": object<{ artifacts: ArtifactRow[] }>({
    artifacts: array(artifact),
  }),
};

/** Additive fields are allowed; required fields and their nullability are checked. */
export function validApiResponse(path: string, value: unknown): boolean {
  if (path.startsWith("/api/identity/")) return validIdentityResponse(path, value);
  if (path === "/api/filter-options") {
    return (
      record(value) &&
      Array.isArray(value.sources) &&
      value.sources.every(text) &&
      Array.isArray(value.instruments) &&
      value.instruments.every(text) &&
      Array.isArray(value.metrics) &&
      value.metrics.every(text) &&
      Array.isArray(value.accounts) &&
      value.accounts.every(
        (row) =>
          record(row) &&
          text(row.source_id) &&
          text(row.source_account) &&
          optional(nullableText)(row.display_name) &&
          optional(boolean)(row.organization_ambiguous),
      )
    );
  }
  if (record(value) && Object.hasOwn(value, "coverage")) {
    const c = value.coverage;
    if (
      !record(c) ||
      !identifier(c.limit) ||
      !boolean(c.truncated) ||
      !(
        c.nextOffset === undefined ||
        c.nextOffset === null ||
        (Number.isSafeInteger(c.nextOffset) &&
          typeof c.nextOffset === "number" &&
          c.nextOffset >= 0)
      ) ||
      !(
        c.latestNextOffset === undefined ||
        c.latestNextOffset === null ||
        (Number.isSafeInteger(c.latestNextOffset) &&
          typeof c.latestNextOffset === "number" &&
          c.latestNextOffset >= 0)
      ) ||
      !(
        c.nextCursor === undefined ||
        c.nextCursor === null ||
        (typeof c.nextCursor === "string" && /^[1-9]\d*$/.test(c.nextCursor))
      )
    )
      return false;
  }
  const check = Object.hasOwn(endpoints, path) ? endpoints[path] : undefined;
  if (check) return check(value);
  if (/^\/api\/artifacts\/\d+$/u.test(path)) {
    const id = Number(path.split("/")[3]);
    return identifier(id) && artifactDetail(value) && value.artifact.id === id;
  }
  if (/^\/api\/observations\/(transaction|balance|position|valuation)\/\d+$/u.test(path)) {
    const id = Number(path.split("/")[4]);
    return (
      identifier(id) &&
      observation(value) &&
      value.kind === path.split("/")[3] &&
      value.row.id === id &&
      (value.organization?.product === undefined ||
        (value.organization.product.origin.kind === value.kind &&
          value.organization.product.origin.id === id &&
          (!value.provenance ||
            (value.organization.product.origin.parseRunId === value.provenance.parse_run_id &&
              value.organization.product.origin.artifactId === value.provenance.artifact_id))))
    );
  }
  return false;
}
