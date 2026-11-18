// The カード照合 page's list of each card's debit account (docs/card-settlements.md,
// Debit account per card; ADR 0114). The read is the server's
// (`GET /api/v2/reconciliation/card-debit-accounts`, the same service as
// `kogane.card-settlements.debit-accounts`); `getJson` checks its shape before
// it renders, and the page shows the server's answer, which kind of evidence it
// rests on and the evidence on each side. It decides nothing and offers no
// action: an undecided candidate is listed, never used as the answer.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type {
  CardDebitAccountCard,
  CardDebitAccountsReview,
  DebitBankAccount,
  MatchedDebitAccount,
  StatedReading,
} from "../../../packages/application/src/query/card-debit-accounts.ts";
import { CARD_DEBIT_ACCOUNTS_PATH } from "../../../packages/observation-shared/src/card-debit-accounts-contract.ts";
import {
  bankSourceLabel,
  DateValue,
  debitAccountReason,
  SettlementQuantity,
} from "./reconciliation-display.tsx";
import { Link } from "./router.tsx";
import { Badge, Nullable, QueryBoundary } from "./ui.tsx";

export function useCardDebitAccounts() {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-settlements", "debit-accounts"],
    enabled: features.known && features.cardSettlementReconciliation,
    // getJson checks the shape (`validApiResponse`) before anything renders.
    queryFn: ({ signal }) => getJson<CardDebitAccountsReview>(CARD_DEBIT_ACCOUNTS_PATH, signal),
    retry: false,
  });
}

/** Each closed code, in words. A code the page does not know is shown as stored. */
const UNKNOWN_REASONS: Record<string, string> = {
  stated_reading_conflicting: "カード会社の表示に合う口座が複数あり、一つに決まりません。",
  only_unreviewed_candidates:
    "金額と日付が一致する出金の候補はありますが、まだ誰も採用していません。候補は判断に使いません。",
  no_debit_account_evidence: "引落口座を示す記録がありません。",
};
const ANSWER_CODES: Record<string, string> = {
  settled_account_differs: "最新の採用済み照合は別の口座から引き落とされています。",
  newer_reading_unresolved:
    "より新しい明細のカード情報からは口座を一つに決められませんでした（表示はそれ以前の明細のものです）。",
  settled_accounts_differ: "採用済みの照合に、別の口座からの引落もあります。",
  stated_reading_conflicting: "カード会社の最新の表示に合う口座が複数あります。",
};
const STATED_STATUS: Record<string, string> = {
  named: "口座を特定",
  conflicting: "合う口座が複数",
  not_named: "口座を特定できず",
  absent: "記録なし",
};
const label = (labels: Record<string, string>, code: string): string =>
  Object.hasOwn(labels, code) ? labels[code]! : code;

function Account({ account }: { account: DebitBankAccount }): ReactNode {
  return (
    <span>
      {bankSourceLabel(account.bankSourceId)} · <code>{account.bankSourceAccount}</code>
    </span>
  );
}

