import { decimalEquals, integerDecimal, sumDecimals } from "../../../domain/src/values.ts";
import type { CoverageClaim } from "../../../domain/src/coverage.ts";
import type { Observation, Parser, ValuationObservation } from "../types.ts";
import { containerClaim, ParseDiagnostics } from "./coverage.ts";
import { decodeUtf8 } from "./util.ts";
import {
  assetHistoryError,
  assetHistoryViews,
  assetHistoryPayload,
  type AssetHistoryCategory,
  type AssetHistoryView,
} from "./sbi-asset-history-schema.ts";

const SOURCE_ACCOUNT = "sbi-securities:account-assets";
const MONEY_FIELDS = [
  ["valuation", "valuation"],
  ["acquisitionCost", "acquisition_cost"],
  ["profitLoss", "profit_loss"],
] as const;
const WEEK = 7 * 86400000;

function money(value: number): number {
  if (!Number.isSafeInteger(value)) throw assetHistoryError("sbi_asset_history_money");
  return value;
}
function pointDate(time: string): string {
  const local = new Date(Number(time) + 9 * 3600000);
  if (
    local.getUTCDay() !== 6 ||
    local.getUTCHours() !== 0 ||
    local.getUTCMinutes() !== 0 ||
    local.getUTCSeconds() !== 0 ||
    local.getUTCMilliseconds() !== 0
  )
    throw assetHistoryError("sbi_asset_history_timestamp");
  return local.toISOString().slice(0, 10);
}
function nativePoints(values: readonly [number, number][]): Map<string, number> {
  const result = new Map<string, number>();
  for (const [time, value] of values) {
    const key = String(time);
    if (result.has(key)) throw assetHistoryError("sbi_asset_history_native_mismatch");
    result.set(key, money(value));
  }
  return result;
}
function validateView(view: AssetHistoryView): string[] {
  if (view.transitions === null) return [];
  const times = Object.keys(view.transitions).sort();
  const balances = nativePoints(view.balances);
  const acquisition = nativePoints(view.acquisitionCosts);
  if (balances.size !== times.length || acquisition.size !== times.length)
    throw assetHistoryError("sbi_asset_history_native_mismatch");
  for (const [index, time] of times.entries()) {
    pointDate(time);
    if (index > 0 && Number(time) - Number(times[index - 1]!) !== WEEK)
      throw assetHistoryError("sbi_asset_history_weekly_gap");
    const rows = view.transitions[time]!;
    for (const point of Object.values(rows)) {
      money(point.valuation);
      money(point.acquisitionCost);
      if (point.profitLoss !== null) money(point.profitLoss);
    }
    const aggregate = rows.ALL!;
    if (
      balances.get(time) !== aggregate.valuation ||
      acquisition.get(time) !== aggregate.acquisitionCost
    )
      throw assetHistoryError("sbi_asset_history_native_mismatch");
    for (const field of ["valuation", "acquisitionCost"] as const) {
      // Only holdCategories participates. WithoutDeposit still returns
      // nonzero deposit rows, and ALL must never be added to its own parts.
      const total = sumDecimals(
        view.holdCategories.map((category) => integerDecimal(rows[category]![field])),
      );
      if (!decimalEquals(total, integerDecimal(aggregate[field])))
        throw assetHistoryError("sbi_asset_history_total_mismatch");
    }
  }
  return times;
}

