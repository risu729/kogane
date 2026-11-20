import type {
  ArtifactMeta,
  Observation,
  Parser,
  ParseResult,
  ValuationObservation,
} from "../types.ts";
import { containerClaim } from "./coverage.ts";
import { decodeUtf8 } from "./util.ts";
import { exactKeys, exactMoney, strictObject, strictString } from "./sbi-strict.ts";

const SOURCE_ACCOUNT = "sbi-securities:account-assets";
const ROOT_KEYS = [
  "summary",
  "summaryWithoutDeposit",
  "summaryWithoutIdeco",
  "summaryWithoutDepositAndIdeco",
  "summaryDetails",
  "summaryDetailsWithoutDeposit",
  "summaryDetailsWithoutIdeco",
  "summaryDetailsWithoutDepositAndIdeco",
] as const;
const SUMMARY_KEYS = [
  "acquisitionCost",
  "assetsErrorType",
  "monthOnMonth",
  "monthOnMonthRatio",
  "netChange",
  "percentChange",
  "profitLoss",
  "profitLossRate",
  "valuation",
] as const;
const DETAIL_KEYS = [...SUMMARY_KEYS, "category", "compositionRatio"] as const;
/**
 * Observed from 2026-11 on: one breakdown list, keyed by a category code that
 * is not one of the `summaryDetails` categories plus a `categoryDetail` code.
 * Earlier artifacts lack it, so it is the only optional root key.
 */
const ITEM_VIEW = "summaryDetailItems";
const ITEM_KEYS = [...DETAIL_KEYS, "categoryDetail"] as const;
const MONEY_FIELDS = [
  ["valuation", "valuation"],
  ["netChange", "net_change"],
  ["monthOnMonth", "month_on_month"],
  ["profitLoss", "profit_loss"],
  ["acquisitionCost", "acquisition_cost"],
] as const;

