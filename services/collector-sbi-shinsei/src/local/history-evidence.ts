// Offline evidence only. No browser, transport, parser registration, or route activation.
import {
  persistRun,
  planManifest,
  readTerminalAt,
  sha256Hex,
  terminalDigest,
  terminalKey,
  type PersistRunPlan,
  type R2BucketLike,
} from "../../../../packages/collection/src";
import {
  inspectObservedHistoryResponse,
  type HistoryInspection,
  type ObservedYenPeriod,
} from "./history-observation";
import { SHARED_SOURCE, PRODUCER } from "../shared-collection";
export { SHARED_SOURCE, PRODUCER };

const VERSION = "history-evidence-only-v1";
const BODY_KEY = "history-decoded.json";
const CONTEXT_KEY = "history-context.json";
const UNIT = "yen-period";
const MAX_BODY = 2 * 1024 * 1024;
const MAX_CONTEXT = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface HistoryEvidenceInput {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly requestContext: ObservedYenPeriod;
  readonly response: { readonly status: number; readonly mediaType: string; readonly body: string };
}

export class HistoryEvidenceError extends Error {
  constructor() {
    super("history_evidence_refused");
    this.name = "HistoryEvidenceError";
  }
}
function refuse(): never {
  throw new HistoryEvidenceError();
}

// Reject accessors, symbols and extra fields before copying any input values.
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key) || !("value" in descriptors[key]!))
  )
    return refuse();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") return refuse();
  return value;
}
function snapshot(value: unknown): HistoryEvidenceInput {
  const root = exact(value, ["runId", "startedAt", "completedAt", "requestContext", "response"]);
  const scope = exact(root.requestContext, ["accountNo", "fromDate", "toDate"]);
  const response = exact(root.response, ["status", "mediaType", "body"]);
  const runId = text(root.runId);
  if (!UUID.test(runId) || typeof response.status !== "number") return refuse();
  return {
    runId,
    startedAt: text(root.startedAt),
    completedAt: text(root.completedAt),
    requestContext: {
      accountNo: text(scope.accountNo),
      fromDate: text(scope.fromDate),
      toDate: text(scope.toDate),
    },
    response: {
      status: response.status,
      mediaType: text(response.mediaType),
      body: text(response.body),
    },
  };
}
function scalarUnicode(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) refuse();
    } else if (code >= 0xdc00 && code <= 0xdfff) refuse();
  }
}

/** JSON.parse alone silently loses duplicate keys (including shadowed secrets). */
function checkedJson(body: string, budget: number): unknown {
  if (body.length > budget) return refuse();
  scalarUnicode(body);
  if (new TextEncoder().encode(body).byteLength > budget) return refuse();
  const parsed: unknown = JSON.parse(body);
  const stack: { keys: Set<string> | null; expectsKey: boolean }[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "{" || ch === "[") {
      stack.push({ keys: ch === "{" ? new Set() : null, expectsKey: true });
      if (stack.length > 64) refuse();
    } else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ":") {
      const top = stack.at(-1);
      if (top) top.expectsKey = false;
    } else if (ch === ",") {
      const top = stack.at(-1);
      if (top) top.expectsKey = true;
    } else if (ch === '"') {
      const start = i;
      for (i += 1; i < body.length; i += 1) {
        if (body[i] === "\\") i += 1;
        else if (body[i] === '"') break;
      }
      const decoded = text(JSON.parse(body.slice(start, i + 1)));
      scalarUnicode(decoded);
      const top = stack.at(-1);
      if (top?.keys && top.expectsKey) {
        if (top.keys.has(decoded)) refuse();
        top.keys.add(decoded);
      }
    }
  }
  return parsed;
}
function summary(inspection: HistoryInspection) {
  return {
    inspectionOutcome: inspection.outcome,
    rowCount: inspection.rows.length,
    periodEchoVerified: inspection.periodEchoVerified,
    reasonCodes: [...inspection.reasonCodes],
    coverageStatus: "unknown" as const,
    captureVerified: false as const,
    providerOriginVerified: false as const,
    registrationReady: false as const,
  };
}
export type HistoryEvidenceSummary = ReturnType<typeof summary>;

