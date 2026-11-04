import { decisionOriginLabel } from "../../../packages/observation-shared/src/decision-origin-contract.ts";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "./api.ts";
import { INSTRUMENT_HISTORY_PATH } from "../../../packages/observation-shared/src/instrument-history-contract.ts";
import type { InstrumentHistoryRead } from "../../../packages/application/src/query/instrument-history-read.ts";
import { Loading, Notice } from "./ui.tsx";

const LABELS = { mapping: "対応付け", decision: "判断", relation: "関係" } as const;

export function InstrumentHistory({ identifierId }: { identifierId: string }) {
  const [opened, setOpened] = useState(false);
  const query = useQuery({
    queryKey: ["instrument-history", identifierId],
    enabled: opened,
    retry: false,
    queryFn: ({ signal }) =>
      getJson<InstrumentHistoryRead>(
        `${INSTRUMENT_HISTORY_PATH}?${new URLSearchParams({ identifierId })}`,
        signal,
      ),
  });
  return (
    <div>
      <button
        className="button button-subtle"
        type="button"
        aria-expanded={opened}
        onClick={() => setOpened(!opened)}
      >
        {opened ? "訂正履歴を閉じる" : "訂正履歴を見る"}
      </button>
      {opened ? (
        <div>
          {query.isPending ? <Loading label="訂正履歴を読み込んでいます" /> : null}
          {query.isError ? (
            <Notice tone="bad" role="alert">
              {query.error.message}
            </Notice>
          ) : null}
          {query.data ? (
            <>
              <p className="footnote">記録順の履歴です。有効期間ごとの対応付けは未対応です。</p>
              {query.data.entries.length === 0 ? (
                <p>履歴はありません。</p>
              ) : (
                <ol className="warning-list">
                  {query.data.entries.map((entry) => (
                    <li key={`${entry.entry}:${entry.recordId}`}>
                      <strong>
                        {LABELS[entry.entry]} · 改訂 {entry.revision}
                      </strong>{" "}
                      · {entry.createdAt}
                      <p>{entry.reason || "理由の記録なし"}</p>
                      <p>
                        {decisionOriginLabel(entry.decisionOrigin, entry.method)} ·{" "}
                        {entry.decisionKind ?? entry.relationStatus ?? entry.status ?? "状態不明"}
                      </p>
                      {entry.instrumentId ? (
                        <p>
                          対応先: <code className="wrap-any">{entry.instrumentId}</code>
                        </p>
                      ) : null}
                      {entry.fromRef ? (
                        <p>
                          関係元: <code className="wrap-any">{entry.fromRef}</code>
                        </p>
                      ) : null}
                      <code className="wrap-any">{entry.recordId}</code>
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
