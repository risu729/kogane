// `kogane.financial.query`: one execution path for the human UI and for an
// agent. Aggregation, filtering, ordering and paging happen here on the
// server; a caller supplies an intent and allow-listed filters and gets a
// `FinancialResult` back. Nothing in this file composes SQL: every read is a
// named method of the explicit read repository (packages/read-model).
//
// Two rules shape the output. Coverage — including the list of gaps and every
// count — is computed inside the granted scope only, so a narrower grant
// recomputes smaller numbers instead of subtracting hidden ones, and nothing
// tells the caller that a hidden account exists (SC18). And a result is never
// silently cut: a page that would exceed the grant's budget is refused with
// `budget_exceeded`, and a page that has more rows behind it carries a
// cursor bound to this context and this query.
import type {
  CompletenessState,
  DataCoverage,
  FinancialError,
  FinancialResult,
  QualityDimension,
} from "../../../domain/src/result.ts";
import type {
  BalanceRow,
  Overview,
  TransactionRow,
} from "../../../../poc/observation-pipeline/shared/api-contract.ts";
import {
  type BalanceProjectionReader,
  knownAssetMetricIds,
  KNOWN_ASSETS_POLICY,
  type ObservationReader,
} from "../../../read-model/src/index";
import { addDecimals, integerDecimal } from "../../../domain/src/values.ts";
import { financialError } from "../errors.ts";
import {
  type Grant,
  grantAllows,
  grantAllowsAccount,
  grantAllowsSource,
  grantedSources,
} from "../grants.ts";
import type { OpenedContext } from "../context/open.ts";
import { encodeCursor, resumeOffset } from "./cursor.ts";
import { INTENT_CAPABILITY, type QueryRequest, querySpecDigest, requestedLimit } from "./spec.ts";

/** The reader methods a query may use. Listing them keeps the surface auditable. */
export type QueryReader = Pick<
  ObservationReader,
  "overview" | "listLatestBalances" | "listTransactions"
>;

export interface CoverageScope {
  sourceRef: string;
  provider: string;
  ingestion: string;
  artifactCount: number;
  collectionRunCount: number;
}
export interface CoverageSummary {
  intent: "coverage";
  scopes: CoverageScope[];
  sourceCount: number;
  artifactCount: number;
  collectionRunCount: number;
}
export interface ReportedStateRow {
  observationRef: string;
  sourceRef: string;
  accountRef: string;
  metric: string;
  instrument: string;
  amountMinor: string | null;
  amountText: string | null;
  asOf: string | null;
  observedAt: string | null;
  parser: string;
}
export interface ActivityRow {
  observationRef: string;
  sourceRef: string;
  accountRef: string;
  asOf: string | null;
  amountMinor: string | null;
  amountText: string | null;
  currency: string | null;
  /**
   * Provider-written text. Untrusted content: it is returned as data and is
   * never a tool name, an instruction, a URL, a scope or a query (addendum 10
   * section 8).
   */
  description: string | null;
  counterparty: string | null;
  externalId: string | null;
  status: string | null;
  parser: string;
}
/**
 * One unit's adopted holding. There is deliberately no cross-unit total and
 * no net worth: different units are not added (INV03), and an asset subtotal
 * with unknown liability coverage is not a net worth (addendum 05 section 5).
 */
export interface HoldingUnit {
  unitRef: string;
  coefficient: string;
  scale: number;
  /** How many adopted measurements the figure is made of. */
  adoptedCount: number;
}
export type QueryData =
  | CoverageSummary
  | { intent: "reported-state"; rows: ReportedStateRow[] }
  | { intent: "activity"; rows: ActivityRow[] }
  | {
      intent: "holdings";
      units: HoldingUnit[];
      policyRelease: string;
      liabilitiesCoverage: "unknown";
    };

export interface QueryExecution {
  grant: Grant;
  opened: OpenedContext;
  request: QueryRequest;
  reader: QueryReader;
  /**
   * A07's adopted balance projection. `holdings` reads it and nothing else;
   * without it, or before a snapshot is sealed, the intent answers
   * `unavailable` rather than summing raw observation rows behind it.
   */
  projection?: BalanceProjectionReader | undefined;
  /** The overview the context was opened from; reused so a query reads it once. */
  overview: Overview;
}

