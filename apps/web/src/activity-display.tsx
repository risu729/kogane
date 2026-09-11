import type { ReactNode } from "react";
import type { TransactionRow } from "./api.ts";
import {
  classifyActivity,
  type ActivityMeaning,
} from "../../../packages/observation-shared/src/activity-semantics.ts";

export function activityMeaning(row: TransactionRow): ActivityMeaning {
  return (
    row.interpretation ??
    classifyActivity({
      sourceId: row.source_id,
      parserName: row.parser.split("@")[0]!,
      status: row.status,
    })
  );
}
export function ActivityFacts({ meaning }: { meaning: ActivityMeaning }): ReactNode {
  const directions = {
    credit: "入金",
    debit: "出金",
    buy: "買い",
    sell: "売り",
    unknown: "方向未判定",
  };
  return (
    <div className="table-secondary">
      <div>
        {meaning.label} · {directions[meaning.direction]}
      </div>
      {meaning.period ? <div>明細の期間表示: {meaning.period}</div> : null}
      {meaning.settlementDate ? <div>受渡日: {meaning.settlementDate}</div> : null}
      {meaning.quantity ? (
        <div>
          数量: {meaning.quantity} {meaning.quantityUnit}
        </div>
      ) : null}
      {meaning.price ? (
        <div>
          単価: {meaning.price} {meaning.priceUnit}
        </div>
      ) : null}
      <details>
        <summary>この記録の意味</summary>
        <p>{meaning.reason}</p>
        <p>解釈の版: {meaning.policyVersion}</p>
      </details>
    </div>
  );
}
