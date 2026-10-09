// `銘柄の同一性の候補`: the instrument candidate review (ADR 0055, amendment
// 2026-10-09). Which stored identifiers may denote the same instrument, on
// what evidence, which are kept apart and why, and the two decisions a
// candidate names: adopting it (`identity.assign`) or keeping the pair apart
// (`relation.reject` of `listed_as`). A decision is planned here and approved
// and committed on the existing confirmation screen; opening that screen
// decides nothing.
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useFeatures } from "../api.ts";
import {
  isCandidate,
  isSeparated,
  planCandidateDecision,
  useInstrumentCandidates,
  type CandidateDecision,
  type InstrumentCandidateReview,
  type InstrumentCandidateView,
  type ResolutionIdentifier,
  type ReviewCandidate,
  type ReviewItem,
} from "../instrument-candidates-api.ts";
import {
  AGREEMENT_LABELS,
  CandidateStatus,
  CodeList,
  CONFLICT_LABELS,
  EVIDENCE_LABELS,
  GAP_LABELS,
  HOLD_LABELS,
  IdentifierSide,
} from "../instrument-candidate-display.tsx";
import { displayLabel } from "../labels.ts";
import { Link, navigate } from "../router.tsx";
import { Badge, EmptyState, Loading, Notice, Panel, QueryBoundary } from "../ui.tsx";

const VIEWS: { view: InstrumentCandidateView; label: string; empty: string }[] = [
  { view: "open", label: "確認待ち", empty: "確認待ちの候補はありません。" },
  { view: "held", label: "採用を保留", empty: "採用を保留している候補はありません。" },
  { view: "decided", label: "判断済み", empty: "判断済みの候補はありません。" },
  {
    view: "separated",
    label: "別の銘柄",
    empty: "値は共通でも別の銘柄と示されている組はありません。",
  },
  { view: "hints", label: "名称のみ一致", empty: "名称だけが一致する組はありません。" },
];

function byId(page: InstrumentCandidateReview): (id: string) => ResolutionIdentifier | undefined {
  const map = new Map(page.identifiers.map((row) => [row.identifierId, row]));
  return (id) => map.get(id);
}