function Answer({ item }: { item: CardDebitAccountCard }): ReactNode {
  const { answer } = item;
  if (answer.basis === "unknown")
    return (
      <p>
        <Badge tone="neutral">引落口座は不明</Badge> {label(UNKNOWN_REASONS, answer.reason)}
      </p>
    );
  return (
    <>
      <p>
        {answer.basis === "provider-stated" ? (
          <Badge tone="ok">カード会社の表示</Badge>
        ) : (
          <Badge tone="warn">採用済みの照合から</Badge>
        )}{" "}
        <Account account={answer.account} />
        {answer.basis === "provider-stated" ? (
          <span className="dim"> · {answer.observedAt} に取得した明細</span>
        ) : (
          <span className="dim">
            {" "}
            · 引落日 <Nullable value={answer.debitDate} placeholder="不明" /> ·{" "}
            <Link to={`/reconciliation/${answer.proposalId}`}>照合を見る</Link>
          </span>
        )}
      </p>
      {answer.basis === "accepted-settlement" ? (
        <p className="footnote">
          金額と日付で照合し、採用された出金の口座です。カード会社が示す口座ではありません。
        </p>
      ) : null}
      {answer.codes.length > 0 ? (
        <ul>
          {answer.codes.map((code) => (
            <li key={code}>{label(ANSWER_CODES, code)}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function Reading({ reading }: { reading: StatedReading }): ReactNode {
  return (
    <span>
      {reading.observedAt} に取得
      {reading.accounts.length > 0 ? (
        <>
          {" · "}
          {reading.accounts.map((account, index) => (
            <span key={account.bankSourceId + "\n" + account.bankSourceAccount}>
              {index > 0 ? "、" : null}
              <Account account={account} />
            </span>
          ))}
          {reading.visibleDigitCount === null
            ? null
            : `（口座番号の先頭${reading.visibleDigitCount}桁が一致）`}
        </>
      ) : null}
      {reading.reasons.length > 0
        ? ` · ${reading.reasons.map((reason) => debitAccountReason(reason)).join("、")}`
        : null}
    </span>
  );
}

function Matched({ entries, empty }: { entries: MatchedDebitAccount[]; empty: string }): ReactNode {
  if (entries.length === 0) return <span className="dim">{empty}</span>;
  return (
    <ul>
      {entries.map((entry) => (
        <li key={entry.bankSourceId + "\n" + entry.bankSourceAccount}>
          <Account account={entry} /> · 請求 {entry.statements}件 · 最新の引落日{" "}
          <Nullable value={entry.latest.debitDate} placeholder="不明" /> ·{" "}
          <Link to={`/reconciliation/${entry.latest.proposalId}`}>照合候補</Link>
        </li>
      ))}
    </ul>
  );
}

function CardRow({ item }: { item: CardDebitAccountCard }): ReactNode {
  const { card, latestStatement: statement, stated } = item;
  return (
    <li className="debit-account-card">
      <p>
        <strong>{card.sourceId === "vpass" ? "Vpass" : "MyJCB"}</strong> ·{" "}
        <code>{card.sourceAccount}</code>
        {statement === null ? (
          <span className="dim"> · 現在の請求なし</span>
        ) : (
          <span className="dim">
            {" "}
            · 最新の請求 <Nullable value={statement.period} /> · 請求総額{" "}
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
          </span>
        )}
      </p>
      <Answer item={item} />
      <dl className="debit-account-evidence">
        <dt>カード会社が示す引落口座</dt>
        <dd>
          <Badge tone="neutral">{label(STATED_STATUS, stated.status)}</Badge>{" "}
          {stated.latest === null ? (
            debitAccountReason(stated.reason ?? "evidence_not_recorded")
          ) : (
            <Reading reading={stated.latest} />
          )}
          {stated.lastNamed !== null &&
          stated.lastNamed.readingRef.id !== stated.latest?.readingRef.id ? (
            <p className="footnote">
              口座を特定できた最後の明細: <Reading reading={stated.lastNamed} />
            </p>
          ) : null}
        </dd>
        <dt>採用済みの照合</dt>
        <dd>
          <Matched entries={item.settled} empty="ありません" />
        </dd>
        <dt>未判断の照合候補（判断には使いません）</dt>
        <dd>
          <Matched entries={item.proposed} empty="ありません" />
        </dd>
      </dl>
    </li>
  );
}

/** The section above the statements without a candidate. */
export function CardDebitAccounts(): ReactNode {
  const query = useCardDebitAccounts();
  return (
    <section className="panel" aria-labelledby="card-debit-accounts">
      <div className="panel-head">
        <h2 id="card-debit-accounts">カードの引落口座</h2>
      </div>
      <div className="panel-body">
        <QueryBoundary
          query={query}
          label="カードの引落口座"
          isEmpty={(data) => data.items.length === 0}
          empty="請求のあるカードはありません。"
        >
          {(data) => (
            <>
              <ul className="debit-account-list">
                {data.items.map((item) => (
                  <CardRow key={item.card.sourceId + "\n" + item.card.sourceAccount} item={item} />
                ))}
              </ul>
              {data.cardsTruncated ? (
                <p className="footnote" role="note">
                  {`カードが多いため、先頭の${data.items.length}枚だけを表示しています。`}
                </p>
              ) : null}
            </>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}
