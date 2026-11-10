import {
  readJPointHistory,
  jpointExpiry,
  jpointHistoryFailure,
} from "../../../domain/src/myjcb-jpoint-history.ts";
import type { BalanceObservation, Parser } from "../types.ts";
import { containerScopeKey, COVERAGE_POLICY_VERSION } from "./coverage.ts";
import { decodeUtf8, unitScopeAdmitted } from "./util.ts";
import { JPOINT_HISTORY_HTML_VERSION } from "./myjcb-jpoint-history-html.ts";
import { monthPeriod } from "../../../domain/src/time.ts";

const KEY = /^([a-z0-9][a-z0-9-]{0,63})\/jpoint-history\.json$/u;
export const myJcbJPointHistory: Parser = {
  name: "myjcb-jpoint-history",
  version: "1.0.0",
  accepts: (a) =>
    a.sourceId === "myjcb" && a.dataset === "jpoint-history" && a.mime === "application/json",
  parse(bytes, artifact) {
    if (!myJcbJPointHistory.accepts(artifact) || bytes.byteLength > 1024 * 1024)
      return jpointHistoryFailure("metadata_unsupported");
    const connection = KEY.exec(artifact.artifactKey ?? "")?.[1];
    if (
      !connection ||
      artifact.fetchUnitKey !== `${connection}:j-point-history` ||
      artifact.statementState != null ||
      artifact.period != null ||
      artifact.url !== null ||
      ((artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
        !unitScopeAdmitted(artifact))
    )
      return jpointHistoryFailure("unit_ineligible");
    let data: unknown;
    try {
      data = JSON.parse(decodeUtf8(bytes));
    } catch {
      return jpointHistoryFailure("json_invalid");
    }
    const history = readJPointHistory(data);
    const observations: BalanceObservation[] = [];
    history.rows.forEach((row, index) => {
      const sourceAccount = `myjcb:${connection}:j-point:acquired:${row.acquiredOn}`;
      for (const metric of ["earned", "used", "expired", "remaining"] as const) {
        observations.push({
          kind: "balance",
          sourceAccount,
          metric: `jpoint_acquisition_${metric}`,
          amountText: row[metric],
          amountScale: 0,
          instrument: "J_POINT",
          observedAt: artifact.fetchedAt,
          rawLocator: `json:$.rows[${index}].${metric}`,
          extra: {
            row,
            _kogane: {
              sourceView: "point-history-acquisition-month",
              normalizerVersion: JPOINT_HISTORY_HTML_VERSION,
              acquisitionDate: row.acquiredOn,
              paymentMonthText: row.paymentText,
              amountBasis:
                metric === "remaining"
                  ? "acquisition-bucket-stock"
                  : "provider-monthly-activity-total",
              reportedHistoryTotal: history.reportedTotal,
              historyBucketCount: history.rows.length,
              jpointHoldingSourceAccount: `myjcb:${connection}:j-point:total`,
              observedExpiry: jpointExpiry(row),
              ...(metric === "remaining"
                ? {}
                : {
                    activityPeriod: monthPeriod(
                      Number(row.acquiredOn.slice(0, 4)),
                      Number(row.acquiredOn.slice(5, 7)),
                      "Asia/Tokyo",
                    ),
                  }),
            },
          },
        });
      }
    });
    return {
      observations,
      warnings: [],
      issues: [],
      coverage: [
        {
          claimId: `container:${containerScopeKey(artifact)}`,
          scopeKey: containerScopeKey(artifact),
          mode: "complete-container",
          completeness: "complete",
          membershipComplete: true,
          observedCount: observations.length,
          expectedCount: observations.length,
          evidenceRefs: ["json:$.rows", "json:$.reportedTotal"],
          policyVersion: COVERAGE_POLICY_VERSION,
          failureCause: null,
          absenceMeaning: "not-applicable",
        },
      ],
    };
  },
};
