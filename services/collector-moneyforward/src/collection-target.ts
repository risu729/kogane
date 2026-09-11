// Which store a finished run is persisted to (unified plan U09, D12).
//
// `legacy` is the deployed behaviour: artifacts and the manifest go to the
// per-source `SNAPSHOTS` bucket and the importer service binding is asked to
// copy them into central storage. `shared` writes the run straight into the
// common DATA bucket through `packages/collection` and never calls the
// importer, so the same bytes are not stored twice (G1-15).
//
// Only the exact string `shared` switches: an unset, misspelled or
// half-deployed variable keeps the legacy path rather than silently changing
// where financial evidence is written.
export type CollectionTarget = "legacy" | "shared";

export const SHARED_COLLECTION_TARGET = "shared";

export function collectionTarget(value: string | undefined): CollectionTarget {
  return value === SHARED_COLLECTION_TARGET ? "shared" : "legacy";
}
