import type { CoverageClaim } from "../../../domain/src/coverage.ts";
import type { Observation, Parser, ValuationObservation } from "../types.ts";
import { containerClaim, ParseDiagnostics } from "./coverage.ts";
import { decodeUtf8 } from "./util.ts";
import { validateAssetHistory, assetHistoryPointDate } from "./sbi-asset-history-validation.ts";
import { parseAssetHistoryJson } from "./sbi-asset-history-json.ts";
import { assetHistoryPayload, type AssetHistoryCategory } from "./sbi-asset-history-schema.ts";

const SOURCE_ACCOUNT = "sbi-securities:account-assets";
const MONEY_FIELDS = [
  ["valuation", "valuation"],
  ["acquisitionCost", "acquisition_cost"],
  ["profitLoss", "profit_loss"],
] as const;

export const sbiAccountAssetsHistory: Parser = {
  name: "sbi-account-assets-history",
  version: "0.1.1",
  accepts: (artifact) =>
    artifact.sourceId === "sbi-securities" && artifact.dataset === "account-assets-history",
  parse(bytes, artifact) {
    const payload = assetHistoryPayload(parseAssetHistoryJson(decodeUtf8(bytes)));
    const views = validateAssetHistory(payload.history);
    const observations: Observation[] = [];
    const diagnostics = new ParseDiagnostics();
    const profileCoverage: CoverageClaim[] = [];
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
      const times = Object.keys(view.transitions).sort();
      for (const time of times) {
        const rows = view.transitions[time]!;
        const asOf = assetHistoryPointDate(time);
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
