import type { ReactNode } from "react";
import { classifyBalance, type BalanceSemantic } from "../../shared/balance-semantics.ts";
import type { BalanceRow } from "./api.ts";
import { ObservationLink } from "./ui.tsx";
import "./balance-display.css";

export function balanceMeaning(row: BalanceRow): BalanceSemantic {
  return (
    row.interpretation?.semantic ??
    classifyBalance({
      sourceId: row.source_id,
      sourceAccount: row.source_account,
      metric: row.metric,
      parserName: row.parser.includes("@")
        ? row.parser.slice(0, row.parser.lastIndexOf("@"))
        : row.parser,
    })
  );
}

export const BALANCE_GROUPS = [
  {
    id: "assets",
    title: "預金・資産の残高",
    kinds: ["asset"],
    note: "各記録の時点の残高です。時点や通貨が異なるため、純資産として合算していません。",
  },
  {
    id: "liabilities",
    title: "負債残高",
    kinds: ["liability"],
    note: "負債として確認された残高です。表示の符号は元の記録のままです。",
  },
  {
    id: "statements",
    title: "請求額（未払残高ではありません）",
    kinds: ["statement"],
    note: "請求月の支払額です。支払済みか未払いかはこの記録だけでは分かりません。資産にも負債にも加算しません。",
  },
  {
    id: "reference",
    title: "集計・参考額・その他",
    kinds: ["aggregate", "other"],
    note: "区分集計、余力、ポイントなどの参考情報です。個別残高と重なる場合や意味が未確認の場合があるため、資産額に加算しません。",
  },
] as const;

export function BalanceEvidence({ row }: { row: BalanceRow }): ReactNode {
  const interpretation = row.interpretation;
  if (!interpretation) return null;
  return (
    <>
      {interpretation.conflict ? (
        <div className="table-secondary balance-conflict">
          同じ残高の候補で金額・根拠が一致していません。各記録を別々に表示しています。
        </div>
      ) : null}
      {interpretation.duplicateCount > 0 ? (
        <details className="balance-evidence">
          <summary>同じ残高の根拠{interpretation.evidence.length}件</summary>
          <ul>
            {interpretation.evidence.map((evidence) => (
              <li key={evidence.id}>
                <ObservationLink kind="balance" id={evidence.id}>
                  記録 #{evidence.id}
                </ObservationLink>{" "}
                <span className="table-secondary">{evidence.metric}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
