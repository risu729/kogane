// The ホーム page's 判断待ち panel (ADR 0126): what waits for the owner's
// decision, one line per kind, read from `GET /api/v2/decisions/pending` (the
// same service as `kogane.decisions.pending`). `getJson` checks its shape
// before it renders. The panel counts nothing and decides nothing: each line
// links to the page that shows and decides its items. The panel reads the
// route only where `/api/meta` advertises it (`pendingDecisions`), so a store
// without it (the local evidence browser) is never probed. The route is the
// operator's; for anyone else the panel is not shown.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, getJson, useFeatures } from "./api.ts";
import type {
  PendingDecisionKind,
  PendingDecisionLine,
  PendingDecisions,
} from "../../../packages/domain/src/pending-decisions.ts";
import { PENDING_DECISIONS_PATH } from "../../../packages/observation-shared/src/pending-decisions-contract.ts";
import { Link } from "./router.tsx";
import { Badge, Panel } from "./ui.tsx";

function usePendingDecisions(advertised: boolean) {
  return useQuery({
    queryKey: ["decisions", "pending"],
    enabled: advertised,
    // getJson checks the shape (`validApiResponse`) before anything renders.
    queryFn: ({ signal }) => getJson<PendingDecisions>(PENDING_DECISIONS_PATH, signal),
    retry: false,
  });
}

const KIND_LABELS: Record<PendingDecisionKind, string> = {
  "card-settlement.statement": "カード請求と引落の照合",
  "card-ownership.account": "照合に必要な口座の所有者",
  "account-candidate.open": "口座の対応候補",
  "account-candidate.held": "口座の対応候補（保留中）",
  "instrument-candidate.open": "銘柄の同一性の候補",
  "instrument-candidate.held": "銘柄の同一性の候補（保留中）",
  "pending-posted.link": "カード利用の速報と確定の対応",
  "maintenance-survey.proposal": "メンテナンス情報の再調査の提案",
  "change-plan.open": "承認待ちの変更計画",
};
const UNAVAILABLE: Record<string, string> = {
  budget_exceeded: "件数が上限を超えるため数えられません",
  unauthorized: "この権限では数えられません",
  not_served: "この環境では提供されていません",
};

/** The handler's page, with the first id where the page names one, else the list. */
function pageOf(line: PendingDecisionLine): string {
  const { page } = line.handler;
  if (!page.includes("{id}")) return page;
  const first = line.ids[0];
  if (first !== undefined) return page.replace("{id}", encodeURIComponent(first));
  // A plan has no list page; a settlement's page lists every statement.
  return page.startsWith("/reconciliation/") ? "/reconciliation" : "/";
}

function Line({ line }: { line: PendingDecisionLine }): ReactNode {
  const label = KIND_LABELS[line.kind];
  if (line.state === "unavailable")
    return (
      <li>
        {label}: <Badge tone="warn">{UNAVAILABLE[line.reason ?? ""] ?? line.reason}</Badge>
      </li>
    );
  const count = line.count ?? 0;
  return (
    <li>
      {label}:{" "}
      <Badge tone={count > 0 ? "warn" : "ok"}>
        {count}件{line.complete ? "" : "以上"}
      </Badge>
      {line.oldestAt !== null ? (
        <span className="dim"> 最も古い提案 {line.oldestAt.slice(0, 10)}</span>
      ) : null}
      {count > 0 && pageOf(line) !== "/" ? (
        <>
          {" "}
          <Link to={pageOf(line)}>確認する →</Link>
        </>
      ) : null}
    </li>
  );
}

export function PendingDecisionsPanel(): ReactNode {
  const features = useFeatures();
  const query = usePendingDecisions(features.pendingDecisions);
  // A store that does not advertise the route (the local evidence browser),
  // or not the operator (the route is theirs): the panel is not shown.
  if (!features.pendingDecisions) return null;
  if (query.error instanceof ApiError && (query.error.status === 403 || query.error.status === 404))
    return null;
  const waiting =
    query.data?.kinds.reduce(
      (sum, line) => sum + (line.state === "counted" ? (line.count ?? 0) : 0),
      0,
    ) ?? null;
  // A line cut at its bound, or one that could not be counted (other than a
  // kind this deployment does not serve), leaves the total a lower bound, so
  // it says so rather than reading as complete (INV05).
  const atLeast =
    query.data?.kinds.some((line) =>
      line.state === "counted" ? !line.complete : line.reason !== "not_served",
    ) ?? false;
  return (
    <Panel
      id="pending-decisions"
      title="判断待ち"
      count={waiting === null ? undefined : `${waiting}件${atLeast ? "以上" : ""}`}
      note="提案された対応や変更のうち、まだ判断していないものです。判断は各ページで行います。"
    >
      {query.isPending ? (
        <p className="dim">読み込んでいます…</p>
      ) : query.error ? (
        <p className="dim">判断待ちの件数を読み込めませんでした。</p>
      ) : (
        <ul>
          {query.data.kinds.map((line) => (
            <Line key={line.kind} line={line} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
