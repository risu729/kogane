import { useState } from "react";
import type {
  ReadinessFamily,
  ReadinessReason,
} from "../../../packages/domain/src/economic-row-readiness.ts";
import { transactionFamilyEntry } from "../../../packages/domain/src/event-families.ts";
import type { EconomicGenerationGate } from "../../../packages/observation-shared/src/economic-readiness-contract.ts";
import type { ObservationDetail } from "./api.ts";
import { useEconomicReadiness } from "./economic-readiness-api.ts";
import { Notice, Panel } from "./ui.tsx";

const REASONS: Record<ReadinessReason, string> = {
  identity_fingerprint_only: "取得元が付けた取引番号ではなく、記録の内容から作った識別子です。",
  identity_origin_unrecorded: "取引番号の由来が記録されていません。",
  identity_digest_not_provider: "通知の内容から作った識別子のため、同じ取引か確認できません。",
  identity_resolver_missing: "この取得元の取引を識別する方法が未対応です。",
  identity_absent: "取得元の取引番号がありません。",
  duplicate_unresolved: "同じ取引かもしれない記録が未解決です。",
  alias_conflict: "同じ取引の別の表現を、別の計算用取引が参照しています。",
  identity_rekeyed: "採用後に取引の識別方法が変わりました。",
  identity_epoch_changed: "採用後に口座・取引の対応が変わりました。",
  observation_missing: "指定された記録と解析の組み合わせが見つかりません。",
  evidence_not_current: "この記録は旧解析のものです。現在の根拠として使えません。",
  evidence_restricted: "この記録の根拠は閲覧が制限されています。",
  evidence_unavailable: "この記録の根拠を利用できません。",
  family_mismatch: "この記録は照会した取引の種類に対応していません。",
  account_mapping_unresolved: "この記録がどの口座に属するか、確定していません。",
  account_mapping_ambiguous: "この記録の口座に複数の対応があり、確定できません。",
  ownership_unresolved: "口座の所有者を、この計算で確認する仕組みが未対応です。",
  economic_claim_held: "この記録はすでに別の計算用取引が参照しています。",
  identity_key_invalid: "この記録を一意に参照する情報が不完全です。",
};
const GATES: Record<EconomicGenerationGate, string> = {
  ownership_principal_contract_missing:
    "口座の所有者と操作する本人の対応を確認する仕組みが必要です。",
  writer_not_registered:
    "この診断から銀行の入出金を基に新しい計算用取引を作る機能は、まだ有効になっていません。",
  security_book_unsupported: "証券の保有数量を増減させる記録には、まだ対応していません。",
  security_selector_unsupported: "証券取引を指定時点の計算へ取り込む機能が未対応です。",
  security_event_vocabulary_missing: "証券取引の計算用の表現が、まだ定まっていません。",
  security_class_unknown: "計算に必要な証券の種類が確定していません。",
  wrapper_unknown: "計算に必要な口座区分が確定していません。",
};
const IDENTITY = {
  admitted: "識別条件を満たしています",
  blocked: "確認できません",
  unavailable: "判定できません",
} as const;

function ReadinessPanel({
  family,
  observationId,
  parseRunId,
}: {
  family: ReadinessFamily;
  observationId: number;
  parseRunId: number;
}) {
  const [opened, setOpened] = useState(false);
  const query = useEconomicReadiness(
    {
      schema: "economic-row-readiness-v1",
      family,
      knowledge: "current",
      rows: [{ observationId, parseRunId }],
    },
    opened,
  );
  const title = family === "bank-movement" ? "銀行の入出金" : "証券の約定";
  const row = query.data?.manifest.rows[0];
  return (
    <Panel id={`economic-readiness-${family}`} title={`${title}からの新しい計算用取引`}>
      <div className="panel-body">
        <p>
          この記録から新しい計算用取引を作るための条件を確認できます。既存の計算用取引で使われている場合もあります。
        </p>
        {!opened ? (
          <button className="button" type="button" onClick={() => setOpened(true)}>
            新規作成の条件を確認する
          </button>
        ) : (
          <div aria-live="polite">
            {query.isFetching ? <p role="status">新規作成の条件を確認しています。</p> : null}
            {query.isError ? (
              <Notice tone="warn">
                <p>
                  新規作成の条件を取得できませんでした。この記録と原本は引き続き確認できます。
                </p>
                <p>{query.error.message}</p>
              </Notice>
            ) : null}
            {row && query.data && !query.isError && !query.isFetching ? (
              <>
                <p>
                  <strong>記録の識別状態:</strong> {IDENTITY[row.identity]}
                </p>
                <p>
                  識別条件を満たしていても、この記録から新しい計算用取引を作成・採用できるという意味ではありません。
                </p>
                {row.reasons.length ? (
                  <ul aria-label="新規作成に向けたこの記録の確認事項">
                    {row.reasons.map((code) => (
                      <li key={code}>{REASONS[code]}</li>
                    ))}
                  </ul>
                ) : null}
                <p>
                  <strong>この機能から新しい計算用取引を作成することは、まだできません。</strong>
                  この確認では取引を作成・採用しません。
                </p>
                <ul aria-label="新規作成に必要な未対応の機能">
                  {query.data.generationGates.map((code) => (
                    <li key={code}>{GATES[code]}</li>
                  ))}
                </ul>
                <p className="footnote">
                  取引履歴がすべて取得されているかは未確認です。根拠はこのページの原本から確認できます。
                </p>
              </>
            ) : null}
          </div>
        )}
      </div>
    </Panel>
  );
}

export function EconomicReadinessPanels({ detail }: { detail: ObservationDetail }) {
  const { provenance, row } = detail;
  if (
    detail.kind !== "transaction" ||
    !provenance ||
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id < 1
  )
    return null;
  const families =
    transactionFamilyEntry(provenance.source_id, provenance.parser_name)?.families ?? [];
  const observationId = row.id;
  const supported: ReadinessFamily[] = ["bank-movement", "securities-execution"];
  return (
    <>
      {supported
        .filter((family) => families.some((entry) => entry.family === family))
        .map((family) => (
          <ReadinessPanel
            key={`${family}/${observationId}/${provenance.parse_run_id}`}
            family={family}
            observationId={observationId}
            parseRunId={provenance.parse_run_id}
          />
        ))}
    </>
  );
}
