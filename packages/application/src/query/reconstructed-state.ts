// Reconstructed state of one account over one range, on the cash basis
// (docs/reconstructed-state.md, ADR 0052 and ADR 0058). Read-only and computed
// per request; nothing is stored, nothing adopted, nothing written.
//
//   start, end   queryDatedState at the range's two dates (their context ids
//                are pinned);
//   knowledge    the knowledge selector at the asked cut (default: the latest
//                commit of the current core epoch), and at the cut of the end
//                capture for the late part;
//   fold         the B adapter's `resolved-at-cut` input to
//                `reconstructState` with `reconstruction-fold-v1`.
//
// The answer says what it is before what it computed: `unavailable` (CORE
// 0070 is not applied, or no reported container lists the account),
// `indeterminate` (the log does not place what the scope needs, or a
// movement sits on a snapshot's boundary), `needs_review` (an identity
// changed, two holders of one claim, an inconsistent chain, a shape the fold
// cannot take), `incomplete` (a cell's gaps) or `complete`. Every reason is a
// closed code. No route, page or service calls this yet (ADR 0058).
import { canonicalDigest } from "../../../domain/src/context.ts";
import { validKnowledgeCut, type KnowledgeCut } from "../../../domain/src/economic-contract.ts";
import {
  KNOWLEDGE_SELECTOR_RELEASE,
  selectAdopted,
  type AdoptedSelection,
  type ResolvedCut,
  type SelectionScope,
} from "../../../domain/src/knowledge-selector.ts";
import {
  adaptedKnowledge,
  COVERAGE_PRODUCER_NONE,
  RECONSTRUCTION_ADAPTER_RELEASE,
  type AdapterNote,
} from "../../../domain/src/reconstruction-adapter.ts";
import {
  RECONSTRUCTION_ENGINE_RELEASE,
  RECONSTRUCTION_FOLD_V1,
  RECONSTRUCTION_GAPS,
  explainLate,
  reconstructState,
  type KnowledgeSelection,
  type LateExplanation,
  type ReconstructedState,
  type ReconstructionGap,
  type ReconstructionReportedBalance,
  type ReconstructionReportedSide,
} from "../../../domain/src/reconstruction.ts";
import { captureDate, type ReportedState } from "../../../domain/src/reported-state.ts";
import { daysFromCivil, parseLocalDate, validInstantText } from "../../../domain/src/time.ts";
import {
  ACCOUNT_SOURCES_SQL,
  economicSelectorAvailable,
  loadSelectorRows,
  readSelectorMeta,
  resolveSelectorCut,
  selectorInput,
  type ResolvedSelectorCut,
  type SelectorMeta,
  type SelectorRows,
} from "../../../read-model/src/economic-selector.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { queryDatedState } from "./dated-state.ts";

export const RECONSTRUCTED_STATE_QUERY_SCHEMA = "reconstructed-state-query-v1";
/** The longest range asked about, in days. */
export const RECONSTRUCTION_RANGE_MAX_DAYS = 366;

export const RECONSTRUCTED_STATE_INPUT_ERRORS = [
  "invalid_query",
  "range_too_long",
  "range_in_future",
  "basis_unsupported",
  "cut_in_future",
] as const;
export type ReconstructedStateInputErrorCode = (typeof RECONSTRUCTED_STATE_INPUT_ERRORS)[number];

export class ReconstructedStateInputError extends Error {
  readonly code: ReconstructedStateInputErrorCode;
  constructor(code: ReconstructedStateInputErrorCode) {
    super(code);
    this.name = "ReconstructedStateInputError";
    this.code = code;
  }
}

/** A refusal of the fold or the selector: a programming error or a bound, never a partial answer. */
export class ReconstructedStateRefusedError extends Error {
  readonly code: string;
  readonly refs: string[];
  constructor(code: string, refs: string[]) {
    super(code);
    this.name = "ReconstructedStateRefusedError";
    this.code = code;
    this.refs = refs;
  }
}