export type QueryOutcome =
  | { ok: true; result: FinancialResult<QueryData> }
  | { ok: false; error: FinancialError };

/** The reader's page size (`PAGE_LIMIT` in packages/read-model). */
const READER_PAGE = 501;
const MAX_READER_PAGES = 8;
const MAX_SCOPE_PAIRS = 32;

function dimension(
  state: QualityDimension["state"],
  reasonCodes: string[],
  evidenceRefs: string[] = [],
): QualityDimension {
  return { state, reasonCodes, evidenceRefs };
}

/** Sources this query reads: the grant, narrowed by an in-scope `source` filter. */
function scopeSources(
  grant: Grant,
  filterSource: string | undefined,
  visible: readonly string[],
): { ok: true; sources: readonly string[] | null } | { ok: false; code: "evidence_restricted" } {
  if (filterSource !== undefined) {
    if (!grantAllowsSource(grant, filterSource)) return { ok: false, code: "evidence_restricted" };
    return { ok: true, sources: [filterSource] };
  }
  const granted = grantedSources(grant);
  return {
    ok: true,
    sources: granted === null ? null : granted.filter((id) => visible.includes(id)),
  };
}

function scopeAccounts(
  grant: Grant,
  filterAccount: string | undefined,
): { ok: true; accounts: readonly string[] | null } | { ok: false; code: "evidence_restricted" } {
  if (filterAccount !== undefined) {
    if (!grantAllowsAccount(grant, filterAccount))
      return { ok: false, code: "evidence_restricted" };
    return { ok: true, accounts: [filterAccount] };
  }
  return {
    ok: true,
    accounts: grant.scopes.accounts === "*" ? null : [...grant.scopes.accounts].sort(),
  };
}

/** `null` means "no filter on this axis"; the pair list drives one reader call each. */
function scopePairs(
  sources: readonly string[] | null,
  accounts: readonly string[] | null,
): { source: string | undefined; account: string | undefined }[] {
  const sourceList: (string | undefined)[] = sources === null ? [undefined] : [...sources];
  const accountList: (string | undefined)[] = accounts === null ? [undefined] : [...accounts];
  return sourceList.flatMap((source) => accountList.map((account) => ({ source, account })));
}

