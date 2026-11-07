// The client half of the account correspondence candidate review (ADR 0077).
// The read is the server's (`GET /api/identity/account-candidates`); a
// decision is a plan of the payload the server named for the candidate, sent
// to the existing change lifecycle and confirmed on the existing confirmation
// screen. Nothing here builds a payload of its own or decides whether a
// candidate may be accepted.
import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import { postCommand, type ChangePlanView } from "./command-api.ts";
import type {
  AccountCandidate,
  AccountCandidateItem,
  AccountCandidateReview,
  AccountCandidateView,
  AccountConnectionEntry,
  AccountSourceFacts,
  UnreviewedAggregatorAccount,
} from "../../../packages/application/src/query/account-candidates.ts";
import { ACCOUNT_CANDIDATES_PATH } from "../../../packages/observation-shared/src/account-candidates-contract.ts";

export type {
  AccountCandidate,
  AccountCandidateItem,
  AccountCandidateReview,
  AccountCandidateView,
  AccountConnectionEntry,
  AccountSourceFacts,
  UnreviewedAggregatorAccount,
};

export function useAccountCandidates(view: AccountCandidateView, offset: number) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["account-candidates", view, offset],
    enabled: features.known && features.identities,
    queryFn: ({ signal }) =>
      getJson<AccountCandidateReview>(
        `${ACCOUNT_CANDIDATES_PATH}?${new URLSearchParams({ view, offset: String(offset) })}`,
        signal,
      ),
    retry: false,
  });
}

export function isAccountCandidate(item: AccountCandidateItem): item is AccountCandidate {
  return "candidateId" in item;
}

export function isAccountConnection(item: AccountCandidateItem): item is AccountConnectionEntry {
  return "connectionRef" in item && !("candidateId" in item);
}

export type AccountCandidateDecision = "accept" | "reject";

const STALE = "候補が更新されています。一覧を更新して、内容を確認し直してください。";

/** The candidate as the server answers it now, in the view it is shown in; null when gone. */
async function currentCandidate(candidate: AccountCandidate): Promise<AccountCandidate | null> {
  const view: AccountCandidateView =
    candidate.status !== "proposed" ? "decided" : candidate.hold === null ? "open" : "held";
  for (let offset: number | null = 0; offset !== null;) {
    const page: AccountCandidateReview = await getJson<AccountCandidateReview>(
      `${ACCOUNT_CANDIDATES_PATH}?${new URLSearchParams({
        view,
        offset: String(offset),
        sourceAccountId: candidate.directSourceAccountId,
      })}`,
      new AbortController().signal,
    );
    const item = page.items.find(
      (entry): entry is AccountCandidate =>
        isAccountCandidate(entry) && entry.candidateId === candidate.candidateId,
    );
    if (item) return item;
    offset = page.nextOffset;
  }
  return null;
}

/**
 * Plan the command the server named for this candidate, with the reason a
 * person wrote. Before anything is planned the candidate is read again: it
 * must still be in the same view with the same status, hold and commands, or
 * nothing is planned. The plan pins the relation's revision; approving and
 * committing happen on the confirmation screen.
 */
export async function planAccountCandidateDecision(
  candidate: AccountCandidate,
  decision: AccountCandidateDecision,
  reason: string,
): Promise<ChangePlanView> {
  const command = candidate.commands[decision];
  if (command === null) throw new Error("この候補では、この判断を計画できません。");
  const current = await currentCandidate(candidate);
  if (
    current === null ||
    current.status !== candidate.status ||
    current.hold !== candidate.hold ||
    JSON.stringify(current.commands) !== JSON.stringify(candidate.commands)
  )
    throw new Error(STALE);
  const response = await postCommand<{ plan: ChangePlanView }>(
    "plan",
    {
      kind: command.kind,
      payload: { ...command.payload, reason: reason.trim() },
      // The plan records where it was made; the command API admits at most
      // 256 characters, which a candidate id of very long references passes.
      baseContextId:
        candidate.candidateId.length <= 256 ? candidate.candidateId : "account-candidates",
    },
    new AbortController().signal,
  );
  return response.plan;
}
