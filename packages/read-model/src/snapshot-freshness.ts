import type { ActivePointerRow } from "./balance-projection-reader";
import type { CoreRevisionRow } from "./source-revision";

/**
 * A snapshot is current only when the active pointer names it and has been
 * verified against CORE's current source revision and epoch. Behind snapshots
 * remain fixed contexts; availability and use restrictions are checked separately.
 */
export function snapshotIsBehind(
  pointer: Pick<ActivePointerRow, "snapshot_id" | "source_revision" | "core_epoch"> | null,
  snapshotId: string,
  revision: Pick<CoreRevisionRow, "source_revision" | "core_epoch">,
): boolean {
  return (
    pointer === null ||
    pointer.snapshot_id !== snapshotId ||
    pointer.source_revision !== revision.source_revision ||
    pointer.core_epoch !== revision.core_epoch
  );
}