async function buildOwned(input: HistoryEvidenceInput): Promise<PersistRunPlan> {
  checkedJson(input.response.body, MAX_BODY);
  const inspection = inspectObservedHistoryResponse(input.requestContext, input.response);
  const context = {
    schemaVersion: VERSION,
    runId: input.runId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    requestContext: input.requestContext,
    response: { status: input.response.status, mediaType: input.response.mediaType },
    representation: "decoded_json_utf8",
    inspection: summary(inspection),
  };
  const body = new TextEncoder().encode(input.response.body);
  const contextBytes = new TextEncoder().encode(JSON.stringify(context));
  if (contextBytes.byteLength > MAX_CONTEXT) refuse();
  const iso = (date: string) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const startValue = iso(input.requestContext.fromDate);
  const endValue = iso(input.requestContext.toDate);
  const plan: PersistRunPlan = {
    run: {
      source: SHARED_SOURCE,
      producer: PRODUCER,
      producerVersion: VERSION,
      runId: input.runId,
      attemptId: input.runId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      requestedScope: { scopeKind: "date_range", startValue, endValue, unitKeys: [UNIT] },
      providerOutcome: "partial",
      coverageStatus: "unknown",
      persistenceComplete: true,
      safeErrorCode: "history_capture_origin_unverified",
      units: [{ unitKey: UNIT, unitKind: "account", artifactCount: 1, coverageStatus: "unknown" }],
      ranges: [
        {
          rangeKey: "requested-period",
          rangeKind: "requested",
          precision: "date",
          basis: "request",
          startValue,
          endValue,
          unitKey: UNIT,
        },
      ],
      reports: [],
      transformations: [
        {
          transformationId: "decoded-json-utf8",
          stepKind: "reencoded",
          transformerId: "collector-sbi-shinsei-history-evidence",
          transformerVersion: VERSION,
          inputArtifactKeys: [],
          outputArtifactKey: BODY_KEY,
        },
        {
          transformationId: "generated-context",
          stepKind: "generated",
          transformerId: "collector-sbi-shinsei-history-evidence",
          transformerVersion: VERSION,
          inputArtifactKeys: [],
          outputArtifactKey: CONTEXT_KEY,
        },
      ],
    },
    artifacts: [
      {
        artifactKey: BODY_KEY,
        sha256: await sha256Hex(body),
        byteSize: body.byteLength,
        mediaType: "application/json",
        role: "collector_derived",
        unitKey: UNIT,
        body: { kind: "bytes", bytes: body },
      },
      {
        artifactKey: CONTEXT_KEY,
        sha256: await sha256Hex(contextBytes),
        byteSize: contextBytes.byteLength,
        mediaType: "application/json",
        role: "collector_manifest",
        body: { kind: "bytes", bytes: contextBytes },
      },
    ],
  };
  planManifest(plan); // Validate metadata before the first storage operation.
  return plan;
}

/** Exact decoded string fidelity, not original HTTP response bytes or capture proof. */
export async function buildHistoryEvidencePlan(
  input: HistoryEvidenceInput,
): Promise<PersistRunPlan> {
  try {
    return await buildOwned(snapshot(input));
  } catch {
    return refuse();
  }
}

export type HistoryEvidenceReadback =
  | { readonly outcome: "verified"; readonly summary: HistoryEvidenceSummary }
  | { readonly outcome: "refused"; readonly reasonCode: "history_evidence_readback_refused" };

