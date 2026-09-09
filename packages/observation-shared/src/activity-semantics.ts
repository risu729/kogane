/** Layer C display interpretation. Never rewrites B amounts or infers income from a sign. */
export interface ActivityMeaning {
  policyVersion: "activity-meaning-v1";
  kind: "cash_movement" | "card_activity" | "statement_item" | "trade" | "notification" | "unknown";
  label: string;
  amountLabel: string;
  dateLabel: string;
  statusLabel: string;
  direction: "credit" | "debit" | "buy" | "sell" | "unknown";
  reason: string;
  period: string | null;
  settlementDate: string | null;
  quantity: string | null;
  quantityUnit: string | null;
  price: string | null;
  priceUnit: string | null;
}
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;

export function classifyActivity(input: {
  sourceId: string;
  parserName: string;
  status: string | null;
  extra?: unknown;
}): ActivityMeaning {
  const facts = obj(obj(input.extra)._kogane);
  const result: ActivityMeaning = {
    policyVersion: "activity-meaning-v1",
    kind: "unknown",
    label: "種類未判定の記録",
    amountLabel: "記録された金額",
    dateLabel: "記録の基準日",
    statusLabel:
      input.status === "posted"
        ? "履歴に記録"
        : input.status === "confirmed"
          ? "確定（意味は取得元による）"
          : input.status === "unconfirmed"
            ? "未確定"
            : input.status === "declined"
              ? "利用拒否"
              : input.status === "notified"
                ? "利用通知"
                : input.status
                  ? "取得元の状態（詳細参照）"
                  : "状態情報なし",
    direction: "unknown",
    reason:
      "正負だけで収入・支出とは判定しません。履歴への記録は支払い・受渡し完了を保証しません。",
    period: null,
    settlementDate: null,
    quantity: null,
    quantityUnit: null,
    price: null,
    priceUnit: null,
  };
  const key = `${input.sourceId}/${input.parserName}`;
  if (key === "myjcb/myjcb-credit-ledger") {
    result.kind = "statement_item";
    result.label = "クレカ利用・請求明細";
    result.dateLabel = "利用日";
    result.amountLabel =
      facts.amountBasis === "current-statement-payment"
        ? "今回の支払額"
        : facts.amountBasis === "unconfirmed-usage"
          ? "未確定の利用額"
          : "明細の記録額（内訳未判定）";
    result.statusLabel =
      input.status === "confirmed" ? "請求確定（未払い残高とは別）" : result.statusLabel;
    result.period = text(facts.period);
    result.reason =
      "利用日・請求月・口座引落日は別です。今回の支払額は、分割払い等では利用総額と異なります。請求確定は支払い完了を意味しません。";
  } else if (key === "sbi-securities/sbi-yen-detail-history") {
    result.kind = "cash_movement";
    result.label = "預り金の入出金";
    result.dateLabel = "入出金日";
    result.direction =
      facts.direction === "credit" || facts.direction === "debit" ? facts.direction : "unknown";
    result.reason =
      "取得元は正の金額と入金・出金区分を別々に記録します。原額を保持し、方向を別表示します。振替や売買代金を収入・支出に自動分類しません。";
  } else if (
    [
      "sbi-securities/sbi-foreign-trade-records",
      "sbi-securities/sbi-domestic-trade-records",
      "sbi-vc-trade/sbi-vc-executions",
    ].includes(key)
  ) {
    result.kind = "trade";
    result.label = "売買・約定の記録";
    result.dateLabel = "約定日・日時";
    result.amountLabel =
      key === "sbi-securities/sbi-foreign-trade-records" ? "受渡金額" : "売買記録の金額";
    result.reason =
      "売買と現金の入出金は別の記録です。代金を損益とみなしたり、預り金の入出金と二重に合算したりしません。約定は受渡し完了を保証しません。";
    if (key === "sbi-securities/sbi-foreign-trade-records") {
      result.settlementDate = text(facts.valueDate);
      result.quantity = text(facts.quantityText);
    }
    if (key === "sbi-vc-trade/sbi-vc-executions") {
      result.direction =
        facts.direction === "buy" || facts.direction === "sell" ? facts.direction : "unknown";
      result.quantity = text(obj(facts.quantity).text);
      result.quantityUnit = text(obj(facts.quantity).currency);
      result.price = text(obj(facts.price).text);
      result.priceUnit = text(obj(facts.price).currency);
      result.reason +=
        "数量と単価は表示しますが、手数料等が未確定のため掛け算で現金支払額を補いません。";
    }
  } else if (key === "v-point-pay/v-point-pay-notification-event") {
    result.kind = "notification";
    result.label = "プリペイド利用通知";
    result.amountLabel = "通知に記載された金額";
    result.dateLabel = "通知の対象日時";
    result.reason =
      "利用通知であり、最終決済額ではありません。利用拒否の金額未記録をゼロ円の利用として扱いません。";
  } else if (
    [
      "vpass/vpass-statement-page",
      "global-pass/global-pass-activity",
      "sony-bank/sony-bank-wallet-history",
    ].includes(key)
  ) {
    result.kind = "card_activity";
    result.label = "カードの利用・調整明細";
    result.dateLabel = "明細の対象日";
    result.reason =
      "カード利用・返金・調整等の明細で、銀行口座の入出金と同一ではありません。請求や引落しとの対応が確認されるまで重複集計しません。";
  } else if (
    [
      "sony-bank/sony-bank-history-json",
      "sony-bank/sony-bank-history-csv",
      "smbc-bank/smbc-direct-transactions",
      "sbi-shinsei-bank/sbi-shinsei-top-balances-and-activity",
      "sbi-vc-trade/sbi-vc-cashflows",
      "mobile-suica/mobile-suica-sf-history",
    ].includes(key)
  ) {
    result.kind = "cash_movement";
    result.label = "口座・電子マネーの増減記録";
    result.reason =
      "口座内の増減です。振替・チャージ・カード引落しもあり、家計の収入・支出と同一とは限りません。方向が未判定でも原額を保持します。";
  }
  return result;
}

export function validActivityMeaning(value: unknown): value is ActivityMeaning {
  const row = obj(value);
  return (
    row.policyVersion === "activity-meaning-v1" &&
    typeof row.kind === "string" &&
    [
      "cash_movement",
      "card_activity",
      "statement_item",
      "trade",
      "notification",
      "unknown",
    ].includes(row.kind) &&
    typeof row.direction === "string" &&
    ["credit", "debit", "buy", "sell", "unknown"].includes(row.direction) &&
    ["label", "amountLabel", "dateLabel", "statusLabel", "reason"].every(
      (key) => text(row[key]) !== null,
    ) &&
    ["period", "settlementDate", "quantity", "quantityUnit", "price", "priceUnit"].every(
      (key) => row[key] === null || text(row[key]) !== null,
    )
  );
}
