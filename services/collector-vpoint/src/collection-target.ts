// Where a finished run is persisted (unified plan U09, decision D12).
//
// `legacy` keeps the deployed path byte for byte: artifacts and the collector
// manifest into the per-source bucket, then the central importer. `shared`
// writes the run into the common DATA bucket through `packages/collection`
// and does not call the importer at all.
//
// The var is read, never trusted: only the exact string `shared` switches the
// target, so a typo, an empty value or an unset binding stays on the deployed
// path instead of silently starting to write somewhere else.
export const COLLECTION_TARGETS = ["legacy", "shared"] as const;
export type CollectionTarget = (typeof COLLECTION_TARGETS)[number];

export function collectionTarget(value: string | undefined): CollectionTarget {
  return value === "shared" ? "shared" : "legacy";
}
