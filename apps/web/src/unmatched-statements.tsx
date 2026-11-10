// The カード照合 page's list of card statements without a settlement candidate
// (docs/card-settlements.md, Statements without a candidate). The read is the
// server's (`GET /api/v2/reconciliation/card-statements-unmatched`, the same
// service as `kogane.card-settlements.unmatched`); `getJson` checks its shape
// before it renders, and the page shows each closed reason and the planner's read-only answer, and offers no
// action: no allocation listed here can be accepted.
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type {
  UnmatchedCardStatement,
  UnmatchedCardStatementsReview,
  UnmatchedPlannerAnswer,
} from "../../../packages/application/src/query/card-statements-unmatched.ts";
import { CARD_STATEMENTS_UNMATCHED_PATH } from "../../../packages/observation-shared/src/card-statements-unmatched-contract.ts";
import {
  bankSourceLabel,
  DateValue,
  PageBudgetNote,
  SettlementQuantity,
} from "./reconciliation-display.tsx";
import { Badge, Nullable, QueryBoundary } from "./ui.tsx";

export function useUnmatchedCardStatements(offset: number) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-settlements", "unmatched", offset],
    enabled: features.known && features.cardSettlementReconciliation,
    // getJson checks the shape (`validApiResponse`) before anything renders.
    queryFn: ({ signal }) =>
      getJson<UnmatchedCardStatementsReview>(
        `${CARD_STATEMENTS_UNMATCHED_PATH}?offset=${offset}`,
        signal,
      ),
    retry: false,
  });
}

/** Each closed reason, in words. A code the page does not know is shown as stored. */
const CODES: Record<string, string> = {
  statement_total_refund_or_zero:
    "請求総額が0円以下（返金など）です。返金の割り当ては未対応のため、照合しません。",
  statement_not_comparable:
    "請求総額・引落予定日・対象月のいずれかが確定していないため、照合できません。",
  no_debit_in_window: "引落予定日の前後3日に、取得済みの銀行出金がありません。",
  no_equal_amount_debit:
    "引落予定日の前後3日に出金はありますが、請求総額と同じ金額の出金はありません。",
  equal_amount_debit_awaiting_sweep:
    "同じ金額の出金があります。次回の照合処理（通常5分ごと）で候補が作られます。",
};
const PLANNER_STATUS: Record<string, string> = {
  proposed: "複数の出金の合計が一致",
  needs_review: "組み合わせが一つに決まりません",
  unsupported: "一致する組み合わせはありません",
  refused: "組み合わせを調べられません",
  run_refused: "組み合わせを調べられません",
};
const PLANNER_CODES: Record<string, string> = {
  candidate_not_unique: "一致する組み合わせが複数あります",
  debit_in_other_statement_allocation: "同じ出金を別の請求にも使えます",
  excluded_debit_competes: "重複の疑いがある出金、または日付のない出金も組み合わせに入り得ます",
  no_debit_in_window: "照合できる出金が期間内にありません",
  no_exact_allocation: "3件までのどの組み合わせも請求総額と一致しません",
  in_window_debits_below_total:
    "期間内の出金の合計が請求総額より少ない（一部払いかどうかは判断しません）",
  debit_above_total: "請求総額より大きい出金があります（過払いや複数請求分かどうかは判断しません）",
  input_bound_exceeded: "請求または出金が多すぎるため、組み合わせを調べていません",
  statement_already_allocated: "この請求は採用済みの照合に使われています",
};
const OWNERSHIP: Record<string, string> = {
  "established-same": "保有者一致を確認済み",
  unknown: "保有者は未確認",
  different: "保有者が一致しません",
};
const label = (labels: Record<string, string>, code: string): string =>
  Object.hasOwn(labels, code) ? labels[code]! : code;

function PlannerAnswer({ answer }: { answer: UnmatchedPlannerAnswer }): ReactNode {
  const codes = "codes" in answer ? answer.codes : [answer.code];
  return (
    <div className="unmatched-planner">
      <p>
        <Badge tone="neutral">{label(PLANNER_STATUS, answer.status)}</Badge>
      </p>
      {codes.length > 0 ? (
        <ul>
          {codes.map((code) => (
            <li key={code}>{label(PLANNER_CODES, code)}</li>
          ))}
        </ul>
      ) : null}
      {"allocations" in answer && answer.allocationsTruncated ? (
        // The server lists the first 50 and counts every one (ADR 0074,
        // amendment 2026-11-07): the page says how many it does not show.
        <p className="footnote" role="note">
          {`一致する組み合わせ ${answer.allocationCount.toLocaleString("ja-JP")}件のうち、` +
            `出金の件数が少ない順に先頭の${answer.allocations.length}件を表示しています。`}
        </p>
      ) : null}
      {"allocations" in answer
        ? answer.allocations.map((allocation, index) => (
            <div key={index} className="unmatched-allocation">
              <p className="footnote">
                組み合わせ {index + 1}（{allocation.members.length}件の出金、
                {label(OWNERSHIP, allocation.ownership)}）
              </p>
              <ul>
                {allocation.members.map((member) => (
                  <li key={member.ref.id}>
                    {bankSourceLabel(member.sourceId)} · {member.sourceAccount} ·{" "}
                    <SettlementQuantity value={member.amount} />
                  </li>
                ))}
              </ul>
            </div>
          ))
        : null}
      <p className="footnote">
        複数の出金による支払いはまだ採用できません。表示は確認用で、何も保存しません。
      </p>
    </div>
  );
}

function UnmatchedRow({ item }: { item: UnmatchedCardStatement }): ReactNode {
  const { statement } = item;
  return (
    <li className="unmatched-statement">
      <p>
        <strong>{statement.sourceId === "vpass" ? "Vpass" : "MyJCB"}</strong> · 対象月{" "}
        <Nullable value={statement.period} /> · 請求総額{" "}
        {statement.amount === null ? (
          <Nullable value={null} placeholder="不明" />
        ) : (
          <SettlementQuantity value={statement.amount} />
        )}{" "}
        · 引落予定日{" "}
        {statement.paymentDate === null ? (
          <Nullable value={null} placeholder="不明" />
        ) : (
          <DateValue value={statement.paymentDate} />
        )}
      </p>
      <p>{label(CODES, item.code)}</p>
      {item.planner === null ? null : <PlannerAnswer answer={item.planner} />}
    </li>
  );
}

/** The section under the candidate list. */
export function UnmatchedStatements(): ReactNode {
  const [offset, setOffset] = useState(0);
  const query = useUnmatchedCardStatements(offset);
  return (
    <section className="panel" aria-labelledby="unmatched-statements">
      <div className="panel-head">
        <h2 id="unmatched-statements">照合候補のない請求</h2>
      </div>
      <div className="panel-body">
        <QueryBoundary
          query={query}
          label="照合候補のない請求"
          isEmpty={(data) => data.items.length === 0}
          empty="照合候補のない請求はありません。"
        >
          {(data) => (
            <>
              <ul className="unmatched-list">
                {data.items.map((item) => (
                  <UnmatchedRow key={item.statement.ref.id} item={item} />
                ))}
              </ul>
              <nav className="pagination" aria-label="照合候補のない請求のページ">
                <button
                  className="button"
                  type="button"
                  disabled={offset === 0}
                  onClick={() => setOffset(0)}
                >
                  先頭に戻る
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={data.nextOffset === null}
                  onClick={() =>
                    data.nextOffset === null ? undefined : setOffset(data.nextOffset)
                  }
                >
                  次の請求
                </button>
              </nav>
              <PageBudgetNote nextPage={data.nextPage} list="照合候補のない請求" />
            </>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}
