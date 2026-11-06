// `口座の対応候補`: the account correspondence candidate review (ADR 0077).
// Which direct provider accounts a reviewed aggregator connection
// (MoneyForward) contains, on what evidence, why no same-account candidate is
// proposed, and the decisions a candidate names: accepting the containment
// (`relation.accept`) or keeping the pair apart / withdrawing an acceptance
// (`relation.reject`). A decision is planned here and approved and committed
// on the existing confirmation screen; opening that screen decides nothing.
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useFeatures } from "../api.ts";
import {
  isAccountCandidate,
  isAccountConnection,
  planAccountCandidateDecision,
  useAccountCandidates,
  type AccountCandidate,
  type AccountCandidateDecision,
  type AccountCandidateItem,
  type AccountCandidateReview,
  type AccountCandidateView,
  type AccountConnectionEntry,
  type AccountSourceFacts,
  type UnreviewedAggregatorAccount,
} from "../account-candidates-api.ts";
import { CodeList } from "../instrument-candidate-display.tsx";
import { displayLabel } from "../labels.ts";
import { Link, navigate } from "../router.tsx";
import { Badge, EmptyState, Loading, Notice, Panel, QueryBoundary } from "../ui.tsx";

const VIEWS: { view: AccountCandidateView; label: string; empty: string }[] = [
  { view: "open", label: "確認待ち", empty: "確認待ちの候補はありません。" },
  { view: "held", label: "採用を保留", empty: "採用を保留している候補はありません。" },
  { view: "decided", label: "判断済み", empty: "判断済みの候補はありません。" },
  { view: "connections", label: "連携の確認記録", empty: "連携の確認記録はありません。" },
  {
    view: "unreviewed",
    label: "未確認の連携",
    empty: "確認記録のない集約サービスの口座はありません。",
  },
];

const EVIDENCE_LABELS: Readonly<Record<string, string>> = {
  "connection-review-confirmed":
    "連携の確認記録: 集約サービス側の支店・口座番号と取得元の口座参照が一致",
};
const HOLD_LABELS: Readonly<Record<string, string>> = {
  "evidence-ineligible": "確認記録の根拠となる原本が現在の集計対象外です。",
  "direct-account-in-several-connections":
    "同じ取得元の口座が複数の連携の確認記録に含まれているため、どれにも決めていません。",
};
const SAME_ACCOUNT_LABELS: Readonly<Record<string, string>> = {
  "aggregator-account-connection-scoped":
    "集約サービスの記録は連携単位で、個別の口座を示す項目がありません",
  "several-direct-accounts": "この連携には取得元の口座が複数含まれます",
};
const STATE_LABELS: Readonly<Record<string, string>> = {
  confirmed: "同じ取得経路と確認済み",
  unresolved: "根拠不足で未確定",
  "evidence-ineligible": "根拠の原本が集計対象外",
};
const UNREVIEWED_LABELS: Readonly<Record<string, string>> = {
  "no-connection-review": "連携の確認記録がありません",
  "reference-unrecognized": "参照が連携の識別子の形式ではありません",
};

function lookupOf(page: AccountCandidateReview): (id: string) => AccountSourceFacts | undefined {
  const map = new Map(page.sourceAccounts.map((row) => [row.sourceAccountId, row]));
  return (id) => map.get(id);
}

function SourceAccount({
  role,
  id,
  facts,
}: {
  role: string;
  id: string;
  facts: AccountSourceFacts | undefined;
}): ReactNode {
  return (
    <p className="identity-card-meta">
      {role}: {facts?.label ?? "（対応付けなし）"}{" "}
      <span className="footnote">
        {facts ? `${facts.sourceId} / ${facts.producerId}` : null} <code>{id}</code>
      </span>
    </p>
  );
}

