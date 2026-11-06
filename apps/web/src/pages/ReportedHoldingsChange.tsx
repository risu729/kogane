// 保有数量の変化: a panel of the 基準日の保有状況 page (/state) that sets the
// reported holdings of a chosen start date beside those of the page's date,
// per provider holding key (GET /api/v2/reported-holdings-change, ADR 0075,
// docs/reported-state.md). It shows the server's figures and computes none:
// a compared holding shows the exact change the server returned, a holding
// listed on one date only shows a status and no number (never a zero), and a
// holding that cannot be compared shows its reasons. Nothing is totalled.
import { useState, type ReactNode } from "react";
import { ApiError } from "../api.ts";
import { QuantityChange } from "../reconciliation-display.tsx";
import {
  useReportedHoldingsChange,
  type HoldingChange,
  type HoldingChangeReason,
  type HoldingChangeStatus,
  type HoldingSide,
  type HoldingsChange,
} from "../reported-holdings-change-api.ts";
import { Link } from "../router.tsx";
import {
  Badge,
  EmptyState,
  Kv,
  KvRow,
  Notice,
  Nullable,
  Panel,
  QueryBoundary,
  type Tone,
} from "../ui.tsx";
import { useViewState } from "../view-state.tsx";

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

const STATUS: Record<HoldingChangeStatus, { label: string; tone: Tone }> = {
  compared: { label: "比較済み", tone: "ok" },
  listed_at_start_only: { label: "開始日だけに記載", tone: "neutral" },
  listed_at_end_only: { label: "基準日だけに記載", tone: "neutral" },
  not_comparable: { label: "比較できません", tone: "warn" },
};
const REASON: Record<HoldingChangeReason, string> = {
  no_snapshot_at_start: "開始日までにこの取得元の完全な取得結果がありません",
  no_snapshot_at_end: "基準日までにこの取得元の完全な取得結果がありません",
  snapshot_scope_ambiguous_at_start:
    "開始日の取得範囲が複数あり、どの取得結果に載るか特定できません",
  snapshot_scope_ambiguous_at_end: "基準日の取得範囲が複数あり、どの取得結果に載るか特定できません",
  holding_key_ambiguous_at_start: "開始日の取得結果に同じ銘柄が複数行あります",
  holding_key_ambiguous_at_end: "基準日の取得結果に同じ銘柄が複数行あります",
  same_capture_both_dates: "両日とも同じ取得結果で、その間の取得がありません",
  capture_order_inverted: "基準日の取得結果が開始日の取得結果より古いものです",
  account_differs: "両日で口座の対応付けが異なります",
  instrument_differs: "両日で銘柄の対応付けが異なります",
  quantity_not_exact_at_start: "開始日の数量を正確に読み取れません",
  quantity_not_exact_at_end: "基準日の数量を正確に読み取れません",
};
const NO_FIGURE: Record<Exclude<HoldingChangeStatus, "compared">, string> = {
  listed_at_start_only: "数値なし（基準日の取得結果に記載なし）",
  listed_at_end_only: "数値なし（開始日の取得結果に記載なし）",
  not_comparable: "数値なし（比較できません）",
};
const SIDE_NAME = { start: "開始日", end: "基準日" } as const;

const label = (labels: Record<string, string>, code: string): string =>
  Object.hasOwn(labels, code) ? labels[code]! : code;
const idOf = (ref: string): string => ref.slice(ref.indexOf(":") + 1);

function SideCell({ side }: { side: HoldingSide }): ReactNode {
  switch (side.state) {
    case "listed":
      return (
        <>
          <Link to={`/observations/position/${idOf(side.positionRef)}`}>{side.quantityText}</Link>
          <span className="holdings-change-capture dim">
            取得 {side.captureDate} · <Link to={`/artifacts/${idOf(side.snapshotRef)}`}>原本</Link>
          </span>
        </>
      );
    case "not_listed":
      return (
        <>
          <Nullable value={null} placeholder="記載なし" />
          <span className="holdings-change-capture dim">
            取得 {side.captureDate} · <Link to={`/artifacts/${idOf(side.snapshotRef)}`}>原本</Link>
          </span>
        </>
      );
    case "listed_more_than_once":
      return <Nullable value={null} placeholder={`${side.positionRefs.length} 行に記載`} />;
    case "snapshot_scope_ambiguous":
      return <Nullable value={null} placeholder="取得範囲を特定できません" />;
    case "no_snapshot":
      return <Nullable value={null} placeholder="取得結果なし" />;
  }
}

