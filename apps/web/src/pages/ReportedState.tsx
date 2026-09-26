// 基準日の保有状況: every account as its provider last reported it in a
// complete capture before the end of a chosen date (Asia/Tokyo), with the card
// statements due around it (docs/reported-state.md). The page lists provider
// figures as they were reported and never adds, converts or compares them: a
// container without a capture is named in the coverage, not shown as zero.
import { useState, type ReactNode } from "react";
import { ApiError, useFeatures } from "../api.ts";
import { SettlementQuantity, SETTLEMENT_STATUS } from "../reconciliation-display.tsx";
import {
  tokyoToday,
  useReportedState,
  type ReportedAccount,
  type ReportedPayable,
  type ReportedSnapshot,
  type ReportedState,
} from "../reported-state-api.ts";
import { Link } from "../router.tsx";
import {
  Badge,
  EmptyState,
  Kv,
  KvRow,
  Loading,
  Notice,
  Nullable,
  Panel,
  QueryBoundary,
  SourceAccount,
  type Tone,
} from "../ui.tsx";
import { useViewState } from "../view-state.tsx";

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

const FRESHNESS: Record<ReportedSnapshot["freshness"], { label: string; tone: Tone }> = {
  "same-day": { label: "当日取得", tone: "ok" },
  recent: { label: "3日以内に取得", tone: "neutral" },
  stale: { label: "4日以上前の取得", tone: "warn" },
};
const PAYABLE: Record<ReportedPayable["status"], { label: string; tone: Tone }> = {
  due_after_date: { label: "基準日より後に引落予定", tone: "neutral" },
  settled_on_or_before_date: { label: "基準日までに引落を確認", tone: "ok" },
  due_unsettled: { label: "引落予定日を過ぎ、引落は未確認", tone: "warn" },
  payment_date_unknown: { label: "引落予定日が不明", tone: "warn" },
};
const IDENTITY: Record<ReportedAccount["identityStatus"], string> = {
  identified: "口座を特定済み",
  "provider-local": "取得元の中だけで識別",
  aggregate: "複数口座の集約",
  unresolved: "口座が未解決",
  "not-recorded": "口座の対応付けなし",
};
const AGGREGATION: Record<string, string> = {
  "sum-disjoint": "別の口座となら合算できる残高",
  "select-one": "同じ残高の別表示（どれか1つ）",
  "non-additive": "合算しない値",
  "domain-specific": "個別の規則",
};
const EXCLUSIONS: Record<string, string> = {
  aggregator: "集約サービス（MoneyForward）の表示",
  aggregate_total: "取得元が表示する合計額（口座ごとの値と重複）",
  balance_after_transaction: "取引ごとの残高（その時点の残高とは別）",
  reward_units: "ポイント",
};
const LIABILITY_GAPS: Record<string, string> = {
  unbilled_card_usage: "まだ請求に載っていないカード利用",
  installment_remaining: "分割払いの残り",
  loan_balances: "ローン残高",
  statements_before_window: "引落予定日が基準日の31日より前の請求",
};

const label = (labels: Record<string, string>, code: string): string =>
  Object.hasOwn(labels, code) ? labels[code]! : code;
const idOf = (ref: string): string => ref.slice(ref.indexOf(":") + 1);

function UnavailableNotice(): ReactNode {
  return <EmptyState>この接続先は基準日の保有状況を提供していません。</EmptyState>;
}

function SnapshotLine({ snapshot }: { snapshot: ReportedSnapshot }): ReactNode {
  const freshness = FRESHNESS[snapshot.freshness];
  return (
    <li>
      取得日時 <time dateTime={snapshot.capturedAt}>{snapshot.capturedAt}</time>{" "}
      <Badge tone={freshness.tone} title={`基準日の${snapshot.ageDays}日前`}>
        {freshness.label}
      </Badge>{" "}
      <span className="dim">
        {snapshot.parserName} · <Link to={`/artifacts/${idOf(snapshot.ref)}`}>原本</Link>
      </span>
    </li>
  );
}