/** Verify actual bytes of both objects even when metadata/checksums claim success. */
export async function readHistoryEvidence(
  bucket: R2BucketLike,
  receipt: { readonly runId: string; readonly terminalDigest: string },
): Promise<HistoryEvidenceReadback> {
  try {
    const value = exact(receipt, ["runId", "terminalDigest"]);
    const runId = text(value.runId);
    const digest = text(value.terminalDigest);
    if (!UUID.test(runId) || !SHA256.test(digest)) refuse();
    const terminal = await readTerminalAt(bucket, terminalKey(SHARED_SOURCE, runId));
    if (terminal.outcome !== "found" || terminal.terminalDigest !== digest) return refuse();
    if (terminal.manifest.artifacts.length !== 2) refuse();
    const contents = new Map<string, string>();
    for (const artifact of terminal.manifest.artifacts) {
      const limit =
        artifact.artifactKey === BODY_KEY
          ? MAX_BODY
          : artifact.artifactKey === CONTEXT_KEY
            ? MAX_CONTEXT
            : 0;
      if (!limit || artifact.byteSize > limit) refuse();
      const object = await bucket.get(artifact.storageRef.key);
      if (!object || object.size !== artifact.byteSize) return refuse();
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength !== artifact.byteSize || (await sha256Hex(bytes)) !== artifact.sha256)
        refuse();
      contents.set(
        artifact.artifactKey,
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      );
    }
    const context = exact(checkedJson(text(contents.get(CONTEXT_KEY)), MAX_CONTEXT), [
      "schemaVersion",
      "runId",
      "startedAt",
      "completedAt",
      "requestContext",
      "response",
      "representation",
      "inspection",
    ]);
    const response = exact(context.response, ["status", "mediaType"]);
    const owned = snapshot({
      runId: context.runId,
      startedAt: context.startedAt,
      completedAt: context.completedAt,
      requestContext: context.requestContext,
      response: { ...response, body: text(contents.get(BODY_KEY)) },
    });
    const rebuilt = await buildOwned(owned);
    // Rebuilding binds identity, scope, roles, transformations, exact inventory and
    // every context field (including recomputed summary) to the caller's receipt.
    if ((await terminalDigest(planManifest(rebuilt))) !== digest) refuse();
    return {
      outcome: "verified",
      summary: summary(inspectObservedHistoryResponse(owned.requestContext, owned.response)),
    };
  } catch {
    return { outcome: "refused", reasonCode: "history_evidence_readback_refused" };
  }
}

export type HistoryEvidencePersistResult =
  | {
      readonly outcome: "persisted" | "already_persisted";
      readonly runId: string;
      readonly terminalDigest: string;
      readonly readback: HistoryEvidenceReadback;
    }
  | {
      readonly outcome: "incomplete";
      readonly reasonCode: "history_evidence_incomplete";
      readonly persistedArtifactCount: number;
      readonly pendingArtifactCount: number;
    }
  | { readonly outcome: "conflict"; readonly reasonCode: "history_evidence_conflict" }
  | { readonly outcome: "refused"; readonly reasonCode: "history_evidence_refused" }
  | { readonly outcome: "unknown"; readonly reasonCode: "history_evidence_persist_failed" };

export async function persistHistoryEvidence(
  bucket: R2BucketLike,
  input: HistoryEvidenceInput,
): Promise<HistoryEvidencePersistResult> {
  let plan: PersistRunPlan;
  try {
    plan = await buildHistoryEvidencePlan(input);
  } catch {
    return { outcome: "refused", reasonCode: "history_evidence_refused" };
  }
  try {
    const result = await persistRun(bucket, plan);
    if (result.outcome === "conflict")
      return { outcome: "conflict", reasonCode: "history_evidence_conflict" };
    if (result.outcome === "incomplete")
      return {
        outcome: "incomplete",
        reasonCode: "history_evidence_incomplete",
        persistedArtifactCount: result.checkpoint.persistedArtifactKeys.length,
        pendingArtifactCount: result.checkpoint.pendingArtifactKeys.length,
      };
    const receipt = { runId: plan.run.runId, terminalDigest: result.terminalDigest };
    return {
      outcome: result.outcome,
      ...receipt,
      readback: await readHistoryEvidence(bucket, receipt),
    };
  } catch {
    return { outcome: "unknown", reasonCode: "history_evidence_persist_failed" };
  }
}
