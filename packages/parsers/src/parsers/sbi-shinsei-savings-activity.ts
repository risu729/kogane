import type { ArtifactMeta, Parser, TransactionObservation } from "../types.ts";
import { inspectSavingsPeriod, validateSavingsScope } from "../sbi-shinsei-period-contract.ts";
import { containerClaim } from "./coverage.ts";
import {
  acceptsSbiShinseiDataset,
  assertSuccessfulRun,
  compactDate,
  decimal,
  exactObject,
  providerExtra,
} from "./sbi-shinsei-common.ts";
import { decimalToMinorUnits, decodeUtf8, minorUnitExponent } from "./util.ts";

export const sbiShinseiSavingsActivity: Parser = {
  name: "sbi-shinsei-savings-activity",
  version: "0.1.0",
  accepts: (artifact: ArtifactMeta) => acceptsSbiShinseiDataset(artifact, "savings-activity"),
  parse(bytes, artifact) {
    assertSuccessfulRun(artifact);
    const root = exactObject(
      JSON.parse(decodeUtf8(bytes)),
      "history",
      ["schema", "scope", "response"],
      ["schema", "scope", "response"],
    );
    if (root.schema !== "sbi-shinsei-savings-activity-v1")
      throw new Error("history_schema_invalid");
    const scope = validateSavingsScope(root.scope);
    const result = inspectSavingsPeriod(root.response, scope);
    const observations: TransactionObservation[] = result.rows.map((row, index) => {
      const field = row.debit === "" ? "credit" : "debit";
      const unsigned = decimal(row[field], "history");
      const amountText =
        field === "debit" && !/^0(?:\.0+)?$/u.test(unsigned.text)
          ? `-${unsigned.text}`
          : unsigned.text;
      const amountMinor = decimalToMinorUnits(amountText, scope.currency);
      if (minorUnitExponent(scope.currency) !== undefined && amountMinor === undefined)
        throw new Error("history_amount_invalid");
      return {
        kind: "transaction",
        sourceAccount: `sbi-shinsei:${scope.accountNo}`,
        externalId: row.txnReferenceNo,
        ...(amountMinor === undefined ? {} : { amountMinor }),
        amountText,
        amountScale: unsigned.scale,
        currency: scope.currency,
        description: row.description,
        asOf: compactDate(row.postingDate, "history"),
        rawLocator: `json:$.response.responseParam.activity.responseParam.activityDetails[${index}]`,
        extra: providerExtra(
          row as unknown as Record<string, unknown>,
          scope as unknown as Record<string, unknown>,
          {
            sourceView: "historical",
            amountSignSource: field,
            identityOrigin: "provider-id",
            rowBalanceDisposition: "preserved_provider_value_semantics_unverified",
            productCode: scope.productCode,
          },
        ),
      };
    });
    return {
      observations,
      warnings: [],
      issues: [],
      coverage: [
        containerClaim({
          artifact,
          issues: [],
          observedCount: observations.length,
          evidenceRefs: [
            "json:$.scope",
            "json:$.response.responseParam.activity.responseParam.activityDetails",
          ],
        }),
      ],
    };
  },
};
