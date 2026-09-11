// The latest-balance read model (review D10/D11). One fixed snapshot, paged
// by an opaque cursor, with the adoption state and its reason code written as
// text rather than signalled by colour alone.
//
// Two counts are deliberately different on this screen: how many balances are
// shown, and how many pieces of evidence back them (addendum 11 section 4).
// A measurement with two witnesses is one balance and two pieces of evidence,
// and this page never calls the second number a balance.
import { useState, type ReactNode } from "react";
import {
  useLatestBalances,
  type BalanceAdoptionState,
  type LatestBalanceItem,
  type LatestBalancePage,
} from "../api.ts";
import type { MeasureView } from "../../../../packages/observation-shared/src/api-schema.ts";
import { Amount, Badge, Nullable, ObservationLink, Panel, QueryBoundary } from "../ui.tsx";
import { OrganizedSourceAccount } from "../organization.tsx";
import { balanceMeaning } from "../balance-display.tsx";

/** Every state is named in words; the badge never carries the meaning alone. */
const ADOPTION_LABELS: Record<BalanceAdoptionState, { label: string; note: string }> = {
  adopted: {
    label: "採用",
    note: "この範囲の集計に採用された測定です。",
  },
  excluded: {
    label: "除外",
    note: "同じ範囲を説明する別の記録が採用されたため、二重計上を避けて除外しました。",
  },
  unresolved: {
    label: "未解決",
    note: "他の記録と範囲が重なる可能性を確認できないため、採用も除外もしていません。",
  },
  conflict: {
    label: "不一致",
    note: "同じ測定を示すはずの記録どうしで金額または根拠が一致していません。",
  },
  stale: {
    label: "更新なし",
    note: "直近の取得でこの範囲を観測できていません。以前の記録をそのまま表示しています。",
  },
};

/** Reason codes shown as text; an unknown code is displayed, never hidden. */
const REASON_LABELS: Record<string, string> = {
  covered_by_breakdown: "内訳の合計が同じ範囲を説明しているため",
  covered_by_total: "総額が同じ範囲を説明しているため",
  duplicate_evidence: "同じ測定の別の証拠として束ねたため",
  conflict_resolved_by_rank: "取得元の優先順位で採用先を決めたため",
  metric_mismatch: "対象の指標が異なるため",
  unit_mismatch: "単位が異なるため",
  overlap_unknown: "他の記録と範囲が重なるかどうか未確認のため",
  overlap_declared: "他の記録と範囲が重なると記録されているため",
  total_breakdown_mismatch: "総額と内訳が一致しないため",
  conflicting_evidence: "同じ測定の証拠どうしで金額が一致しないため",
  value_not_exact: "金額を正確な数値として読み取れないため",
  coverage_partial: "取得範囲が途中までのため",
  coverage_unknown: "取得範囲が不明のため",
  witness_value_conflict: "同じ測定の別欄と金額が一致しないため",
  adoption_target_oversized: "同時に比較すべき対象が多すぎて判定を保留したため",
  no_new_observation: "直近の取得で新しい観測が得られなかったため",
  partial_membership: "直近の取得が対象範囲の一部しか読めていないため",
  window_absence_only: "期間内に該当がないだけで、保有の消滅を意味しないため",
  coverage_unknown_claim: "取得範囲の申告が不明のため",
};

const reasonText = (code: string | null): string | null =>
  code === null ? null : (REASON_LABELS[code] ?? code);

export function BalancesLatestPage({ view = "balances" }: { view?: MeasureView }): ReactNode {
  // The cursor is opaque and belongs to one snapshot; clearing it is the
  // "read the newest snapshot" action rather than a silent switch.
  const [cursor, setCursor] = useState<string | null>(null);
  const [trail, setTrail] = useState<(string | null)[]>([]);
  const query = useLatestBalances(view, cursor);
  return (
    <QueryBoundary query={query} label="最新の残高">
      {(page) => (
        <LatestBody
          page={page}
          canGoBack={trail.length > 0}
          onNext={() => {
            if (page.page.nextCursor === null) return;
            setTrail([...trail, cursor]);
            setCursor(page.page.nextCursor);
          }}
          onBack={() => {
            setCursor(trail[trail.length - 1] ?? null);
            setTrail(trail.slice(0, -1));
          }}
          onRefresh={() => {
            setTrail([]);
            setCursor(null);
          }}
        />
      )}
    </QueryBoundary>
  );
}

