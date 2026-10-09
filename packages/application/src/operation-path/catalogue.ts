// OPERATION_CATALOGUE: the closed list of operations an audit record may name
// (ADR 0063 item 9, ADR 0064; plan section 6.3).
//
// This is the skeleton for the operations that exist today, on the paths that
// reach them today. Each entry says which risk classes the operation is
// recorded under (the first is its default), what its writer's own record
// says when the effect is applied (`applied`, `accepted`, or null for a read),
// what a successful call that wrote nothing is (`read`, or `replayed` when an
// earlier call already made the effect), which capability grades it today,
// and on which paths it exists. The handler of each operation is the existing
// service the adapter already calls; no operation is implemented twice, and
// no delegation, prepare or confirm exists yet (ADR 0063, later slices).
//
// The operation name of an agent tool is the tool name without `kogane.`.
import type { RiskClass, SubjectPath } from "../audit/vocabulary.ts";
import type { DelegationCapability } from "../delegation/contract.ts";

export interface CatalogueEntry {
  /** The risk classes this operation may be recorded under; the first is the default. */
  risk: readonly [RiskClass, ...RiskClass[]];
  /** The writer's own record of an applied effect; null for an operation that writes nothing. */
  effect: "applied" | "accepted" | null;
  /** A successful call whose writer wrote nothing. */
  quiet: "read" | "replayed";
  /** The capability that grades the operation today (the change lifecycle's or the agent API's). */
  capability: string;
  /**
   * The capability an owner's delegation must hold for this operation on
   * `mcp` (ADR 0063). Nothing executes under a delegation yet (plan slice
   * S3): a call on `mcp` is refused at the delegation gate and recorded.
   */
  delegation?: DelegationCapability;
  /** The paths the operation exists on today. */
  paths: readonly SubjectPath[];
}

const UI: readonly SubjectPath[] = ["ui"];
const AGENT: readonly SubjectPath[] = ["agent-http", "mcp"];
// The operations tools of docs/ops-api.md are never served on `/mcp` now: its
// only caller is an MCP client, which is agent-only (ADR 0047), so the tools
// are not published to it and every call is refused `actor_not_supported`
// before any grader runs. That refusal is recorded under the tool's operation
// on `mcp`, which is why the path stays listed.
const OPS: readonly SubjectPath[] = ["ui", "mcp"];

