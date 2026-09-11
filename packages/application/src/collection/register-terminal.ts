// Registering one shared-R2 collection run (unified plan 03 §4, U08).
//
// The terminal manifest is the record that a run finished persisting its
// bytes. Registration turns that record into CORE rows, and its whole job is
// to be *exactly once per (source, run, terminal digest, registration
// contract)* no matter how often it is asked:
//
//   * the same terminal delivered twice — a duplicate Queue message, or the
//     scan finding what the queue already handled — finds a completed
//     `registered` stage and does nothing (G1-05, G1-11);
//   * a *different* manifest under the same run id is a conflict: the new
//     sighting is blocked and nothing is overwritten (G1-06);
//   * a referenced object that is missing or the wrong size records a failed
//     `registered` stage with the reason and never seals (G1-14);
//   * a terminal that cannot be read at all is recorded as a blocked run, so
//     the scan can move on instead of stopping on it (G1-13);
//   * a terminal for a source the Processor does not know, or a failed run
//     that persisted nothing from the provider, is recorded and blocked
//     without a single port call: there is no route to authorize the first
//     and nothing to seal for the second.
//
// No byte is copied. The shared DATA bucket and the ingest object store are
// the same bucket, and the objects are already at the content-addressed key
// registration uses, so the artifacts are adopted in place (`adoptObject`).
// There is no `put` and no copy anywhere on this path (G1-15).
//
// The seal is last. Until it is written the run is incomplete and no normal
// reader sees it, which is what makes a half-finished registration safe to
// resume from the same manifest (G1-10).
import { readTerminal, type ReadTerminalResult } from "../../../collection/src/reader.ts";
import type { R2BucketLike } from "../../../collection/src/bucket.ts";
import { sha256Hex } from "../../../collection/src/digest.ts";
import type { TerminalArtifact, TerminalManifest } from "../../../collection/src/manifest.ts";
import { verifyReferencedObjects } from "../../../collection/src/reader.ts";
import { descriptorContractV1 } from "../../../evidence-contract/src/descriptor.ts";
import { canonicalJsonV1, type JsonValue } from "../../../evidence-contract/src/json.ts";
import type { ArtifactRequest } from "../../../evidence-contract/src/descriptor.ts";
import type { InventoryItem } from "../../../evidence-contract/src/requests.ts";
import { readRunCatalogue } from "../../../storage-d1/src/core/artifacts.ts";
import {
  appendCollectionStage,
  blockCollectionRun,
  collectionRunRegistered,
  insertCollectionRunIfAbsent,
  linkRegisteredRun,
  readLatestCollectionStage,
  readCollectionRun,
  readCollectionRunsFor,
  type CollectionRunRow,
} from "../../../storage-d1/src/core/collection-runs.ts";
import { readFetchRunSessionId } from "../../../storage-d1/src/core/fetch-runs.ts";
import { sourceDeclared } from "../../../storage-d1/src/core/ingest-registry.ts";
import { IngestError, type IngestEnv } from "../ingest/contract.ts";
import type { RunRegistrationPort } from "../ingest/port.ts";
import {
  artifactRequest,
  coreSourceId,
  createRunRequest,
  hasProviderArtifact,
  instantMs,
  REGISTRATION_CONTRACT_VERSION,
  runRangeRequests,
  runReportRequest,
  TerminalRegistrationError,
  unitReportRequest,
  unitRequest,
} from "./descriptors.ts";

export { REGISTRATION_CONTRACT_VERSION };

/** Artifacts catalogued in one invocation before the call yields (15 §2). */
export const DEFAULT_ARTIFACT_BUDGET = 500;
/** Inventory items staged per D1 batch for a run above the direct-seal size. */
export const DEFAULT_INVENTORY_CHUNK = 50;
/** A run with at most this many artifacts is registered and sealed in one go (03 §4). */
export const DIRECT_SEAL_ARTIFACTS = 50;

export interface RegisterTerminalInput {
  env: IngestEnv;
  /** The shared DATA bucket, read through the collection contract. */
  bucket: R2BucketLike;
  /** The Processor's ingest client id; its route is checked per operation. */
  clientId: string;
  port: RunRegistrationPort;
  source: string;
  runId: string;
  now?: () => Date;
  artifactBudget?: number;
  inventoryChunk?: number;
  /** Re-hash an object whose digest R2 metadata cannot prove. Off by default. */
  streamHash?: boolean;
}