function DecisionActions({
  candidate,
  anchor,
  subject,
}: {
  candidate: ReviewCandidate;
  anchor: ResolutionIdentifier | undefined;
  subject: ResolutionIdentifier | undefined;
}): ReactNode {
  const features = useFeatures();
  const [reason, setReason] = useState("");
  const plan = useMutation({
    mutationFn: (decision: CandidateDecision) =>
      planCandidateDecision(candidate, decision, reason, { anchor, subject }),
    onSuccess: (value) => navigate(`/confirm/${value.planId}`),
  });
  if (candidate.commands === null) return null;
  const canPlan =
    features.known && features.commands && reason.trim().length > 0 && !plan.isPending;
  const id = `reason-${candidate.candidateId.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
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
        {candidate.hold !== null || candidate.commands.adopt === null ? null : (
          <button
            className="button"
            type="button"
            disabled={!canPlan}
            onClick={() => plan.mutate("adopt")}
          >
            同じ銘柄として採用する内容を確認
          </button>
        )}
        <button
          className="button"
          type="button"
          disabled={!canPlan}
          onClick={() => plan.mutate("keepApart")}
        >
          別の銘柄として扱う内容を確認
        </button>
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

function CandidateCard({
  candidate,
  lookup,
}: {
  candidate: ReviewCandidate;
  lookup: (id: string) => ResolutionIdentifier | undefined;
}): ReactNode {
  const anchor = lookup(candidate.anchorIdentifierId);
  const subject = lookup(candidate.subjectIdentifierId);
  return (
    <article className="identity-card">
      <h3 className="identity-card-title">
        {subject?.label ?? candidate.subjectIdentifierId} <CandidateStatus candidate={candidate} />
      </h3>
      <p className="identity-card-meta">
        {candidate.crossSource ? "取得元をまたぐ候補" : "同じ取得元の中の候補"}
      </p>
      <IdentifierSide role="基準の識別子" identifier={anchor} id={candidate.anchorIdentifierId} />
      <IdentifierSide role="対象の識別子" identifier={subject} id={candidate.subjectIdentifierId} />
      <CodeList title="候補の根拠" codes={candidate.evidence} labels={EVIDENCE_LABELS} />
      <CodeList title="一致している情報" codes={candidate.agreements} labels={AGREEMENT_LABELS} />
      <CodeList title="確認できない情報" codes={candidate.gaps} labels={GAP_LABELS} />
      {candidate.hold === null ? null : (
        <Notice tone="warn" inline role="note">
          {displayLabel(HOLD_LABELS, candidate.hold)} <code>{candidate.hold}</code>
        </Notice>
      )}
      {candidate.status === "proposed" ? (
        <DecisionActions candidate={candidate} anchor={anchor} subject={subject} />
      ) : (
        <p className="footnote">
          この候補の判断は保存されています。訂正する場合は、口座・銘柄の整理で対応付けを確認してください。
        </p>
      )}
    </article>
  );
}

function PairCard({
  item,
  lookup,
}: {
  item: Exclude<ReviewItem, ReviewCandidate>;
  lookup: (id: string) => ResolutionIdentifier | undefined;
}): ReactNode {
  const [left, right] = item.identifierIds;
  const separated = isSeparated(item);
  return (
    <article className="identity-card">
      <h3 className="identity-card-title">
        {lookup(left)?.label ?? left}{" "}
        {separated ? (
          <Badge tone="neutral">別の銘柄として表示</Badge>
        ) : (
          <Badge tone="neutral">名称のみ一致（候補ではありません）</Badge>
        )}
      </h3>
      <IdentifierSide role="識別子" identifier={lookup(left)} id={left} />
      <IdentifierSide role="識別子" identifier={lookup(right)} id={right} />
      {separated ? (
        <CodeList title="共通している値" codes={item.evidence} labels={EVIDENCE_LABELS} />
      ) : null}
      <CodeList title="異なる情報" codes={item.conflicts} labels={CONFLICT_LABELS} />
      {separated && item.via.length > 0 ? (
        <>
          <h4>同じ銘柄に対応しているほかの識別子から判明</h4>
          {item.via.map((id) => (
            <IdentifierSide key={id} role="識別子" identifier={lookup(id)} id={id} />
          ))}
        </>
      ) : null}
      {separated && item.sharedInstrument ? (
        <Notice tone="warn" inline role="note">
          この2つは手動の判断で同じ銘柄に対応していますが、記録された情報は異なります。判断は変更されていません。
        </Notice>
      ) : null}
      {separated ? null : <p className="footnote">名称が同じことは同じ銘柄の根拠になりません。</p>}
    </article>
  );
}

function Summary({ page }: { page: InstrumentCandidateReview }): ReactNode {
  const { summary } = page;
  return (
    <ul className="connection-counts" aria-label="候補の件数">
      <li className="connection-count">
        対象の識別子 <span className="count">{summary.identifiers}</span>
      </li>
      <li className="connection-count">
        未判断の候補がある識別子 <span className="count">{summary.unresolved}</span>
      </li>
      <li className="connection-count">
        確認待ち <span className="count">{summary.proposed - summary.held}</span>
      </li>
      <li className="connection-count">
        採用を保留 <span className="count">{summary.held}</span>
      </li>
      <li className="connection-count">
        採用済み <span className="count">{summary.adopted}</span>
      </li>
      <li className="connection-count">
        別の銘柄と判断済み <span className="count">{summary.rejected}</span>
      </li>
      <li className="connection-count">
        別の銘柄 <span className="count">{summary.separated}</span>
      </li>
      <li className="connection-count">
        名称のみ一致 <span className="count">{summary.hints}</span>
      </li>
    </ul>
  );
}

export function InstrumentCandidatesPage(): ReactNode {
  const features = useFeatures();
  const [view, setView] = useState<InstrumentCandidateView>("open");
  const [offset, setOffset] = useState(0);
  const query = useInstrumentCandidates(view, offset);
  const current = VIEWS.find((entry) => entry.view === view)!;
  if (!features.known) return <Loading label="銘柄の同一性の候補" />;
  return (
    <>
      <div className="page-head">
        <h1>銘柄の同一性の候補</h1>
        <p className="lede">
          取得元ごとに記録された識別子のうち、同じ銘柄を指す可能性がある組を、保存された識別子の情報だけから示します。候補は自動採用されません。
        </p>
        <p className="footnote">
          名称は根拠にしません。確認できない情報は一致とは扱いません。候補がないことは、同じ銘柄がほかにないことを意味しません。
          <Link to="/identities">口座・銘柄の整理に戻る</Link>
        </p>
      </div>
      {!features.identities ? (
        <EmptyState>この接続先は銘柄の整理を提供していません。</EmptyState>
      ) : (
        <Panel id="instrument-candidates" title={current.label}>
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
          <QueryBoundary query={query} label="銘柄の同一性の候補" coverageNotice={false}>
            {(page) => {
              const lookup = byId(page);
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
                        isCandidate(item) ? (
                          <CandidateCard key={item.candidateId} candidate={item} lookup={lookup} />
                        ) : (
                          <PairCard key={item.pairId} item={item} lookup={lookup} />
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
