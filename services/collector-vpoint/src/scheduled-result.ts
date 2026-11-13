import {
  scheduledResult,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";
import type { CollectionManifest } from "./types";

type Manifest = Pick<CollectionManifest, "status" | "runId" | "failures">;

/** The first attempt remains failed: the separate email-triggered run may not have completed yet. */
export function awaitingReauthentication(manifest: Manifest): boolean {
  return (
    manifest.status === "failed" &&
    manifest.failures.length === 1 &&
    ["VPointReauthenticationPendingError", "VPointSessionExpiredError"].includes(
      manifest.failures[0]?.errorType ?? "",
    )
  );
}

export function vPointScheduledResult(outcome: {
  manifest: Manifest;
  terminal: { persisted: boolean };
}): ScheduledResult {
  const result = scheduledResult(outcome);
  if (!outcome.terminal.persisted)
    return { ...result, status: "failed", failureCode: "terminal_persistence_failed" };
  if (awaitingReauthentication(outcome.manifest))
    return { ...result, status: "failed", failureCode: "reauthentication_pending" };
  // A refused session whose automatic challenge also failed needs the owner's refresh path.
  if (
    outcome.manifest.status === "failed" &&
    outcome.manifest.failures.some(
      (failure) =>
        ["VPointReauthenticationPendingError", "VPointSessionExpiredError"].includes(
          failure.errorType,
        ) || failure.stage === "email-challenge-request",
    )
  )
    return { ...result, status: "failed", failureCode: "human_required_session_refresh" };
  return result;
}
