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
//
// Every call is bounded by the invocation's operation budget (`budget.ts`,
// issue #87). Registration is a sequence of steps — the run, each missing
// unit and range, the inventory, each missing artifact, each missing
// inventory chunk, each missing unit report, the run report and the seal —
// and a step only starts while its reserve still fits. Each step is
// idempotent on its own key and each call skips what CORE already holds, so a
// run of any size the manifest schema allows converges over as many
// invocations as it needs, and no single invocation spends more than the
// budget however many units, ranges or artifacts the manifest names.
import { readTerminal, type ReadTerminalResult } from "../../../collection/src/reader.ts";
import type { R2BucketLike } from "../../../collection/src/bucket.ts";
import { sha256Hex } from "../../../collection/src/digest.ts";
import type { TerminalArtifact, TerminalManifest } from "../../../collection/src/manifest.ts";
import { verifyReferencedObjects } from "../../../collection/src/reader.ts";
import { descriptorContractV1 } from "../../../evidence-contract/src/descriptor.ts";
import { canonicalJsonV1, type JsonValue } from "../../../evidence-contract/src/json.ts";
import type { ArtifactRequest } from "../../../evidence-contract/src/descriptor.ts";
import {
  MAX_INVENTORY_CHUNK_ITEMS,
  type InventoryItem,
} from "../../../evidence-contract/src/requests.ts";
import { ContractError } from "../../../evidence-contract/src/validate.ts";
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
import { readInventoryItems } from "../../../storage-d1/src/core/inventories.ts";
import {
  readRunRangeKeys,
  readRunUnitReportKeys,
  readRunUnits,
} from "../../../storage-d1/src/core/structure.ts";
import { IngestError, type IngestEnv } from "../ingest/contract.ts";
import { directRegistrationPort, type RunRegistrationPort } from "../ingest/port.ts";
import {
  ARTIFACT_STEP_BASE,
  ARTIFACT_STEP_TYPICAL,
  FINAL_STEP_RESERVE,
  inventoryChunkReserve,
  meterBucket,
  meterD1,
  PREAMBLE_RESERVE,
  RegistrationBudget,
  STRUCTURE_STEP_RESERVE,
} from "./budget.ts";
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

/**
 * Artifacts catalogued in one call before it yields (15 §2). The operation
 * budget is what bounds an invocation; this count is a second, coarser cap.
 */
export const DEFAULT_ARTIFACT_BUDGET = 500;
/**
 * Inventory items staged per call for a run above the direct-seal size. It
 * was 50, above the contract's 30, so a run of more than 50 artifacts could
 * never stage its inventory; it is now the contract's own maximum.
 */
export const DEFAULT_INVENTORY_CHUNK = MAX_INVENTORY_CHUNK_ITEMS;
/** A run with at most this many artifacts is registered and sealed in one go (03 §4). */
export const DIRECT_SEAL_ARTIFACTS = 50;

export interface RegisterTerminalInput {
  env: IngestEnv;
  /** The shared DATA bucket, read through the collection contract. */
  bucket: R2BucketLike;
  /** The Processor's ingest client id; its route is checked per operation. */
  clientId: string;
  /**
   * Builds the registration port over the bindings registration is metered
   * through. Defaults to the in-process port; it is a factory rather than a
   * port so that every operation the port makes is counted against the budget.
   */
  port?: (env: IngestEnv) => RunRegistrationPort;
  source: string;
  runId: string;
  now?: () => Date;
  artifactBudget?: number;
  inventoryChunk?: number;
  /** Re-hash an object whose digest R2 metadata cannot prove. Off by default. */
  streamHash?: boolean;
  /**
   * The invocation's operation budget, shared by every registration the
   * invocation makes. A call without one gets a budget of its own.
   */
  budget?: RegistrationBudget;
}

/** Where a staged registration stopped: what the next call starts with. */
export type RegistrationPhase = "structure" | "catalogue" | "inventory" | "terminal";

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
      phase: RegistrationPhase;
    }
  | { outcome: "blocked"; collectionRunId: number | null; code: string }
  /** Refused for a reason that is not about this evidence; try again later. */
  | { outcome: "retryable"; collectionRunId: number; code: string }
  /** No terminal at this key. Nothing is recorded: the run never finished. */
  | { outcome: "missing" }
  /**
   * Not started, or stopped before the fetch run was created: the
   * invocation's budget was already spent. Nothing was registered — at most
   * the sighting of the terminal was recorded — so the caller asks again on a
   * later invocation.
   */
  | { outcome: "deferred" };