export type RegisterTerminalOutcome =
  | {
      outcome: "registered";
      collectionRunId: number;
      fetchRunId: number;
      terminalDigest: string;
      artifacts: number;
    }
  | {
      outcome: "already_registered";
      collectionRunId: number;
      fetchRunId: number | null;
      terminalDigest: string;
    }
  /** Work remains: the budget was spent before the run could be sealed. */
  | {
      outcome: "pending";
      collectionRunId: number;
      fetchRunId: number;
      terminalDigest: string;
      catalogued: number;
      artifacts: number;
    }
  | { outcome: "blocked"; collectionRunId: number | null; code: string }
  /** Refused for a reason that is not about this evidence; try again later. */
  | { outcome: "retryable"; collectionRunId: number; code: string }
  /** No terminal at this key. Nothing is recorded: the run never finished. */
  | { outcome: "missing" };

/**
 * Refusals that say something about the deployment rather than about this
 * run: the Processor's ingest client or its route for this source has not
 * been created yet, or was revoked. Blocking the run for that would make an
 * operator's configuration fix unable to take effect, because a block is
 * write-once. They stay retryable instead.
 */
const RETRYABLE_INGEST_CODES = new Set(["inactive_ingest_client", "inactive_ingest_route"]);

/**
 * Register the run whose terminal is at `runs/<source>/<runId>/terminal.json`.
 * Idempotent, and safe to call from the Queue consumer and the scan at the
 * same time: every write below is conditional and read back.
 */
export async function registerTerminal(
  input: RegisterTerminalInput,
): Promise<RegisterTerminalOutcome> {
  const now = input.now ?? (() => new Date());
  const read = await readTerminal(input.bucket, input.source, input.runId);
  if (read.outcome === "missing") return { outcome: "missing" };
  if (read.outcome === "blocked") return recordBlockedTerminal(input, read, now());

  const manifest = read.manifest;
  const identity = {
    source: manifest.source,
    runId: manifest.runId,
    terminalDigest: read.terminalDigest,
    registrationContractVersion: REGISTRATION_CONTRACT_VERSION,
  };
  const seenAt = now().toISOString();
  const inserted = await insertCollectionRunIfAbsent(input.env.DB, {
    ...identity,
    terminalKey: read.key,
    providerOutcome: manifest.providerOutcome,
    coverageStatus: manifest.coverageStatus,
    acquisitionSessionRef: manifest.acquisitionSessionRef ?? null,
    firstSeenAt: seenAt,
    blockedCode: null,
  });
  const row = await readCollectionRun(input.env.DB, identity);
  if (!row) throw new IngestError(500, "collection_run_not_visible");
  if (inserted > 0) {
    // The terminal exists and its objects are what it says they are as far as
    // the terminal itself goes: that is the `persisted` stage, and nothing
    // more. It is not a claim that the provider returned everything.
    await appendCollectionStage(input.env.DB, {
      collectionRunId: row.id,
      stage: "persisted",
      state: "completed",
      evidenceRef: read.terminalDigest,
      recordedAt: seenAt,
    });
  }
  if (row.blocked_code !== null) {
    return { outcome: "blocked", collectionRunId: row.id, code: row.blocked_code };
  }
  if (row.registered_at !== null || (await collectionRunRegistered(input.env.DB, row.id))) {
    return {
      outcome: "already_registered",
      collectionRunId: row.id,
      fetchRunId: row.fetch_run_id,
      terminalDigest: row.terminal_digest,
    };
  }
  // A second manifest under the same run id is a disagreement about what that
  // run was, and the earlier record stays. Nothing is overwritten and nothing
  // is merged (03 §3, G1-06).
  const conflict = await conflictingDigest(input, row);
  if (conflict) return block(input, row, "terminal_digest_conflict", "registered", now());
  const refusal = await refusalFor(input, manifest);
  if (refusal) return block(input, row, refusal, "registered", now());

  const verified = await verifyReferencedObjects(input.bucket, manifest, {
    ...(input.streamHash === undefined ? {} : { streamHash: input.streamHash }),
  });
  if (verified.outcome === "blocked") {
    const problem = verified.problems[0];
    return block(input, row, problem?.reasonCode ?? "object_unverified", "registered", now());
  }

  try {
    return await register(input, manifest, row, now);
  } catch (error) {
    if (error instanceof TerminalRegistrationError) {
      return block(input, row, error.code, "registered", now());
    }
    // A refusal CORE itself made: 4xx is about this terminal and blocks it;
    // 5xx is the server, so it stays retryable and the caller tries again.
    if (error instanceof IngestError && RETRYABLE_INGEST_CODES.has(error.code)) {
      return retryable(input, row, error.code, now());
    }
    if (error instanceof IngestError && error.status < 500) {
      return block(input, row, safeCode(error.code), "registered", now());
    }
    throw error;
  }
}

