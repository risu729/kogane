// `kogane.explain`: a bounded graph of why a result says what it says.
//
// The graph is ids only. It never carries provider text, a provider URL, a
// credential, a raw body or an exception string, and it is depth-limited so
// "explain" can never become "download everything". Reaching a raw locator is
// a separate capability: `records.read` gets the adopted claim, the identity
// decision and the parse run; only `evidence.read` gets the artifact and
// object references under them, and a caller without it is told which
// capability is missing rather than being shown a shorter graph silently.
//
// Every ref is re-authorized here. A ref that names something outside the
// grant and a ref that names nothing at all get the same answer, so an agent
// cannot probe for the existence of a hidden account (SC18).
import type { FinancialError } from "../../domain/src/result.ts";
import type { ObservationReader } from "../../read-model/src/index";
import { financialError } from "./errors.ts";
import { type Grant, grantAllows, grantAllowsRow, grantAllowsSource } from "./grants.ts";
import type { OpenedContext } from "./context/open.ts";

export const EXPLANATION_NODE_KINDS = [
  "result-row",
  "scope",
  "adopted-claim",
  "identity-decision",
  "parse-run",
  "raw-locator",
] as const;
export type ExplanationNodeKind = (typeof EXPLANATION_NODE_KINDS)[number];

export interface ExplanationNode {
  ref: string;
  kind: ExplanationNodeKind;
  depth: number;
  /** Refs one level closer to the result; ids only. */
  parents: string[];
}

export interface ExplanationGraph {
  schemaVersion: "explanation-graph-v1";
  contextId: string;
  rootRef: string;
  depth: number;
  nodes: ExplanationNode[];
  /** The graph stops at `depth`; deeper evidence exists but was not expanded. */
  truncated: boolean;
  /** Capabilities that would have added levels this principal cannot see. */
  restricted: string[];
}

export type ExplainOutcome =
  | { ok: true; graph: ExplanationGraph }
  | { ok: false; error: FinancialError };

export interface ExplainRequest {
  ref: string;
  depth: number | null;
}

export const DEFAULT_EXPLAIN_DEPTH = 4;
/** Deepest level the graph has: result → scope → claim → decision/parse → locator. */
export const MAX_NODE_DEPTH = 4;
const OBSERVATION_REF =
  /^observation:(transaction|balance|position|valuation):([1-9][0-9]{0,15})$/u;
