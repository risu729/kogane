// The カード照合 page's `次回の引落` section (docs/card-settlements.md, Upcoming
// bills; ADR 0114's 2026-11-19 amendment). The read is the server's
// (`GET /api/v2/reconciliation/card-debit-accounts?view=upcoming`, the same
// service as `kogane.card-settlements.debit-accounts` with `view: "upcoming"`);
// `getJson` checks its shape before it renders, and the page shows the
// server's bills, lines and `covers` as they are: it adds and compares
// nothing, and it offers no action.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type { UpcomingCardBillsReview } from "../../../packages/application/src/query/card-upcoming-bills.ts";
import type {
  CompactQuantity,
  UpcomingDebitAccountLine,
} from "../../../packages/domain/src/card-upcoming-bills.ts";
import { CARD_DEBIT_ACCOUNTS_PATH } from "../../../packages/observation-shared/src/card-debit-accounts-contract.ts";
import { bankSourceLabel } from "./reconciliation-display.tsx";
import { Badge, Nullable, QueryBoundary } from "./ui.tsx";

export function useUpcomingCardBills() {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-settlements", "debit-accounts", "upcoming"],
    enabled: features.known && features.cardSettlementReconciliation,
    // getJson checks the shape (`validApiResponse`) before anything renders.
    queryFn: ({ signal }) =>
      getJson<UpcomingCardBillsReview>(`${CARD_DEBIT_ACCOUNTS_PATH}?view=upcoming`, signal),
    retry: false,
  });
}

/** Each closed code, in words. A code the page does not know is shown as stored. */
const COVERS_REASONS: Record<string, string> = {
  debit_account_unknown: "引落口座が分かりません。",
  bill_not_exact: "請求額が確定していない請求があります。",
  balance_not_exact: "口座の残高が分かりません。",
  balance_before_previous_debit:
    "残高は前回の引落より前に取得したもので、その引落を含まない可能性があります。",
  cards_with_unknown_account:
    "引落口座が分からないカードの請求が、この口座から引き落とされる可能性があります。",
};
const NOT_LISTED_REASONS: Record<string, string> = {
  no_statement: "請求がありません",
  payment_date_not_published: "カード会社が引落日を示していません",
  no_statement_due: "これから引き落とされる請求はありません",
  statement_settled: "最新の請求は採用済みの照合で支払済みです",
};
const ANSWERS: Record<string, string> = {
  "provider-stated": "カード会社の表示",
  "accepted-settlement": "採用済みの照合から",
  unknown: "引落口座は不明",
};
const label = (labels: Record<string, string>, code: string): string =>
  Object.hasOwn(labels, code) ? labels[code]! : code;

function Amount({ value }: { value: CompactQuantity }): ReactNode {
  return value.status === "exact" ? (
    <span>
      {value.value} {value.unit}
    </span>
  ) : (
    <Nullable value={null} placeholder={`不明（${value.reason}） · ${value.unit}`} />
  );
}

function AccountName({
  account,
  sourceAccount,
  label: name,
}: {
  account: string | null;
  sourceAccount: string | null;
  label: string | null;
}): ReactNode {
  if (account === null && sourceAccount === null) return <span>引落口座が不明な請求</span>;
  return (
    <span>
      {name ?? (sourceAccount === null ? account : bankSourceLabel(sourceAccount.split(":")[0]!))}
      {sourceAccount === null ? null : (
        <>
          {" · "}
          <code>{sourceAccount}</code>
        </>
      )}
    </span>
  );
}

