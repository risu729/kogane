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

/**
 * Plan the command the server named for this candidate, with the reason a
 * person wrote. An adoption whose plan pinned a different mapping revision of
 * the subject than the one on screen is not offered for approval: the list is
 * stale and the candidate needs another look.
 */
export async function planCandidateDecision(
  candidate: ReviewCandidate,
  decision: CandidateDecision,
  reason: string,
  subject: ResolutionIdentifier | undefined,
): Promise<ChangePlanView> {
  const command = candidate.commands?.[decision] ?? null;
  if (command === null) throw new Error("この候補では、この判断を計画できません。");
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
    subject !== undefined &&
    response.plan.expectedRevisions[`instrument_mapping:${subject.identifierId}`] !==
      subject.mappingRevision
  )
    throw new Error("候補が更新されています。一覧を更新して、内容を確認し直してください。");
  return response.plan;
}