const SOURCE_REF = /^source:([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/u;

export type ExplainReader = Pick<ObservationReader, "getObservation">;

export async function explain(input: {
  grant: Grant;
  opened: OpenedContext;
  reader: ExplainReader;
  request: ExplainRequest;
}): Promise<ExplainOutcome> {
  const { grant, opened, reader, request } = input;
  const requestId = opened.context.contextId;
  const fail = (
    code: Parameters<typeof financialError>[0],
    refs: string[] = [],
  ): ExplainOutcome => ({ ok: false, error: financialError(code, requestId, refs) });

  if (!grantAllows(grant, "summary.read")) return fail("unauthorized", ["capability:summary.read"]);
  const evidence = grantAllows(grant, "evidence.read");
  const maxDepth = Math.min(
    request.depth ?? DEFAULT_EXPLAIN_DEPTH,
    grant.budget.maxExplainDepth,
    MAX_NODE_DEPTH,
  );
  if (maxDepth < 1) return fail("budget_exceeded", ["budget:maxExplainDepth"]);

  const sourceMatch = SOURCE_REF.exec(request.ref);
  if (sourceMatch) {
    const sourceId = sourceMatch[1]!;
    if (!grantAllowsSource(grant, sourceId)) return fail("evidence_restricted", ["scope:source"]);
    return {
      ok: true,
      graph: {
        schemaVersion: "explanation-graph-v1",
        contextId: opened.context.contextId,
        rootRef: request.ref,
        depth: maxDepth,
        nodes: [{ ref: request.ref, kind: "scope", depth: 0, parents: [] }],
        truncated: false,
        restricted: evidence ? [] : ["evidence.read"],
      },
    };
  }

  const match = OBSERVATION_REF.exec(request.ref);
  if (!match) return fail("unsupported_semantics", ["ref"]);
  const kind = match[1] as "transaction" | "balance" | "position" | "valuation";
  const id = Number(match[2]);
  const detail = await reader.getObservation({ kind, id });
  const sourceId = detail?.provenance?.source_id ?? null;
  const account =
    typeof detail?.row["source_account"] === "string" ? detail.row["source_account"] : null;
  // Absent and out-of-scope are the same answer on purpose.
  if (detail === undefined || sourceId === null || !grantAllowsRow(grant, sourceId, account))
    return fail("evidence_restricted", ["ref"]);

  const provenance = detail.provenance;
  if (provenance === undefined) return fail("incomplete_evidence", ["ref"]);
  const nodes: ExplanationNode[] = [
    { ref: request.ref, kind: "result-row", depth: 0, parents: [] },
  ];
  const add = (node: ExplanationNode): void => {
    if (node.depth <= maxDepth && !nodes.some((existing) => existing.ref === node.ref))
      nodes.push(node);
  };
  add({ ref: `source:${sourceId}`, kind: "scope", depth: 1, parents: [request.ref] });
  if (account !== null)
    add({
      ref: `source_account:${sourceId}/${account}`,
      kind: "scope",
      depth: 1,
      parents: [request.ref],
    });

  const organization = detail.organization;
  const claimParents = [request.ref];
  if (organization?.account) {
    const claim = `account_mapping:${organization.account.referenceId}@${String(organization.account.revision)}`;
    add({ ref: claim, kind: "adopted-claim", depth: 2, parents: claimParents });
    add({
      ref: `identity-decision:${organization.account.method}:${organization.account.referenceId}@${String(organization.account.revision)}`,
      kind: "identity-decision",
      depth: 3,
      parents: [claim],
    });
  }
  for (const instrument of organization?.instruments ?? []) {
    const claim = `instrument_mapping:${instrument.referenceId}@${String(instrument.revision)}`;
    add({ ref: claim, kind: "adopted-claim", depth: 2, parents: claimParents });
  }

  const parseRef = `parse_run:${String(provenance.parse_run_id)}`;
  add({ ref: parseRef, kind: "parse-run", depth: 3, parents: [request.ref] });
  // Locators only, never the provider URL the artifact was fetched from.
  if (evidence) {
    add({
      ref: `fetch_artifact:${String(provenance.artifact_id)}`,
      kind: "raw-locator",
      depth: 4,
      parents: [parseRef],
    });
    add({ ref: `raw:${provenance.sha256}`, kind: "raw-locator", depth: 4, parents: [parseRef] });
  }
  return {
    ok: true,
    graph: {
      schemaVersion: "explanation-graph-v1",
      contextId: opened.context.contextId,
      rootRef: request.ref,
      depth: maxDepth,
      nodes,
      truncated: maxDepth < MAX_NODE_DEPTH,
      restricted: evidence ? [] : ["evidence.read"],
    },
  };
}

/** Validate an untrusted explain body: two keys, no free-form anything else. */
export function parseExplainRequest(
  value: unknown,
):
  | { ok: true; value: ExplainRequest }
  | { ok: false; code: "unsupported_semantics" | "invalid_query"; refs: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { ok: false, code: "invalid_query", refs: [] };
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => key !== "ref" && key !== "depth");
  if (unknown.length > 0)
    return { ok: false, code: "unsupported_semantics", refs: unknown.slice(0, 10) };
  const ref = body["ref"];
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 512)
    return { ok: false, code: "invalid_query", refs: ["ref"] };
  const depth = body["depth"] ?? null;
  if (
    depth !== null &&
    (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 1 || depth > 16)
  )
    return { ok: false, code: "invalid_query", refs: ["depth"] };
  return { ok: true, value: { ref, depth: depth as number | null } };
}