function Line({ line }: { line: UpcomingDebitAccountLine }): ReactNode {
  const tone = line.covers === "yes" ? "ok" : line.covers === "no" ? "bad" : "neutral";
  const verdict =
    line.covers === "yes"
      ? "残高で足ります"
      : line.covers === "no"
        ? "残高が足りません"
        : "判定できません";
  return (
    <li className="debit-account-card">
      <p>
        <strong>
          <AccountName
            account={line.account}
            sourceAccount={line.sourceAccount}
            label={line.label}
          />
        </strong>{" "}
        · {line.debitDate} までの請求 {line.bills}件 · 合計 <Amount value={line.cardBills} />
        {line.balance === null ? null : (
          <>
            {" · "}残高 <Amount value={line.balance} />
            <span className="dim">
              {" "}
              （取得 <Nullable value={line.balance.capturedAt} placeholder="なし" />）
            </span>
          </>
        )}
      </p>
      <p>
        <Badge tone={tone}>{verdict}</Badge>
      </p>
      {line.reasons.length > 0 ? (
        <ul>
          {line.reasons.map((reason) => (
            <li key={reason}>{label(COVERS_REASONS, reason)}</li>
          ))}
        </ul>
      ) : null}
      <p className="footnote">
        カードの請求だけを残高と比べています。ほかの引落や入金は含みません。
      </p>
    </li>
  );
}

/** The section above each card's debit account. */
export function UpcomingCardBills(): ReactNode {
  const query = useUpcomingCardBills();
  return (
    <section className="panel" aria-labelledby="upcoming-card-bills">
      <div className="panel-head">
        <h2 id="upcoming-card-bills">次回の引落</h2>
      </div>
      <div className="panel-body">
        <QueryBoundary
          query={query}
          label="次回の引落"
          isEmpty={(data) => data.bills.length === 0 && data.notListed.length === 0}
          empty="請求のあるカードはありません。"
        >
          {(data) => (
            <>
              <p className="dim">{data.date} 以降に引き落とされるカードの請求です。</p>
              {data.bills.length === 0 ? (
                <p>これから引き落とされる請求はありません。</p>
              ) : (
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="カードごとの請求"
                  tabIndex={0}
                >
                  <table>
                    <caption>カード会社が示した請求額と引落日です。</caption>
                    <thead>
                      <tr>
                        <th scope="col">カード</th>
                        <th scope="col">請求月</th>
                        <th scope="col">引落日</th>
                        <th scope="col">請求額</th>
                        <th scope="col">引落口座</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.bills.map((bill) => (
                        <tr key={bill.card.source + "\n" + bill.card.sourceAccount}>
                          <td>
                            {bill.card.label ?? (bill.card.source === "vpass" ? "Vpass" : "MyJCB")}{" "}
                            · <code>{bill.card.sourceAccount}</code>
                          </td>
                          <td>
                            <Nullable value={bill.statementPeriod} />
                          </td>
                          <td>{bill.debitDate}</td>
                          <td>
                            <Amount value={bill.amount} />
                          </td>
                          <td>
                            <Badge
                              tone={bill.debitAccount.answer === "provider-stated" ? "ok" : "warn"}
                            >
                              {label(ANSWERS, bill.debitAccount.answer)}
                            </Badge>{" "}
                            {bill.debitAccount.answer === "unknown" ? null : (
                              <AccountName
                                account={bill.debitAccount.account}
                                sourceAccount={bill.debitAccount.sourceAccount}
                                label={bill.debitAccount.label}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data.byDebitAccount.length > 0 ? (
                <ul className="debit-account-list">
                  {data.byDebitAccount.map((line) => (
                    <Line
                      key={JSON.stringify([line.account, line.sourceAccount, line.debitDate])}
                      line={line}
                    />
                  ))}
                </ul>
              ) : null}
              {data.notListed.length > 0 ? (
                <>
                  <h3>次回の請求がないカード</h3>
                  <ul>
                    {data.notListed.map((card) => (
                      <li key={card.source + "\n" + card.card}>
                        <code>{card.card}</code> · {label(NOT_LISTED_REASONS, card.reason)}
                        {card.last === null ? null : (
                          <span className="dim">
                            {" "}
                            · 最新の請求 <Nullable value={card.last.period} /> · 引落日{" "}
                            <Nullable value={card.last.debitDate} placeholder="不明" />
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {data.cardsTruncated ? (
                <p className="footnote" role="note">
                  {`カードが多いため、先頭の${data.cardsMax}枚だけを対象にしています。`}
                </p>
              ) : null}
            </>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}
