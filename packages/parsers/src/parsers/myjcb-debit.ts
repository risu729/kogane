import { parse } from "parse5";
import {
  readMyJcbDebitPage,
  myJcbDebitOtherIsEmpty,
} from "../../../domain/src/myjcb-debit-page.ts";
import type { Parser } from "../types.ts";
import { normalizedDate, stableFingerprint } from "./sbi-strict.ts";
import { decodeUtf8, unitScopeAdmitted } from "./util.ts";

const KEY = /^([a-z0-9][a-z0-9-]{0,63})\/debit-detail-(0[0-9]|1[0-4])\.html$/u;

export const myJcbDebitLedger: Parser = {
  name: "myjcb-debit-ledger",
  version: "1.0.0",
  accepts: (a) => a.sourceId === "myjcb" && a.dataset === "debit-detail" && a.mime === "text/html",
  parse(bytes, artifact) {
    const connection = KEY.exec(artifact.artifactKey ?? "")?.[1];
    if (
      !connection ||
      artifact.statementState !== "debit" ||
      (artifact.fetchUnitKey != null && artifact.fetchUnitKey !== connection) ||
      ((artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
        !unitScopeAdmitted(artifact))
    )
      throw new Error("myjcb_debit_metadata_unsupported");
    const rows = readMyJcbDebitPage(parse(decodeUtf8(bytes)));
    const occurrences = new Map<string, number>();
    const observations = rows.map((row) => {
      const date = normalizedDate(row.cells[1]!.replaceAll("/", "-"), "debit date");
      const providerAmount = BigInt(row.cells[3]!.replaceAll(",", ""));
      const fingerprint = stableFingerprint({ section: row.section, cells: row.cells });
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      return {
        kind: "transaction" as const,
        sourceAccount: `myjcb:${connection}:root`,
        externalId: `myjcb-debit:${row.section}:${fingerprint}:${occurrence}`,
        status: row.section === "ordinary" ? "transferred" : "銀行振替済",
        amountText: (-providerAmount).toString(),
        amountScale: 0,
        currency: "JPY",
        counterparty: row.cells[2]!,
        description: row.cells[4]!,
        asOf: date,
        observedAt: artifact.fetchedAt,
        rawLocator: row.locator,
        extra: {
          section: row.section,
          cells: [...row.cells],
          _kogane: {
            canonicalDataset: "debit-detail",
            statementState: "debit",
            providerStatus: row.section === "difference" ? row.cells[5] : null,
            amountBasis: row.section === "ordinary" ? "debit-transfer" : "debit-difference",
            providerAmountSign: "debit-positive-refund-negative",
            observationSign: "outflow-negative-inflow-positive",
            reconciliation: "unconfirmed",
          },
        },
      };
    });
    return { observations, warnings: [] };
  },
};

export const myJcbDebitOtherStatement: Parser = {
  name: "myjcb-debit-other-statement",
  version: "1.0.0",
  accepts: (a) =>
    a.sourceId === "myjcb" && a.dataset === "debit-other-detail" && a.mime === "text/html",
  parse(bytes, artifact) {
    const connection =
      /^([a-z0-9][a-z0-9-]{0,63})\/debit-other-detail-(0[1-9]|1[0-4])\.html$/u.exec(
        artifact.artifactKey ?? "",
      )?.[1];
    if (
      !connection ||
      (artifact.fetchUnitKey != null && artifact.fetchUnitKey !== `${connection}:debit-other`) ||
      ((artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
        !unitScopeAdmitted(artifact))
    )
      throw new Error("myjcb_debit_other_metadata_unsupported");
    if (!myJcbDebitOtherIsEmpty(parse(decodeUtf8(bytes))))
      throw new Error("myjcb_debit_other_nonempty_unsupported");
    return { observations: [], warnings: [] };
  },
};
