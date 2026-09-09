// Reward programmes: native quantity, buckets, observed expiry, estimate state
// and membership, each in its own block (addendum 08 §8).
//
// Three display rules are load-bearing here, not decoration.
//   * A quantity is shown in the programme's own unit. There is no yen column
//     for points and no combined total anywhere on this page.
//   * A bucket whose deadline is not confirmed stays in the deadline list as
//     「期限未確認」. It is never dropped for being undated.
//   * Confidence is written out. Every row says whether its date is
//     provider-observed or policy-estimated, and every reason code has text;
//     colour alone never carries the meaning.
import { type ReactNode } from "react";
import { EmptyState, Panel, QueryBoundary } from "../ui.tsx";
import {
  useRewardExpiry,
  useRewardHoldings,
  type RewardExpiryRow,
  type RewardHoldingRow,
  type RewardQuantity,
  type RewardTime,
} from "../rewards-api.ts";

const BUCKET_LABELS: Record<string, string> = {
  regular: "通常",
  restricted: "用途限定",
  "time-limited": "期間限定",
  "pending-award": "付与予定",
  qualification: "資格指標",
};
const STATE_LABELS: Record<string, string> = {
  computed: "規約から算定",
  partial: "情報不足のため一部のみ",
  conflict: "表示期限と算定結果が不一致",
  "needs-rule-verification": "規約未確認",
};
const BASIS_LABELS: Record<string, string> = {
  "provider-observed": "取得元の表示",
  "policy-estimated": "規約からの推定",
  unknown: "期限未確認",
};
const HOLDING_KIND_LABELS: Record<string, string> = {
  "reward-points": "ポイント",
  "prepaid-balance": "前払式残高",
};
/**
 * Every uncertainty and reason code the API can return, in words. A code with
 * no entry is still shown verbatim rather than hidden.
 */
const REASON_LABELS: Record<string, string> = {
  history_incomplete: "取得できた履歴が途中からのため、延長活動の有無を確定できません",
  history_completeness_unknown: "履歴の完全性が未確認です",
  no_qualifying_activity_observed: "期限延長の対象になる活動を観測できていません",
  rule_not_verified: "この制度の規約を確認できていません",
  rule_family_unsupported: "規約の内容を計算方法へ落とし込めていません",
  rule_out_of_force: "この規約版の有効期間外です",
  rule_bucket_kind_not_covered: "この規約はこの種類のポイントを対象にしていません",
  membership_required: "会員資格が条件に含まれます",
  membership_self_reported: "会員資格が自己申告で、取得元で確認できていません",
  membership_not_retroactive: "会員資格の適用期間が対象時点をさかのぼりません",
  membership_out_of_scope: "対象になる会員資格を確認できていません",
  deadline_zone_assumed: "期限のタイムゾーンは規約に明記がなく、仮置きです",
  provider_and_policy_differ: "取得元の表示期限と規約からの算定が異なります",
  provider_expiry_only: "取得元の表示期限だけがあり、算定との照合はできていません",
  no_expiry_under_verified_terms: "規約上、期限がないことを確認しています",
  acquisition_date_unknown: "取得日が分からないため期限を算定できません",
  activity_date_unknown: "活動日を読み取れませんでした",
  deadline_passed: "期限を過ぎています",
  qualification_measures_reported_separately: "資格指標は保有量と別に表示しています",
  unit_mismatch: "単位が異なるため合算していません",
  qualification_not_consumable: "資格指標は利用できる量ではありません",
  award_not_yet_held: "付与予定であり、まだ保有していません",
  observed_at_unparsed: "取得時刻の表記を読み取れませんでした",
};

function reasonText(code: string): string {
  return REASON_LABELS[code] ?? code;
}

function Quantity({ quantity }: { quantity: RewardQuantity }): ReactNode {
  if (quantity.value.status !== "exact")
    return (
      <span className="reward-quantity">
        <span className="reward-unknown">未確定</span>
        <span className="reward-unit">{quantity.value.reasonCode}</span>
      </span>
    );
  const { coefficient, scale } = quantity.value.value;
  const negative = coefficient.startsWith("-");
  const digits = (negative ? coefficient.slice(1) : coefficient).padStart(scale + 1, "0");
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return (
    <span className="reward-quantity">
      <strong>{`${negative ? "-" : ""}${text}`}</strong>{" "}
      {/* The unit is always shown: this number is not yen unless the unit says so. */}
      <span className="reward-unit">{quantity.unitRef}</span>
    </span>
  );
}

function Time({ time }: { time: RewardTime | null }): ReactNode {
  if (time === null) return <span className="reward-unknown">期限の表示なし</span>;
  if (time.kind === "unknown")
    return (
      <span className="reward-unknown" title={time.reasonCode}>
        期限未確認
      </span>
    );
  if (time.kind === "period")
    return (
      <span>
        {time.start} 〜 {time.end}
      </span>
    );
  return (
    <span>
      {time.value}
      {time.zone ? <span className="reward-unit"> {time.zone}</span> : null}
    </span>
  );
}

function Codes({ codes }: { codes: string[] }): ReactNode {
  if (codes.length === 0) return null;
  return (
    <ul className="reward-reasons">
      {codes.map((code) => (
        <li key={code}>{reasonText(code)}</li>
      ))}
    </ul>
  );
}

