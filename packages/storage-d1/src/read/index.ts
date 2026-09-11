// The READ database adapters: identity, cursor codec, reader and writer.
//
// Everything a service needs to build or serve the balance read model in its
// own physical D1 (unified plan 04, 05; U11) is re-exported here, so a service
// imports one module and never a table name.
export {
  inputRefDigest,
  readContentKey,
  readOutputDigest,
  readSnapshotId,
  READ_CONTRACT_VERSION,
  type SnapshotInputRef,
} from "./identity.ts";
export { checkReadCursor, decodeReadCursor, encodeReadCursor, type ReadCursor } from "./cursor.ts";
export {
  createReadProjectionReader,
  type ReadInstanceRow,
  type ReadProjectionReader,
} from "./reader.ts";
export {
  abandonSnapshot,
  activePointer,
  activePointerStatement,
  beginSnapshot,
  claimWriterLease,
  ensureReadInstance,
  oldestBuildingSnapshot,
  publishedSnapshotAt,
  READ_RETAINED_SNAPSHOTS,
  READ_WRITE_CHUNK,
  releaseWriterLease,
  retireOldSnapshots,
  rowCheckpoint,
  rowDigest,
  sealAndPublish,
  snapshotForContent,
  writeRowChunk,
  writeScopeRelations,
  writerFence,
  writtenRowsMatch,
  type BuildingSnapshotRow,
  type ChunkOutcome,
  type ContentSnapshotRow,
  type PointerRow,
  type ReadInstance,
  type SealOutcome,
  type SnapshotPlan,
  type StartedSnapshot,
} from "./writer.ts";
export type { D1Like, D1StatementLike } from "../d1.ts";
