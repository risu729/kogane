import type {
  ArtifactMeta,
  BalanceObservation,
  Parser,
  ParseResult,
  TransactionObservation,
} from "../types.ts";
import { containerClaim } from "./coverage.ts";
import { parseAccountPage, parseHistoryPage, MizuhoParseError } from "./mizuho-html.ts";
import { stableFingerprint } from "./sbi-strict.ts";
import { unitScopeAdmitted } from "./util.ts";

const SOURCE = "mizuho-bank";
const ACCOUNT_DATASET = "mizuho-account-list-html";
const HISTORY_DATASET = "mizuho-ordinary-history-html";
const HISTORY_UNIT = /^ordinary:(\d{3}):(\d{7}):page:([1-9]\d*):([1-9]\d*)$/u;

function requireRun(artifact: ArtifactMeta): void {
  if (
    (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
    !unitScopeAdmitted(artifact)
  ) {
    throw new MizuhoParseError("unsuccessful-fetch-unit");
  }
  const observed = new Date(artifact.fetchedAt);
  if (Number.isNaN(observed.valueOf()) || observed.toISOString() !== artifact.fetchedAt) {
    throw new MizuhoParseError("invalid-observed-at");
  }
}
function html(bytes: Uint8Array): string {
  if (!bytes.byteLength || bytes.byteLength > 1024 * 1024)
    throw new MizuhoParseError("invalid-html-size");
  // The collector persists an explicitly sanitized UTF-8 capture. Never guess
  // between original Shift_JIS and transformed bytes in the observation layer.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MizuhoParseError("invalid-utf8-capture");
  }
}
function amount(amountText: string): {
  amountText: string;
  amountScale: number;
  amountMinor?: number;
} {
  const minor = Number(amountText);
  return {
    amountText,
    amountScale: 0,
    ...(Number.isSafeInteger(minor) ? { amountMinor: minor } : {}),
  };
}
const sourceAccount = (branch: string, account: string): string =>
  `${SOURCE}:ordinary:${branch}:${account}`;

export const mizuhoAccountList: Parser = {
  name: "mizuho-account-list",
  version: "1.0.0",
  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === SOURCE &&
      (artifact.dataset === ACCOUNT_DATASET || artifact.dataset === null) &&
      artifact.mime === "text/html" &&
      artifact.artifactKey === "account-list.html" &&
      artifact.fetchUnitKey === "account-list"
    );
  },
  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    if (!this.accepts(artifact)) throw new MizuhoParseError("invalid-artifact-metadata");
    requireRun(artifact);
    const { accounts } = parseAccountPage(html(bytes));
    const observations: BalanceObservation[] = accounts.flatMap((account) =>
      (["account_balance", "available_balance"] as const).map((metric): BalanceObservation => ({
        kind: "balance",
        sourceAccount: sourceAccount(account.branchCode, account.accountNumber),
        metric,
        ...amount(metric === "account_balance" ? account.balanceYen : account.availableBalanceYen),
        instrument: "JPY",
        asOf: artifact.fetchedAt,
        observedAt: artifact.fetchedAt,
        rawLocator: `html:#${metric === "account_balance" ? "txtCrntBalBrrwBal" : "txtBrrwUsblBal"}_${account.sourceIndex}`,
        extra: {
          accountType: account.accountType,
          branchCode: account.branchCode,
          accountNumber: account.accountNumber,
          branchName: account.branchName,
          _kogane: {
            captureProvenance: "sanitized_provider_capture",
            currency: "JPY",
            identityOrigin: "provider-branch-and-account",
          },
        },
      })),
    );
    return {
      observations,
      warnings: [],
      issues: [],
      coverage: [
        containerClaim({
          artifact,
          issues: [],
          observedCount: accounts.length,
          evidenceRefs: ["html:form[name=BALINQ_03010B]"],
        }),
      ],
    };
  },
};

export const mizuhoOrdinaryHistory: Parser = {
  name: "mizuho-ordinary-history",
  version: "1.0.0",
  accepts(artifact: ArtifactMeta): boolean {
    const unit = HISTORY_UNIT.exec(artifact.fetchUnitKey ?? "");
    return (
      artifact.sourceId === SOURCE &&
      (artifact.dataset === HISTORY_DATASET || artifact.dataset === null) &&
      artifact.mime === "text/html" &&
      unit !== null &&
      artifact.artifactKey === `ordinary/${unit[1]}-${unit[2]}/history/${unit[3]}-${unit[4]}.html`
    );
  },
  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    if (!this.accepts(artifact)) throw new MizuhoParseError("invalid-artifact-metadata");
    requireRun(artifact);
    const unit = HISTORY_UNIT.exec(artifact.fetchUnitKey!)!;
    const result = parseHistoryPage(html(bytes), {
      source: "mizuho",
      accountType: "ordinary-deposit",
      currency: "JPY",
      branchCode: unit[1]!,
      accountNumber: unit[2]!,
    });
    if (
      String(result.displayedRange.from) !== unit[3] ||
      String(result.displayedRange.to) !== unit[4]
    ) {
      throw new MizuhoParseError("artifact-page-range-mismatch");
    }
    const account = sourceAccount(result.branchCode, result.accountNumber);
    const occurrences = new Map<string, number>();
    const observations: TransactionObservation[] = result.transactions.map((transaction) => {
      const fingerprint = stableFingerprint({
        account,
        date: transaction.date,
        description: transaction.description,
        amountYen: transaction.amountYen,
        balanceAfterYen: transaction.balanceAfterYen,
      });
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      return {
        kind: "transaction",
        sourceAccount: account,
        externalId: `${SOURCE}:${fingerprint}:${occurrence}`,
        status: "posted",
        ...amount(transaction.amountYen),
        currency: "JPY",
        description: transaction.description,
        asOf: `${transaction.date}T00:00:00+09:00`,
        observedAt: artifact.fetchedAt,
        rawLocator: `html:#txtTransCntnt_${transaction.sourceIndex}`,
        extra: {
          balanceAfterYen: transaction.balanceAfterYen,
          displayedRange: result.displayedRange,
          _kogane: {
            captureProvenance: "sanitized_provider_capture",
            amountSignSource: "provider-signed",
            identityOrigin: "provider-fields-and-occurrence",
            duplicateOccurrenceScope: "observed-page",
            crossPageDuplicateIdentity: "unproven",
            coverageScope: "observed-page-only",
            hasMore: result.hasMore,
          },
        },
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
          observedCount: result.transactions.length,
          expectedCount: result.displayedRange.to - result.displayedRange.from + 1,
          evidenceRefs: ["html:#txtDispDetails", "html:#txtAllDispDetails"],
        }),
      ],
    };
  },
};