function compareActivity(a: TransactionRow, b: TransactionRow): number {
  const left = a.as_of ?? "";
  const right = b.as_of ?? "";
  if (left !== right) return left < right ? 1 : -1;
  return b.id - a.id;
}
function compareBalances(a: BalanceRow, b: BalanceRow): number {
  const keys: (keyof BalanceRow)[] = ["source_id", "source_account", "metric", "instrument"];
  for (const key of keys) {
    const left = String(a[key] ?? "");
    const right = String(b[key] ?? "");
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.id - b.id;
}

interface Collected<T> {
  rows: T[];
  /** A scope pair reached the scan bound before it ran out of rows. */
  scanBound: boolean;
}

/**
 * Read `need` rows across every scope pair, in reader pages. Each pair is a
 * separate reader call with its own filters, so no query ever observes a row
 * outside the grant, and nothing is filtered out of a larger visible set.
 */
async function collect<T>(
  pairs: { source: string | undefined; account: string | undefined }[],
  need: number,
  page: (
    pair: { source: string | undefined; account: string | undefined },
    offset: number,
  ) => Promise<T[]>,
): Promise<Collected<T>> {
  const rows: T[] = [];
  let scanBound = false;
  for (const pair of pairs) {
    // Each pair is read in its own order, which is the merge order restricted
    // to that pair, so its first `need` rows are all the merge can use.
    let offset = 0;
    let collected = 0;
    for (let index = 0; ; index += 1) {
      if (index >= MAX_READER_PAGES) {
        scanBound = true;
        break;
      }
      const batch = await page(pair, offset);
      rows.push(...batch);
      collected += batch.length;
      if (batch.length < READER_PAGE || collected >= need) break;
      offset += READER_PAGE;
    }
  }
  return { rows, scanBound };
}

function coverageOf(
  scopeRef: string,
  coveredRef: string,
  gaps: { reasonCode: string; scopeRef: string | null }[],
): DataCoverage {
  return { scopeRef, coveredRef, gaps, truncated: false };
}

function coveredRefFor(sources: readonly string[] | null, visible: readonly string[]): string {
  const list = sources === null ? [...visible].sort() : [...sources].sort();
  const joined = list.join(",");
  return joined.length <= 480
    ? `covered-sources:${joined}`
    : `covered-sources@count=${String(list.length)}`;
}

function dedupeGaps(
  gaps: { reasonCode: string; scopeRef: string | null }[],
): { reasonCode: string; scopeRef: string | null }[] {
  return [...new Set(gaps.map((gap) => gap.reasonCode))]
    .sort()
    .map((reasonCode) => ({ reasonCode, scopeRef: null }));
}

export async function executeQuery(input: QueryExecution): Promise<QueryOutcome> {
  const { grant, opened, request, reader, overview } = input;
  const requestId = opened.context.contextId;
  const fail = (code: Parameters<typeof financialError>[0], refs: string[] = []): QueryOutcome => ({
    ok: false,
    error: financialError(code, requestId, refs),
  });

  const required = INTENT_CAPABILITY[request.intent];
  if (!grantAllows(grant, required)) return fail("unauthorized", [`capability:${required}`]);

  const visible = overview.sources
    .map((source) => source.id)
    .filter((id) => grantAllowsSource(grant, id))
    .sort();
  const sourceScope = scopeSources(grant, request.filters.source, visible);
  if (!sourceScope.ok) return fail("evidence_restricted", ["scope:source"]);
  const accountScope = scopeAccounts(grant, request.filters.account);
  if (!accountScope.ok) return fail("evidence_restricted", ["scope:account"]);

  const limit = requestedLimit(request);
  const digest = await querySpecDigest(opened.resolvedQuery);
  const resume = resumeOffset(request.cursor, opened.context.contextId, digest);
  if (!resume.ok) return fail("stale_context", [opened.context.contextId]);
  const offset = resume.offset;
  const need = offset + limit + 1;
  if (need > grant.budget.maxRows)
    return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);

  const scopeRef = opened.context.perimeterRef;
  const coveredRef = coveredRefFor(sourceScope.sources, visible);
  const identity = dimension(
    opened.interpretation.mode === "as-recorded" ? "verified" : "partial",
    opened.interpretation.mode === "as-recorded"
      ? ["identity_pinned_as_recorded"]
      : ["mappings_may_change_under_latest"],
    [opened.context.identityDecisionManifestRef],
  );
  const reconciliation = dimension("not-applicable", ["reconciliation_not_implemented"]);
  const unavailableHoldings = (): QueryOutcome => ({
    ok: true,
    result: {
      schemaVersion: "financial-result-v1",
      contextId: opened.context.contextId,
      resolvedQuery: opened.resolvedQuery,
      completeness: "unavailable" satisfies CompletenessState,
      data: {
        intent: "holdings",
        units: [],
        policyRelease: KNOWN_ASSETS_POLICY,
        liabilitiesCoverage: "unknown",
      },
      coverage: coverageOf(scopeRef, coveredRef, [
        { reasonCode: "projection_not_built", scopeRef },
      ]),
      quality: {
        identity,
        freshness: dimension("not-applicable", ["projection_not_built"]),
        numeric: dimension("not-applicable", ["projection_not_built"]),
        reconciliation,
        valuation: dimension("unresolved", ["projection_not_built"]),
      },
      nextCursor: null,
      explanationRefs: [],
      warnings: [{ code: "projection_not_built", severity: "blocking" }],
    },
  });

  if (request.intent === "holdings") {
    // A07's adopted balance projection is what `holdings` reads. Without a
    // sealed snapshot the answer is `unavailable` with a reason, never a total
    // this service computed from the raw observation rows behind it.
    const snapshot = input.projection ? await input.projection.currentSnapshot() : null;
    if (!input.projection || !snapshot) return unavailableHoldings();
    const holdingPairs = scopePairs(sourceScope.sources, accountScope.accounts);
    if (holdingPairs.length > MAX_SCOPE_PAIRS)
      return fail("budget_exceeded", [`budget:scopePairs=${String(MAX_SCOPE_PAIRS)}`]);
    const metricIds = knownAssetMetricIds();
    const totals = new Map<string, { coefficient: string; scale: number; adoptedCount: number }>();
    // One subject may be adopted only once across the whole answer; a subject
    // reached through two scope pairs would otherwise be counted twice (INV06).
    const subjects = new Set<string>();
    const gaps: { reasonCode: string; scopeRef: string | null }[] = [];
    let stale = false;
    let unresolved = false;
    for (const pair of holdingPairs) {
      const scope = {
        ...(pair.source === undefined ? {} : { source: pair.source }),
        ...(pair.account === undefined ? {} : { account: pair.account }),
        ...(request.filters.instrument === undefined
          ? {}
          : { instrument: request.filters.instrument }),
      };
      const rows = await input.projection.summableQuantities(
        snapshot.snapshot_id,
        scope,
        metricIds,
      );
      if (rows === null) return fail("budget_exceeded", ["budget:subtotalRows"]);
      for (const row of rows) {
        // The projection is read inside the grant, and every row is checked
        // again: a query never observes a scope the grant does not allow.
        if (!grantAllowsSource(grant, row.source_id)) continue;
        if (!grantAllowsAccount(grant, row.source_account)) continue;
        if (subjects.has(row.subject_scope_key)) return fail("incomplete_evidence", ["overlap"]);
        subjects.add(row.subject_scope_key);
        const current = totals.get(row.unit_ref) ?? { ...integerDecimal(0), adoptedCount: 0 };
        const sum = addDecimals(
          { coefficient: current.coefficient, scale: current.scale },
          { coefficient: row.quantity_coefficient, scale: row.quantity_scale },
        );
        totals.set(row.unit_ref, { ...sum, adoptedCount: current.adoptedCount + 1 });
      }
      for (const row of await input.projection.coverage(snapshot.snapshot_id, scope)) {
        if (row.state === "adopted" && row.freshness === "current") continue;
        if (row.state === "stale" || row.freshness === "stale") stale = true;
        if (row.state === "unresolved" || row.state === "conflict") unresolved = true;
        if (row.reason_code !== null)
          gaps.push({ reasonCode: `${row.state}:${row.reason_code}`, scopeRef: null });
      }
    }
    const units: HoldingUnit[] = [...totals.entries()]
      .map(([unitRef, total]) => ({ unitRef, ...total }))
      .sort((a, b) => (a.unitRef < b.unitRef ? -1 : 1));
    if (units.length > grant.budget.maxRows)
      return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);
    return {
      ok: true,
      result: {
        schemaVersion: "financial-result-v1",
        contextId: opened.context.contextId,
        resolvedQuery: opened.resolvedQuery,
        completeness: (unresolved || stale ? "partial" : "complete") satisfies CompletenessState,
        data: {
          intent: "holdings",
          units,
          policyRelease: KNOWN_ASSETS_POLICY,
          // Unfetched liabilities mean this is not even a lower bound on net
          // worth, so the answer says so instead of implying one.
          liabilitiesCoverage: "unknown",
        },
        coverage: coverageOf(scopeRef, coveredRef, dedupeGaps(gaps)),
        quality: {
          identity,
          freshness: dimension(
            stale ? "partial" : "verified",
            stale ? ["scope_not_re_observed"] : ["snapshot_current"],
            [snapshot.snapshot_id],
          ),
          // Only adopted, exactly normalised values are summed; a missing,
          // unparsed or conflicting value never became a zero.
          numeric: dimension(
            "verified",
            ["exact_adopted_quantities_only"],
            [opened.context.calculationPolicyRef],
          ),
          reconciliation,
          valuation: dimension("not-applicable", ["quantities_are_not_valued"]),
        },
        nextCursor: null,
        explanationRefs: metricIds.map((metricId) => `metric:${metricId}`),
        warnings: unresolved ? [{ code: "measures_unresolved", severity: "warning" }] : [],
      },
    };
  }

  if (request.intent === "coverage") {
    const inScope = overview.sources.filter(
      (source) =>
        grantAllowsSource(grant, source.id) &&
        (sourceScope.sources === null || sourceScope.sources.includes(source.id)),
    );
    if (inScope.length > grant.budget.maxRows)
      return fail("budget_exceeded", [`budget:maxRows=${String(grant.budget.maxRows)}`]);
    const runsBySource = new Map<string, number>();
    for (const run of overview.fetchRuns) {
      if (!grantAllowsSource(grant, run.source_id)) continue;
      if (sourceScope.sources !== null && !sourceScope.sources.includes(run.source_id)) continue;
      runsBySource.set(run.source_id, (runsBySource.get(run.source_id) ?? 0) + 1);
    }
    const scopes: CoverageScope[] = inScope.map((source) => ({
      sourceRef: source.id,
      provider: source.provider,
      ingestion: source.ingestion,
      artifactCount: source.artifact_count,
      collectionRunCount: runsBySource.get(source.id) ?? 0,
    }));
    const gaps = scopes
      .filter((scope) => scope.artifactCount === 0)
      .map((scope) => ({
        reasonCode: "no_artifacts_collected",
        scopeRef: `source:${scope.sourceRef}`,
      }));
    const data: CoverageSummary = {
      intent: "coverage",
      scopes,
      sourceCount: scopes.length,
      artifactCount: scopes.reduce((total, scope) => total + scope.artifactCount, 0),
      collectionRunCount: scopes.reduce((total, scope) => total + scope.collectionRunCount, 0),
    };
    return {
      ok: true,
      result: {
        schemaVersion: "financial-result-v1",
        contextId: opened.context.contextId,
        resolvedQuery: opened.resolvedQuery,
        completeness: gaps.length === 0 ? "complete" : "partial",
        data,
        coverage: coverageOf(scopeRef, coveredRef, gaps),
        quality: {
          identity: dimension("not-applicable", ["identity_not_used_by_coverage"]),
          freshness: dimension(
            gaps.length === 0 ? "verified" : "partial",
            gaps.length === 0
              ? ["every_source_has_collected_evidence"]
              : ["source_without_artifacts"],
            [opened.context.publicationRef],
          ),
          numeric: dimension("not-applicable", ["counts_are_exact_integers"]),
          reconciliation,
          valuation: dimension("not-applicable", ["no_valuation_policy_adopted"]),
        },
        nextCursor: null,
        explanationRefs: scopes.map((scope) => `source:${scope.sourceRef}`),
        warnings: [],
      },
    };
  }

  const pairs = scopePairs(sourceScope.sources, accountScope.accounts);
  if (pairs.length > MAX_SCOPE_PAIRS)
    return fail("budget_exceeded", [`budget:scopePairs=${String(MAX_SCOPE_PAIRS)}`]);

  if (request.intent === "reported-state") {
    const view = request.filters.view;
    const collected = await collect<BalanceRow>(pairs, need, (pair, readerOffset) =>
      reader.listLatestBalances({
        ...(pair.source === undefined ? {} : { source: pair.source }),
        ...(pair.account === undefined ? {} : { account: pair.account }),
        ...(request.filters.instrument === undefined
          ? {}
          : { instrument: request.filters.instrument }),
        ...(request.filters.metric === undefined ? {} : { metric: request.filters.metric }),
        ...(view === undefined
          ? {}
          : { measureView: view === "summaries" ? "summaries" : "balances" }),
        offset: readerOffset,
        limit: 501,
      }),
    );
    const sorted = collected.rows
      .filter(
        (row) =>
          grantAllowsSource(grant, row.source_id) && grantAllowsAccount(grant, row.source_account),
      )
      .sort(compareBalances);
    if (collected.scanBound) return fail("budget_exceeded", ["budget:scan"]);
    const page = sorted.slice(offset, offset + limit);
    const rows: ReportedStateRow[] = page.map((row) => ({
      observationRef: `observation:balance:${String(row.id)}`,
      sourceRef: row.source_id,
      accountRef: row.source_account,
      metric: row.metric,
      instrument: row.instrument,
      amountMinor: row.amount_minor,
      amountText: row.amount_text,
      asOf: row.as_of,
      observedAt: row.observed_at,
      parser: row.parser,
    }));
    return rowResult({
      opened,
      identity,
      reconciliation,
      scopeRef,
      coveredRef,
      sources: sourceScope.sources ?? visible,
      present: new Set(sorted.map((row) => row.source_id)),
      data: { intent: "reported-state", rows },
      exact: rows.every((row) => row.amountMinor !== null),
      dated: rows.every((row) => row.asOf !== null),
      more: sorted.length > offset + limit,
      digest,
      offset,
      limit,
      refs: rows.map((row) => row.observationRef),
    });
  }

  const collected = await collect<TransactionRow>(pairs, need, (pair, readerOffset) =>
    reader.listTransactions({
      ...(pair.source === undefined ? {} : { source: pair.source }),
      ...(pair.account === undefined ? {} : { account: pair.account }),
      ...(request.filters.from === undefined ? {} : { from: request.filters.from }),
      ...(request.filters.to === undefined ? {} : { to: request.filters.to }),
      ...(request.filters.q === undefined ? {} : { q: request.filters.q }),
      offset: readerOffset,
    }),
  );
  const sorted = collected.rows
    .filter(
      (row) =>
        grantAllowsSource(grant, row.source_id) && grantAllowsAccount(grant, row.source_account),
    )
    .sort(compareActivity);
  if (collected.scanBound) return fail("budget_exceeded", ["budget:scan"]);
  const page = sorted.slice(offset, offset + limit);
  const rows: ActivityRow[] = page.map((row) => ({
    observationRef: `observation:transaction:${String(row.id)}`,
    sourceRef: row.source_id,
    accountRef: row.source_account,
    asOf: row.as_of,
    amountMinor: row.amount_minor,
    amountText: row.amount_text,
    currency: row.currency,
    description: row.description,
    counterparty: row.counterparty,
    externalId: row.external_id,
    status: row.status,
    parser: row.parser,
  }));
  return rowResult({
    opened,
    identity,
    reconciliation,
    scopeRef,
    coveredRef,
    sources: sourceScope.sources ?? visible,
    present: new Set(sorted.map((row) => row.source_id)),
    data: { intent: "activity", rows },
    exact: rows.every((row) => row.amountMinor !== null),
    dated: rows.every((row) => row.asOf !== null),
    more: sorted.length > offset + limit,
    digest,
    offset,
    limit,
    refs: rows.map((row) => row.observationRef),
  });
}