/**
 * Why a validated terminal is not registered at all, before any port call.
 * The terminal is still recorded in every case, so the run does not vanish
 * from the scan (G1-13).
 *
 *  * `unknown_source`: the terminal's source is not in the closed collector
 *    → CORE source mapping (`COLLECTOR_SOURCE_IDS`).
 *  * `source_undeclared`: it maps to a source id CORE has no active row for,
 *    so no ingest route can exist.
 *  * `provider_run_failed`: the collector reported `failed` and persisted no
 *    provider bytes — nothing, or only its own manifest, error capture or
 *    summary. The run is recorded with its outcome and nothing is sealed: an
 *    empty seal would present a failure as a registered acquisition. A
 *    failed run that did capture provider bytes registers like any other,
 *    unwidened.
 */
async function refusalFor(
  input: RegisterTerminalInput,
  manifest: TerminalManifest,
): Promise<string | null> {
  const sourceId = coreSourceId(manifest.source);
  if (sourceId === null) return "unknown_source";
  if (!(await sourceDeclared(input.env.DB, sourceId))) return "source_undeclared";
  if (manifest.providerOutcome === "failed" && !hasProviderArtifact(manifest)) {
    return "provider_run_failed";
  }
  return null;
}

/**
 * The registration proper. Every operation is idempotent on its own key, so a
 * second attempt after a crash re-runs them as no-ops and continues with what
 * is missing — only what is missing, so a run larger than one call's budget
 * still finishes over several calls (G1-10, 03 §6).
 */