function HoldingRow({ holding }: { holding: HoldingChange }): ReactNode {
  const status = STATUS[holding.status];
  return (
    <tr>
      <th scope="row">
        {holding.key.securityCode}
        {holding.key.market === null ? null : <span className="dim"> · {holding.key.market}</span>}
        <span className="holdings-change-capture dim">
          {holding.key.sourceId} · {holding.key.sourceAccount} · {holding.key.parserName}
        </span>
      </th>
      <td className="num">
        <SideCell side={holding.start} />
      </td>
      <td className="num">
        <SideCell side={holding.end} />
      </td>
      <td className="num">
        {holding.status === "compared" && holding.change !== null ? (
          <QuantityChange value={holding.change} />
        ) : (
          <Nullable
            value={null}
            placeholder={holding.status === "compared" ? "数値なし" : NO_FIGURE[holding.status]}
          />
        )}
      </td>
      <td>
        <Badge tone={status.tone}>{status.label}</Badge>
        {holding.reasons.length === 0 ? null : (
          <ul
            className="warning-list"
            aria-label={`${holding.key.securityCode} を比較できない理由`}
          >
            {holding.reasons.map((reason) => (
              <li key={reason}>{label(REASON, reason)}</li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function ChangeResult({ change }: { change: HoldingsChange }): ReactNode {
  const { coverage, counts } = change;
  return (
    <>
      <div className="panel-body">
        <Kv>
          <KvRow label="比較した日">
            {change.from} → {change.to}
          </KvRow>
          <KvRow label="銘柄">
            比較済み {counts.compared} 件 · 開始日だけ {counts.listed_at_start_only} 件 · 基準日だけ{" "}
            {counts.listed_at_end_only} 件 · 比較できない {counts.not_comparable} 件
          </KvRow>
          <KvRow label="照会 ID">
            <code>{change.contextId.slice(0, 12)}</code>
          </KvRow>
        </Kv>
        <Notice tone="warn" role="note">
          <p>
            <strong>保有数量の合計や評価額ではありません。</strong>
            取得元の銘柄ごとに、2 つの日の取得結果が報告した数量を並べています。
          </p>
          {coverage.containersWithoutSnapshot.length === 0 ? null : (
            <>
              <p>
                完全な取得結果がないため比べられない取得元があります（記載なしや 0
                ではありません）。
              </p>
              <ul className="warning-list" aria-label="比較に使える取得結果のない取得元">
                {coverage.containersWithoutSnapshot.map((entry) => (
                  <li key={`${entry.side}/${entry.sourceId}/${entry.parserName}/${entry.dataset}`}>
                    {SIDE_NAME[entry.side]}: {entry.sourceId}{" "}
                    <span className="dim">· {entry.parserName}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {coverage.staleSnapshots.length === 0 ? null : (
            <p>
              {coverage.staleSnapshots.length}{" "}
              件の取得結果はその日の4日以上前のものです。変化はその取得結果どうしの差です。
            </p>
          )}
        </Notice>
      </div>
      {change.holdings.length === 0 ? (
        <EmptyState>
          <p>どちらの日の取得結果にも記載された銘柄はありません。</p>
          <p>保有がないという意味ではありません。</p>
        </EmptyState>
      ) : (
        <div className="table-scroll" role="region" aria-label="保有数量の変化の一覧" tabIndex={0}>
          <table className="reported-state-table holdings-change-table">
            <caption>
              数量は取得元の表示のままです。変化は両日の数量が正確に読める銘柄だけに示し、合計しません。
            </caption>
            <thead>
              <tr>
                <th scope="col">銘柄</th>
                <th scope="col" className="num">
                  開始日 {change.from}
                </th>
                <th scope="col" className="num">
                  基準日 {change.to}
                </th>
                <th scope="col" className="num">
                  変化
                </th>
                <th scope="col">状態</th>
              </tr>
            </thead>
            <tbody>
              {change.holdings.map((holding) => (
                <HoldingRow key={keyOf(holding)} holding={holding} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function keyOf(holding: HoldingChange): string {
  const { key } = holding;
  return JSON.stringify([
    key.sourceId,
    key.parserName,
    key.dataset,
    key.sourceAccount,
    key.market,
    key.securityCode,
  ]);
}

/** Compares a chosen start date with `to`, the page's 基準日. */
export function HoldingsChangePanel({ to }: { to: string }): ReactNode {
  const [from, setFrom] = useViewState("reportedState.changeFrom");
  const [draft, setDraft] = useState(from);
  const invalid = !DATE.test(draft) || draft >= to;
  const request = from !== "" && from < to ? { from, to } : null;
  const query = useReportedHoldingsChange(request);
  const tooLarge = query.error instanceof ApiError && query.error.status === 413;
  return (
    <Panel
      id="reported-holdings-change"
      title="保有数量の変化"
      note="開始日と基準日のそれぞれで最新の完全な取得結果を、取得元の銘柄ごとに並べます。合計・評価額は計算しません。"
    >
      <div className="panel-body">
        <form
          className="filter-grid"
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid) return;
            setFrom(draft);
          }}
        >
          <label className="filter-field">
            比較の開始日
            <input
              type="date"
              name="holdings-change-from"
              value={draft}
              max={to}
              aria-invalid={(draft !== "" && invalid) || undefined}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button className="button" type="submit" disabled={invalid}>
            比べる
          </button>
          {draft !== "" && invalid ? (
            <p role="alert">比較の開始日は基準日（{to}）より前の日付を指定してください。</p>
          ) : null}
        </form>
      </div>
      {request === null ? (
        <div className="panel-body">
          <p className="footnote">
            開始日を選ぶと、その日から基準日までの保有数量の変化を表示します。
          </p>
        </div>
      ) : tooLarge ? (
        <Notice tone="warn" role="note">
          この期間の保有は多すぎて、一度に比べられません。一部だけの表示はしません。
        </Notice>
      ) : (
        <QueryBoundary query={query} label="保有数量の変化">
          {(change) => <ChangeResult change={change} />}
        </QueryBoundary>
      )}
    </Panel>
  );
}
