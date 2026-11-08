// One source account's correction history, opened on request (ADR 0077,
// amendment 2026-11-08): its mapping revisions, the decisions about that
// mapping and every relation row naming it, in the server's order. The
// browser derives no state from it; the candidate's status comes from the
// candidate read.
import { decisionOriginLabel } from "../../../packages/observation-shared/src/decision-origin-contract.ts";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "./api.ts";
import { ACCOUNT_HISTORY_PATH } from "../../../packages/observation-shared/src/account-history-contract.ts";
import type {
  AccountHistoryEntry,
  AccountHistoryRead,
} from "../../../packages/application/src/query/account-history-read.ts";
import { displayLabel } from "./labels.ts";
import { Loading, Notice } from "./ui.tsx";

const LABELS = { mapping: "対応付け", decision: "判断", relation: "関係" } as const;
const RELATION_LABELS: Readonly<Record<string, string>> = {
  connection_contains: "連携に含まれる",
  same_account: "同じ口座",
};
const STATE_LABELS: Readonly<Record<string, string>> = {
  assign: "対応付け",
  "release-override": "手動の対応付けを解除",
  propose: "提案",
  accept: "採用",
  reject: "却下・取り下げ",
  supersede: "置き換え",
  proposed: "提案のみ",
  accepted: "採用",
  rejected: "含まれないと判断",
  released: "解除",
};

function HistoryEntry({ entry }: { entry: AccountHistoryEntry }): ReactNode {
  const state = entry.relationStatus ?? entry.decisionKind ?? entry.status;
  return (
    <li>
      <strong>
        {LABELS[entry.entry]}
        {entry.relationKind ? `（${displayLabel(RELATION_LABELS, entry.relationKind)}）` : null} ·
        改訂 {entry.revision}
      </strong>{" "}
      · {entry.createdAt}
      <p>{entry.reason || "理由の記録なし"}</p>
      <p>
        {decisionOriginLabel(entry.decisionOrigin, entry.method)} ·{" "}
        {state === null ? "状態不明" : displayLabel(STATE_LABELS, state)}
      </p>
      {entry.accountId ? (
        <p>
          対応先: <code className="wrap-any">{entry.accountId}</code>
        </p>
      ) : null}
      {entry.fromRef && entry.toRef ? (
        <p>
          関係元: <code className="wrap-any">{entry.fromRef}</code> → 関係先:{" "}
          <code className="wrap-any">{entry.toRef}</code>
        </p>
      ) : null}
      <code className="wrap-any">{entry.recordId}</code>
    </li>
  );
}

export function AccountHistory({ sourceAccountId }: { sourceAccountId: string }): ReactNode {
  const [opened, setOpened] = useState(false);
  const query = useQuery({
    queryKey: ["account-history", sourceAccountId],
    enabled: opened,
    retry: false,
    queryFn: ({ signal }) =>
      getJson<AccountHistoryRead>(
        `${ACCOUNT_HISTORY_PATH}?${new URLSearchParams({ sourceAccountId })}`,
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
        {opened ? "取得元の口座の訂正履歴を閉じる" : "取得元の口座の訂正履歴を見る"}
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
              <p className="footnote">
                記録順の履歴です。以前の判断は消さず、訂正は後の記録として残ります。有効期間ごとの対応付けは未対応です。
              </p>
              {query.data.entries.length === 0 ? (
                <p>履歴はありません。</p>
              ) : (
                <ol className="warning-list">
                  {query.data.entries.map((entry) => (
                    <HistoryEntry key={`${entry.entry}:${entry.recordId}`} entry={entry} />
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