async function register(
  input: RegisterTerminalInput,
  manifest: TerminalManifest,
  row: CollectionRunRow,
  now: () => Date,
): Promise<RegisterTerminalOutcome> {
  const port = input.port;
  const adopt = port.adoptObject;
  if (!adopt) throw new TerminalRegistrationError("registration_port_cannot_adopt_objects");
  const budget = Math.max(1, input.artifactBudget ?? DEFAULT_ARTIFACT_BUDGET);
  const chunk = Math.max(1, input.inventoryChunk ?? DEFAULT_INVENTORY_CHUNK);

  const fetchRunId = await port.createRun(createRunRequest(manifest));
  const unitIds = new Map<string, number>();
  for (const unit of manifest.units) {
    unitIds.set(unit.unitKey, await port.addUnit(fetchRunId, unitRequest(unit)));
  }
  for (const range of runRangeRequests(manifest)) await port.addRunRange(fetchRunId, range);

  // The whole inventory is declared up front, so the seal can only succeed
  // once every artifact the manifest names is catalogued. A run that stops
  // half-way leaves the declaration and no seal.
  const descriptors = manifest.artifacts.map((artifact) => ({
    artifact,
    request: artifactRequest(manifest, artifact, unitIds),
  }));
  const items: InventoryItem[] = [];
  for (const entry of descriptors) {
    items.push({
      artifactKey: entry.artifact.artifactKey,
      sha256: entry.artifact.sha256,
      // The digest is computed the way the catalogue computes it — parse,
      // normalize, encode, hash — because a client-side shortcut that skips
      // the parse produces a different value for the same descriptor, and the
      // inventory would then disagree with the catalogue it declares.
      descriptorSha256: await descriptorDigest(entry.request, fetchRunId),
    });
  }
  const staged = items.length > DIRECT_SEAL_ARTIFACTS;
  let inventoryId = 0;
  if (staged) {
    const digest = await sha256Hex(
      new TextEncoder().encode(canonicalJsonV1(items as unknown as JsonValue)),
    );
    inventoryId = await port.beginInventory(fetchRunId, digest, items.length);
  }

  // What an earlier call already catalogued for this run. Those artifacts are
  // skipped rather than re-adopted as no-ops, so the budget is spent on new
  // work and a run with more artifacts than one budget converges instead of
  // re-cataloguing the same first page every tick.
  const already = new Set(
    (await readRunCatalogue(input.env.DB, fetchRunId)).map((row) => row.artifact_key),
  );
  const itemByKey = new Map(items.map((item) => [item.artifactKey, item]));
  let catalogued = 0;
  let stopped = false;
  let pending: InventoryItem[] = [];
  // Catalogued parents first: the catalogue links a relation to an artifact
  // that already exists, so a derived artifact must follow what it was
  // derived from, whatever their key order. The inventory itself stays in
  // key order above.
  for (const entry of lineageOrder(descriptors)) {
    const index = itemByKey.get(entry.artifact.artifactKey)!;
    if (!already.has(entry.artifact.artifactKey)) {
      if (catalogued >= budget) {
        stopped = true;
        break;
      }
      // The bytes are already in the bucket at the key registration uses;
      // this records them, it does not write them (G1-15).
      await adopt.call(port, fetchRunId, entry.artifact.sha256, entry.artifact.byteSize);
      const descriptorSha256 = await port.addArtifact(fetchRunId, entry.request);
      if (descriptorSha256 !== index.descriptorSha256) {
        throw new TerminalRegistrationError("descriptor_digest_mismatch");
      }
      catalogued += 1;
    }
    // Inventory items are declared for every artifact, catalogued now or
    // earlier; the staging call is idempotent per item.
    if (staged) {
      pending.push(index);
      if (pending.length >= chunk) {
        await port.addInventoryItems(fetchRunId, inventoryId, pending);
        pending = [];
      }
    }
  }
  if (staged && pending.length > 0) {
    await port.addInventoryItems(fetchRunId, inventoryId, pending);
  }

  const startedAtMs = instantMs(manifest.startedAt);
  const attemptId = `${manifest.runId}:${REGISTRATION_CONTRACT_VERSION}`;
  if (stopped) {
    // Out of budget. The run stays unsealed and therefore invisible to normal
    // readers; the next delivery or scan continues from here (15 §2).
    await appendCollectionStage(input.env.DB, {
      collectionRunId: row.id,
      stage: "registered",
      state: "pending",
      evidenceRef: String(fetchRunId),
      recordedAt: now().toISOString(),
    });
    return {
      outcome: "pending",
      collectionRunId: row.id,
      fetchRunId,
      terminalDigest: row.terminal_digest,
      catalogued: already.size + catalogued,
      artifacts: descriptors.length,
    };
  }

  for (const unit of manifest.units) {
    const unitId = unitIds.get(unit.unitKey);
    if (unitId === undefined) throw new TerminalRegistrationError("unit_not_registered");
    await port.addUnitReport(unitId, unitReportRequest(unit, manifest));
  }
  await port.addRunReport(fetchRunId, runReportRequest(manifest));

  if (staged) await port.sealStagedInventory(fetchRunId, inventoryId, attemptId, startedAtMs);
  else await port.seal(fetchRunId, items, attemptId, startedAtMs);

  const registeredAt = now().toISOString();
  await linkRegisteredRun(input.env.DB, row.id, {
    fetchRunId,
    acquisitionSessionId: await readFetchRunSessionId(input.env.DB, fetchRunId),
    registeredAt,
  });
  await appendCollectionStage(input.env.DB, {
    collectionRunId: row.id,
    stage: "registered",
    state: "completed",
    evidenceRef: String(fetchRunId),
    recordedAt: registeredAt,
  });
  return {
    outcome: "registered",
    collectionRunId: row.id,
    fetchRunId,
    terminalDigest: row.terminal_digest,
    artifacts: descriptors.length,
  };
}

interface DescriptorEntry {
  artifact: TerminalArtifact;
  request: ArtifactRequest;
}

/**
 * The descriptors in an order where every relation's parent precedes its
 * child. Stable within a level, so two readings of one manifest catalogue in
 * the same order. A cycle is a manifest that claims an artifact was derived
 * from itself, and is refused.
 */
function lineageOrder(descriptors: readonly DescriptorEntry[]): DescriptorEntry[] {
  const placed = new Set<string>();
  const ordered: DescriptorEntry[] = [];
  let remaining = [...descriptors];
  while (remaining.length > 0) {
    const ready = remaining.filter((entry) =>
      (entry.request.relations ?? []).every((relation) => placed.has(relation.parentArtifactKey)),
    );
    if (ready.length === 0) throw new TerminalRegistrationError("artifact_lineage_cycle");
    for (const entry of ready) {
      ordered.push(entry);
      placed.add(entry.artifact.artifactKey);
    }
    remaining = remaining.filter((entry) => !placed.has(entry.artifact.artifactKey));
  }
  return ordered;
}