export interface ReconstructedStateInput {
  /** A resolved account id (`accounts.id`). */
  account: string;
  /** Start and end dates, civil days in Asia/Tokyo; `from` before `to`. */
  from: string;
  to: string;
  /** Only `cash` is answered; the others are refused (ADR 0004: no container states its basis). */
  basis: string;
  /** Null for the latest commit of the current core epoch. */
  cut: KnowledgeCut | null;
  /** The caller's clock (a UTC instant): only refuses future dates and cuts, and names an empty log's cut. */
  now: string;
}

export const RECONSTRUCTED_STATE_STATUSES = [
  "unavailable",
  "indeterminate",
  "needs_review",
  "incomplete",
  "complete",
] as const;
export type ReconstructedStateStatus = (typeof RECONSTRUCTED_STATE_STATUSES)[number];

/** Closed reason codes, in order of the status they decide. */
const UNAVAILABLE_REASONS = ["economic_guard_missing", "no_reported_container"] as const;
const INDETERMINATE_REASONS = [
  "log_empty",
  "cut_before_log_start",
  "knowledge_unlogged",
  "snapshot_boundary_unknown",
] as const;
const REVIEW_REASONS = [
  "identity_changed",
  "claim_conflict",
  "alias_conflict",
  "revision_chain_inconsistent",
  "writer_unsupported",
  "revision_left_out",
] as const;
const INCOMPLETE_EXTRA = ["nothing_to_reconstruct", "positions_not_folded"] as const;
export const RECONSTRUCTED_STATE_REASONS = [
  ...UNAVAILABLE_REASONS,
  ...INDETERMINATE_REASONS,
  ...REVIEW_REASONS,
  ...RECONSTRUCTION_GAPS.filter(
    (gap) =>
      !(INDETERMINATE_REASONS as readonly string[]).includes(gap) &&
      !(REVIEW_REASONS as readonly string[]).includes(gap) &&
      gap !== "duplicate_claim",
  ),
  ...INCOMPLETE_EXTRA,
] as const;
export type ReconstructedStateReason = (typeof RECONSTRUCTED_STATE_REASONS)[number];

export const LATE_UNAVAILABLE_REASONS = [
  "no_end_capture",
  "end_captures_differ",
  "baseline_after_cut",
] as const;
export type LateUnavailableReason = (typeof LATE_UNAVAILABLE_REASONS)[number];

/** Everything the answer depends on, pinned (ADR 0054, "Manifest pins"). */
export interface ReconstructedStateManifest {
  schemaVersion: typeof RECONSTRUCTED_STATE_QUERY_SCHEMA;
  selectorRelease: typeof KNOWLEDGE_SELECTOR_RELEASE;
  adapterRelease: typeof RECONSTRUCTION_ADAPTER_RELEASE;
  engineRelease: typeof RECONSTRUCTION_ENGINE_RELEASE;
  foldPolicy: string;
  account: string;
  range: { from: string; to: string };
  basis: "cash";
  cut: { requested: KnowledgeCut; resolved: ResolvedCut; knownAt: string | null };
  setVersion: string;
  baseline: { cut: ResolvedCut; setVersion: string } | null;
  identity: { epoch: string; pins: [string, string, number][] };
  aliasRuleVersions: string[];
  coverageProducer: typeof COVERAGE_PRODUCER_NONE;
  snapshots: { startContextId: string; endContextId: string };
  /** `canonicalDigest` of the fold's own manifest. */
  innerManifestDigest: string;
}

export interface ReconstructedStateKnowledge {
  setVersion: string;
  coverage: AdoptedSelection["coverage"];
  revisions: number;
  unlogged: AdoptedSelection["unlogged"];
  inconsistent: AdoptedSelection["inconsistent"];
  identityChanged: AdoptedSelection["identityChanged"];
  conflicts: AdoptedSelection["conflicts"];
  unsupported: AdoptedSelection["unsupported"];
  adapterNotes: AdapterNote[];
}