export const sbiAccountAssetsHistory: Parser = {
  name: "sbi-account-assets-history",
  version: "0.1.0",
  accepts: (artifact) =>
    artifact.sourceId === "sbi-securities" && artifact.dataset === "account-assets-history",
  parse(bytes, artifact) {
    const payload = assetHistoryPayload(JSON.parse(decodeUtf8(bytes)));
    const views = assetHistoryViews(payload.history);
    const observations: Observation[] = [];
    const diagnostics = new ParseDiagnostics();
    const profileCoverage: CoverageClaim[] = [];
    let calendar: string[] | undefined;
    for (const view of views) {
      const root = `${payload.root}.valuationsTransitions${view.suffix}`;
      const scopeKey = `${artifact.sourceId}/${artifact.dataset}/profile=${view.profile}`;
      const startCount = observations.length;
      if (view.transitions === null) {
        diagnostics.note({
          code: "container_unreadable",
          locator: root,
          severity: "warning",
          impact: "membership",
          message: "sbi_asset_history_profile_unavailable",
        });
        profileCoverage.push({
          claimId: `profile:${view.profile}`,
          scopeKey,
          mode: "evidence-only",
          completeness: "unknown",
          membershipComplete: false,
          observedCount: 0,
          expectedCount: null,
          evidenceRefs: [root],
          policyVersion: "coverage-v1",
          failureCause: "container_unreadable",
          absenceMeaning: "not-observed",
        });
        continue;
      }
      const times = validateView(view);
      if (calendar !== undefined && JSON.stringify(times) !== JSON.stringify(calendar))
        throw assetHistoryError("sbi_asset_history_weekly_gap");
      calendar = times;
      for (const time of times) {
        const rows = view.transitions[time]!;
        const asOf = pointDate(time);
        const excluded = Object.fromEntries(
          Object.entries(rows).filter(
            ([category]) =>
              category !== "ALL" && !view.holdCategories.includes(category as AssetHistoryCategory),
          ),
        );
        for (const category of [...view.holdCategories, "ALL"] as const) {
          const point = rows[category]!;
          const locator = `${root}["${time}"].${category}`;
          const pointKey = `sbi-assets-weekly:${view.profile}:${category}:${asOf}`;
          if (point.profitLossRate === null)
            diagnostics.note({
              code: "row_unreadable",
              locator: `${locator}.profitLossRate`,
              severity: "info",
              impact: "field",
              message: "sbi_asset_history_metric_unavailable",
            });
          for (const [field, metric] of MONEY_FIELDS) {
            const value = point[field];
            if (value === null) {
              diagnostics.note({
                code: "row_unreadable",
                locator: `${locator}.${field}`,
                severity: "info",
                impact: "field",
                message: "sbi_asset_history_metric_unavailable",
              });
              continue;
            }
            const observation: ValuationObservation = {
              kind: "valuation",
              sourceAccount: SOURCE_ACCOUNT,
              subject: `portfolio:weekly:${view.profile}:${category}`,
              metric,
              amountMinor: value,
              amountText: String(value),
              amountScale: 0,
              currency: "JPY",
              asOf,
              rawLocator: `${locator}.${field}`,
              extra: {
                ...point,
                _kogane: {
                  profile: view.profile,
                  category,
                  pointKey,
                  role: category === "ALL" ? "aggregate" : "included-category",
                  ...(category !== "ALL"
                    ? {}
                    : {
                        holdCategories: view.holdCategories,
                        residualCategories: excluded,
                        nativeSeries: [
                          `${payload.root}.balances${view.suffix}`,
                          `${payload.root}.acquisitionCosts${view.suffix}`,
                        ],
                      }),
                },
              },
            };
            observations.push(observation);
          }
        }
      }
      profileCoverage.push({
        claimId: `profile:${view.profile}`,
        scopeKey,
        mode: "window",
        completeness: "complete",
        membershipComplete: true,
        observedCount: observations.length - startCount,
        expectedCount: null,
        evidenceRefs: [...new Set([root, `${root}["${times[0]}"]`, `${root}["${times.at(-1)}"]`])],
        policyVersion: "coverage-v1",
        failureCause: null,
        absenceMeaning: "not-applicable",
      });
    }
    return {
      observations,
      warnings: [],
      issues: diagnostics.issues,
      coverage: [
        containerClaim({
          artifact,
          issues: diagnostics.issues,
          observedCount: observations.length,
          evidenceRefs: views.map((view) => `${payload.root}.valuationsTransitions${view.suffix}`),
        }),
        ...profileCoverage,
      ],
    };
  },
};
