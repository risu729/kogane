import type { ReactNode } from "react";
import type { Quantity } from "../../../packages/domain/src/values.ts";
import { decimalToString } from "../../../packages/domain/src/values.ts";
import type { TemporalValue } from "../../../packages/domain/src/time.ts";
import type { SourceFactRef } from "../../../packages/domain/src/events.ts";
import type { CardSettlementReview } from "./reconciliation-api.ts";
import { Link } from "./router.tsx";
import { Badge, Kv, KvRow, Notice, Nullable } from "./ui.tsx";

export const SETTLEMENT_STATUS = {
  proposed: "確認待ち",
  accepted: "採用済み",
  rejected: "却下済み",
  withdrawn: "採用を解除済み",
} as const;

const REASONS: Record<string, string> = {
  authoritative_statement_total: "カード会社が報告した請求総額",
  observed_bank_debit: "銀行の出金明細を取得済み",
  amount_equal: "請求額と出金額が一致",
  date_within_window: "引落予定日と出金日が照合対象期間内",
  statement_changed: "請求の原本が更新された場合は再確認",
  bank_debit_changed: "銀行明細が更新された場合は再確認",
  allocation_already_used: "同じ請求・出金を別の決済へ配賦済みの場合は採用不可",
  owner_not_established: "両方の口座が同じ保有者のものだと確認できていません",
  owner_differs: "口座の保有者が一致しません",
  account_not_resolved: "口座の対応付けが未解決です",
  ownership_changed: "候補作成後に口座・保有者の対応付けが変わっています",
  settlement_not_eligible: "採用に必要な条件が揃っていません",
};

export function settlementReason(code: string): string {
  return Object.hasOwn(REASONS, code) ? REASONS[code]! : code;
}

export function SettlementQuantity({ value }: { value: Quantity }): ReactNode {
  return value.value.status === "exact" ? (
    <span>
      {decimalToString(value.value.value)} {value.unitRef}
    </span>
  ) : (
    <Nullable value={null} placeholder={`不明（${value.value.reasonCode}） · ${value.unitRef}`} />
  );
}

export function DateValue({ value }: { value: TemporalValue }): ReactNode {
  if (value.kind === "unknown")
    return <Nullable value={null} placeholder={`不明（${value.reasonCode}）`} />;
  if (value.kind === "period")
    return (
      <span>
        {value.start} ～ {value.end}
      </span>
    );
  return <time dateTime={value.value}>{value.value}</time>;
}

function FactLink({ fact, label }: { fact: SourceFactRef; label: string }): ReactNode {
  const match = /^(balance|transaction):([0-9]+)$/u.exec(fact.id);
  return (
    <span>
      {match && match[1] === fact.kind ? (
        <Link to={`/observations/${match[1]}/${match[2]}`}>{label}</Link>
      ) : (
        <span>
          {label}: <code>{fact.id}</code>
        </span>
      )}
      <span className="dim"> · 解析版: {fact.revision}</span>
    </span>
  );
}