export interface ReconstructedStateResult {
  schemaVersion: typeof RECONSTRUCTED_STATE_QUERY_SCHEMA;
  status: ReconstructedStateStatus;
  reasons: ReconstructedStateReason[];
  account: string;
  range: { from: string; to: string };
  basis: "cash";
  cut: ReconstructedStateManifest["cut"] | null;
  knowledge: ReconstructedStateKnowledge | null;
  reported: {
    start: { date: string; contextId: string };
    end: { date: string; contextId: string };
    /** Positions carry provider text only (ADR 0019), so they are listed, never folded. */
    positionsNotFolded: number;
  } | null;
  reconstruction: ReconstructedState | null;
  late: LateExplanation | null;
  lateUnavailable: LateUnavailableReason | null;
  manifest: ReconstructedStateManifest | null;
  contextId: string | null;
}

function checkInput(input: ReconstructedStateInput): void {
  const from = parseLocalDate(input.from);
  const to = parseLocalDate(input.to);
  const today = validInstantText(input.now)
    ? captureDate(new Date(Date.parse(input.now)).toISOString())
    : null;
  if (
    typeof input.account !== "string" ||
    input.account.length === 0 ||
    input.account.length > 256 ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(input.from) ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(input.to) ||
    from === null ||
    to === null ||
    input.from >= input.to ||
    today === null ||
    !(input.cut === null || validKnowledgeCut(input.cut))
  )
    throw new ReconstructedStateInputError("invalid_query");
  if (daysFromCivil(to) - daysFromCivil(from) > RECONSTRUCTION_RANGE_MAX_DAYS)
    throw new ReconstructedStateInputError("range_too_long");
  if (input.to > today) throw new ReconstructedStateInputError("range_in_future");
  if (input.basis !== "cash") throw new ReconstructedStateInputError("basis_unsupported");
  if (
    input.cut !== null &&
    "instant" in input.cut &&
    (!validInstantText(input.cut.instant) || Date.parse(input.cut.instant) > Date.parse(input.now))
  )
    throw new ReconstructedStateInputError("cut_in_future");
}

/** The account's balances on one reported side, in the fold's terms. */
function reportedSide(
  state: ReportedState,
  account: string,
  hasContainer: boolean,
): { side: ReconstructionReportedSide; positions: number } {
  const balances: ReconstructionReportedBalance[] = [];
  let positions = 0;
  for (const entry of state.accounts) {
    if (entry.accountId !== account) continue;
    const captured = new Map(
      entry.snapshots.map((snapshot) => [snapshot.ref, snapshot.capturedAt]),
    );
    positions += entry.positions.length;
    for (const balance of entry.balances) {
      const capturedAt = captured.get(balance.snapshotRef);
      if (capturedAt === undefined) continue;
      balances.push({
        ref: balance.ref,
        accountId: account,
        metricId: balance.metric.metricId,
        measurementKind: balance.metric.measurementKind,
        signMeaning: balance.metric.signMeaning,
        quantity: balance.amount,
        snapshotRef: balance.snapshotRef,
        capturedAt,
      });
    }
  }
  return {
    side: {
      contextId: state.contextId,
      date: state.date,
      accountsWithoutContainer: hasContainer ? [] : [account],
      balances,
      positions: [],
    },
    positions,
  };
}

function refusedIfNot<T>(
  result: ({ ok: true } & T) | { ok: false; error: { code: string; refs: string[] } },
): asserts result is { ok: true } & T {
  if (!result.ok) throw new ReconstructedStateRefusedError(result.error.code, result.error.refs);
}

async function select(
  meta: SelectorMeta,
  cut: ResolvedSelectorCut,
  scope: SelectionScope,
  rows: SelectorRows,
): Promise<{
  selection: AdoptedSelection;
  knowledge: KnowledgeSelection;
  notes: AdapterNote[];
  aliasRuleVersions: string[];
}> {
  const selected = await selectAdopted(selectorInput(meta, cut, scope, rows));
  refusedIfNot(selected);
  const adapted = await adaptedKnowledge(selected.selection);
  refusedIfNot(adapted);
  return {
    selection: selected.selection,
    knowledge: adapted.selection,
    notes: adapted.adapted.notes,
    aliasRuleVersions: adapted.adapted.aliasRuleVersions,
  };
}

/**
 * One account, one range, cash basis, at one cut. Throws
 * `ReconstructedStateInputError` for a query it does not answer,
 * `EconomicSelectorError` for a bound or a cut the log cannot answer, and
 * `DatedStateLimitError` past the reported-state bound; nothing is cut.
 */
