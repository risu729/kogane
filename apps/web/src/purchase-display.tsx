// Display pieces for recognised card purchases. Every figure is the server's:
// nothing here adds, subtracts or compares an amount, and a statement total is
// only ever shown beside the purchase figures, never against them.
import type { ReactNode } from "react";
import type {
  CardPurchaseSourceId,
  CardUsageExclusion,
} from "../../../packages/domain/src/card-purchase.ts";
import type {
  CardPurchaseCandidate,
  CardPurchaseCandidateSide,
  CardPurchasePage,
  CardPurchaseStatementReason,
  CardPurchaseView,
} from "../../../packages/domain/src/card-purchase-view.ts";
import type { EventState, SourceFactRef } from "../../../packages/domain/src/events.ts";
import type {
  PendingPostedAction,
  PendingPostedBlocker,
} from "../../../packages/domain/src/pending-posted-review.ts";
import type {
  RationaleCode,
  RejectionConditionCode,
} from "../../../packages/domain/src/reconcile.ts";
import { useFeatures } from "./api.ts";
import { DateValue, SETTLEMENT_STATUS, SettlementQuantity } from "./reconciliation-display.tsx";
import { Link } from "./router.tsx";
import { Badge, ChainStep, Kv, KvRow, Notice, Nullable, ObservationLink } from "./ui.tsx";

const SOURCE_LABELS: Record<CardPurchaseSourceId, string> = {
  vpass: "Vpass",
  myjcb: "MyJCB",
};
export const KIND_LABELS = { purchase: "購入", refund: "返金" } as const;

/** The one sentence every settlement mention carries (plan §4: no double count). */
export const SETTLEMENT_NOTE = "引落は購入費用に加算しません";

function stateLabel(view: Pick<CardPurchaseView, "state" | "unknownReason">): string {
  if (view.state === "captured") return "確定";
  if (view.state === "authorized") return "未確定";
  if (view.state === "unknown")
    return view.unknownReason === "provider_status_absent"
      ? "取得元に表示されなくなった"
      : view.unknownReason === "conflicting_evidence"
        ? "根拠の食い違いで保留"
        : "状態不明";
  return view.state;
}

export function PurchaseStateBadge({
  view,
}: {
  view: Pick<CardPurchaseView, "state" | "unknownReason">;
}): ReactNode {
  const tone = view.state === "captured" ? "ok" : view.state === "unknown" ? "warn" : "neutral";
  return <Badge tone={tone}>{stateLabel(view)}</Badge>;
}

const STATEMENT_REASONS: Record<CardPurchaseStatementReason, string> = {
  not_posted: "未確定の利用は、まだ請求に含まれていません。",
  statement_not_collected:
    "この請求月の請求を取得していないか、請求の口座がまだ一つに定まっていません。",
  period_unrecognized: "取得元の請求月の表記を読み取れないため、請求と結び付けていません。",
};

/** Short forms for a table cell. */
const STATEMENT_SHORT: Record<CardPurchaseStatementReason, string> = {
  not_posted: "未請求",
  statement_not_collected: "請求未取得",
  period_unrecognized: "請求月不明",
};

export const EXCLUSION_LABELS: Record<CardUsageExclusion, string> = {
  account_not_resolved: "カードの口座が未確定",
  card_identity_unstable: "カードを安定して識別できない",
  amount_not_exact: "金額を正確に読み取れない",
  amount_zero: "金額が0円",
  unit_unsupported: "日本円以外の金額",
  payment_type_unsupported: "1回払い以外（分割・リボ・ボーナス払いなど）",
  installment_amount_differs: "利用額と今回の支払額が異なる（分割払いの一部など）",
  payment_split_unknown: "利用額と支払額を確認できない",
  refund_shape_unverified: "返金の形式を確認できない",
  status_unsupported: "確定・未確定以外の状態",
  date_absent: "利用日が記録されていない",
  superseded_representation: "同じ明細のより新しい取得がある",
};

/** A stored `transaction:<id>` / `balance:<id>` reference as a link to its record and original. */
function EvidenceLink({ fact, label }: { fact: SourceFactRef; label: string }): ReactNode {
  const match = /^(transaction|balance):([0-9]+)$/u.exec(fact.id);
  const id = match ? Number(match[2]) : NaN;
  return (
    <span>
      {match && match[1] === fact.kind && Number.isSafeInteger(id) ? (
        <ObservationLink kind={fact.kind === "balance" ? "balance" : "transaction"} id={id}>
          {label}
        </ObservationLink>
      ) : (
        <span>
          {label}: <code className="wrap-any">{fact.id}</code>
        </span>
      )}
      <span className="dim"> · 解析版 {fact.revision}</span>
    </span>
  );
}