export function CardSettlementDetails({ review }: { review: CardSettlementReview }): ReactNode {
  const { facts, impact } = review;
  return (
    <div className="settlement-details">
      <Kv>
        <KvRow label="状態">
          <Badge tone={review.status === "accepted" ? "ok" : "neutral"}>
            {SETTLEMENT_STATUS[review.status]}
          </Badge>{" "}
          · 判断の版 {review.revision}
        </KvRow>
        <KvRow label="カードの取得元">
          {facts.statement.sourceId === "vpass" ? "Vpass" : "MyJCB"} ·{" "}
          {facts.statement.sourceAccount}
        </KvRow>
        <KvRow label="請求対象期間">
          <Nullable value={facts.statement.period} placeholder="不明" />
        </KvRow>
        <KvRow label="カード会社の請求総額">
          <SettlementQuantity value={facts.statement.amount} />
        </KvRow>
        <KvRow label="引落予定日">
          <DateValue value={facts.statement.paymentDate} />
        </KvRow>
        <KvRow label="銀行の取得元">
          {facts.bankDebit.sourceId} · {facts.bankDebit.sourceAccount}
        </KvRow>
        <KvRow label="銀行明細の出金額">
          <SettlementQuantity value={facts.bankDebit.amount} />
        </KvRow>
        <KvRow label="銀行の出金日">
          <DateValue value={facts.bankDebit.occurred} />
        </KvRow>
        <KvRow label="口座の保有者">
          {facts.ownership === "established-same"
            ? "同一保有者の根拠あり"
            : facts.ownership === "different"
              ? "一致しない"
              : "未確認"}
        </KvRow>
        <KvRow label="原本への経路">
          <FactLink fact={facts.statement.ref} label="請求の記録と原本" />
          {" / "}
          <FactLink fact={facts.bankDebit.ref} label="銀行明細と原本" />
        </KvRow>
      </Kv>
      <h3>照合の根拠</h3>
      <ul className="warning-list">
        {facts.rationaleCodes.map((code) => (
          <li key={code}>{settlementReason(code)}</li>
        ))}
      </ul>
      {review.acceptanceBlockers.length > 0 ? (
        <Notice tone="warn" inline role="note">
          <p>
            <strong>
              {review.status === "proposed"
                ? "現時点では採用できません。"
                : "保存された根拠の再確認が必要です。"}
            </strong>
          </p>
          <ul className="warning-list">
            {review.acceptanceBlockers.map((code) => (
              <li key={code}>{settlementReason(code)}</li>
            ))}
          </ul>
          <p>金額や日付の一致だけで、口座の保有者を推測して確定することはありません。</p>
        </Notice>
      ) : null}
      <h3>残高・支出への影響</h3>
      <Kv>
        <KvRow label="銀行が報告済みの出金">
          <SettlementQuantity value={impact.bankDebitAlreadyObserved} />
        </KvRow>
        <KvRow label="この対応付けで追加する現金移動">
          <SettlementQuantity value={impact.addedCashMovement} />
        </KvRow>
        <KvRow label="この対応付けで追加する購入支出">
          <SettlementQuantity value={impact.addedPurchaseExpense} />
        </KvRow>
        <KvRow
          label={
            impact.allocationState === "proposed"
              ? "採用した場合の請求への決済配賦"
              : "現在の請求への決済配賦"
          }
        >
          <SettlementQuantity value={impact.liabilityAllocation} />
          {impact.allocationState === "proposed"
            ? "（候補・未適用）"
            : impact.allocationState === "not-applied"
              ? "（適用なし）"
              : "（採用済み）"}
        </KvRow>
        <KvRow label="元本負債の減少額">不明（請求総額だけでは元本と手数料を分けられません）</KvRow>
        <KvRow label="手数料の内訳">不明</KvRow>
        <KvRow label="純資産への影響">算定していません（資産・負債全体の情報が不足）</KvRow>
      </Kv>
      <p className="footnote">
        出金は銀行の記録にすでに存在します。この照合は請求の支払先を説明するもので、同じ出金や購入をもう一度計上しません。個々のカード利用と請求内訳の照合は、この候補だけでは完了しません。
      </p>
      <details className="detail-disclosure settlement-history">
        <summary>再確認する条件と判断の履歴</summary>
        <ul className="warning-list">
          {facts.rejectionConditions.map((code) => (
            <li key={code}>{settlementReason(code)}</li>
          ))}
        </ul>
        <p>採用時には原本の公開状態、口座の保有者、重複配賦をサーバーで再確認します。</p>
        {facts.ownershipEvidenceRefs.length > 0 ? (
          <p>保有者の根拠: {facts.ownershipEvidenceRefs.join("、")}</p>
        ) : null}
        {review.history.length === 0 ? (
          <p>まだ判断は保存されていません。</p>
        ) : (
          <ol className="plain-list">
            {review.history.map((entry) => (
              <li key={entry.revision}>
                版 {entry.revision}: {SETTLEMENT_STATUS[entry.status]} · {entry.createdAt}
                <br />
                <code>{entry.decisionRevisionId}</code>
              </li>
            ))}
          </ol>
        )}
        {review.historyTruncated ? (
          <p>直近20件の判断を表示しています。古い判断も保存されています。</p>
        ) : null}
        <p>訂正は新しい判断を追加します。原本や以前の判断は消しません。</p>
      </details>
    </div>
  );
}