export async function queryReconstructedState(
  sql: SqlExecutor,
  input: ReconstructedStateInput,
): Promise<ReconstructedStateResult> {
  checkInput(input);
  const range = { from: input.from, to: input.to };
  const empty = {
    schemaVersion: RECONSTRUCTED_STATE_QUERY_SCHEMA as typeof RECONSTRUCTED_STATE_QUERY_SCHEMA,
    account: input.account,
    range,
    basis: "cash" as const,
  };
  if (!(await economicSelectorAvailable(sql)))
    return {
      ...empty,
      status: "unavailable",
      reasons: ["economic_guard_missing"],
      cut: null,
      knowledge: null,
      reported: null,
      reconstruction: null,
      late: null,
      lateUnavailable: null,
      manifest: null,
      contextId: null,
    };

  const meta = await readSelectorMeta(sql);
  const requested: KnowledgeCut =
    input.cut ??
    (meta.log.lastSeq === null
      ? { coreEpoch: meta.currentCoreEpoch, instant: new Date(Date.parse(input.now)).toISOString() }
      : { coreEpoch: meta.currentCoreEpoch, commitSeq: meta.log.lastSeq });
  const cut = await resolveSelectorCut(sql, meta, requested);
  const scope: SelectionScope = {
    accounts: [input.account],
    instruments: null,
    kinds: null,
    legEffects: null,
    basis: null,
    range: null,
  };
  const rows = await loadSelectorRows(sql, scope);
  const now = await select(meta, cut, scope, rows);

  const [startState, endState, sources] = await Promise.all([
    queryDatedState(sql, { date: input.from, account: input.account }),
    queryDatedState(sql, { date: input.to, account: input.account }),
    sql.all<{ source_id: string }>(ACCOUNT_SOURCES_SQL, [input.account]),
  ]);
  const perimeter = new Set(
    [startState, endState].flatMap((state) => [
      ...state.snapshots.map((snapshot) => snapshot.sourceId),
      ...state.coverage.containersWithoutSnapshot.map((container) => container.sourceId),
    ]),
  );
  const hasContainer = sources.some((row) => perimeter.has(row.source_id));
  const start = reportedSide(startState, input.account, hasContainer);
  const end = reportedSide(endState, input.account, hasContainer);

  // The late part: the same scope at the cut of the end capture.
  const endCaptures = [...new Set(end.side.balances.map((row) => row.capturedAt))];
  let baseline: Awaited<ReturnType<typeof select>> | null = null;
  let lateUnavailable: LateUnavailableReason | null = null;
  if (endCaptures.length === 0) lateUnavailable = "no_end_capture";
  else if (endCaptures.length > 1) lateUnavailable = "end_captures_differ";
  else {
    const baselineCut = await resolveSelectorCut(sql, meta, {
      coreEpoch: cut.cut.coreEpoch,
      instant: endCaptures[0]!,
    });
    if (baselineCut.cut.commitSeq > cut.cut.commitSeq) lateUnavailable = "baseline_after_cut";
    else baseline = await select(meta, baselineCut, scope, rows);
  }

  const knowledgeAt =
    "instant" in requested
      ? requested.instant
      : (cut.knownAt ?? new Date(Date.parse(input.now)).toISOString());
  const folded = reconstructState({
    request: {
      accountIds: [input.account],
      startDate: input.from,
      endDate: input.to,
      basis: "cash",
      knowledgeAt,
      knowledgeCut: { ...cut.cut },
    },
    policy: RECONSTRUCTION_FOLD_V1,
    start: start.side,
    end: end.side,
    selection: now.knowledge,
    baseline: baseline?.knowledge ?? null,
  });
  refusedIfNot(folded);
  const state = folded.state;
  let late: LateExplanation | null = null;
  if (baseline !== null) {
    const explained = explainLate(baseline.knowledge, now.knowledge);
    refusedIfNot(explained);
    late = explained.late;
  }

  const reasons = new Set<ReconstructedStateReason>();
  if (!hasContainer) reasons.add("no_reported_container");
  for (const reason of now.selection.coverage.reasons)
    if (reason !== "cut_epoch_not_current") reasons.add(reason);
  if (state.cells.some((cell) => cell.boundary.count > 0)) reasons.add("snapshot_boundary_unknown");
  if (now.selection.identityChanged.length > 0) reasons.add("identity_changed");
  if (now.selection.conflicts.some((conflict) => conflict.dimension === "key"))
    reasons.add("claim_conflict");
  if (now.selection.conflicts.some((conflict) => conflict.dimension === "alias"))
    reasons.add("alias_conflict");
  if (now.selection.inconsistent.length > 0) reasons.add("revision_chain_inconsistent");
  if (now.selection.unsupported.length > 0) reasons.add("writer_unsupported");
  for (const note of now.notes)
    reasons.add(
      note.code === "revision_left_out" || note.code === "leg_left_out"
        ? "revision_left_out"
        : "writer_unsupported",
    );
  for (const cell of state.cells)
    for (const gap of cell.gaps)
      reasons.add(
        gap === "duplicate_claim"
          ? "claim_conflict"
          : (gap as ReconstructionGap & ReconstructedStateReason),
      );
  if (state.cells.length === 0) reasons.add("nothing_to_reconstruct");
  if (start.positions + end.positions > 0) reasons.add("positions_not_folded");
  const sorted = RECONSTRUCTED_STATE_REASONS.filter((reason) => reasons.has(reason));
  const status: ReconstructedStateStatus = sorted.some((reason) =>
    (UNAVAILABLE_REASONS as readonly string[]).includes(reason),
  )
    ? "unavailable"
    : sorted.some((reason) => (INDETERMINATE_REASONS as readonly string[]).includes(reason))
      ? "indeterminate"
      : sorted.some((reason) => (REVIEW_REASONS as readonly string[]).includes(reason))
        ? "needs_review"
        : sorted.length > 0
          ? "incomplete"
          : "complete";

  const pins: [string, string, number][] = now.selection.revisions
    .flatMap((revision) =>
      Object.entries(revision.seal?.identityPins ?? {}).map(
        ([subject, pinned]): [string, string, number] => [
          `${revision.eventId}@${revision.revision}`,
          subject,
          pinned,
        ],
      ),
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const manifest: ReconstructedStateManifest = {
    schemaVersion: RECONSTRUCTED_STATE_QUERY_SCHEMA,
    selectorRelease: KNOWLEDGE_SELECTOR_RELEASE,
    adapterRelease: RECONSTRUCTION_ADAPTER_RELEASE,
    engineRelease: RECONSTRUCTION_ENGINE_RELEASE,
    foldPolicy: RECONSTRUCTION_FOLD_V1.policyId,
    account: input.account,
    range,
    basis: "cash",
    cut: { requested: { ...requested }, resolved: { ...cut.cut }, knownAt: cut.knownAt },
    setVersion: now.selection.setVersion,
    baseline:
      baseline === null
        ? null
        : { cut: { ...baseline.selection.cut }, setVersion: baseline.selection.setVersion },
    identity: { epoch: now.selection.currentIdentityEpoch, pins },
    aliasRuleVersions: now.aliasRuleVersions,
    coverageProducer: COVERAGE_PRODUCER_NONE,
    snapshots: { startContextId: start.side.contextId, endContextId: end.side.contextId },
    innerManifestDigest: await canonicalDigest(state.manifest),
  };
  return {
    ...empty,
    status,
    reasons: sorted,
    cut: manifest.cut,
    knowledge: {
      setVersion: now.selection.setVersion,
      coverage: now.selection.coverage,
      revisions: now.selection.revisions.length,
      unlogged: now.selection.unlogged,
      inconsistent: now.selection.inconsistent,
      identityChanged: now.selection.identityChanged,
      conflicts: now.selection.conflicts,
      unsupported: now.selection.unsupported,
      adapterNotes: now.notes,
    },
    reported: {
      start: { date: input.from, contextId: start.side.contextId },
      end: { date: input.to, contextId: end.side.contextId },
      positionsNotFolded: start.positions + end.positions,
    },
    reconstruction: state,
    late,
    lateUnavailable,
    manifest,
    contextId: await canonicalDigest(manifest),
  };
}
