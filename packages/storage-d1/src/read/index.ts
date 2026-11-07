// The READ database adapters: identity, cursor codec, reader and writer.
//
// Everything a service needs to build or serve the balance read model in its
// own physical D1 (unified plan 04, 05; U11) is re-exported here, so a service
// imports one module and never a table name.
export {
  inputRefDigest,
  readContentKey,
  readSnapshotId,
  READ_CONTRACT_VERSION,
  type SnapshotInputRef,
} from "./identity.ts";
export { checkReadCursor, decodeReadCursor, encodeReadCursor } from "./cursor.ts";
export { createReadProjectionReader, type ReadProjectionReader } from "./reader.ts";
export {
  abandonSnapshot,
  activePointer,
  activePointerStatement,
  beginSnapshot,
  claimWriterLease,
  currentRevisionSnapshot,
  ensureReadInstance,
  oldestBuildingSnapshot,
  publishedSnapshotAt,
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
  type PointerRow,
  type SnapshotPlan,
} from "./writer.ts";
export {
  abandonRewardSnapshot,
  activeRewardSnapshot,
  beginRewardSnapshot,
  claimRewardWriterLease,
  currentRewardContext,
  oldestBuildingRewardSnapshot,
  releaseRewardWriterLease,
  retireOldRewardSnapshots,
  rewardCheckpoint,
  rewardEstimateDigest,
  rewardEstimatePage,
  rewardPointer,
  rewardPointerStatement,
  rewardSimulationDigest,
  rewardSimulationPage,
  rewardSnapshot,
  rewardSnapshotForContent,
  rewardWriterFence,
  sealAndPublishRewardSnapshot,
  writeRewardEstimateChunk,
  writeRewardSimulationChunk,
  writtenRewardRowsMatch,
  type RewardEstimateRow,
  type RewardInputRef,
  type RewardSimulationRow,
  type RewardSnapshotPlan,
  type RewardSnapshotRow,
} from "./rewards.ts";
export type { D1Like } from "../d1.ts";
