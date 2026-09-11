import type { BackfillProgress } from "./types";

export function isResumable(progress: BackfillProgress): boolean {
  return (
    (progress.phase === "partial" ||
      progress.phase === "failed" ||
      progress.phase === "waiting_for_approval") &&
    Boolean(progress.runId) &&
    Boolean(progress.startedAt) &&
    Boolean(progress.from) &&
    Boolean(progress.to) &&
    progress.totalChunks > 0 &&
    progress.completedChunks < progress.totalChunks
  );
}
