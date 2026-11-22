// A synthetic account view answer (ADR 0088) at a chosen scale, for the
// account summary's byte bound (ADR 0123, amendment 2026-11-20). Every id,
// label, unit key, dataset, parser, period and time is invented; no amount,
// merchant or provider text is written. The answer passes the full answer's
// wire check, so its summary is that of an answer the route could give.
import {
  COLLECTION_FRESHNESS_POLICY,
  collectionFreshness,
} from "../../domain/src/collection-freshness.ts";
import {
  ACCOUNT_COVERAGE_API_VERSION,
  type AccountCoverage,
  type AccountCoveragePeriod,
  type CellReason,
  MAPPING_STATUSES,
  OBSERVATION_KINDS,
  PROVIDER_DATA_TYPES,
  PROVIDER_DATA_TYPES_VERSION,
} from "../../observation-shared/src/collection-quality-contract.ts";

export interface AccountCoverageScale {
  /** Accounts the source's observations name. */
  accounts: number;
  /** Data types (dataset, parser, kind) per account. */
  typesPerAccount: number;
  /** Periods per data type. */
  periodsPerType: number;
  /** Mapping statuses per account (1 to 4). */
  statuses: number;
  /** Observation kinds the data types cycle through (1 to 4). */
  kinds: number;
  /** Characters of each account's label (Japanese, 3 bytes each in UTF-8). */
  labelChars: number;
  /** Provider data types each parser publishes (1 to 12). */
  providerTypesPerParser: number;
  /** The reasons of every account period. */
  reasons: readonly CellReason[];
  /** Unattributed cells: fetch units × datasets × periods. */
  unattributed: { units: number; datasets: number; periods: number };
  /** The reasons of every unattributed cell. */
  unattributedReasons: readonly CellReason[];
}

/**
 * The realistic worst case ADR 0123's amendment of 2026-11-20 measures: a
 * source with 62 accounts (SBI Shinsei's provider account count), each with
 * three data types of ten months, two mapping statuses, a 64-hex id, a
 * 30-character label and eight reasons on every period; and 140 cells of
 * seven card units that name no account. 2,000 cells, the read's bound.
 */
export const REALISTIC_ACCOUNT_SCALE: AccountCoverageScale = {
  accounts: 62,
  typesPerAccount: 3,
  periodsPerType: 10,
  statuses: 2,
  kinds: 2,
  labelChars: 30,
  providerTypesPerParser: 1,
  reasons: [
    "retention_not_assessed",
    "identity_unresolved",
    "run_not_successful",
    "unit_failed",
    "newer_capture_not_current",
    "no_current_capture",
    "coverage_incomplete",
    "parse_pending",
  ],
  unattributed: { units: 7, datasets: 4, periods: 5 },
  unattributedReasons: [
    "retention_not_assessed",
    "unit_without_artifacts",
    "run_not_successful",
    "unit_failed",
    "no_current_capture",
  ],
};

/** The instant ages are counted to, and its Asia/Tokyo date. */
const SCALE_AS_OF = { at: "2026-11-19T02:00:00.000Z", date: "2026-11-19" };

const nn = (value: number, width = 2) => String(value).padStart(width, "0");
/** A month label `count` months before 2026-11. */
const month = (back: number) => {
  const index = 2026 * 12 + 10 - back;
  return `${Math.floor(index / 12)}-${nn((index % 12) + 1)}`;
};
/** A capture `hours` hours before the as-of instant. */
const capturedAt = (hours: number) =>
  new Date(Date.parse(SCALE_AS_OF.at) - hours * 3_600_000).toISOString();
const freshness = (at: string) => collectionFreshness(at, SCALE_AS_OF.date, null);

/** The newest named capture's freshness, the first such period winning a tie (as the read does). */
function newest(periods: readonly AccountCoveragePeriod[]) {
  let freshest = periods[0]!;
  for (const entry of periods)
    if (Date.parse(entry.capture.capturedAt) > Date.parse(freshest.capture.capturedAt))
      freshest = entry;
  return { ...freshest.freshness };
}

