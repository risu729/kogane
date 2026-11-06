// Labels and small display pieces for the fixed report pages. Nothing here
// adds, converts or rounds an amount: a stored exact decimal is widened to
// minor units by string manipulation and handed to the shared formatter, and
// a decimal that has more places than its unit's minor unit is shown verbatim
// rather than rounded.
import type { ReactNode } from "react";
import { decimalToString, type ExactDecimal } from "../../../packages/domain/src/values.ts";
import type { Replayability } from "../../../packages/domain/src/context.ts";
import type { ResultPartition, UnvaluedReason } from "../../../packages/domain/src/calculation.ts";
import type { ReportEventKind, ReportPurpose } from "../../../packages/domain/src/reports.ts";
import { minorUnitExponent } from "./money.ts";
import { Amount, Badge, type Tone } from "./ui.tsx";
import { Link } from "./router.tsx";

export const PURPOSE_LABELS: Record<ReportPurpose, string> = {
  "holdings-view": "保有資産の評価",
};

const PARTITION_LABELS: Record<ResultPartition, string> = {
  complete: "すべて評価済み",
  "partial-verified-scope": "確認できた範囲のみ評価",
  "not-computable": "評価できた保有資産なし",
};

const PARTITION_TONES: Record<ResultPartition, Tone> = {
  complete: "ok",
  "partial-verified-scope": "warn",
  "not-computable": "bad",
};

const REPLAYABILITY_LABELS: Record<Replayability, string> = {
  replayable: "入力から再計算できる",
  "artifact-preserved": "保存内容のみ（入力からは再計算できない）",
  restricted: "根拠の利用が制限されている",
  unavailable: "保存内容を読み出せない",
};

const REPLAYABILITY_TONES: Record<Replayability, Tone> = {
  replayable: "ok",
  "artifact-preserved": "neutral",
  restricted: "bad",
  unavailable: "bad",
};

/** Why a holding has no value. Every reason is shown in words, never as 0. */
export const UNVALUED_LABELS: Record<UnvaluedReason, string> = {
  "missing-quantity": "数量を確定できない",
  "unresolved-identity": "銘柄を特定できない",
  overlap: "対象範囲が重複している",
  "stale-price": "価格が古い",
  "missing-price": "同じ取得結果の価格がない",
  "unsupported-instrument": "評価方法が未対応",
  "incomplete-liabilities": "負債が揃っていない",
};

export const EVENT_LABELS: Record<ReportEventKind, string> = {
  generated: "作成",
  confirmed: "確認",
  shared: "共有",
  submitted: "提出",
  corrected: "訂正版を作成",
  superseded: "置き換え",
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  building: "作成中",
  complete: "完了",
  failed: "失敗",
};

const METRIC_LABELS: Record<string, string> = {
  "holdings.valuation": "保有評価額",
};

export function metricLabel(metric: string): string {
  return Object.hasOwn(METRIC_LABELS, metric) ? METRIC_LABELS[metric]! : metric;
}

/**
 * The exact decimal as integer minor units of `unit`, or null when the unit
 * has no known minor unit or the value has places the minor unit cannot hold
 * (then the decimal is shown as written, never rounded). String work only.
 */
export function reportAmountMinor(value: ExactDecimal, unit: string): string | null {
  const exponent = minorUnitExponent(unit);
  if (exponent === undefined) return null;
  const negative = value.coefficient.startsWith("-");
  const digits = negative ? value.coefficient.slice(1) : value.coefficient;
  let minor: string;
  if (value.scale <= exponent) {
    minor = digits + "0".repeat(exponent - value.scale);
  } else {
    const drop = value.scale - exponent;
    // Only trailing zeros may go: 1.50 JPY is not 1 JPY or 2 JPY.
    if (digits.length <= drop || !/^0+$/u.test(digits.slice(-drop))) return null;
    minor = digits.slice(0, -drop);
  }
  return negative ? `-${minor}` : minor;
}

/** A stored exact amount, through the shared formatter. */
export function ReportAmount({ value, unit }: { value: ExactDecimal; unit: string }): ReactNode {
  return (
    <Amount
      minor={reportAmountMinor(value, unit)}
      unit={unit}
      text={decimalToString(value)}
      neutral
    />
  );
}

export function PartitionBadge({ partition }: { partition: ResultPartition }): ReactNode {
  return <Badge tone={PARTITION_TONES[partition]}>{PARTITION_LABELS[partition]}</Badge>;
}

export function ReplayabilityBadge({ replayability }: { replayability: Replayability }): ReactNode {
  return (
    <Badge tone={REPLAYABILITY_TONES[replayability]}>{REPLAYABILITY_LABELS[replayability]}</Badge>
  );
}

const CLAIM_REF = /^(position|valuation|balance|transaction)_observations\/([1-9][0-9]{0,15})#/u;

/**
 * A price's source claim (`<kind>_observations/<id>#<json path>`): the
 * observation it was read from is linked, and the whole reference is kept.
 */
export function ClaimRef({ value }: { value: string }): ReactNode {
  const match = CLAIM_REF.exec(value);
  return (
    <>
      <code className="wrap-any">{value}</code>
      {match ? (
        <>
          {" "}
          <Link to={`/observations/${match[1]}/${match[2]}`}>観測記録を開く</Link>
        </>
      ) : null}
    </>
  );
}