function DecisionActions({ candidate }: { candidate: AccountCandidate }): ReactNode {
  const features = useFeatures();
  const [reason, setReason] = useState("");
  const plan = useMutation({
    mutationFn: (decision: AccountCandidateDecision) =>
      planAccountCandidateDecision(candidate, decision, reason),
    onSuccess: (value) => navigate(`/confirm/${value.planId}`),
  });
  const canPlan =
    features.known && features.commands && reason.trim().length > 0 && !plan.isPending;
  const id = `reason-${candidate.candidateId.replace(/[^A-Za-z0-9_-]/gu, "-").slice(-80)}`;
  return (
    <div className="settlement-decision">
      <div className="field">
        <label htmlFor={id}>判断の理由</label>
        <textarea
          id={id}
          className="settlement-reason"
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={!features.known || !features.commands || plan.isPending}
        />
      </div>
      <div className="button-row">
        {candidate.commands.accept === null ? null : (
          <button
            className="button"
            type="button"
            disabled={!canPlan}
            onClick={() => plan.mutate("accept")}
          >
            この連携に含まれる口座として採用する内容を確認
          </button>
        )}
        {candidate.commands.reject === null ? null : (
          <button
            className="button"
            type="button"
            disabled={!canPlan}
            onClick={() => plan.mutate("reject")}
          >
            {candidate.status === "accepted"
              ? "採用を取り消す内容を確認"
              : "含まれないものとして扱う内容を確認"}
          </button>
        )}
      </div>
      {plan.isError ? (
        <Notice tone="bad" inline role="alert">
          {plan.error.message}
        </Notice>
      ) : null}
      {features.known && !features.commands ? (
        <p className="footnote">この接続先では確認操作が有効になっていません。</p>
      ) : null}
      <p className="footnote">
        次の画面で内容を確認し、承認してから確定します。確認画面を開くだけでは採用・却下しません。
      </p>
    </div>
  );
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  proposed: "未判断",
  accepted: "採用済み",
  rejected: "含まれないと判断済み",
};

function CandidateCard({
  candidate,
  lookup,
}: {
  candidate: AccountCandidate;
  lookup: (id: string) => AccountSourceFacts | undefined;
}): ReactNode {
  const direct = lookup(candidate.directSourceAccountId);
  return (
    <article className="identity-card">
      <h3 className="identity-card-title">
        {direct?.label ?? candidate.directSourceAccountId}{" "}
        <Badge tone="neutral">{displayLabel(STATUS_LABELS, candidate.status)}</Badge>
      </h3>
      <SourceAccount role="取得元の口座" id={candidate.directSourceAccountId} facts={direct} />
      {candidate.aggregatorSourceAccountIds.length === 0 ? (
        <p className="identity-card-meta">集約サービス側の口座: 記録された明細はありません</p>
      ) : (
        candidate.aggregatorSourceAccountIds.map((id) => (
          <SourceAccount key={id} role="集約サービスの連携" id={id} facts={lookup(id)} />
        ))
      )}
      <CodeList title="候補の根拠" codes={candidate.evidence} labels={EVIDENCE_LABELS} />
      <CodeList
        title="同じ口座の候補にしない理由"
        codes={candidate.sameAccount.reasons}
        labels={SAME_ACCOUNT_LABELS}
      />
      {candidate.sameAccount.recorded.length > 0 ? (
        <p className="footnote">
          同じ口座かどうかの判断が別に保存されています（
          {candidate.sameAccount.recorded.map((row) => row.status).join("、")}）。
        </p>
      ) : null}
      {candidate.hold === null ? null : (
        <Notice tone="warn" inline role="note">
          {displayLabel(HOLD_LABELS, candidate.hold)} <code>{candidate.hold}</code>
        </Notice>
      )}
      <DecisionActions candidate={candidate} />
    </article>
  );
}

function ConnectionCard({
  item,
  lookup,
}: {
  item: AccountConnectionEntry;
  lookup: (id: string) => AccountSourceFacts | undefined;
}): ReactNode {
  return (
    <article className="identity-card">
      <h3 className="identity-card-title">
        {item.label} <Badge tone="neutral">{displayLabel(STATE_LABELS, item.state)}</Badge>
      </h3>
      {item.aggregatorSourceAccountIds.map((id) => (
        <SourceAccount key={id} role="集約サービスの連携" id={id} facts={lookup(id)} />
      ))}
      {item.directSourceAccountIds.map((id) => (
        <SourceAccount key={id} role="確認記録が示す取得元の口座" id={id} facts={lookup(id)} />
      ))}
      <p className="footnote">
        確認記録 第{String(item.revision)}版。連携が同じでも、個別の口座の対応は確定していません。
      </p>
    </article>
  );
}

function UnreviewedCard({
  item,
  lookup,
}: {
  item: UnreviewedAggregatorAccount;
  lookup: (id: string) => AccountSourceFacts | undefined;
}): ReactNode {
  return (
    <article className="identity-card">
      <h3 className="identity-card-title">
        {lookup(item.sourceAccountId)?.label ?? item.sourceAccountId}{" "}
        <Badge tone="neutral">{displayLabel(UNREVIEWED_LABELS, item.reason)}</Badge>
      </h3>
      <SourceAccount
        role="集約サービスの連携"
        id={item.sourceAccountId}
        facts={lookup(item.sourceAccountId)}
      />
      <p className="footnote">名称が似ていても、取得元の口座と同じものとして扱いません。</p>
    </article>
  );
}