/**
 * Refusals that say something about the deployment rather than about this
 * run: the Processor's ingest client or its route for this source has not
 * been created yet, or was revoked. Blocking the run for that would make an
 * operator's configuration fix unable to take effect, because a block is
 * write-once. They stay retryable instead.
 */
const RETRYABLE_INGEST_CODES = new Set(["inactive_ingest_client", "inactive_ingest_route"]);

/** What one call works with once its bindings are metered. */
interface Registration {
  input: RegisterTerminalInput;
  env: IngestEnv;
  bucket: R2BucketLike;
  port: RunRegistrationPort;
  budget: RegistrationBudget;
  now: () => Date;
}

/**
 * Register the run whose terminal is at `runs/<source>/<runId>/terminal.json`.
 * Idempotent, and safe to call from the Queue consumer and the scan at the
 * same time: every write below is conditional and read back.
 */
export async function registerTerminal(
  input: RegisterTerminalInput,
): Promise<RegisterTerminalOutcome> {
  const budget = input.budget ?? new RegistrationBudget();
  // A run is started only when its preamble and its first step both fit, so
  // a started registration always makes progress or records why it did not.
  if (!budget.fits(PREAMBLE_RESERVE + STRUCTURE_STEP_RESERVE)) {
    budget.deferred += 1;
    return { outcome: "deferred" };
  }
  budget.started += 1;
  const meter = budget.meter;
  const env: IngestEnv = {
    ...input.env,
    DB: meterD1(input.env.DB, meter),
    EVIDENCE: meterBucket(input.env.EVIDENCE, meter),
  };
  const context: Registration = {
    input,
    env,
    bucket: meterBucket(input.bucket, meter),
    port: (input.port ?? ((metered) => directRegistrationPort(metered, input.clientId)))(env),
    budget,
    now: input.now ?? (() => new Date()),
  };
  return registerWithin(context);
}

