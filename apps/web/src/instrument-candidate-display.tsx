import { InstrumentHistory } from "./InstrumentHistory.tsx";
// How the instrument candidate review names its closed codes (ADR 0055).
// Every code the server sends is one of the manifest's; an unknown one is
// shown as itself (`displayLabel`), never dropped. A gap is shown as what is
// not known, never as agreement: missing is a reason, not a match.
import type { ReactNode } from "react";
import { displayLabel } from "./labels.ts";
import type { ResolutionIdentifier, ReviewCandidate } from "./instrument-candidates-api.ts";
import { Badge, Kv, KvRow, type Tone } from "./ui.tsx";

export const EVIDENCE_LABELS: Readonly<Record<string, string>> = {
  "isin-equal": "ISINが一致",
  "ric-equal": "RICが一致",
  "security-code-equal": "国と銘柄コードが一致",
};

export const AGREEMENT_LABELS: Readonly<Record<string, string>> = {
  "kind-agrees": "種別が一致",
  "country-agrees": "国が一致",
  "market-agrees": "市場（MIC・RIC）が一致",
  "currency-agrees": "通貨が一致",
  "share-class-agrees": "クラスが一致",
  "product-class-agrees": "商品区分が一致",
};

export const CONFLICT_LABELS: Readonly<Record<string, string>> = {
  "kind-differs": "種別が異なる",
  "isin-differs": "ISINが異なる",
  "ric-differs": "RICが異なる（別の上場）",
  "country-differs": "国が異なる",
  "market-differs": "市場（MIC）が異なる",
  "currency-differs": "通貨が異なる",
  "share-class-differs": "クラスが異なる",
  "product-class-differs": "商品区分が異なる",
};

export const GAP_LABELS: Readonly<Record<string, string>> = {
  "isin-unconfirmed": "ISINを確認できない",
  "market-unconfirmed": "市場を確認できない",
  "currency-unconfirmed": "通貨を確認できない",
  "share-class-unconfirmed": "クラスを確認できない",
  "product-class-unconfirmed": "商品区分を確認できない",
};

export const HOLD_LABELS: Readonly<Record<string, string>> = {
  "subject-decided-elsewhere":
    "対象の識別子は、すでに手動で別の銘柄に対応付けられています。採用は、その判断の訂正になるため候補からは計画できません。",
  "subject-shares-instrument":
    "対象の識別子は、ほかの識別子と同じ銘柄に対応しています。採用するとその対応を分けることになるため、候補からは計画できません。",
};

const STATUS: Readonly<Record<string, { label: string; tone: Tone }>> = {
  proposed: { label: "確認待ち", tone: "neutral" },
  adopted: { label: "同じ銘柄として採用済み", tone: "ok" },
  rejected: { label: "別の銘柄と判断済み", tone: "neutral" },
};

const IDENTIFIER_STATE_LABELS: Readonly<Record<string, string>> = {
  "unresolved-candidates": "未判断の候補あり",
  "resolved-by-decision": "判断により同じ銘柄",
  "shared-without-decision": "判断の記録なしで同じ銘柄（要確認）",
  "kept-separate": "別の銘柄と判断済み",
  "no-candidate": "候補なし",
};

export function CandidateStatus({ candidate }: { candidate: ReviewCandidate }): ReactNode {
  const status = STATUS[candidate.status] ?? { label: candidate.status, tone: "warn" as const };
  return (
    <>
      <Badge tone={status.tone}>{status.label}</Badge>
      {candidate.hold === null ? null : <Badge tone="warn">採用を保留</Badge>}
    </>
  );
}

/** One list of codes under a heading; nothing when the list is empty. */
export function CodeList({
  title,
  codes,
  labels,
}: {
  title: string;
  codes: readonly string[];
  labels: Readonly<Record<string, string>>;
}): ReactNode {
  if (codes.length === 0) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="warning-list">
        {codes.map((code) => (
          <li key={code}>
            {displayLabel(labels, code)} <code>{code}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * What one side of a pair rests on: the identifier the identity rule stored,
 * the sources that use it, the currencies its uses state, and where its
 * mapping stands. The label is the mapping's display name, which the identity
 * pages already show; it is never evidence.
 */
export function IdentifierSide({
  role,
  identifier,
  id,
}: {
  role: string;
  identifier: ResolutionIdentifier | undefined;
  id: string;
}): ReactNode {
  if (identifier === undefined)
    return (
      <Kv>
        <KvRow label={role}>
          <code className="wrap-any">{id}</code>
        </KvRow>
      </Kv>
    );
  return (
    <Kv>
      <KvRow label={role}>
        <strong>{identifier.label}</strong>
      </KvRow>
      <KvRow label="識別子">
        <code className="wrap-any">
          {identifier.namespace} / {identifier.scope || "—"} / {identifier.value}
        </code>
      </KvRow>
      <KvRow label="種別">{identifier.kind}</KvRow>
      <KvRow label="取得元">{identifier.sources.join("、")}</KvRow>
      <KvRow label="通貨">
        {identifier.currencies.length === 0 ? "記載なし" : identifier.currencies.join("、")}
        {identifier.currencyUnconfirmed ? (
          <>
            {" "}
            <Badge tone="warn">確認できない記録あり</Badge>
          </>
        ) : null}
      </KvRow>
      <KvRow label="対応付け">
        {identifier.mappingMethod === "manual" ? "手動" : "自動方針"} · 改訂{" "}
        {identifier.mappingRevision}
      </KvRow>
      <KvRow label="状態">{displayLabel(IDENTIFIER_STATE_LABELS, identifier.state)}</KvRow>
      <KvRow label="参照ID">
        <code className="wrap-any">{identifier.identifierId}</code>
      </KvRow>
      <KvRow label="訂正履歴">
        <InstrumentHistory identifierId={identifier.identifierId} />
      </KvRow>
    </Kv>
  );
}