/** A full account view answer of the given scale for source `sourceId`. */
export function syntheticAccountCoverage(
  scale: AccountCoverageScale,
  sourceId = "synthetic-source",
): AccountCoverage {
  // Twelve collected or partial provider types, each parser in
  // `providerTypesPerParser` of them, and four not collected.
  const parsers = Array.from(
    { length: scale.typesPerAccount },
    (_, index) => `synthetic-parser-${nn(index)}`,
  );
  const published = PROVIDER_DATA_TYPES.slice(0, 12);
  const catalogue = [
    ...published.map((type, index) => {
      const members = parsers.filter(
        (_, parser) =>
          (index - parser + published.length) % published.length < scale.providerTypesPerParser,
      );
      return members.length === 0
        ? { type, status: "not_collected" as const, parsers: [], issue: 9_000 + index }
        : index % 3 === 2
          ? { type, status: "partial" as const, parsers: members, issue: 9_000 + index }
          : { type, status: "collected" as const, parsers: members, issue: null };
    }),
    ...PROVIDER_DATA_TYPES.slice(12).map((type, index) => ({
      type,
      status: "not_collected" as const,
      parsers: [],
      issue: 9_100 + index,
    })),
  ];
  const accounts = Array.from({ length: scale.accounts }, (_, account) => {
    const dataTypes = parsers.map((parser, type) => {
      const periods: AccountCoveragePeriod[] = Array.from(
        { length: scale.periodsPerType },
        (_, period) => {
          const shape = (account + type + period) % 3;
          // Current; older-current behind a newer refused capture; or named
          // only by a newest capture that is not current.
          const at = capturedAt(24 * (period + 1) + type);
          return {
            unitKey: `synthetic-card-${nn(account, 3)}`,
            period: { kind: "statement-month" as const, value: month(period), state: null },
            currentRule: "vpass-card-month" as const,
            cellState: (["current", "older-current", "no-current"] as const)[shape]!,
            standing: (["current", "older-current", "newest-not-current"] as const)[shape]!,
            capture: { fetchRunId: 1_000 + account * 100 + period, capturedAt: at },
            observations: 3,
            reasons: [...scale.reasons],
            freshness: freshness(at),
          };
        },
      );
      return {
        dataset: `synthetic-statement-dataset-${nn(type)}`,
        parser,
        providerTypes: catalogue
          .filter((entry) => (entry.parsers as readonly string[]).includes(parser))
          .map((entry) => entry.type),
        kind: OBSERVATION_KINDS[type % scale.kinds]!,
        periods,
        freshness: newest(periods),
      };
    });
    const label = `シンセティック口座${nn(account, 3)}`;
    return {
      // A 64-hex entity id, as the identity layer writes one.
      accountId: `${nn(account, 4)}${"5a".repeat(30)}`,
      label: (label + "テ".repeat(scale.labelChars)).slice(0, scale.labelChars),
      statuses: MAPPING_STATUSES.slice(0, scale.statuses),
      dataTypes,
      freshness: newest(dataTypes.flatMap((type) => type.periods)),
    };
  });
  const unattributed = [];
  for (let unit = 0; unit < scale.unattributed.units; unit++)
    for (let dataset = 0; dataset < scale.unattributed.datasets; dataset++)
      for (let period = 0; period < scale.unattributed.periods; period++)
        unattributed.push({
          dataset: `synthetic-unattributed-dataset-${nn(dataset)}`,
          parser: `synthetic-unattributed-parser-${nn(dataset)}`,
          unitKey: `synthetic-unattributed-card-${nn(unit, 3)}`,
          period: { kind: "statement-month" as const, value: month(period), state: null },
          currentRule: "vpass-card-month" as const,
          state: (["current", "older-current", "no-current"] as const)[period % 3],
          reasons: [...scale.unattributedReasons],
        });
  const entries = scale.accounts * scale.typesPerAccount * scale.periodsPerType;
  return {
    apiVersion: ACCOUNT_COVERAGE_API_VERSION,
    freshnessAsOf: { policy: COLLECTION_FRESHNESS_POLICY, ...SCALE_AS_OF },
    dataTypesVersion: PROVIDER_DATA_TYPES_VERSION,
    dataTypes: catalogue,
    sourceId,
    latestFetchRun: { id: 99_999, succeeded: false, completedAt: capturedAt(2) },
    // Each account period is its own cell here (one account per card unit).
    cells: entries + unattributed.length,
    accounts,
    unattributed,
  } as unknown as AccountCoverage;
}