/**
 * The descriptor digest exactly as the catalogue recomputes it. The contract's
 * own parse fills every default and sorts every array, so the value here and
 * the value `addArtifact` returns are the same by construction rather than by
 * agreement; `register` compares them anyway.
 */
async function descriptorDigest(request: ArtifactRequest, runId: number): Promise<string> {
  const parsed = descriptorContractV1.parseRequest(request as unknown as Record<string, unknown>, {
    runId,
  });
  return descriptorContractV1.digest(
    descriptorContractV1.encode(descriptorContractV1.normalize(parsed)),
  );
}

/**
 * A terminal that could not be validated. It is still recorded — a run that
 * cannot be written down is a run that silently vanishes from the scan — under
 * the digest of the bytes that are actually there, so one corrupt terminal has
 * one identity and not a new one per sweep (G1-13).
 */
async function recordBlockedTerminal(
  input: RegisterTerminalInput,
  read: Extract<ReadTerminalResult, { outcome: "blocked" }>,
  at: Date,
): Promise<RegisterTerminalOutcome> {
  // A second read, only on this path: the reader does not hand back the bytes
  // of a terminal it refused, and an unreadable terminal is rare.
  const stored = await input.bucket.get(read.key);
  if (!stored) return { outcome: "missing" };
  const digest = await sha256Hex(new Uint8Array(await stored.arrayBuffer()));
  const identity = {
    source: input.source,
    runId: input.runId,
    terminalDigest: digest,
    registrationContractVersion: REGISTRATION_CONTRACT_VERSION,
  };
  const seenAt = at.toISOString();
  const inserted = await insertCollectionRunIfAbsent(input.env.DB, {
    ...identity,
    terminalKey: read.key,
    // An unvalidated terminal has no provider outcome at all. Recording one
    // would be inventing the acquisition's result from its corruption.
    providerOutcome: null,
    coverageStatus: null,
    acquisitionSessionRef: null,
    firstSeenAt: seenAt,
    blockedCode: safeCode(read.reasonCode),
  });
  const row = await readCollectionRun(input.env.DB, identity);
  if (row && inserted > 0) {
    await appendCollectionStage(input.env.DB, {
      collectionRunId: row.id,
      stage: "persisted",
      state: "blocked",
      failureCode: safeCode(read.reasonCode),
      recordedAt: seenAt,
    });
  }
  return {
    outcome: "blocked",
    collectionRunId: row?.id ?? null,
    code: safeCode(read.reasonCode),
  };
}

/** True when another manifest is already recorded for this run id. */
async function conflictingDigest(
  input: RegisterTerminalInput,
  row: CollectionRunRow,
): Promise<boolean> {
  const rows = await readCollectionRunsFor(input.env.DB, row.source, row.run_id);
  return rows.some(
    (other) =>
      other.id !== row.id &&
      other.registration_contract_version === row.registration_contract_version &&
      other.terminal_digest !== row.terminal_digest,
  );
}

async function retryable(
  input: RegisterTerminalInput,
  row: CollectionRunRow,
  code: string,
  at: Date,
): Promise<RegisterTerminalOutcome> {
  const safe = safeCode(code);
  // The stage table is append-only, and a configuration problem repeats every
  // tick. One row per *change* of state keeps the history readable instead of
  // filling it with the same sentence.
  const latest = await readLatestCollectionStage(input.env.DB, row.id, "registered");
  if (latest?.state !== "retryable" || latest.failure_code !== safe) {
    await appendCollectionStage(input.env.DB, {
      collectionRunId: row.id,
      stage: "registered",
      state: "retryable",
      failureCode: safe,
      recordedAt: at.toISOString(),
    });
  }
  return { outcome: "retryable", collectionRunId: row.id, code: safe };
}

async function block(
  input: RegisterTerminalInput,
  row: CollectionRunRow,
  code: string,
  stage: "persisted" | "registered",
  at: Date,
): Promise<RegisterTerminalOutcome> {
  const safe = safeCode(code);
  const recordedAt = at.toISOString();
  await appendCollectionStage(input.env.DB, {
    collectionRunId: row.id,
    stage,
    state: "blocked",
    failureCode: safe,
    recordedAt,
  });
  await blockCollectionRun(input.env.DB, row.id, safe);
  return { outcome: "blocked", collectionRunId: row.id, code: safe };
}

/** The stored codes are machine codes; anything else becomes one generic code. */
function safeCode(value: string): string {
  return /^[a-z0-9_]{1,64}$/u.test(value) ? value : "unsafe_reason_code";
}
