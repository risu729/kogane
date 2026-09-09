// `kogane.context.open`: fix the set of versions an answer is computed from.
//
// Contexts are not stored. `contextId` is the canonical digest of the context
// manifest itself (`canonical-json-v1`, packages/domain), so:
//
//   * it is re-derivable — any node can recompute it from the same inputs and
//     get the same id, and a client that keeps only the id can be handed back
//     the manifest to check;
//   * it cannot drift — changing any pinned input necessarily changes the id
//     (INV09), which is exactly the property a `financial_contexts` table
//     would have had to be trusted to enforce with a trigger;
//   * it needs no migration, no write path, no expiry job and no cross-Worker
//     replication, and it keeps this package pure.
//
// The cost is that a context has no server-side lifetime: an id whose inputs
// have moved on is simply a different id, so a stale cursor is refused
// (`stale_context`) rather than answered from a table that no longer matches
// the data. That trade is the right one here because every pinned input is
// already immutable in the store; nothing is remembered that could rot.
import { canonicalDigest, type FinancialContext } from "../../../domain/src/context.ts";
import type { QuerySpec } from "../../../domain/src/result.ts";
import type { TemporalValue } from "../../../domain/src/time.ts";
import type { InterpretationContext } from "../../../../poc/observation-pipeline/shared/api-schema.ts";
import { type Grant, perimeterRefFor } from "../grants.ts";
import {
  type QueryRequest,
  requestedLimit,
  resolveQuerySpec,
  type SupportedQueryIntent,
} from "../query/spec.ts";

export const QUERY_SEMANTICS_VERSION = "query-semantics-v1";
/** No adopted economic-event or valuation policy exists yet; the context says so. */
export const EVENT_DECISION_MANIFEST_REF = "economic-events:none-v1";

/**
 * What the server knows before it answers: the clock, the publication
 * high-water mark of the visible read model, the parser builds behind it, the
 * sources this grant can see, and the interpretation releases in force.
 * Every field is read from the shared read model, never from the request.
 */
export interface ContextInputs {
  /** Instant the evaluation runs at. */
  now: string;
  /** Highest visible publication; what "current" means for this context. */
  publicationHighWater: string;
  /** Digest over the parser builds behind the visible publications. */
  parserBuildDigest: string;
  /** Source ids visible to this grant, sorted; the selection this context read. */
  visibleSources: readonly string[];
  interpretation: InterpretationContext;
}

/** A default the server chose because the caller did not state a preference. */
export interface UnresolvedInput {
  key: string;
  /** The question that was not asked, in fixed server text. */
  question: string;
  /** The value the server used. */
  chosen: string;
  reasonCode: string;
}

export interface OpenContextRequest {
  /** The query this context is opened for; a context with no query still resolves. */
  query?: QueryRequest;
  /** Instant after which evidence is not part of this context. */
  knowledgeCutoff?: string;
  /** Interpretation mode; `latest` when not stated. */
  identityRead?: InterpretationContext["mode"];
}

export interface OpenedContext {
  context: FinancialContext;
  interpretation: InterpretationContext;
  /** Server-resolved, never a caller paraphrase. */
  resolvedQuery: QuerySpec;
  unresolvedInputs: UnresolvedInput[];
}

const DEFAULT_INTENT: SupportedQueryIntent = "coverage";
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

function selectionRef(sources: readonly string[]): string {
  const joined = [...sources].sort().join(",");
  return joined.length <= 480 ? `sources:${joined}` : `sources@count=${String(sources.length)}`;
}

/**
 * Resolve every input this answer depends on and return the fixed context.
 * The caller may state a knowledge cutoff and an interpretation mode; every
 * other axis is the server's, and each default the server picked is reported
 * in `unresolvedInputs` rather than applied silently.
 */
export async function openContext(
  grant: Grant,
  inputs: ContextInputs,
  request: OpenContextRequest = {},
): Promise<OpenedContext> {
  const unresolved: UnresolvedInput[] = [];
  const knowledgeCutoff =
    request.knowledgeCutoff !== undefined && INSTANT.test(request.knowledgeCutoff)
      ? request.knowledgeCutoff
      : inputs.now;
  if (request.knowledgeCutoff === undefined)
    unresolved.push({
      key: "knowledgeCutoff",
      question: "which recording instant the answer is allowed to know about",
      chosen: knowledgeCutoff,
      reasonCode: "defaulted_to_evaluation_clock",
    });
  if (request.identityRead === undefined)
    unresolved.push({
      key: "identityRead",
      question: "current mappings, or the mappings recorded when the run was sealed",
      chosen: inputs.interpretation.mode,
      reasonCode: "defaulted_to_latest_identity",
    });
  unresolved.push({
    key: "valuation",
    question: "whether amounts are valued in a common unit",
    chosen: "no valuation policy is adopted; quantities stay in their own units",
    reasonCode: "no_valuation_policy_adopted",
  });
  const effectiveTime: TemporalValue = {
    kind: "instant",
    value: inputs.now,
    zone: "UTC",
    basis: "derived",
  };
  unresolved.push({
    key: "effectiveTime",
    question: "the instant the reported state is evaluated at",
    chosen: inputs.now,
    reasonCode: "defaulted_to_evaluation_clock",
  });

  const perimeterRef = perimeterRefFor(grant);
  const manifest = {
    schemaVersion: "financial-context-v1",
    querySemanticsVersion: QUERY_SEMANTICS_VERSION,
    perimeterRef,
    effectiveTime,
    knowledgeCutoff,
    publicationRef: inputs.publicationHighWater,
    sourceSelectionManifestRef: selectionRef(inputs.visibleSources),
    parserBuildManifestRef: `parser-builds:${inputs.parserBuildDigest}`,
    metadataBuildManifestRef: `product-catalogue:${inputs.interpretation.productCatalogueRelease}+resolver:${inputs.interpretation.productResolverRelease}`,
    identityDecisionManifestRef: `identity:${inputs.interpretation.mode}:${inputs.interpretation.identityRelease}`,
    eventDecisionManifestRef: EVENT_DECISION_MANIFEST_REF,
    referenceManifestRef: `metric-registry:${inputs.interpretation.measurePolicyRelease}`,
    calculationPolicyRef: `decimal:${inputs.interpretation.decimalPolicyRelease}+aggregation:none-v1`,
    evaluationClock: inputs.now,
  } as const;
  const context: FinancialContext = {
    contextId: `ctx_${await canonicalDigest(manifest)}`,
    ...manifest,
  };

  const query: QueryRequest = request.query ?? {
    intent: DEFAULT_INTENT,
    filters: {},
    cursor: null,
    limit: null,
  };
  if (request.query === undefined)
    unresolved.push({
      key: "intent",
      question: "which question this context is opened for",
      chosen: DEFAULT_INTENT,
      reasonCode: "defaulted_to_coverage",
    });
  const resolvedQuery = resolveQuerySpec({
    request: query,
    perimeterRef,
    effectiveTime,
    basisRefs: {
      publication: context.publicationRef,
      identity: context.identityDecisionManifestRef,
      metrics: context.referenceManifestRef,
      decimals: context.calculationPolicyRef,
    },
    limit: requestedLimit(query),
  });
  return {
    context,
    interpretation: inputs.interpretation,
    resolvedQuery,
    unresolvedInputs: unresolved,
  };
}

/** Recompute a context id from its own manifest; equal inputs give an equal id. */
export async function contextIdOf(context: FinancialContext): Promise<string> {
  const { contextId: _id, ...manifest } = context;
  return `ctx_${await canonicalDigest(manifest)}`;
}