function validateNullableFinite(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${label} must be null or a finite number`);
  }
}

function observationsForSummary(
  value: unknown,
  view: string,
  locator: string,
  category?: string,
  categoryDetail?: string,
): ValuationObservation[] {
  const label =
    category === undefined
      ? view
      : categoryDetail === undefined
        ? `${view}[${category}]`
        : `${view}[${category}/${categoryDetail}]`;
  const object = strictObject(value, label);
  exactKeys(
    object,
    category === undefined ? SUMMARY_KEYS : categoryDetail === undefined ? DETAIL_KEYS : ITEM_KEYS,
    label,
  );
  if (object["assetsErrorType"] !== null) {
    throw new Error(`${label}.assetsErrorType is not a successful valuation`);
  }
  for (const field of ["percentChange", "monthOnMonthRatio", "profitLossRate"] as const) {
    validateNullableFinite(object[field], `${label}.${field}`);
  }
  if (category !== undefined) {
    const actualCategory = strictString(object["category"], `${label}.category`, { max: 128 });
    if (actualCategory !== category) throw new Error(`${label}.category changed during parsing`);
    validateNullableFinite(object["compositionRatio"], `${label}.compositionRatio`);
  }
  if (categoryDetail !== undefined) {
    const actual = strictString(object["categoryDetail"], `${label}.categoryDetail`, { max: 128 });
    if (actual !== categoryDetail)
      throw new Error(`${label}.categoryDetail changed during parsing`);
  }

  const subject =
    category === undefined
      ? `portfolio:${view}`
      : categoryDetail === undefined
        ? `portfolio:${view}:${category}`
        : `portfolio:${view}:${category}:${categoryDetail}`;
  const result: ValuationObservation[] = [];
  for (const [field, metric] of MONEY_FIELDS) {
    const value = object[field];
    if (value === null) continue;
    const amount = exactMoney(value, "JPY", `${label}.${field}`);
    result.push({
      kind: "valuation",
      sourceAccount: SOURCE_ACCOUNT,
      subject,
      metric,
      amountMinor: amount.minor,
      amountText: amount.text,
      amountScale: amount.scale,
      currency: "JPY",
      rawLocator: `${locator}.${field}`,
      extra: {
        ...object,
        _kogane: {
          view,
          ...(category === undefined ? {} : { category }),
          ...(categoryDetail === undefined ? {} : { categoryDetail }),
        },
      },
    });
  }
  return result;
}

export const sbiAccountAssetsCurrent: Parser = {
  name: "sbi-account-assets-current",
  version: "1.0.2",

  accepts(artifact: ArtifactMeta): boolean {
    return artifact.sourceId === "sbi-securities" && artifact.dataset === "account-assets-current";
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    const body = strictObject(JSON.parse(decodeUtf8(bytes)), "account-assets-current");
    const hasItems = Object.hasOwn(body, ITEM_VIEW);
    exactKeys(body, hasItems ? [...ROOT_KEYS, ITEM_VIEW] : ROOT_KEYS, "account-assets-current");
    const observations: Observation[] = [];
    const summaryViews = [
      "summary",
      "summaryWithoutDeposit",
      "summaryWithoutIdeco",
      "summaryWithoutDepositAndIdeco",
    ] as const;
    for (const view of summaryViews) {
      const value = body[view];
      if (value === null) continue;
      observations.push(...observationsForSummary(value, view, `json:$.${view}`));
    }

    const detailViews = [
      "summaryDetails",
      "summaryDetailsWithoutDeposit",
      "summaryDetailsWithoutIdeco",
      "summaryDetailsWithoutDepositAndIdeco",
    ] as const;
    for (const view of detailViews) {
      const rows = body[view];
      if (!Array.isArray(rows)) throw new Error(`${view} must be an array`);
      if (rows.length > 1_000) throw new Error(`${view} exceeds the parser bound`);
      const categories = new Set<string>();
      rows.forEach((value, index) => {
        const row = strictObject(value, `${view}[${index}]`);
        const category = strictString(row["category"], `${view}[${index}].category`, { max: 128 });
        if (categories.has(category)) throw new Error(`${view} repeats category ${category}`);
        categories.add(category);
        observations.push(
          ...observationsForSummary(value, view, `json:$.${view}[${index}]`, category),
        );
      });
    }
    if (hasItems) {
      const rows = body[ITEM_VIEW];
      if (!Array.isArray(rows)) throw new Error(`${ITEM_VIEW} must be an array`);
      if (rows.length > 1_000) throw new Error(`${ITEM_VIEW} exceeds the parser bound`);
      const keys = new Set<string>();
      rows.forEach((value, index) => {
        const label = `${ITEM_VIEW}[${index}]`;
        const row = strictObject(value, label);
        const category = strictString(row["category"], `${label}.category`, { max: 128 });
        const detail = strictString(row["categoryDetail"], `${label}.categoryDetail`, {
          max: 128,
        });
        // Keyed like the subject, so two code pairs that join to one subject are refused.
        const key = `${category}:${detail}`;
        if (keys.has(key)) throw new Error(`${ITEM_VIEW} repeats category ${category}/${detail}`);
        keys.add(key);
        observations.push(
          ...observationsForSummary(
            value,
            ITEM_VIEW,
            `json:$.${ITEM_VIEW}[${index}]`,
            category,
            detail,
          ),
        );
      });
    }
    // Every view is validated to its exact key set or rejected, so a parse
    // that returns is a complete container; null summaries are the provider's
    // own statement of absence.
    return {
      observations,
      warnings: [],
      issues: [],
      coverage: [
        containerClaim({
          artifact,
          issues: [],
          observedCount: observations.length,
          evidenceRefs: [...summaryViews, ...detailViews, ...(hasItems ? [ITEM_VIEW] : [])].map(
            (view) => `json:$.${view}`,
          ),
        }),
      ],
    };
  },
};