function Summary({ page }: { page: AccountCandidateReview }): ReactNode {
  const { summary } = page;
  return (
    <ul className="connection-counts" aria-label="候補の件数">
      <li className="connection-count">
        確認待ち <span className="count">{summary.candidates.proposed - summary.held}</span>
      </li>
      <li className="connection-count">
        採用を保留 <span className="count">{summary.held}</span>
      </li>
      <li className="connection-count">
        採用済み <span className="count">{summary.candidates.accepted}</span>
      </li>
      <li className="connection-count">
        含まれないと判断済み <span className="count">{summary.candidates.rejected}</span>
      </li>
      <li className="connection-count">
        確認済みの連携 <span className="count">{summary.connections.confirmed}</span>
      </li>
      <li className="connection-count">
        根拠不足の連携 <span className="count">{summary.connections.unresolved}</span>
      </li>
      <li className="connection-count">
        根拠が集計対象外の連携{" "}
        <span className="count">{summary.connections["evidence-ineligible"]}</span>
      </li>
      <li className="connection-count">
        未確認の連携 <span className="count">{summary.unreviewedAggregatorAccounts}</span>
      </li>
    </ul>
  );
}

function itemKey(item: AccountCandidateItem): string {
  if (isAccountCandidate(item)) return item.candidateId;
  if (isAccountConnection(item)) return item.connectionRef;
  return item.sourceAccountId;
}

export function AccountCandidatesPage(): ReactNode {
  const features = useFeatures();
  const [view, setView] = useState<AccountCandidateView>("open");
  const [offset, setOffset] = useState(0);
  const query = useAccountCandidates(view, offset);
  const current = VIEWS.find((entry) => entry.view === view)!;
  if (!features.known) return <Loading label="口座の対応候補" />;
  return (
    <>
      <div className="page-head">
        <h1>口座の対応候補</h1>
        <p className="lede">
          集約サービス（Money
          Forward）の連携と、取得元から直接取得した口座の対応を、保存された連携の確認記録だけから示します。候補は自動採用されません。
        </p>
        <p className="footnote">
          名称や金額の近さは根拠にしません。連携に含まれることを採用しても、同じ口座とはみなさず、残高や明細を合算・置換しません。
          <Link to="/identities">口座・銘柄の整理に戻る</Link>
        </p>
      </div>
      {!features.identities ? (
        <EmptyState>この接続先は口座の整理を提供していません。</EmptyState>
      ) : (
        <Panel id="account-candidates" title={current.label}>
          <div className="panel-body">
            <div className="tab-row" role="group" aria-label="候補の種類">
              {VIEWS.map((entry) => (
                <button
                  key={entry.view}
                  type="button"
                  className="button"
                  aria-pressed={view === entry.view}
                  onClick={() => {
                    setView(entry.view);
                    setOffset(0);
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          <QueryBoundary query={query} label="口座の対応候補" coverageNotice={false}>
            {(page) => {
              const lookup = lookupOf(page);
              return (
                <>
                  <div className="panel-body">
                    <Summary page={page} />
                  </div>
                  {page.items.length === 0 ? (
                    <div className="panel-body">
                      <EmptyState>{current.empty}</EmptyState>
                    </div>
                  ) : (
                    <div className="identity-grid">
                      {page.items.map((item) =>
                        isAccountCandidate(item) ? (
                          <CandidateCard key={itemKey(item)} candidate={item} lookup={lookup} />
                        ) : isAccountConnection(item) ? (
                          <ConnectionCard key={itemKey(item)} item={item} lookup={lookup} />
                        ) : (
                          <UnreviewedCard key={itemKey(item)} item={item} lookup={lookup} />
                        ),
                      )}
                    </div>
                  )}
                  <nav className="pagination" aria-label="候補のページ">
                    <span role="status" aria-live="polite">
                      {page.total === 0
                        ? "0 件"
                        : `${String(offset + 1)}–${String(offset + page.items.length)} 件目 / ${String(page.total)} 件`}
                    </span>
                    <button
                      className="button"
                      type="button"
                      disabled={offset === 0}
                      onClick={() => setOffset(0)}
                    >
                      先頭に戻る
                    </button>
                    <button
                      className="button"
                      type="button"
                      disabled={page.nextOffset === null}
                      onClick={() =>
                        page.nextOffset === null ? undefined : setOffset(page.nextOffset)
                      }
                    >
                      次の候補
                    </button>
                  </nav>
                </>
              );
            }}
          </QueryBoundary>
        </Panel>
      )}
    </>
  );
}