function AccountCard({ account, index }: { account: ReportedAccount; index: number }): ReactNode {
  const id = `reported-account-${index}`;
  return (
    <Panel
      id={id}
      title={<SourceAccount source={account.sourceId} account={account.sourceAccount} />}
      count={
        <Badge tone={account.identityStatus === "identified" ? "ok" : "neutral"}>
          {IDENTITY[account.identityStatus]}
        </Badge>
      }
    >
      <div className="panel-body">
        <ul className="plain-list" aria-label="この口座の取得結果">
          {account.snapshots.map((snapshot) => (
            <SnapshotLine key={snapshot.ref} snapshot={snapshot} />
          ))}
        </ul>
        {account.accountId === null ? null : (
          <p className="footnote">
            口座 ID: <code>{account.accountId}</code>
          </p>
        )}
      </div>
      {account.positions.length === 0 ? null : (
        <div className="table-scroll" role="region" aria-label="保有銘柄" tabIndex={0}>
          <table className="reported-state-table">
            <caption>取得元の評価額は取得元の通貨のまま表示し、換算・合算しません。</caption>
            <thead>
              <tr>
                <th scope="col">銘柄</th>
                <th scope="col" className="num">
                  数量
                </th>
                <th scope="col">取得元の評価額</th>
              </tr>
            </thead>
            <tbody>
              {account.positions.map((position) => (
                <tr key={position.ref}>
                  <td>
                    <Link to={`/observations/position/${idOf(position.ref)}`}>
                      {position.securityCode}
                    </Link>{" "}
                    <Nullable value={position.securityName} placeholder="名称未記録" />
                  </td>
                  <td className="num">
                    {position.quantityText}
                    {position.currency === null ? null : (
                      <span className="dim"> · {position.currency}</span>
                    )}
                  </td>
                  <td>
                    {position.valuations.length === 0 ? (
                      <Nullable value={null} placeholder="評価額の報告なし" />
                    ) : (
                      <ul className="plain-list">
                        {position.valuations.map((valuation) => (
                          <li key={valuation.ref}>
                            <span className="dim">{valuation.metric}</span>{" "}
                            <SettlementQuantity value={valuation.amount} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {account.balances.length === 0 ? null : (
        <div className="table-scroll" role="region" aria-label="残高" tabIndex={0}>
          <table className="reported-state-table">
            <caption>取得元が報告した残高です。口座をまたいで合算していません。</caption>
            <thead>
              <tr>
                <th scope="col">項目</th>
                <th scope="col" className="num">
                  金額
                </th>
                <th scope="col">合算の扱い</th>
              </tr>
            </thead>
            <tbody>
              {account.balances.map((balance) => (
                <tr key={balance.ref}>
                  <td>
                    <Link to={`/observations/balance/${idOf(balance.ref)}`}>
                      {balance.providerMetric}
                    </Link>
                  </td>
                  <td className="num">
                    <SettlementQuantity value={balance.amount} />
                  </td>
                  <td>{label(AGGREGATION, balance.metric.aggregationRule)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function PayableTable({ payables }: { payables: ReportedPayable[] }): ReactNode {
  return (
    <div className="table-scroll" role="region" aria-label="カードの請求の一覧" tabIndex={0}>
      <table className="reported-state-table">
        <caption>カード会社が報告した請求額です。合算していません。</caption>
        <thead>
          <tr>
            <th scope="col">カード</th>
            <th scope="col">請求月</th>
            <th scope="col">引落予定日</th>
            <th scope="col" className="num">
              請求額
            </th>
            <th scope="col">基準日の状態</th>
            <th scope="col">引落の照合</th>
          </tr>
        </thead>
        <tbody>
          {payables.map((payable) => {
            const status = PAYABLE[payable.status];
            return (
              <tr key={payable.ref}>
                <td>
                  <SourceAccount source={payable.sourceId} account={payable.sourceAccount} />
                </td>
                <td>
                  <Nullable value={payable.period} />
                </td>
                <td>
                  <Nullable value={payable.paymentDate} placeholder="不明" />
                </td>
                <td className="num">
                  <Link to={`/observations/balance/${idOf(payable.ref)}`}>
                    <SettlementQuantity value={payable.amount} />
                  </Link>
                </td>
                <td>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </td>
                <td>
                  {payable.settlement === null ? (
                    <Nullable value={null} placeholder="照合候補なし" />
                  ) : (
                    <>
                      {SETTLEMENT_STATUS[payable.settlement.reviewStatus]}
                      {payable.settlement.debitDate === null ? null : (
                        <span className="dim"> · 出金日 {payable.settlement.debitDate}</span>
                      )}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CoverageNotes({ state }: { state: ReportedState }): ReactNode {
  const { coverage } = state;
  return (
    <Notice tone="warn" role="note">
      <p>
        <strong>この一覧は資産や負債の合計ではありません。</strong>
        取得元ごとの報告を並べたもので、合算・換算・純資産の計算はしていません。
      </p>
      {coverage.containersWithoutSnapshot.length === 0 ? null : (
        <>
          <p>
            基準日までに完全な取得結果がないため、表示していない取得元があります（0
            ではありません）。
          </p>
          <ul className="warning-list" aria-label="取得結果のない取得元">
            {coverage.containersWithoutSnapshot.map((entry) => (
              <li key={`${entry.sourceId}/${entry.parserName}/${entry.dataset}`}>
                {entry.sourceId} <span className="dim">· {entry.parserName}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {coverage.staleSnapshots.length === 0 ? null : (
        <p>
          {coverage.staleSnapshots.length}{" "}
          件の取得結果は基準日の4日以上前のものです。その後の変化は反映されていません。
        </p>
      )}
      <p>
        負債は一部だけです。次のものは含まれていません:{" "}
        {coverage.liabilitiesMissing.map((code) => label(LIABILITY_GAPS, code)).join("、")}。
      </p>
      <details className="inline-disclosure">
        <summary>対象外にしているもの</summary>
        <ul className="warning-list">
          {coverage.excluded.map((entry) => (
            <li key={entry.scope}>{label(EXCLUSIONS, entry.reasonCode)}</li>
          ))}
        </ul>
        {coverage.excludedRows.map((entry) => (
          <p key={entry.reasonCode} className="footnote">
            {label(EXCLUSIONS, entry.reasonCode)}: {entry.count} 件を一覧から除いています。
          </p>
        ))}
      </details>
    </Notice>
  );
}

export function ReportedStatePage(): ReactNode {
  const features = useFeatures();
  const today = tokyoToday();
  const [chosen, setChosen] = useViewState("reportedState.date");
  const date = chosen === "" ? today : chosen;
  const [draft, setDraft] = useState(date);
  const invalid = !DATE.test(draft) || draft > today;
  const query = useReportedState(date);
  const tooLarge = query.error instanceof ApiError && query.error.status === 413;
  if (!features.known) return <Loading label="基準日の保有状況" />;
  return (
    <>
      <div className="page-head">
        <h1>基準日の保有状況</h1>
        <p className="lede">
          基準日の終わり（日本時間）までに各取得元が報告した、最新の完全な取得結果を口座ごとに表示します。
        </p>
        <p className="footnote">
          金額は取得元の表示のままです。合算・通貨換算はしていません。取得結果のない取得元は 0
          として扱わず、下の注記に挙げます。
        </p>
      </div>
      {!features.reportedStateOnDate ? (
        <UnavailableNotice />
      ) : (
        <>
          <Panel id="reported-state-date" title="基準日を選ぶ">
            <form
              className="filter-grid"
              onSubmit={(event) => {
                event.preventDefault();
                if (invalid) return;
                setChosen(draft);
              }}
            >
              <label className="filter-field">
                基準日
                <input
                  type="date"
                  name="reported-state-date"
                  value={draft}
                  max={today}
                  aria-invalid={invalid || undefined}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <button className="button" type="submit" disabled={invalid}>
                表示する
              </button>
              {invalid ? (
                <p role="alert">基準日は今日以前の日付を 2026-09-10 のように指定してください。</p>
              ) : null}
            </form>
          </Panel>
          {tooLarge ? (
            <Notice tone="warn" role="note">
              この基準日の記録は多すぎて、一度に表示できません。一部だけの表示はしません。
            </Notice>
          ) : (
            <QueryBoundary query={query} label="基準日の保有状況">
              {(state) => (
                <>
                  <Panel id="reported-state-summary" title={`${state.date} の保有状況`}>
                    <div className="panel-body">
                      <Kv>
                        <KvRow label="対象の取得">
                          <time dateTime={state.cutoff}>{state.cutoff}</time> より前（UTC）
                        </KvRow>
                        <KvRow label="口座">{state.accounts.length} 件</KvRow>
                        <KvRow label="カードの請求">{state.payables.length} 件</KvRow>
                        <KvRow label="照会 ID">
                          <code>{state.contextId.slice(0, 12)}</code>
                        </KvRow>
                      </Kv>
                    </div>
                  </Panel>
                  <CoverageNotes state={state} />
                  {state.accounts.length === 0 ? (
                    <EmptyState>
                      <p>この基準日までに完全な取得結果のある口座はありません。</p>
                      <p>保有がないという意味ではありません。</p>
                    </EmptyState>
                  ) : (
                    state.accounts.map((account, index) => (
                      <AccountCard
                        key={`${account.sourceId}/${account.sourceAccount}`}
                        account={account}
                        index={index}
                      />
                    ))
                  )}
                  <Panel
                    id="reported-state-payables"
                    title="カードの請求"
                    count={`${state.payables.length}件`}
                    note={`引落予定日が ${state.coverage.payablesFromPaymentDate} 以降の請求と、引落予定日が不明な最近の請求です。`}
                  >
                    {state.payables.length === 0 ? (
                      <div className="panel-body">
                        <p>この期間の請求は取得されていません。</p>
                      </div>
                    ) : (
                      <PayableTable payables={state.payables} />
                    )}
                  </Panel>
                </>
              )}
            </QueryBoundary>
          )}
        </>
      )}
    </>
  );
}
