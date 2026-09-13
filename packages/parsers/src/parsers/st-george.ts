import { parseStGeorgeSnapshot, stGeorgeDate, stGeorgeMinor } from "../st-george-contract.ts";
import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { decodeUtf8, unitScopeAdmitted } from "./util.ts";
import { containerClaim } from "./coverage.ts";
import { stableFingerprint } from "./sbi-strict.ts";

function amount(value: string) {
  const amountMinor = stGeorgeMinor(value);
  const digits = (amountMinor < 0 ? -BigInt(amountMinor) : BigInt(amountMinor))
    .toString()
    .padStart(3, "0");
  return {
    amountMinor,
    amountText: (amountMinor < 0 ? "-" : "") + digits.slice(0, -2) + "." + digits.slice(-2),
    amountScale: 2,
  };
}

function inputSnapshot(bytes: Uint8Array) {
  try {
    return parseStGeorgeSnapshot(JSON.parse(decodeUtf8(bytes)));
  } catch {
    // JSON decoder errors may include provider text; return only a fixed code.
    throw new Error("invalid-st-george-snapshot");
  }
}

function createParser(kind: "balance" | "transaction"): Parser {
  return {
    name: kind === "balance" ? "st-george-balances" : "st-george-transactions",
    version: "1.0.0",
    accepts(artifact: ArtifactMeta) {
      return (
        artifact.sourceId === "st-george" &&
        artifact.dataset === "account-snapshot" &&
        artifact.artifactKey === "account-snapshot.json" &&
        artifact.mime === "application/json"
      );
    },
    parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
      if (
        !this.accepts(artifact) ||
        (!(artifact.runStatus === "success" && artifact.runFailureCount === 0) &&
          !unitScopeAdmitted(artifact)) ||
        bytes.length > 4 * 1024 * 1024
      ) {
        throw new Error("invalid-st-george-artifact");
      }
      const snapshot = inputSnapshot(bytes);
      const observations: Observation[] = [];
      for (const [index, account] of snapshot.accounts.entries()) {
        const sourceAccount = "st-george:" + account.accountKey;
        const rawLocator = "json:$.accounts[" + index + "]";
        const provenance = {
          label: account.label,
          currencyEvidence: snapshot.currencyEvidence,
          accountIdentity: "sha256-normalized-bsb-account",
          historyState: account.historyState,
          pendingState: account.pendingState,
        };
        for (const [metric, field] of [
          ["account_balance", "currentBalanceText"],
          ["available_balance", "availableBalanceText"],
        ] as const) {
          observations.push({
            kind: "balance",
            sourceAccount,
            metric,
            ...amount(account[field]),
            instrument: "AUD",
            asOf: snapshot.observedAt,
            observedAt: snapshot.observedAt,
            rawLocator: rawLocator + "." + field,
            extra: { sourceAmountText: account[field], _kogane: provenance },
          });
        }
        const occurrences = new Map<string, number>();
        for (const [rowIndex, row] of account.transactions.entries()) {
          const unsigned = amount(row.debitText || row.creditText);
          const signed = row.debitText ? -unsigned.amountMinor : unsigned.amountMinor;
          const date = stGeorgeDate(row.dateText);
          const fingerprint = stableFingerprint({
            date,
            direction: row.debitText ? "debit" : "credit",
            amountMinor: signed,
            currency: "AUD",
            description: row.description,
            category: row.category,
            balanceAfterMinor: stGeorgeMinor(row.balanceText),
          });
          const occurrence = occurrences.get(fingerprint) ?? 0;
          occurrences.set(fingerprint, occurrence + 1);
          observations.push({
            kind: "transaction",
            sourceAccount,
            externalId: "st-george-derived:" + fingerprint + ":" + occurrence,
            ...amount((signed < 0 ? "-" : "") + unsigned.amountText),
            currency: "AUD",
            description: row.description,
            asOf: date,
            observedAt: snapshot.observedAt,
            rawLocator: rawLocator + ".transactions[" + rowIndex + "]",
            // No provider ID or explicit posted marker was observed. This
            // derived identity prevents repeat captures duplicating unchanged rows.
            extra: {
              ...row,
              balanceAfterMinor: stGeorgeMinor(row.balanceText),
              openingBalanceText: account.openingBalanceText,
              closingBalanceText: account.closingBalanceText,
              _kogane: {
                ...provenance,
                direction: row.debitText ? "outflow" : "inflow",
                amountSignSource: "debit-credit-column",
                identityOrigin: "derived-normalized-row+occurrence",
              },
            },
          });
        }
      }
      const selected = observations.filter((observation) => observation.kind === kind);
      return {
        observations: selected,
        warnings:
          kind === "balance"
            ? []
            : [
                "This account projection has unverified history coverage and pending rows; AUD is source configured.",
              ],
        issues: [],
        coverage:
          kind === "balance"
            ? [
                containerClaim({
                  artifact,
                  issues: [],
                  observedCount: selected.length,
                  expectedCount: snapshot.accounts.length * 2,
                  evidenceRefs: ["json:$.accounts"],
                }),
              ]
            : [
                {
                  claimId: "st-george-account-projection",
                  scopeKey: "st-george/account-snapshot",
                  mode: "evidence-only",
                  completeness: "partial",
                  membershipComplete: false,
                  observedCount: selected.length,
                  expectedCount: null,
                  evidenceRefs: ["json:$.accounts"],
                  policyVersion: "coverage-v1",
                  failureCause: null,
                  absenceMeaning: selected.length > 0 ? "not-applicable" : "unknown",
                },
              ],
      };
    },
  };
}

export const stGeorgeBalances = createParser("balance");
export const stGeorgeTransactions = createParser("transaction");
