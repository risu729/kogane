// The client half of the instrument candidate review (ADR 0055, amendment
// 2026-10-09). The read is the server's (`GET
// /api/identity/instrument-candidates`); a decision is a plan of the payload
// the server named for the candidate, sent to the existing change lifecycle
// and confirmed on the existing confirmation screen. Nothing here builds a
// payload of its own or decides whether a candidate may be adopted.
import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import { postCommand, type ChangePlanView } from "./command-api.ts";
import type {
  InstrumentCandidateReview,
  InstrumentCandidateView,
  ReviewCandidate,
  ReviewItem,
  ReviewSeparated,
} from "../../../packages/application/src/query/instrument-candidates-review.ts";
import type { ResolutionIdentifier } from "../../../packages/application/src/query/instrument-resolution.ts";
import { INSTRUMENT_CANDIDATES_PATH } from "../../../packages/observation-shared/src/instrument-candidates-contract.ts";

export type {
  InstrumentCandidateReview,
  InstrumentCandidateView,
  ResolutionIdentifier,
  ReviewCandidate,
  ReviewItem,
  ReviewSeparated,
};

export function useInstrumentCandidates(view: InstrumentCandidateView, offset: number) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["instrument-candidates", view, offset],
    enabled: features.known && features.identities,
    queryFn: ({ signal }) =>
      getJson<InstrumentCandidateReview>(
        `${INSTRUMENT_CANDIDATES_PATH}?${new URLSearchParams({ view, offset: String(offset) })}`,
        signal,
      ),
    retry: false,
  });
}

export function isCandidate(item: ReviewItem): item is ReviewCandidate {
  return "candidateId" in item;
}

export function isSeparated(item: ReviewItem): item is ReviewSeparated {
  return "via" in item;
}

export type CandidateDecision = "adopt" | "keepApart";

const STALE = "候補が更新されています。一覧を更新して、内容を確認し直してください。";

/**
 * The candidate as the server answers it now, read through the subject's own
 * pairs in the view the candidate is shown in, with its two identifiers; null
 * when the view no longer holds it.
 */
async function currentCandidate(candidate: ReviewCandidate): Promise<{
  item: ReviewCandidate;
  identifiers: readonly ResolutionIdentifier[];
} | null> {
  const view: InstrumentCandidateView = candidate.hold === null ? "open" : "held";
  for (let offset: number | null = 0; offset !== null;) {
    const page: InstrumentCandidateReview = await getJson<InstrumentCandidateReview>(
      `${INSTRUMENT_CANDIDATES_PATH}?${new URLSearchParams({
        view,
        offset: String(offset),
        identifierId: candidate.subjectIdentifierId,
      })}`,
      new AbortController().signal,
    );
    const item = page.items.find(
      (entry): entry is ReviewCandidate =>
        isCandidate(entry) && entry.candidateId === candidate.candidateId,
    );
    if (item) return { item, identifiers: page.identifiers };
    offset = page.nextOffset;
  }
  return null;
}

const revisionOf = (identifiers: readonly ResolutionIdentifier[], id: string) =>
  identifiers.find((row) => row.identifierId === id)?.mappingRevision;

/**
 * Plan the command the server named for this candidate, with the reason a
 * person wrote. Before anything is planned the candidate is read again: it
 * must still be in the same view with the same anchor, subject and commands,
 * and neither identifier's mapping may have a new revision since the list was
 * shown, or nothing is planned. After planning, an adoption whose plan pinned
 * another revision of the subject than the one on screen (a change between
 * the two requests) is not offered for approval either. The server pins the
 * subject and anchor mapping revisions; the page checks both pins too.
 */
export async function planCandidateDecision(
  candidate: ReviewCandidate,
  decision: CandidateDecision,
  reason: string,
  shown: { anchor: ResolutionIdentifier | undefined; subject: ResolutionIdentifier | undefined },
): Promise<ChangePlanView> {
  const command = candidate.commands?.[decision] ?? null;
  if (command === null) throw new Error("この候補では、この判断を計画できません。");
  const current = await currentCandidate(candidate);
  if (
    current === null ||
    current.item.anchorIdentifierId !== candidate.anchorIdentifierId ||
    current.item.subjectIdentifierId !== candidate.subjectIdentifierId ||
    JSON.stringify(current.item.commands) !== JSON.stringify(candidate.commands) ||
    shown.anchor === undefined ||
    shown.subject === undefined ||
    revisionOf(current.identifiers, candidate.anchorIdentifierId) !==
      shown.anchor.mappingRevision ||
    revisionOf(current.identifiers, candidate.subjectIdentifierId) !== shown.subject.mappingRevision
  )
    throw new Error(STALE);
  const response = await postCommand<{ plan: ChangePlanView }>(
    "plan",
    {
      kind: command.kind,
      payload: { ...command.payload, reason: reason.trim() },
      baseContextId: candidate.candidateId,
    },
    new AbortController().signal,
  );
  if (
    decision === "adopt" &&
    (response.plan.expectedRevisions[`instrument_mapping:${candidate.subjectIdentifierId}`] !==
      shown.subject.mappingRevision ||
      response.plan.expectedRevisions[`instrument_mapping:${candidate.anchorIdentifierId}`] !==
        shown.anchor.mappingRevision)
  )
    throw new Error(STALE);
  return response.plan;
}
