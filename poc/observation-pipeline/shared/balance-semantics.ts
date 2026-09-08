import { validFinancialProductClaim, type FinancialProductClaim } from "./financial-products";

export interface BalanceSemantic {
  kind: "asset" | "liability" | "statement" | "aggregate" | "other";
  label: string;
  netAssetEligible: false;
  reason: string;
}
export interface BalanceSemanticInput {
  sourceId: string;
  parserName: string | null;
  metric: string;
  sourceAccount: string;
}
/** No observation is summable before a reconciler establishes a complete, non-overlapping universe. */
export function classifyBalance(input: BalanceSemanticInput): BalanceSemantic {
  const result = (
    kind: BalanceSemantic["kind"],
    label: string,
    reason: string,
  ): BalanceSemantic => ({ kind, label, netAssetEligible: false, reason });
  const matches = (source: string, parser: string, metrics: string[]) =>
    input.sourceId === source && input.parserName === parser && metrics.includes(input.metric);
  if (matches("myjcb", "myjcb-credit-past-month-balances", ["credit_statement_payment_amount"]))
    return result(
      "statement",
      "請求額",
      "請求月の支払額です。支払済みか未払いかを証明しないため、負債残高には加算しません。",
    );
  if (
    matches("sony-bank", "sony-bank-gross-balance", ["gross_asset_balance", "gross_loan_balance"])
  )
    return result(
      "aggregate",
      input.metric === "gross_loan_balance" ? "借入区分集計" : "資産区分集計",
      "商品別の個別残高と重なる取得元の区分集計です。純資産には自動加算しません。",
    );
  if (matches("v-point", "v-point-smfg-point", ["displayed_point_balance"]))
    return result(
      "aggregate",
      "表示ポイント合計",
      "別のポイント内訳と重なる可能性がある表示合計です。",
    );
  if (matches("v-point", "v-point-balance-info", ["available_point_bucket"]))
    return result(
      "other",
      "利用可能ポイント",
      "ポイント単位の内訳であり、通貨建ての資産額ではありません。",
    );
  if (matches("v-point-pay", "v-point-pay-notification-event", ["prepaid_balance_after_event"]))
    return result(
      "other",
      "通知時のプリペイド残高",
      "通知に記載された残高です。最終決済や現在残高を保証しません。",
    );
  const deposit =
    matches("sbi-shinsei-bank", "sbi-shinsei-yen-deposit-account", [
      "yen_deposit_account_balance",
      "yen_deposit_savings_balance",
    ]) ||
    matches("sbi-shinsei-bank", "sbi-shinsei-top-balances-and-activity", [
      "account_balance",
      "activity_current_balance",
    ]) ||
    matches("smbc-bank", "smbc-direct-balance", ["account_balance"]) ||
    matches("sony-bank", "sony-bank-history-json", ["available_after_transaction"]) ||
    matches("sony-bank", "sony-bank-history-csv", ["available_after_transaction"]);
  if (deposit)
    return result(
      "asset",
      "預金残高",
      "取得元が示した時点の預金残高です。異なる時点や重複する表示を合計しません。",
    );
  if (
    matches("mobile-suica", "mobile-suica-sf-history", ["sf_balance_after_transaction"]) &&
    input.sourceAccount === "mobile-suica:sf"
  )
    return result(
      "asset",
      "SF残高",
      "取引後の電子マネー残高です。定期券や現在残高の証明ではありません。",
    );
  if (
    matches("sbi-vc-trade", "sbi-vc-cash-balances", ["cash_balance"]) ||
    matches("sbi-vc-trade", "sbi-vc-cashflows", ["cash_balance_after_cashflow"])
  )
    return result(
      "asset",
      "取引所現金残高",
      "取得元が報告した現金残高です。証拠金や決済内訳と重複加算しません。",
    );
  if (matches("sbi-securities", "sbi-foreign-cash-balances", ["keep_cash"]))
    return result(
      "asset",
      "外貨預り金",
      "取得元の預り金です。買付余力・振替可能額とは区別します。",
    );
  if (input.sourceId === "sbi-securities" && input.parserName === "sbi-foreign-cash-balances")
    return result(
      "other",
      "余力・決済関連額",
      "買付・振替の可能額や決済関連の項目であり、独立した資産として加算しません。",
    );
  if (
    input.sourceId === "sbi-vc-trade" &&
    ["sbi-vc-account-margin", "sbi-vc-cash-balances"].includes(input.parserName ?? "")
  )
    return result(
      "other",
      "証拠金・決済関連額",
      "証拠金・制限・決済内訳は独立した残高として自動加算しません。",
    );
  // MoneyForward, Vpass, GLOBAL PASS and unknown/new metrics have no generic asset inference.
  return result(
    "other",
    "その他の観測額",
    "この項目の資産・負債としての意味は未確認です。純資産には加算しません。",
  );
}