function LatestBody({
  page,
  canGoBack,
  onNext,
  onBack,
  onRefresh,
}: {
  page: LatestBalancePage;
  canGoBack: boolean;
  onNext: () => void;
  onBack: () => void;
  onRefresh: () => void;
}): ReactNode {
  const evidence = page.items.reduce((total, item) => total + item.adoption.evidenceCount, 0);
  return (
    <>
      <section className="panel" aria-label="この一覧の範囲">
        <div className="panel-body">
          <p className="footnote">
            残高 {page.items.length}件 / 根拠となる記録 {evidence}件。 根拠の件数は残高の件数では
            ありません。
          </p>
          <p className="footnote">
            データの完全性:{" "}
            {page.dataCoverage.completeness === "complete"
              ? "この範囲で未解決の記録はありません"
              : page.dataCoverage.completeness === "partial"
                ? "未解決または更新のない記録があります"
                : "取得範囲が不明です"}
            {page.dataCoverage.stale ? " / 直近の取得で更新できていない記録があります" : ""}
          </p>
          {page.dataCoverage.reasons.length ? (
            <ul className="footnote">
              {page.dataCoverage.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <Subtotals page={page} />
        </div>
      </section>
      <Panel
        id="latest-balances-v2"
        title="項目ごとの最新の記録"
        count={`このページ ${page.items.length}件`}
        note="一つの固定スナップショットを順に読んでいます。読んでいる間に新しい解析が終わっても、この一覧の内容は変わりません。"
      >
        <div className="table-scroll" role="region" aria-label="最新の残高" tabIndex={0}>
          <table className="balance-table">
            <caption>
              金額・日時は保存された表記です。採用・除外はこの範囲の集計についての判断であり、
              金額の正しさの評価ではありません。
            </caption>
            <thead>
              <tr>
                <th scope="col" className="col-source">
                  取得元・口座
                </th>
                <th scope="col" className="col-metric">
                  残高の種類
                </th>
                <th scope="col" className="col-amount num">
                  金額
                </th>
                <th scope="col" className="col-dates">
                  時点
                </th>
                <th scope="col" className="col-lineage">
                  採用状態
                </th>
                <th scope="col" className="col-detail">
                  記録
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.length ? (
                page.items.map((item) => <ItemRow key={item.observationId} item={item} />)
              ) : (
                <tr>
                  <td colSpan={6}>
                    表示対象の記録がありません。金額がゼロであることを意味しません。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="pagination" aria-label="表示ページ">
        <span role="status" aria-live="polite">
          {page.page.hasMore ? "続きがあります" : "最後のページです"}
        </span>
        <button className="button" type="button" disabled={!canGoBack} onClick={onBack}>
          前へ
        </button>
        <button className="button" type="button" disabled={!page.page.hasMore} onClick={onNext}>
          次へ
        </button>
        <button className="button" type="button" onClick={onRefresh}>
          最新の状態に更新
        </button>
      </div>
    </>
  );
}

function Subtotals({ page }: { page: LatestBalancePage }): ReactNode {
  const subtotal = page.subtotals.knownAssetsSubtotal;
  if (subtotal === null)
    return (
      <p className="footnote">
        把握できている資産の小計は出していません（{page.subtotals.reasonCode ?? "理由未記録"}）。
      </p>
    );
  if (subtotal.length === 0) return null;
  return (
    <div>
      <p className="footnote">
        把握できている資産の小計（単位ごと）。負債の取得状況は不明のため、純資産ではありません。
      </p>
      <ul className="footnote">
        {subtotal.map((total) => (
          <li key={total.unitRef}>
            {total.unitRef}: {decimalText(total.coefficient, total.scale)}（採用{" "}
            {total.adoptedCount}件）
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Plain decimal text; formatting never changes the stored value. */
function decimalText(coefficient: string, scale: number): string {
  if (scale === 0) return coefficient;
  const negative = coefficient.startsWith("-");
  const digits = (negative ? coefficient.slice(1) : coefficient).padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
}

function ItemRow({ item }: { item: LatestBalanceItem }): ReactNode {
  const adoption = ADOPTION_LABELS[item.adoption.state];
  const reason = reasonText(item.adoption.reasonCode);
  return (
    <tr>
      <td className="col-source">
        <OrganizedSourceAccount
          source={item.row.source_id}
          account={item.row.source_account}
          organization={item.row.organization}
        />
      </td>
      <td className="col-metric">
        {balanceMeaning(item.row).label} <Badge>{item.row.instrument}</Badge>
        <div className="table-secondary">{item.row.metric}</div>
        <div className="table-secondary">
          指標: {item.metric.metricId}（{item.metric.measurementKind} /{" "}
          {item.metric.aggregationRule}）
        </div>
      </td>
      <td className="col-amount num">
        <Amount
          minor={item.row.amount_minor}
          unit={item.row.instrument}
          text={item.row.amount_text}
        />
      </td>
      <td className="col-dates">
        <dl className="record-dates">
          <dt>基準日</dt>
          <dd>
            <Nullable value={item.row.as_of} />
          </dd>
          <dt>精度</dt>
          <dd>{String(item.temporal.time.kind ?? "unknown")}</dd>
        </dl>
      </td>
      <td className="col-lineage">
        <div>{adoption.label}</div>
        <div className="table-secondary">{adoption.note}</div>
        {reason ? <div className="table-secondary">理由: {reason}</div> : null}
        {item.freshness.state !== "current" ? (
          <div className="table-secondary">
            鮮度: {item.freshness.state}
            {item.freshness.reasonCode ? `（${reasonText(item.freshness.reasonCode)}）` : ""}
          </div>
        ) : null}
      </td>
      <td className="col-detail">
        <ObservationLink kind="balance" id={item.observationId}>
          詳細
        </ObservationLink>
        <details className="balance-evidence">
          <summary>根拠 {item.adoption.evidenceCount}件</summary>
          <ul>
            {item.adoption.memberEvidence.map((member) => (
              <li key={member.ref}>
                <ObservationLink kind="balance" id={member.observationId}>
                  記録 #{member.observationId}
                </ObservationLink>{" "}
                <span className="table-secondary">{member.metric}</span>
              </li>
            ))}
          </ul>
        </details>
      </td>
    </tr>
  );
}
