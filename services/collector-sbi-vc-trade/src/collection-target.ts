// Where a finished run is recorded (unified plan U09, decision D12).
//
//   legacy  the per-source staging bucket plus the central importer upload —
//           byte-for-byte the path this collector has always taken.
//   shared  the same staging write, then `persistRun` into the shared DATA
//           bucket; the central importer upload is skipped (G1-15).
//
// The default is `legacy` and only the exact string `shared` selects the new
// path: an unset variable, a typo, a half-finished deploy or a var carrying
// stray whitespace must never silently redirect a bank run to a different
// store. Nothing here reads `Env`, so the decision is testable on its own.

export const COLLECTION_TARGETS = ["legacy", "shared"] as const;
export type CollectionTarget = (typeof COLLECTION_TARGETS)[number];

export function collectionTarget(value: string | undefined): CollectionTarget {
  return value === "shared" ? "shared" : "legacy";
}

export function sharedCollectionEnabled(value: string | undefined): boolean {
  return collectionTarget(value) === "shared";
}