function Holding({ holding }: { holding: RewardHoldingRow }): ReactNode {
  return (
    <Panel
      title={`${holding.programRef}（${HOLDING_KIND_LABELS[holding.holdingKind] ?? holding.holdingKind}）`}
      note={
        <>
          取得元 {holding.sourceId} ／ 単位 {holding.unitRef}。
          この数量は他のプログラムや円の残高と合計していません。
        </>
      }
    >
      <div className="table-scroll">
        <table>
          <caption className="reward-caption">保有内訳</caption>
          <thead>
            <tr>
              <th scope="col">区分</th>
              <th scope="col">数量</th>
              <th scope="col">利用制限</th>
              <th scope="col">取得元が表示した期限</th>
            </tr>
          </thead>
          <tbody>
            {holding.buckets.map((bucket) => (
              <tr key={bucket.bucketRef}>
                <td>{BUCKET_LABELS[bucket.kind] ?? bucket.kind}</td>
                <td>
                  <Quantity quantity={bucket.quantity} />
                </td>
                <td>
                  {bucket.restrictionRefs.length === 0
                    ? "指定なし"
                    : bucket.restrictionRefs.join("、")}
                </td>
                <td>
                  <Time time={bucket.observedExpiry} />
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row">利用できる量の合計</th>
              <td colSpan={3}>
                <Quantity quantity={holding.consumable} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {holding.qualificationMeasures.length > 0 ? (
        <div className="reward-block">
          <h3>資格指標（利用できる量ではありません）</h3>
          <ul>
            {holding.qualificationMeasures.map((measure) => (
              <li key={measure.measureRef}>
                {measure.metricRef}: <Quantity quantity={measure.quantity} />（
                <Time time={measure.period} />）
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {holding.excluded.length > 0 ? (
        <div className="reward-block">
          <h3>合計に含めていないもの</h3>
          <ul>
            {holding.excluded.map((row) => (
              <li key={row.bucketRef}>
                {BUCKET_LABELS[row.kind] ?? row.kind}: {reasonText(row.reasonCode)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="reward-block">
        <h3>会員資格</h3>
        {holding.membership.length === 0 ? (
          <p>会員資格の記録はありません。</p>
        ) : (
          <ul>
            {holding.membership.map((state) => (
              <li key={`${state.tier}${state.source}`}>
                {state.tier}（<Time time={state.valid} />）
                {state.source === "provider" ? "取得元で確認" : "自己申告"}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="footnote">
        表示されている量を円などへ換算した金額は出していません。換金の目安は、条件・手数料・期限を伴う
        個別の交換条件を指定したときにだけ算出できます。
      </p>
    </Panel>
  );
}

function Expiry({ row }: { row: RewardExpiryRow }): ReactNode {
  return (
    <Panel
      title={row.ruleRef}
      note={
        <>
          判定: {STATE_LABELS[row.state] ?? row.state} ／ 規約の確認状況:{" "}
          {row.verification === "verified" ? "確認済み" : "未確認"} ／ 期限の基準時間帯:{" "}
          {row.deadlineZone}
          {row.deadlineZoneBasis === "assumed" ? "（規約に明記なし・仮置き）" : "（規約に明記）"}
        </>
      }
    >
      <div className="table-scroll">
        <table>
          <caption className="reward-caption">期限の内訳</caption>
          <thead>
            <tr>
              <th scope="col">対象</th>
              <th scope="col">数量</th>
              <th scope="col">期限</th>
              <th scope="col">根拠</th>
              <th scope="col">取得元の表示</th>
              <th scope="col">規約からの算定</th>
            </tr>
          </thead>
          <tbody>
            {/* Undated buckets stay in this list: an unknown deadline is a row,
              not an omission. */}
            {row.rows.map((bucket) => (
              <tr key={bucket.bucketRef}>
                <td>{bucket.bucketRef}</td>
                <td>
                  <Quantity quantity={bucket.quantity} />
                </td>
                <td>
                  <Time time={bucket.deadline} />
                </td>
                <td>{BASIS_LABELS[bucket.basis] ?? bucket.basis}</td>
                <td>
                  <Time time={bucket.providerObserved} />
                </td>
                <td>
                  <Time time={bucket.policyEstimated} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Codes codes={row.uncertaintyCodes} />
    </Panel>
  );
}

export function RewardsPage(): ReactNode {
  const holdings = useRewardHoldings();
  const expiry = useRewardExpiry();
  return (
    <>
      <div className="page-head">
        <h1>ポイント・前払式残高</h1>
        <p className="lede">
          プログラムごとの保有量、用途別の内訳、取得元が表示した期限、規約からの期限の見込み、
          会員資格、資格指標を分けて表示します。円建ての合計や純資産へは加算しません。
        </p>
      </div>
      <QueryBoundary
        query={holdings}
        label="ポイント保有"
        isEmpty={(data) => data.rows.length === 0}
        empty={<EmptyState>保有の記録がまだありません。</EmptyState>}
      >
        {(data) => (
          <>
            {data.rows.map((holding) => (
              <Holding key={`${holding.programId}${holding.holdingRef}`} holding={holding} />
            ))}
            {data.coverage.truncated ? (
              <p className="footnote">
                表示は先頭 {data.coverage.limit} 件です。残りは取得していません。
              </p>
            ) : null}
          </>
        )}
      </QueryBoundary>
      <QueryBoundary
        query={expiry}
        label="期限の見込み"
        isEmpty={(data) => data.rows.length === 0}
        empty={<EmptyState>期限を判定できる規約がまだありません。</EmptyState>}
      >
        {(data) => (
          <>
            {data.rows.map((row) => (
              <Expiry key={`${row.holdingRef}${row.ruleRef}`} row={row} />
            ))}
            <p className="footnote">
              期限が確認できない残高も一覧から外さず「期限未確認」として残しています。
              交換の可否や必要な手続きは、この画面では実行できません。
            </p>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
