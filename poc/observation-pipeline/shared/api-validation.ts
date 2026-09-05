// Runtime checks for the shared HTTP contract; no database or UI dependencies.
// Shape<T> requires a validator for every declared field when contracts evolve.
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
const text: Check<string> = (value): value is string =>
  typeof value === "string";
const number: Check<number> = (value): value is number =>
  typeof value === "number" && Number.isFinite(value);
const boolean: Check<boolean> = (value): value is boolean =>
  typeof value === "boolean";
const unknown: Check<unknown> = (_value): _value is unknown => true;
const record: Check<Record<string, unknown>> = (
  value,
): value is Record<string, unknown> =>
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
function literal<T extends string | number | boolean>(
  ...choices: T[]
): Check<T> {
  return (value): value is T => choices.some((choice) => choice === value);
}
function object<T>(shape: Shape<T>): Check<T> {
  return (value): value is T =>
    record(value) &&
    (Object.keys(shape) as (keyof T & string)[]).every((key) =>
      shape[key](value[key]),
    );
}
const nullableText = nullable(text);
const nullableNumber = nullable(number);
const observationKind = literal<ObservationKind>(
  "transaction",
  "balance",
  "position",
  "valuation",
);
const warnings = object<Warnings>({
  list: array(text),
  raw: nullableText,
  parsed: boolean,
});
const metadata = object<ApiMetadata>({
  apiVersion: literal(1),
  source: object<ApiMetadata["source"]>({
    kind: literal("local-store"),
    classification: literal("unknown", "synthetic"),
  }),
  capabilities: object<ApiMetadata["capabilities"]>({
    readOnly: literal(true),
    rawEvidence: literal(true),
    liveCollectors: literal(false),
  }),
});
const transaction = object<TransactionRow>({
  id: number,
  source_id: text,
  source_account: text,
  as_of: nullableText,
  amount_minor: nullableText,
  amount_text: nullableText,
  currency: nullableText,
  description: nullableText,
  counterparty: nullableText,
  external_id: nullableText,
  status: nullableText,
  parser: text,
});
const balanceFields = {
  id: number,
  source_id: text,
  source_account: text,
  metric: text,
  instrument: text,
  amount_minor: nullableText,
  amount_text: nullableText,
  as_of: nullableText,
  observed_at: nullableText,
  parser: text,
} satisfies Shape<BalanceRow>;
const balance = object<BalanceRow>(balanceFields);
const balanceHistory = object<BalanceHistoryRow>({
  ...balanceFields,
  superseded_by_parse_run_id: nullableNumber,
  parse_status: text,
});
const position = object<PositionRow>({
  id: number,
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
});
const valuation = object<ValuationRow>({
  id: number,
  source_id: text,
  source_account: text,
  subject: text,
  metric: text,
  amount_minor: nullableText,
  amount_text: nullableText,
  currency: text,
  as_of: nullableText,
  parser: text,
});
const positionWithValuations = object<PositionWithValuations>({
  position,
  valuations: array(valuation),
});
const artifact = object<ArtifactRow>({
  id: number,
  source_id: text,
  dataset: nullableText,
  url: nullableText,
  mime: text,
  fetched_at: text,
  sha256: text,
  parse_run_count: number,
  transaction_count: number,
  balance_count: number,
  position_count: number,
  valuation_count: number,
});
const parseFields = {
  id: number,
  parser_name: text,
  parser_version: text,
  parsed_at: text,
  status: text,
  warnings,
  error: nullableText,
  superseded_by_parse_run_id: nullableNumber,
};
const overview = object<Overview>({
  counts: array(
    object<Overview["counts"][number]>({ table: text, rows: number }),
  ),
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
      id: number,
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
      fetch_artifact_id: number,
    }),
  ),
});
const observationRef = object<ObservationRef>({
  kind: observationKind,
  id: number,
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
  sha256: text,
  size: number,
  content_type: text,
  fetch_run_id: number,
  tool: text,
  external_run_id: nullableText,
  fetch_status: text,
  started_at: text,
  completed_at: nullableText,
};
const artifactDetail = object<ArtifactDetail>({
  artifact: object<ArtifactDetail["artifact"]>({
    ...provenanceFields,
    id: number,
    method: nullableText,
    http_status: nullableNumber,
  }),
  parseRuns: array(parseRun),
});
const provenance = object<Provenance>({
  ...provenanceFields,
  parse_run_id: number,
  parser_name: text,
  parser_version: text,
  parsed_at: text,
  parse_status: text,
  error: nullableText,
  warnings,
  superseded_by_parse_run_id: nullableNumber,
  artifact_id: number,
});
const observation = object<ObservationDetail>({
  kind: observationKind,
  row: record,
  extra: unknown,
  extraRaw: text,
  extraParsed: boolean,
  provenance: optional(provenance),
});
const endpoints: Record<string, Check<unknown>> = {
  "/api/meta": metadata,
  "/api/overview": overview,
  "/api/transactions": object<{ transactions: TransactionRow[] }>({
    transactions: array(transaction),
  }),
  "/api/balances": object<{
    latest: BalanceRow[];
    history: BalanceHistoryRow[];
  }>({ latest: array(balance), history: array(balanceHistory) }),
  "/api/positions": object<{ positions: PositionWithValuations[] }>({
    positions: array(positionWithValuations),
  }),
  "/api/artifacts": object<{ artifacts: ArtifactRow[] }>({
    artifacts: array(artifact),
  }),
};

/** Additive fields are allowed; required fields and their nullability are checked. */
export function validApiResponse(path: string, value: unknown): boolean {
  const check = Object.hasOwn(endpoints, path) ? endpoints[path] : undefined;
  if (check) return check(value);
  if (/^\/api\/artifacts\/\d+$/u.test(path)) return artifactDetail(value);
  if (
    /^\/api\/observations\/(transaction|balance|position|valuation)\/\d+$/u.test(
      path,
    )
  ) {
    return observation(value) && value.kind === path.split("/")[3];
  }
  return false;
}