async function registerWithin(context: Registration): Promise<RegisterTerminalOutcome> {
  const { input, env, now } = context;
  const read = await readTerminal(context.bucket, input.source, input.runId);
  if (read.outcome === "missing") return { outcome: "missing" };
  if (read.outcome === "blocked") return recordBlockedTerminal(context, read, now());

  const manifest = read.manifest;
  const identity = {
    source: manifest.source,
    runId: manifest.runId,
    terminalDigest: read.terminalDigest,
    registrationContractVersion: REGISTRATION_CONTRACT_VERSION,
  };
  const seenAt = now().toISOString();
  const inserted = await insertCollectionRunIfAbsent(env.DB, {
    ...identity,
    terminalKey: read.key,
    providerOutcome: manifest.providerOutcome,
    coverageStatus: manifest.coverageStatus,
    acquisitionSessionRef: manifest.acquisitionSessionRef ?? null,
    firstSeenAt: seenAt,
    blockedCode: null,
  });
  const row = await readCollectionRun(env.DB, identity);
  if (!row) throw new IngestError(500, "collection_run_not_visible");
  if (inserted > 0) {
    // The terminal exists and its objects are what it says they are as far as
    // the terminal itself goes: that is the `persisted` stage, and nothing
    // more. It is not a claim that the provider returned everything.
    await appendCollectionStage(env.DB, {
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
  if (row.registered_at !== null || (await collectionRunRegistered(env.DB, row.id))) {
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
  const conflict = await conflictingDigest(context, row);
  if (conflict) return block(context, row, "terminal_digest_conflict", "registered", now());
  const refusal = await refusalFor(context, manifest);
  if (refusal) return block(context, row, refusal, "registered", now());

  try {
    return await register(context, manifest, row);
  } catch (error) {
    if (error instanceof TerminalRegistrationError) {
      return block(context, row, error.code, "registered", now());
    }
    // The ingest contract refused a request derived from this manifest — a
    // descriptor with more relations or steps than it accepts, say. The
    // manifest schema allows what the contract does not, and asking again
    // cannot change the answer, so it blocks like any 4xx instead of
    // failing every tick.
    if (error instanceof ContractError) {
      return block(context, row, safeCode(error.code), "registered", now());
    }
    // A refusal CORE itself made: 4xx is about this terminal and blocks it;
    // 5xx is the server, so it stays retryable and the caller tries again.
    if (error instanceof IngestError && RETRYABLE_INGEST_CODES.has(error.code)) {
      return retryable(context, row, error.code, now());
    }
    if (error instanceof IngestError && error.status < 500) {
      return block(context, row, safeCode(error.code), "registered", now());
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
  context: Registration,
  manifest: TerminalManifest,
): Promise<string | null> {
  const sourceId = coreSourceId(manifest.source);
  if (sourceId === null) return "unknown_source";
  if (!(await sourceDeclared(context.env.DB, sourceId))) return "source_undeclared";
  if (manifest.providerOutcome === "failed" && !hasProviderArtifact(manifest)) {
    return "provider_run_failed";
  }
  return null;
}

/** The reserve of one artifact step: fixed work plus its steps and relations. */
export function artifactStepReserve(request: ArtifactRequest): number {
  return (
    ARTIFACT_STEP_BASE +
    (request.transformSteps?.length ?? 0) +
    2 * (request.relations?.length ?? 0)
  );
}

/**
 * The registration proper, as bounded steps. Every operation is idempotent on
 * its own key, and every call reads what the run already has and skips it, so
 * a run larger than one invocation's budget finishes over several (G1-10,
 * 03 §6) and the next call spends its budget only on what is missing.
 */
async function register(
  context: Registration,
  manifest: TerminalManifest,
  row: CollectionRunRow,
): Promise<RegisterTerminalOutcome> {
  const { input, env, port, budget } = context;
  const adopt = port.adoptObject;
  if (!adopt) throw new TerminalRegistrationError("registration_port_cannot_adopt_objects");
  const artifactCap = Math.max(1, input.artifactBudget ?? DEFAULT_ARTIFACT_BUDGET);
  const chunk = Math.min(
    MAX_INVENTORY_CHUNK_ITEMS,
    Math.max(1, input.inventoryChunk ?? DEFAULT_INVENTORY_CHUNK),
  );
  const verifyOptions = input.streamHash === undefined ? {} : { streamHash: input.streamHash };

  // Where an earlier call stopped. A pending attempt names the fetch run it
  // created, so a continuation does not verify ahead again: the run exists.
  const latest = await readLatestCollectionStage(env.DB, row.id, "registered");
  const continuing =
    latest?.state === "pending" && /^[1-9][0-9]*$/u.test(latest.evidence_ref ?? "");

  // Objects are verified before anything is recorded for them. On the first
  // call that happens before the fetch run exists, for as many artifacts as
  // this invocation can go on to catalogue — for every run that fits one
  // invocation, all of them — so a missing or resized object blocks the run
  // with no fetch run at all (G1-14). An artifact outside that window is
  // verified in its own step, just before it is catalogued, and a problem
  // found there blocks the run before its seal.
  const verified = new Set<string>();
  if (!continuing) {
    // Sized to what this invocation can go on to catalogue once the run, its
    // structure and the final step are paid for: an estimate that only
    // decides how much is checked early, never whether it is checked.
    const window = manifest.artifacts.slice(
      0,
      Math.floor(
        Math.max(0, budget.available - 4 * STRUCTURE_STEP_RESERVE - FINAL_STEP_RESERVE) /
          ARTIFACT_STEP_TYPICAL,
      ),
    );
    const checked = await verifyReferencedObjects(
      context.bucket,
      { ...manifest, artifacts: window },
      verifyOptions,
    );
    if (checked.outcome === "blocked") {
      const problem = checked.problems[0];
      return block(
        context,
        row,
        problem?.reasonCode ?? "object_unverified",
        "registered",
        context.now(),
      );
    }
    for (const artifact of window) verified.add(artifact.artifactKey);
  }
  if (!budget.fits(STRUCTURE_STEP_RESERVE)) {
    // Verification took what was left and nothing was written; ask again.
    budget.deferred += 1;
    return { outcome: "deferred" };
  }

  const fetchRunId = await port.createRun(createRunRequest(manifest));
  // What earlier calls already catalogued for this run. Those artifacts are
  // skipped rather than re-adopted as no-ops, so the budget is spent on new
  // work and a run with more artifacts than one budget converges instead of
  // re-cataloguing the same first page every tick.
  const already = new Set(
    (await readRunCatalogue(env.DB, fetchRunId)).map((catalogued) => catalogued.artifact_key),
  );
  const pending = (phase: RegistrationPhase) =>
    yieldPending(context, row, fetchRunId, phase, already.size, manifest.artifacts.length);

  // Structure: only the units and ranges the run does not have yet.
  const unitIds = new Map<string, number>();
  for (const unit of await readRunUnits(env.DB, fetchRunId)) {
    if (unit.parent_unit_id === null)
      unitIds.set(`${unit.unit_kind}\u0000${unit.unit_key}`, unit.id);
  }
  const unitIdsByKey = new Map<string, number>();
  for (const unit of manifest.units) {
    const existing = unitIds.get(`${unit.unitKind}\u0000${unit.unitKey}`);
    if (existing !== undefined) {
      unitIdsByKey.set(unit.unitKey, existing);
      continue;
    }
    if (!budget.fits(STRUCTURE_STEP_RESERVE)) return pending("structure");
    unitIdsByKey.set(unit.unitKey, await port.addUnit(fetchRunId, unitRequest(unit)));
  }
  const ranges = new Set(await readRunRangeKeys(env.DB, fetchRunId));
  for (const range of runRangeRequests(manifest)) {
    if (ranges.has(range.rangeKey)) continue;
    if (!budget.fits(STRUCTURE_STEP_RESERVE)) return pending("structure");
    await port.addRunRange(fetchRunId, range);
  }

  // The whole inventory is declared up front, so the seal can only succeed
  // once every artifact the manifest names is catalogued. A run that stops
  // half-way leaves the declaration and no seal. Deriving it is pure work.
  const descriptors = manifest.artifacts.map((artifact) => ({
    artifact,
    request: artifactRequest(manifest, artifact, unitIdsByKey),
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
    if (!budget.fits(STRUCTURE_STEP_RESERVE)) return pending("structure");
    const digest = await sha256Hex(
      new TextEncoder().encode(canonicalJsonV1(items as unknown as JsonValue)),
    );
    inventoryId = await port.beginInventory(fetchRunId, digest, items.length);
  }

  // Catalogued parents first: the catalogue links a relation to an artifact
  // that already exists, so a derived artifact must follow what it was
  // derived from, whatever their key order. The inventory itself stays in
  // key order above.
  const itemByKey = new Map(items.map((item) => [item.artifactKey, item]));
  let catalogued = 0;
  for (const entry of lineageOrder(descriptors)) {
    const key = entry.artifact.artifactKey;
    if (already.has(key)) continue;
    if (catalogued >= artifactCap || !budget.fits(artifactStepReserve(entry.request))) {
      // Out of budget. The run stays unsealed and therefore invisible to
      // normal readers; the next invocation continues from here (15 §2).
      return pending("catalogue");
    }
    if (!verified.has(key)) {
      const checked = await verifyReferencedObjects(
        context.bucket,
        { ...manifest, artifacts: [entry.artifact] },
        verifyOptions,
      );
      if (checked.outcome === "blocked") {
        const problem = checked.problems[0];
        return block(
          context,
          row,
          problem?.reasonCode ?? "object_unverified",
          "registered",
          context.now(),
        );
      }
    }
    // The bytes are already in the bucket at the key registration uses;
    // this records them, it does not write them (G1-15).
    await adopt.call(port, fetchRunId, entry.artifact.sha256, entry.artifact.byteSize);
    const descriptorSha256 = await port.addArtifact(fetchRunId, entry.request);
    if (descriptorSha256 !== itemByKey.get(key)!.descriptorSha256) {
      throw new TerminalRegistrationError("descriptor_digest_mismatch");
    }
    already.add(key);
    catalogued += 1;
  }

  // Every artifact is catalogued. A staged inventory now takes the items it
  // does not hold yet, one chunk per step; an item is only accepted for an
  // artifact the catalogue already has, which is why this follows it.
  if (staged) {
    const held = new Set(
      (await readInventoryItems(env.DB, inventoryId)).map((item) => item.artifact_key),
    );
    const missing = items.filter((item) => !held.has(item.artifactKey));
    for (let start = 0; start < missing.length; start += chunk) {
      const slice = missing.slice(start, start + chunk);
      if (!budget.fits(inventoryChunkReserve(slice.length))) return pending("inventory");
      await port.addInventoryItems(fetchRunId, inventoryId, slice);
    }
  }

  // The terminal reports, then the seal.
  const reported = new Set(
    (await readRunUnitReportKeys(env.DB, fetchRunId)).map(
      (report) => `${report.fetch_unit_id}\u0000${report.report_key}`,
    ),
  );
  for (const unit of manifest.units) {
    const unitId = unitIdsByKey.get(unit.unitKey);
    if (unitId === undefined) throw new TerminalRegistrationError("unit_not_registered");
    const request = unitReportRequest(unit, manifest);
    if (reported.has(`${unitId}\u0000${request.reportKey}`)) continue;
    if (!budget.fits(STRUCTURE_STEP_RESERVE)) return pending("terminal");
    await port.addUnitReport(unitId, request);
  }
  // The run report, the seal and the link that records it are one step: they
  // are never separated by a yield, so each is made once per registration.
  if (!budget.fits(FINAL_STEP_RESERVE)) return pending("terminal");
  await port.addRunReport(fetchRunId, runReportRequest(manifest));
  const startedAtMs = instantMs(manifest.startedAt);
  const attemptId = `${manifest.runId}:${REGISTRATION_CONTRACT_VERSION}`;
  if (staged) await port.sealStagedInventory(fetchRunId, inventoryId, attemptId, startedAtMs);
  else await port.seal(fetchRunId, items, attemptId, startedAtMs);

  const registeredAt = context.now().toISOString();
  await linkRegisteredRun(env.DB, row.id, {
    fetchRunId,
    acquisitionSessionId: await readFetchRunSessionId(env.DB, fetchRunId),
    registeredAt,
  });
  await appendCollectionStage(env.DB, {
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

/**
 * Stop at the budget with the progress recorded. The run stays unsealed; the
 * `registered` stage says `pending` and names the fetch run, which is what the
 * next invocation continues from (`readPendingRegistrations`).
 */
async function yieldPending(
  context: Registration,
  row: CollectionRunRow,
  fetchRunId: number,
  phase: RegistrationPhase,
  catalogued: number,
  artifacts: number,
): Promise<RegisterTerminalOutcome> {
  await appendCollectionStage(context.env.DB, {
    collectionRunId: row.id,
    stage: "registered",
    state: "pending",
    evidenceRef: String(fetchRunId),
    recordedAt: context.now().toISOString(),
  });
  context.budget.yielded += 1;
  return {
    outcome: "pending",
    collectionRunId: row.id,
    fetchRunId,
    terminalDigest: row.terminal_digest,
    catalogued,
    artifacts,
    phase,
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
  context: Registration,
  read: Extract<ReadTerminalResult, { outcome: "blocked" }>,
  at: Date,
): Promise<RegisterTerminalOutcome> {
  const { input, env } = context;
  // A second read, only on this path: the reader does not hand back the bytes
  // of a terminal it refused, and an unreadable terminal is rare.
  const stored = await context.bucket.get(read.key);
  if (!stored) return { outcome: "missing" };
  const digest = await sha256Hex(new Uint8Array(await stored.arrayBuffer()));
  const identity = {
    source: input.source,
    runId: input.runId,
    terminalDigest: digest,
    registrationContractVersion: REGISTRATION_CONTRACT_VERSION,
  };
  const seenAt = at.toISOString();
  const inserted = await insertCollectionRunIfAbsent(env.DB, {
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
  const row = await readCollectionRun(env.DB, identity);
  if (row && inserted > 0) {
    await appendCollectionStage(env.DB, {
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
async function conflictingDigest(context: Registration, row: CollectionRunRow): Promise<boolean> {
  const rows = await readCollectionRunsFor(context.env.DB, row.source, row.run_id);
  return rows.some(
    (other) =>
      other.id !== row.id &&
      other.registration_contract_version === row.registration_contract_version &&
      other.terminal_digest !== row.terminal_digest,
  );
}

async function retryable(
  context: Registration,
  row: CollectionRunRow,
  code: string,
  at: Date,
): Promise<RegisterTerminalOutcome> {
  const safe = safeCode(code);
  // The stage table is append-only, and a configuration problem repeats every
  // tick. One row per *change* of state keeps the history readable instead of
  // filling it with the same sentence.
  const latest = await readLatestCollectionStage(context.env.DB, row.id, "registered");
  if (latest?.state !== "retryable" || latest.failure_code !== safe) {
    await appendCollectionStage(context.env.DB, {
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
  context: Registration,
  row: CollectionRunRow,
  code: string,
  stage: "persisted" | "registered",
  at: Date,
): Promise<RegisterTerminalOutcome> {
  const safe = safeCode(code);
  const recordedAt = at.toISOString();
  await appendCollectionStage(context.env.DB, {
    collectionRunId: row.id,
    stage,
    state: "blocked",
    failureCode: safe,
    recordedAt,
  });
  await blockCollectionRun(context.env.DB, row.id, safe);
  return { outcome: "blocked", collectionRunId: row.id, code: safe };
}

/** The stored codes are machine codes; anything else becomes one generic code. */
function safeCode(value: string): string {
  return /^[a-z0-9_]{1,64}$/u.test(value) ? value : "unsafe_reason_code";
}