export const OPERATION_CATALOGUE = {
  // ── the change lifecycle (W7–W13, H1) ───────────────────────────────────
  "command.plan": {
    risk: ["R1"],
    effect: "applied",
    quiet: "replayed",
    capability: "interpretation.propose",
    paths: UI,
  },
  "command.simulate": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "interpretation.propose",
    paths: UI,
  },
  "command.approve": {
    risk: ["R2"],
    effect: "applied",
    quiet: "replayed",
    capability: "interpretation.accept",
    paths: UI,
  },
  "command.commit": {
    risk: ["R2"],
    effect: "applied",
    quiet: "replayed",
    capability: "interpretation.accept",
    paths: UI,
  },
  "command.operation.get": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "interpretation.propose",
    paths: UI,
  },
  // ── operations requests (H2–H7) ────────────────────────────────────────
  "ops.collection.request": {
    risk: ["R2"],
    effect: "accepted",
    quiet: "replayed",
    capability: "interpretation.accept",
    paths: OPS,
  },
  "ops.import.request": {
    risk: ["R1"],
    effect: "accepted",
    quiet: "replayed",
    capability: "interpretation.accept",
    paths: OPS,
  },
  "ops.replay.request": {
    risk: ["R1"],
    effect: "accepted",
    quiet: "replayed",
    capability: "interpretation.accept",
    paths: OPS,
  },
  "ops.projection.request": {
    risk: ["R1"],
    effect: "accepted",
    quiet: "replayed",
    capability: "interpretation.accept",
    paths: OPS,
  },
  "ops.session.refresh": {
    risk: ["R2"],
    effect: "accepted",
    quiet: "replayed",
    capability: "interpretation.accept",
    paths: OPS,
  },
  "ops.operation.get": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "interpretation.accept",
    paths: OPS,
  },
  // ── schedule settings (W1–W6) ──────────────────────────────────────────
  "schedules.job.update": {
    risk: ["R2"],
    effect: "applied",
    quiet: "replayed",
    capability: "interpretation.accept",
    paths: UI,
  },
  // A maintenance revision (W3): R1 inside the direct envelope of ADR 0063
  // item 8 — a delegated revision that leaves no new joined deferral over
  // seven days. Beyond that bound it is R3 until the owner answers the plan's
  // question 1, and the writer refuses it (`maintenance_deferral_too_long`).
  // On `ui` the operator's edit; on `mcp` the delegated tool, which no
  // delegation can execute yet, so every call there is a recorded refusal.
  "schedules.maintenance.update": {
    risk: ["R1", "R3"],
    effect: "applied",
    quiet: "replayed",
    capability: "interpretation.accept",
    delegation: "schedules.maintenance.update",
    paths: ["ui", "mcp"],
  },
  // Accepting a proposal changes a rule (R2); rejecting records a decision
  // only (R1). One route, so one operation recorded under either class.
  "schedules.survey.decide": {
    risk: ["R2", "R1"],
    effect: "applied",
    quiet: "replayed",
    capability: "interpretation.accept",
    paths: UI,
  },
  // Stopped-execution lease release: operator in the UI only (R3).
  "schedules.lease.release": {
    risk: ["R3"],
    effect: "applied",
    quiet: "replayed",
    capability: "interpretation.accept",
    paths: UI,
  },
  // ── agent API tools (docs/agent-api.md) ─────────────────────────────────
  capabilities: { risk: ["R0"], effect: null, quiet: "read", capability: "", paths: AGENT },
  "context.open": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "summary.read",
    paths: AGENT,
  },
  "financial.query": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "summary.read",
    paths: AGENT,
  },
  explain: {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "records.read",
    paths: AGENT,
  },
  "instruments.candidates": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "records.read",
    paths: AGENT,
  },
  // The reconstructed state of one account (#610), served while its GET
  // route is; an unserved tool is not an operation and is not recorded.
  "reconstructed-state.read": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "records.read",
    paths: AGENT,
  },
  "purchases.explain": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "records.read",
    paths: AGENT,
  },
  // The maintenance settings of the granted schedule sources (ADR 0046, plan
  // D15), served while the settings routes are.
  "schedules.maintenance.read": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "schedules.read",
    paths: AGENT,
  },
  // An inert proposal (H8); acceptance is the operator's.
  "reconcile.propose": {
    risk: ["R1"],
    effect: "applied",
    quiet: "replayed",
    capability: "interpretation.propose",
    paths: AGENT,
  },
  // A refusal on `/mcp` before any tool is named: the App's own (a method
  // other than POST, a query string, a cross-origin request, no grant) and
  // the MCP SDK's HTTP refusals (a body that is not JSON, too large, of the
  // wrong media type, a client that does not accept JSON, an unsupported
  // protocol header). Recorded so such a refusal after authentication is
  // never silent. JSON-RPC errors inside a 200 (an unknown method or tool) and
  // accepted notifications are the protocol's own and not recorded.
  "mcp.request": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "",
    paths: ["mcp"],
  },
  // The Processor's daily aggregate of capped records (ADR 0064, "Daily caps").
  "audit.overflow": {
    risk: ["R0"],
    effect: null,
    quiet: "read",
    capability: "",
    paths: ["ui", "agent-http", "mcp"],
  },
} as const satisfies Record<string, CatalogueEntry>;

export type OperationName = keyof typeof OPERATION_CATALOGUE;

export function isOperationName(value: string): value is OperationName {
  return Object.hasOwn(OPERATION_CATALOGUE, value);
}

export function catalogueEntry(operation: OperationName): CatalogueEntry {
  return OPERATION_CATALOGUE[operation];
}

/** Catalogue entries that are not tools: the transport refusal and the daily aggregate. */
const NOT_TOOLS: readonly OperationName[] = ["mcp.request", "audit.overflow"];

/**
 * The operation an agent tool name records under on `path`, or null for a
 * name the catalogue does not serve there.
 */
export function toolOperation(tool: string, path: "agent-http" | "mcp"): OperationName | null {
  if (!tool.startsWith("kogane.")) return null;
  const name = tool.slice("kogane.".length);
  return isOperationName(name) &&
    !NOT_TOOLS.includes(name) &&
    (catalogueEntry(name).paths as readonly string[]).includes(path)
    ? name
    : null;
}