function rowResult(input: {
  opened: OpenedContext;
  identity: QualityDimension;
  reconciliation: QualityDimension;
  scopeRef: string;
  coveredRef: string;
  sources: readonly string[];
  present: ReadonlySet<string>;
  data: QueryData;
  exact: boolean;
  dated: boolean;
  more: boolean;
  digest: string;
  offset: number;
  limit: number;
  refs: string[];
}): QueryOutcome {
  const gaps = input.sources
    .filter((source) => !input.present.has(source))
    .map((source) => ({ reasonCode: "no_rows_in_scope", scopeRef: `source:${source}` }));
  const nextCursor = input.more
    ? encodeCursor({
        contextId: input.opened.context.contextId,
        queryDigest: input.digest,
        offset: input.offset + input.limit,
      })
    : null;
  const completeness: CompletenessState =
    gaps.length === 0 && nextCursor === null ? "complete" : "partial";
  return {
    ok: true,
    result: {
      schemaVersion: "financial-result-v1",
      contextId: input.opened.context.contextId,
      resolvedQuery: input.opened.resolvedQuery,
      completeness,
      data: input.data,
      coverage: coverageOf(input.scopeRef, input.coveredRef, gaps),
      quality: {
        identity: input.identity,
        freshness: dimension(
          input.dated ? "verified" : "partial",
          input.dated ? ["every_row_carries_an_as_of"] : ["as_of_missing"],
          [input.opened.context.publicationRef],
        ),
        numeric: dimension(
          input.exact ? "verified" : "partial",
          input.exact ? ["exact_minor_units"] : ["amount_text_only"],
          [input.opened.context.calculationPolicyRef],
        ),
        reconciliation: input.reconciliation,
        valuation: dimension("not-applicable", ["no_valuation_policy_adopted"]),
      },
      nextCursor,
      explanationRefs: input.refs,
      warnings: nextCursor === null ? [] : [{ code: "more_rows_available", severity: "info" }],
    },
  };
}