export interface BalanceProjectionInput extends BalanceSemanticInput {
  id: number;
  accountReference: string | null;
  accountTarget: string | null;
  currency: string;
  amountText: string | null;
  amountMinor: string | null;
  artifactId: number | null;
  parseRunId: number | null;
  rawLocator: string | null;
  asOf: string | null;
  observedAt: string | null;
  product: FinancialProductClaim | null;
}
export interface BalanceEvidenceRef {
  id: number;
  artifactId: number | null;
  parseRunId: number | null;
  rawLocator: string | null;
  metric: string;
}
export interface BalanceProjectionGroup<T extends BalanceProjectionInput> {
  representative: T;
  members: T[];
  evidence: BalanceEvidenceRef[];
  duplicateCount: number;
  conflict: boolean;
}
export interface BalanceInterpretation {
  policyVersion: "balance-view-v1";
  semantic: BalanceSemantic;
  evidence: Array<{ id: number; metric: string }>;
  duplicateCount: number;
  conflict: boolean;
}
export const BALANCE_INTERPRETATION_POLICY_VERSION = "balance-view-v1";
export function validBalanceInterpretation(value: unknown): value is BalanceInterpretation {
  const object = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const text = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= max;
  const row = object(value);
  const semantic = object(row.semantic);
  if (
    row.policyVersion !== BALANCE_INTERPRETATION_POLICY_VERSION ||
    typeof row.conflict !== "boolean" ||
    semantic.netAssetEligible !== false ||
    typeof semantic.kind !== "string" ||
    !["asset", "liability", "statement", "aggregate", "other"].includes(semantic.kind) ||
    !text(semantic.label, 128) ||
    !text(semantic.reason, 1000) ||
    !Array.isArray(row.evidence) ||
    row.evidence.length < 1 ||
    row.evidence.length > 2 ||
    row.duplicateCount !== row.evidence.length - 1 ||
    (row.conflict && row.duplicateCount !== 0)
  )
    return false;
  const ids = new Set<number>();
  for (const item of row.evidence) {
    const ref = object(item);
    if (
      typeof ref.id !== "number" ||
      !Number.isSafeInteger(ref.id) ||
      ref.id < 1 ||
      ids.has(ref.id) ||
      !text(ref.metric, 128)
    )
      return false;
    ids.add(ref.id);
  }
  return true;
}
/** Same currency uses its exact provider minor-unit integer; raw text must also agree. */
function amountKey(row: BalanceProjectionInput): string | null {
  if (
    typeof row.amountMinor !== "string" ||
    row.amountMinor.length > 128 ||
    !/^-?\d+$/u.test(row.amountMinor)
  )
    return null;
  if (
    row.amountText !== null &&
    (typeof row.amountText !== "string" || row.amountText.length > 128)
  )
    return null;
  return JSON.stringify([BigInt(row.amountMinor).toString(), row.amountText]);
}
function candidateKey(row: BalanceProjectionInput): string | null {
  if (
    row.sourceId !== "sbi-shinsei-bank" ||
    row.parserName !== "sbi-shinsei-yen-deposit-account" ||
    !["yen_deposit_account_balance", "yen_deposit_savings_balance"].includes(row.metric) ||
    !row.accountReference ||
    row.accountReference.length > 512 ||
    !row.asOf ||
    !row.product ||
    !validFinancialProductClaim(row.product) ||
    row.product.status !== "identified"
  )
    return null;
  const origin = row.product.origin;
  if (
    origin.kind !== "balance" ||
    origin.id !== row.id ||
    origin.artifactId !== row.artifactId ||
    origin.parseRunId !== row.parseRunId ||
    origin.rawLocator !== row.rawLocator ||
    origin.parserName !== row.parserName ||
    origin.asOf !== row.asOf ||
    origin.observedAt !== row.observedAt ||
    row.product.nativeCurrency !== row.currency ||
    row.product.institution?.id !== row.sourceId
  )
    return null;
  const section =
    row.metric === "yen_deposit_account_balance" ? "debitAccountDetails" : "savingsDetails";
  if (!row.rawLocator?.startsWith(`json:$.responseParam.${section}[`)) return null;
  if (row.accountTarget !== null && (!row.accountTarget || row.accountTarget.length > 512))
    return null;
  return JSON.stringify([
    row.sourceId,
    row.parserName,
    row.sourceAccount,
    row.accountReference,
    row.accountTarget,
    row.currency,
    row.artifactId,
    row.parseRunId,
    row.asOf,
    row.observedAt,
    row.product.productId,
  ]);
}
/** Project a bounded complete candidate set before pagination; original B rows are never changed. */
export function projectBalanceRows<T extends BalanceProjectionInput>(
  rows: readonly T[],
): BalanceProjectionGroup<T>[] {
  if (rows.length > 10000) throw new Error("balance_projection_row_limit");
  const result: BalanceProjectionGroup<T>[] = rows.map((row) => ({
    representative: row,
    members: [row],
    evidence: [
      {
        id: row.id,
        artifactId: row.artifactId,
        parseRunId: row.parseRunId,
        rawLocator: row.rawLocator,
        metric: row.metric,
      },
    ],
    duplicateCount: 0,
    conflict: false,
  }));
  const candidates = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    const key = candidateKey(row);
    if (key !== null) {
      const indexes = candidates.get(key) ?? [];
      indexes.push(index);
      candidates.set(key, indexes);
    }
  }
  const removed = new Set<number>();
  for (const indexes of candidates.values()) {
    if (indexes.length < 2 || new Set(indexes.map((i) => rows[i]!.metric)).size !== 2) continue;
    const amounts = indexes.map((i) => amountKey(rows[i]!));
    if (
      amounts.some((v) => v === null) ||
      new Set(amounts).size !== 1 ||
      indexes.length !== 2 ||
      new Set(indexes.map((i) => rows[i]!.id)).size !== indexes.length
    ) {
      for (const index of indexes) result[index]!.conflict = true;
      continue;
    }
    const first = indexes[0]!;
    const second = indexes[1]!;
    result[first]!.evidence.push(...result[second]!.evidence);
    result[first]!.members.push(...result[second]!.members);
    result[first]!.duplicateCount = 1;
    removed.add(second);
  }
  return result.filter((_, index) => !removed.has(index));
}