/** The live amount, or, for an unresolved event, the last amount the provider showed. */
export function PurchaseAmount({ view }: { view: CardPurchaseView }): ReactNode {
  if (view.amount !== null) return <SettlementQuantity value={view.amount} />;
  if (view.lastKnownAmount !== null)
    return (
      <span>
        合計に含めていません（最後の表示 <SettlementQuantity value={view.lastKnownAmount} />）
      </span>
    );
  return <Nullable value={null} placeholder="金額なし" />;
}

export function statementCell(view: CardPurchaseView): string {
  return view.statement.status === "linked"
    ? `${view.statement.period} 請求分`
    : STATEMENT_SHORT[view.statement.reasonCode];
}

export function settlementCell(view: CardPurchaseView): string {
  if (view.settlement === null) return view.statement.status === "linked" ? "未照合" : "—";
  return view.settlement.bankDebit === null
    ? SETTLEMENT_STATUS[view.settlement.reviewStatus]
    : "引落を確認済み";
}

function FigureTile({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="tile" role="listitem">
      <div className="tile-value">{children}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

/**
 * State-separated figures, one tile each: they are deliberately not added up,
 * and each unit keeps its own tiles.
 */
export function PurchaseFigures({ summary }: { summary: CardPurchasePage["summary"] }): ReactNode {
  return (
    <div className="tiles purchase-figures" role="list" aria-label="状態ごとの利用額">
      {summary.units.map((unit) => [
        <FigureTile key={`${unit.unitRef}-captured`} label="確定">
          <SettlementQuantity value={unit.captured} />
        </FigureTile>,
        <FigureTile key={`${unit.unitRef}-authorized`} label="未確定">
          <SettlementQuantity value={unit.authorized} />
        </FigureTile>,
        <FigureTile key={`${unit.unitRef}-refunds`} label="返金（対応不明）">
          <SettlementQuantity value={unit.capturedRefunds} />
        </FigureTile>,
        <FigureTile key={`${unit.unitRef}-pending-refunds`} label="未確定の返金（対応不明）">
          <SettlementQuantity value={unit.authorizedRefunds} />
        </FigureTile>,
      ])}
      <FigureTile label="取得元に表示されなくなった利用">{summary.unresolved}件</FigureTile>
    </div>
  );
}

/** Provider statement totals, beside the figures: never compared with them. */
export function StatementTotals({
  totals,
}: {
  totals: CardPurchasePage["summary"]["statementTotals"];
}): ReactNode {
  if (totals.length === 0) return <p>この条件の利用に対応する請求はまだ取得していません。</p>;
  return (
    <Kv>
      {totals.map((entry) => (
        <KvRow
          key={`${entry.sourceId}:${entry.accountId}:${entry.period}`}
          label={`${SOURCE_LABELS[entry.sourceId]} ${entry.period} 請求分`}
        >
          <SettlementQuantity value={entry.total} />
          <br />
          <span className="dim wrap-any">{entry.accountId}</span> ·{" "}
          <EvidenceLink fact={entry.ref} label="請求の記録と原本" />
        </KvRow>
      ))}
    </Kv>
  );
}

function SourceRows({ view }: { view: CardPurchaseView }): ReactNode {
  return (
    <ul className="plain-list purchase-rows">
      {view.sourceRows.map((row) => (
        <li key={row.ref.id}>
          <strong>{row.role === "posted" ? "確定の明細" : "未確定の明細"}</strong>{" "}
          <Badge tone={row.current ? "neutral" : "warn"}>
            {row.current ? "取得元に表示中" : "取得元に表示されていません"}
          </Badge>
          <br />
          <Nullable value={row.usageDate} placeholder="利用日未記録" /> ·{" "}
          <Nullable value={row.counterparty} placeholder="利用先未記録" />
          <br />
          <EvidenceLink fact={row.ref} label="明細の記録と原本" />
          {row.rawLocator === null ? null : (
            <span className="dim">
              {" "}
              · 原本内の位置 <code className="wrap-any">{row.rawLocator}</code>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 利用 → 請求 → 引落, each step with its evidence. */
export function PurchaseChain({ view }: { view: CardPurchaseView }): ReactNode {
  const features = useFeatures();
  const { statement, settlement } = view;
  const reconciliation = features.cardSettlementReconciliation ? (
    <Link to="/reconciliation">カード照合で確認</Link>
  ) : null;
  return (
    <ol className="chain" aria-label="利用から請求、引落までの経路">
      <ChainStep number={1} stage="利用" title={`${KIND_LABELS[view.kind]} · ${stateLabel(view)}`}>
        <Kv>
          <KvRow label="利用日">{view.usageDate}</KvRow>
          <KvRow label="金額">
            <PurchaseAmount view={view} />
          </KvRow>
          <KvRow label="カード">
            {SOURCE_LABELS[view.sourceId]} · <span className="wrap-any">{view.accountId}</span>
          </KvRow>
          <KvRow label="請求月">
            <Nullable value={view.statementPeriod} placeholder="読み取れません" />
          </KvRow>
        </Kv>
        {view.state === "unknown" ? (
          <Notice tone="warn" inline role="note">
            取得元に表示されなくなったため、この利用は合計に含めていません。取消や返金があったとは判断していません。
          </Notice>
        ) : null}
        {view.kind === "refund" ? (
          <p className="footnote">
            返金がどの購入に対するものかは確認していません。購入額から差し引かず、別に表示します。
          </p>
        ) : null}
        <SourceRows view={view} />
      </ChainStep>
      <ChainStep
        number={2}
        stage="請求"
        title={
          statement.status === "linked" ? `${statement.period} 請求分` : "請求に結び付いていません"
        }
      >
        {statement.status === "linked" ? (
          <>
            <Kv>
              <KvRow label="カード会社の請求総額">
                <SettlementQuantity value={statement.providerTotal} />
              </KvRow>
              <KvRow label="引落予定日">
                <DateValue value={statement.paymentDate} />
              </KvRow>
              <KvRow label="原本">
                <EvidenceLink fact={statement.ref} label="請求の記録と原本" />
              </KvRow>
            </Kv>
            <p className="footnote">
              請求総額はカード会社が報告した金額で、個々の利用の合計ではありません。利用額と比較したり差し引いたりしません。
            </p>
          </>
        ) : (
          <p>{STATEMENT_REASONS[statement.reasonCode]}</p>
        )}
      </ChainStep>
      <ChainStep
        number={3}
        stage="引落"
        title={
          settlement?.bankDebit
            ? "銀行引落を確認済み"
            : settlement
              ? `照合 · ${SETTLEMENT_STATUS[settlement.reviewStatus]}`
              : "引落は照合されていません"
        }
      >
        {settlement === null ? (
          <p>
            {statement.status === "linked"
              ? "この請求の支払いに対応する銀行引落は、まだ照合されていません。"
              : "請求に結び付いていないため、引落はたどれません。"}
          </p>
        ) : (
          <Kv>
            <KvRow label="照合の状態">{SETTLEMENT_STATUS[settlement.reviewStatus]}</KvRow>
            {settlement.bankDebit === null ? null : (
              <>
                <KvRow label="銀行">{settlement.bankDebit.sourceId}</KvRow>
                <KvRow label="出金額">
                  <SettlementQuantity value={settlement.bankDebit.amount} />
                </KvRow>
                <KvRow label="出金日">
                  <DateValue value={settlement.bankDebit.occurred} />
                </KvRow>
                <KvRow label="原本">
                  <EvidenceLink fact={settlement.bankDebit.ref} label="銀行明細と原本" />
                </KvRow>
              </>
            )}
            {settlement.settlementEventId === null ? null : (
              <KvRow label="決済の記録">
                <code className="wrap-any">{settlement.settlementEventId}</code>
              </KvRow>
            )}
            {settlement.allocationId === null ? null : (
              <KvRow label="引落の配賦">
                <code className="wrap-any">{settlement.allocationId}</code>
              </KvRow>
            )}
          </Kv>
        )}
        <p className="footnote">
          <strong>{SETTLEMENT_NOTE}。</strong>
          引落は請求の支払いとして記録され、利用の金額や銀行の出金を二重に数えません。
          {reconciliation === null ? null : <> {reconciliation}</>}
        </p>
      </ChainStep>
    </ol>
  );
}

// ── pending-to-posted candidates ─────────────────────────────────────
//
// A candidate names one pending (未確定) row and one posted (確定) row that
// may be the same purchase. Nothing here decides that: the server says which
// actions a review may take (`actions`) and why not (`blockers`), and the
// payload a review plans is the candidate's own `relation`.

/** The three decisions, as the buttons and the confirmation screen name them. */
export const CANDIDATE_ACTION_LABELS: Record<PendingPostedAction, string> = {
  accept: "同一の利用として統合",
  reject: "別の利用として扱う",
  withdraw: "統合を取り消す",
};

const RATIONALE_LABELS: Record<RationaleCode, string> = {
  provider_link_id_equal: "カード会社が同じ利用として対応番号を示している",
  provider_identifier_equal: "取得元の識別子が一致",
  collector_fingerprint_identifier: "取得処理が作った識別子で対応",
  same_identifier_namespace: "同じ取得元・同じ識別子の体系の明細",
  same_source_account: "同じカードの明細",
  same_statement_period: "同じ請求月",
  amount_equal: "金額が一致",
  amount_opposite_sign: "金額の符号が逆",
  date_within_window: "利用日が近い",
  status_pending_to_posted: "未確定の明細と確定の明細の組",
  counterparty_equal: "利用先の表示が一致",
  owner_established_self: "保有者を確認済み",
  multiple_candidates: "同じ未確定の明細に、ほかの候補もある",
  no_provider_link_id: "カード会社の対応番号はない（金額・日付などからの候補）",
};

const REJECTION_LABELS: Record<RejectionConditionCode, string> = {
  identifier_namespace_differs: "識別子の体系が異なる",
  credential_epoch_differs: "取得したログインの期間が異なる",
  counterparty_differs: "利用先が異なる",
  amount_differs: "金額が異なる",
  unit_differs: "通貨が異なる",
  owner_not_established: "保有者を確認できていない",
  date_outside_window: "利用日が離れている",
  provider_link_absent: "カード会社が対応を示していない",
  candidate_not_unique: "ほかにも候補がある",
};

const BLOCKER_LABELS: Record<PendingPostedBlocker, string> = {
  row_not_recognized: "どちらかの明細が、カード利用としてまだ認識されていません。",
  already_linked: "どちらかの利用は、すでに別の明細と統合されています。",
  kind_differs: "購入と返金は同じ利用として統合できません。",
  account_differs: "2件の明細のカード口座または取得元が異なります。",
  posted_not_captured: "確定の明細の利用が、確定の状態ではありません。",
  proposal_closed: "この候補はすでに別の利用と判断されたか、統合が取り消されています。",
  proposal_shape_unsupported:
    "この候補は未確定と確定の明細1件ずつの組ではないため、ここでは判断できません。",
};

/** A candidate still waiting for a decision (the server offers `reject` for exactly these). */
export function candidateOpen(candidate: CardPurchaseCandidate): boolean {
  return candidate.proposalStatus === "proposed" && candidate.relationStatus !== "accepted";
}

/** Both rows are held by one live event: the link was merged. */
export function candidateMerged(candidate: CardPurchaseCandidate): boolean {
  return (
    candidate.pending.eventId !== null && candidate.pending.eventId === candidate.posted.eventId
  );
}

function candidateStatus(candidate: CardPurchaseCandidate): {
  tone: "ok" | "neutral" | "warn";
  label: string;
} {
  if (candidateOpen(candidate)) return { tone: "neutral", label: "確認待ち" };
  if (candidate.proposalStatus === "accepted" && candidate.relationStatus === "accepted")
    return candidateMerged(candidate)
      ? { tone: "ok", label: "統合済み" }
      : { tone: "ok", label: "同一の利用と判断済み" };
  if (candidate.proposalStatus === "rejected")
    return { tone: "neutral", label: "別の利用と判断済み" };
  if (candidate.proposalStatus === "withdrawn")
    return { tone: "neutral", label: "統合を取り消し済み" };
  return { tone: "warn", label: "判断の記録を確認中" };
}

export function CandidateStatusBadge({
  candidate,
}: {
  candidate: CardPurchaseCandidate;
}): ReactNode {
  const status = candidateStatus(candidate);
  return <Badge tone={status.tone}>{status.label}</Badge>;
}

/** Whether the provider itself linked the two rows, or the pair is only a heuristic candidate. */
export function CandidateOrigin({ candidate }: { candidate: CardPurchaseCandidate }): ReactNode {
  return candidate.providerLinked ? (
    <Badge tone="ok">カード会社が対応を明示</Badge>
  ) : (
    <Badge tone="neutral">金額・日付などからの候補</Badge>
  );
}

const SIDE_STATES: Partial<Record<EventState, string>> = {
  captured: "確定",
  authorized: "未確定",
  unknown: "状態不明（合計に含めていません）",
};

/** The state word alone, for a transition such as 未確定 → 確定. */
function sideStateWord(side: CardPurchaseCandidateSide): string {
  if (side.state === null) return "未認識";
  return side.state === "unknown" ? "状態不明" : (SIDE_STATES[side.state] ?? side.state);
}

function sideStateLabel(side: CardPurchaseCandidateSide): string {
  if (side.state === null) return "カード利用として認識されていません";
  return SIDE_STATES[side.state] ?? side.state;
}

/** A signed amount as the provider displayed it, or why none is shown. */
export function DisplayedAmount({ side }: { side: CardPurchaseCandidateSide }): ReactNode {
  return side.displayedAmount === null ? (
    <Nullable value={null} placeholder="金額を読み取れません" />
  ) : (
    <SettlementQuantity value={side.displayedAmount} />
  );
}

/** One row as the provider displayed it: date, its own signed amount, state, record and original. */
function CandidateSide({
  number,
  stage,
  side,
  currentEventId,
}: {
  number: number;
  stage: string;
  side: CardPurchaseCandidateSide;
  currentEventId: string | null;
}): ReactNode {
  return (
    <ChainStep number={number} stage={stage} title={side.usageDate ?? "利用日未記録"}>
      <Kv>
        <KvRow label="取得元の表示金額">
          <DisplayedAmount side={side} />
        </KvRow>
        <KvRow label="利用の記録">
          {sideStateLabel(side)}
          {side.eventId === null ? null : (
            <>
              {" "}
              · 版 {side.revision}
              <br />
              {side.eventId === currentEventId ? (
                <span className="dim">この画面の利用</span>
              ) : (
                <Link to={`/purchases/${side.eventId}`}>この利用の説明</Link>
              )}
            </>
          )}
        </KvRow>
        <KvRow label="原本">
          <EvidenceLink fact={side.ref} label="明細の記録と原本" />
        </KvRow>
      </Kv>
    </ChainStep>
  );
}

/** The pending row, then the posted row: the order the provider showed them in. */
export function CandidateSides({
  candidate,
  currentEventId = null,
}: {
  candidate: CardPurchaseCandidate;
  currentEventId?: string | null;
}): ReactNode {
  return (
    <ol className="chain" aria-label="未確定の明細と確定の明細">
      <CandidateSide
        number={1}
        stage="未確定の明細"
        side={candidate.pending}
        currentEventId={currentEventId}
      />
      <CandidateSide
        number={2}
        stage="確定の明細"
        side={candidate.posted}
        currentEventId={currentEventId}
      />
    </ol>
  );
}

/** Why the pair was proposed, what would make it two purchases, and what blocks a decision. */
export function CandidateCodes({ candidate }: { candidate: CardPurchaseCandidate }): ReactNode {
  return (
    <>
      <h3>候補の根拠</h3>
      <ul className="warning-list">
        {candidate.rationaleCodes.map((code) => (
          <li key={code}>{RATIONALE_LABELS[code] ?? code}</li>
        ))}
      </ul>
      {candidate.rejectionConditions.length === 0 ? null : (
        <>
          <h3>統合する前に確かめること</h3>
          <p>次に当てはまる場合は、別の利用の可能性があります。</p>
          <ul className="warning-list">
            {candidate.rejectionConditions.map((code) => (
              <li key={code}>{REJECTION_LABELS[code] ?? code}</li>
            ))}
          </ul>
        </>
      )}
      {candidate.blockers.length === 0 ? null : (
        <Notice tone="warn" inline role="note">
          <p>
            <strong>
              {candidateOpen(candidate)
                ? "現時点では同一の利用として統合できません。"
                : "この候補の判断は変更できません。"}
            </strong>
          </p>
          <ul className="warning-list">
            {candidate.blockers.map((code) => (
              <li key={code}>{BLOCKER_LABELS[code] ?? code}</li>
            ))}
          </ul>
        </Notice>
      )}
    </>
  );
}

/**
 * What a decision does to the purchase records, in words. The figures stay
 * the server's: no decision adds or removes an amount, and the captured
 * figure stays as it is.
 */
export function candidateEffect(
  candidate: CardPurchaseCandidate,
  action: PendingPostedAction,
): string {
  if (action === "accept")
    return `2件の利用の記録を1件にまとめます。未確定の明細の記録が残り、状態が ${sideStateWord(candidate.pending)} → 確定 になります。確定の明細の記録はこの1件に統合されます。金額の追加や削除はなく、確定の合計は変わりません。`;
  if (action === "withdraw")
    return candidateMerged(candidate)
      ? "統合した1件の利用を、元の2件の記録に戻します。確定の明細は確定の利用として戻り、未確定の明細の記録は根拠の食い違いで保留として合計に含めません。以前の版と履歴は残ります。金額の追加や削除はなく、確定の合計は変わりません。"
      : "同一の利用とした判断を取り消します。統合された記録はないため、どの利用の記録も変わりません。";
  return "この候補を別の利用として閉じます。2件の記録はそのまま残り、金額や合計は変わりません。";
}
