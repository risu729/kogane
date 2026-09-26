// The first reconciliation vertical slice (architecture addendum A10; root
// review 09 section 2: matching and its explanation before any net-worth
// screen).
//
// Pending/posted pairs stay inside one source account and billing period.
// Vpass uses unconfirmed/posted; MyJCB uses unconfirmed/confirmed. MyJCB's
// posted payment can be an installment slice, so only rows whose explicit
// usage and payment totals agree participate in the pending purchase match,
// and only under a known payment month: an absolute label, or a relative
// `detailMonth-N` label resolved from the row's capture time
// (`statementPeriodOf`, `comparablePayment`).
//
// One tick, per slice (bounded: see `reconciliationSweep`):
//   1. one page of the slice's published rows after its scan cursor, in
//      observation id order;
//   2. the groups (source account, statement period) the page touched are read
//      whole, so a pair is found whichever pages its two rows fall on;
//   3. stage A and stage B run over each group. The digests already stored
//      are looked up a chunk at a time, and only the proposals not stored yet
//      are written: a decided proposal is never proposed again, and a stored
//      one costs no write;
//   4. the cursor moves past the page, and back to 0 after the last page. It
//      waits on the page while new proposals are left for the write budget
//      (unless D1 rejected every batch the tick sent), and moves only from the
//      value this tick read, so an overlapping tick never pulls it back.
//
// Nothing is accepted automatically. Auto-acceptance needs a link id the
// provider itself issued for the pair, exposed by the parser as
// `extra_json.$._kogane.providerLinkId`. Surveying the deployed parsers and
// `docs/sources/*.md`: MyJCB's third-party column survey mentions an approval
// number on the debit sections, which the deployed ledger parser does not read;
// SBI Shinsei (`txnReferenceNo`), SMBC Direct, SBI VC Trade (`cashflowId`,
// `executionId`), PayPay (`transactionNumber`) and V Point Pay expose a
// provider row id, which identifies one row (stage A) and does not link a
// pending row to its posted row; Vpass, Sony Bank, MoneyForward, Mobile Suica,
// Global Pass and SBI Securities' histories derive their external ids from a
// collector fingerprint, which is not a provider identifier at all. So no
// source currently supplies a pending-to-posted link id, every proposal this
// job writes stays `proposed`, and acceptance goes through
// `reconciliation-commands.ts` and the decision log.
//
// The log line carries counts only: no amount, account label, provider text
// or row id.
import {
  quantityFromNormalizedDecimal,
  type Quantity,
} from "../../../packages/domain/src/values.ts";
import type { NormalizedDecimal } from "../../../packages/observation-shared/src/normalized-decimal.ts";
import {
  cardStatementPeriod,
  comparableCardPayment,
  statementPeriod,
} from "../../../packages/domain/src/card-purchase.ts";
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  DEFAULT_MATCH_OPTIONS,
  proposalIdentity,
  stageAProposals,
  stageBProposals,
  type MatchFact,
  type ReconciliationProposal,
} from "../../../packages/domain/src/reconcile.ts";
import type { TemporalValue } from "../../../packages/domain/src/time.ts";
import { acceptProposal } from "./reconciliation-commands.ts";

/** One source whose own displays are compared. Datasets, not free-form rules. */
export interface ReconciliationSlice {
  sourceId: string;
  /** Provider statuses that mean "not final yet" and "recorded", for this source only. */
  pendingStatuses: readonly string[];
  postedStatuses: readonly string[];
}

/**
 * Explicit supported provider status families; installment comparability is
 * checked before MyJCB facts enter the matcher.
 */
export const RECONCILIATION_SLICES: readonly ReconciliationSlice[] = [
  { sourceId: "vpass", pendingStatuses: ["unconfirmed"], postedStatuses: ["posted"] },
  { sourceId: "myjcb", pendingStatuses: ["unconfirmed"], postedStatuses: ["confirmed"] },
];

/** Published rows one tick reads after a slice's cursor. */
export const SCAN_LIMIT = 1_000;
/** Published rows one group may hold; a larger group is counted and skipped. */
export const GROUP_LIMIT = 200;
/**
 * Rows of the groups a page touched that one tick reads per slice, so each
 * group is paired whole. The first group of a page is read whatever its size
 * (at most `GROUP_LIMIT`), so the cursor always moves.
 */
export const GROUP_READ_LIMIT = 2_000;
/** New proposals one tick writes, over every slice. */
export const WRITE_LIMIT = 500;
/**
 * Proposal digests one stored-proposal lookup binds, as the purchase lane's
 * candidate lookup does: a JSON array of 1,000 digests is about 67 KB.
 */
export const LOOKUP_CHUNK = 1_000;
/** New proposals one D1 batch carries. */
export const WRITE_BATCH = 100;

export interface ReconciliationSweepResult {
  /** Safe counts only; no amounts, provider text, account labels or row ids are logged. */
  slices: number;
  /** Published rows read after the slices' cursors. */
  scanned: number;
  /** Groups paired whole. */
  groups: number;
  /** Groups of more than `GROUP_LIMIT` published rows, counted and never paired. */
  groupsSkipped: number;
  /** Groups past this tick's group read; the cursor stops before their first row. */
  groupsDeferred: number;
  /** Candidates the matcher produced for the paired groups, stored or not. */
  proposed: number;
  /** Candidates whose digest was already stored; nothing is sent for them. */
  known: number;
  /** New proposals written. */
  written: number;
  /** Proposal batches D1 rejected; nothing of them was written, and the next cycle retries them. */
  failed: number;
  autoAccepted: number;
}

export interface ReconciliationSweepOptions {
  slices?: readonly ReconciliationSlice[];
  now?: string;
  /** Rows read after each slice's cursor, at most `SCAN_LIMIT`. */
  scanLimit?: number;
  /** Group rows read per slice, at most `GROUP_READ_LIMIT`. */
  groupReadLimit?: number;
  /** New proposals written over every slice, at most `WRITE_LIMIT`. */
  writeLimit?: number;
  /** Digests one lookup binds, at most `LOOKUP_CHUNK`. */
  lookupChunk?: number;
}

/** Off unless explicitly enabled; the default deploy changes nothing readers see. */
export function reconciliationEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

interface FactRow {
  id: number;
  parse_run_id: number;
  source_account: string;
  external_id: string | null;
  status: string | null;
  as_of: string | null;
  counterparty: string | null;
  currency: string | null;
  source_id: string;
  producer_id: string;
  external_id_namespace: string | null;
  value_status: string | null;
  coefficient: string | null;
  scale: number | null;
  value_basis: string | null;
  statement_period: string | null;
  /** `_kogane.period` verbatim (MyJCB's label, possibly the relative `detailMonth-N`). */
  period_label: string | null;
  /** The `fetched_at` of the row's artifact: the capture a relative label is resolved from. */
  fetched_at: string | null;
  provider_link_id: string | null;
  identity_origin: string | null;
  usage_amount_text: string | null;
  payment_amount_text: string | null;
}

const jsonText = (path: string) =>
  `CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json,'${path}')='text'
     AND length(json_extract(t.extra_json,'${path}')) BETWEEN 1 AND 256
   THEN json_extract(t.extra_json,'${path}') END`;

const statementPeriodSql = `coalesce(${jsonText("$._kogane.statementMonth")},replace(${jsonText("$._kogane.period")},'-',''))`;

const factColumns = `SELECT t.id,t.parse_run_id,t.source_account,t.external_id,t.status,t.as_of,
 t.counterparty,t.currency,a.source_id,fr.producer_id,ses.external_id_namespace,
 d.status AS value_status,d.coefficient,d.scale,d.basis AS value_basis,
 ${statementPeriodSql} AS statement_period,
 ${jsonText("$._kogane.period")} AS period_label,a.fetched_at,
 ${jsonText("$._kogane.providerLinkId")} AS provider_link_id,
 ${jsonText("$._kogane.identityOrigin")} AS identity_origin,
 ${jsonText("$._kogane.usageAmountText")} AS usage_amount_text,
 ${jsonText("$._kogane.paymentAmountText")} AS payment_amount_text`;

/**
 * Published transaction observations of one source (?1) with a pending or
 * posted status (?2, a JSON array). Only the publication projection is read
 * (docs/publication-gate.md), so an unadopted successful parse never produces
 * a candidate.
 */
const sliceJoins = `JOIN parse_runs p ON p.id=t.parse_run_id
JOIN published_parse_runs pub ON pub.parse_run_id=p.id
JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
JOIN fetch_runs fr ON fr.id=a.fetch_run_id
JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
LEFT JOIN observation_decimal_values d
 ON d.kind='transaction' AND d.observation_id=t.id AND d.policy_version='decimal-v1'
WHERE a.source_id=?1 AND t.status IN (SELECT value FROM json_each(?2))`;

/**
 * The slice's rows whose ids the CTE `ids(id)` names, read by primary key.
 * Only these rows pay for the JSON columns: on the scaled store of
 * docs/read-model.md#cost, computing them for every published Vpass row
 * before choosing a page took 2 s, choosing the ids first 0.3 s.
 */
const factsOfIds = `${factColumns}
FROM ids CROSS JOIN transaction_observations t ON t.id=ids.id
${sliceJoins}
ORDER BY t.id`;

/** One page of a slice's rows after the cursor (?3), in observation id order, at most ?4 rows. */
export const factPageQuery = `WITH ids(id) AS (SELECT t.id FROM transaction_observations t
${sliceJoins}
 AND t.id>?3
ORDER BY t.id
LIMIT ?4)
${factsOfIds}`;

/**
 * The published rows of the slice's source accounts in ?3 (a JSON array),
 * counted by what places their statement period: the stored period, and for
 * MyJCB also the label and the capture time a relative `detailMonth-N` is
 * resolved from (`statementPeriodOf`). A group of at most ?4 rows also names
 * its row ids. One pass over the slice computes each row's key once; the job
 * merges these into the groups of resolved periods, and the rows themselves
 * are then read by id (`groupFactQuery`).
 */
const groupMembersQuery = `WITH keyed AS (SELECT t.id AS id,t.source_account,a.source_id,
  ${statementPeriodSql} AS statement_period,
  CASE WHEN a.source_id='myjcb' THEN ${jsonText("$._kogane.period")} END AS period_label,
  CASE WHEN a.source_id='myjcb' THEN a.fetched_at END AS fetched_at
  FROM transaction_observations t
  ${sliceJoins}
  AND t.source_account IN (SELECT value FROM json_each(?3)))
SELECT source_account,source_id,statement_period,period_label,fetched_at,count(*) AS n,
 CASE WHEN count(*)<=?4 THEN json_group_array(id) END AS ids
FROM keyed
GROUP BY source_account,source_id,statement_period,period_label,fetched_at`;

/** The slice's rows with the ids in ?3 (a JSON array), in observation id order. */
const groupFactQuery = `WITH ids(id) AS (SELECT value FROM json_each(?3))
${factsOfIds}`;

const STORED_PROPOSALS_SQL = `SELECT proposal_digest,status FROM reconciliation_proposals
WHERE proposal_digest IN (SELECT value FROM json_each(?1))`;

const INSERT_PROPOSAL_SQL = `INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,
 rationale_codes_json,rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,'proposed',NULL,?,?
 WHERE NOT EXISTS(SELECT 1 FROM reconciliation_proposals WHERE proposal_digest=?)`;

const CURSOR_SQL = "SELECT last_observation_id FROM reconciliation_scan_cursor WHERE source_id=?1";

/**
 * The cursor moves only from the value this tick read: an absent row is
 * created, and a row another tick already moved is left where it is.
 */
const MOVE_CURSOR_SQL = `INSERT INTO reconciliation_scan_cursor(source_id,last_observation_id) VALUES(?1,?2)
ON CONFLICT(source_id) DO UPDATE SET last_observation_id=excluded.last_observation_id
WHERE reconciliation_scan_cursor.last_observation_id=?3`;

function quantityOf(row: FactRow): Quantity {
  const normalized: NormalizedDecimal = {
    policyVersion: "decimal-v1",
    status:
      row.value_status === "exact" ||
      row.value_status === "missing" ||
      row.value_status === "unparsed" ||
      row.value_status === "conflict"
        ? row.value_status
        : "missing",
    coefficient: row.coefficient,
    scale: row.scale,
    basis:
      row.value_basis === "minor_units" ||
      row.value_basis === "decimal_text" ||
      row.value_basis === "agreement"
        ? row.value_basis
        : "none",
  };
  return quantityFromNormalizedDecimal(row.currency ?? "unknown-unit", normalized);
}

function occurredOf(row: FactRow): TemporalValue {
  if (row.as_of !== null && /^\d{4}-\d{2}-\d{2}$/u.test(row.as_of))
    return { kind: "local-date", value: row.as_of, zone: null, basis: "provider" };
  return { kind: "unknown", reasonCode: "provider_date_absent" };
}

/** A collector fingerprint is not a provider identifier, and it is not treated as one. */
function originOf(row: FactRow): MatchFact["identifierOrigin"] {
  if (row.identity_origin === null) return "unknown";
  return row.identity_origin.includes("fingerprint") || row.identity_origin.includes("occurrence")
    ? "collector-fingerprint"
    : "provider";
}

/**
 * The statement period a row is paired under. Vpass: its `statementMonth` as
 * stored. MyJCB: the payment month `YYYY-MM`, read as recognition reads it: an
 * absolute label (`YYYY年M月お支払い分`, or a `statementMonth`), else a relative
 * `detailMonth-N` resolved from the capture time of the row's own artifact
 * (`cardStatementPeriod`; relative-statement-period-v1 places `detailMonth-0`
 * and `detailMonth-1`). Null when neither places the month. The raw relative
 * label is never a group: it is a position in the provider's list on the
 * capture day, so rows of different payment months share it over time.
 */
function statementPeriodOf(
  row: Pick<FactRow, "source_id" | "statement_period" | "period_label" | "fetched_at">,
): string | null {
  if (row.source_id !== "myjcb") return row.statement_period;
  return (
    statementPeriod(row.statement_period) ??
    cardStatementPeriod({
      sourceId: row.source_id,
      statementPeriod: row.period_label,
      capturedAt: row.fetched_at,
    })
  );
}

export function factOf(row: FactRow, slice: ReconciliationSlice): MatchFact {
  return {
    ref: {
      kind: "transaction",
      id: `transaction:${row.id}`,
      // The parse run is the immutable version the claim was read in.
      revision: `parse_run:${row.parse_run_id}`,
    },
    scope: {
      sourceId: row.source_id,
      // A re-authenticated connection is a different epoch, so ids never cross it.
      credentialEpoch: `${row.producer_id}/${row.external_id_namespace ?? "-"}`,
      accountNamespace: row.source_account,
    },
    sourceAccount: row.source_account,
    externalId: row.external_id,
    identifierOrigin: originOf(row),
    providerLinkId: row.provider_link_id,
    settlementState: slice.pendingStatuses.includes(row.status ?? "")
      ? "pending"
      : slice.postedStatuses.includes(row.status ?? "")
        ? "posted"
        : "unknown",
    quantity: quantityOf(row),
    occurred: occurredOf(row),
    counterparty: row.counterparty,
    statementPeriod: statementPeriodOf(row),
    // Ownership is a separate judgement; this slice never guesses one (UC23).
    ownerRef: null,
  };
}

/** The group of a fact: one source account and statement period ("" when none). */
function groupKey(sourceAccount: string, period: string | null): string {
  return `${sourceAccount} ${period ?? ""}`;
}

/** Facts are paired inside one source account and statement period, and each group is bounded. */
export function groupFacts(facts: readonly MatchFact[]): Map<string, MatchFact[]> {
  const groups = new Map<string, MatchFact[]>();
  for (const fact of facts) {
    const key = groupKey(fact.sourceAccount, fact.statementPeriod);
    const group = groups.get(key);
    if (group) group.push(fact);
    else groups.set(key, [fact]);
  }
  return groups;
}

/** A positive integer option, at most `max`, else the default. */
function bounded(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

interface Candidate {
  proposal: ReconciliationProposal;
  digest: string;
}

interface Limits {
  scan: number;
  groupRead: number;
  lookup: number;
}

/** A group the page touched, with the first (lowest-id) page row that belongs to it. */
interface TouchedGroup {
  sourceAccount: string;
  period: string;
  firstId: number;
}

/**
 * The new candidates among `proposals`, looked up a chunk at a time. Stops at
 * the first new candidate past the write budget (`complete: false`): the
 * cursor then waits on this page and the next tick writes the rest. A stored
 * pair the provider linked that is still open is returned for acceptance.
 */
async function newCandidates(
  db: D1Database,
  proposals: readonly ReconciliationProposal[],
  budget: number,
  chunkSize: number,
  result: ReconciliationSweepResult,
): Promise<{ writes: Candidate[]; openLinked: Candidate[]; complete: boolean }> {
  const writes: Candidate[] = [];
  const openLinked: Candidate[] = [];
  const seen = new Set<string>();
  for (let start = 0; start < proposals.length; start += chunkSize) {
    const chunk = await Promise.all(
      proposals.slice(start, start + chunkSize).map(async (proposal) => ({
        proposal,
        digest: await canonicalDigest(proposalIdentity(proposal)),
      })),
    );
    const stored = new Map(
      (
        await db
          .prepare(STORED_PROPOSALS_SQL)
          .bind(JSON.stringify(chunk.map((candidate) => candidate.digest)))
          .all<{ proposal_digest: string; status: string }>()
      ).results.map((row) => [row.proposal_digest, row.status]),
    );
    for (const candidate of chunk) {
      if (seen.has(candidate.digest)) continue;
      seen.add(candidate.digest);
      const status = stored.get(candidate.digest);
      if (status !== undefined) {
        result.known += 1;
        // Decided (accepted, rejected, withdrawn) is final; only an open pair
        // the provider linked is still the rule's to accept.
        if (candidate.proposal.autoAcceptable && status === "proposed") openLinked.push(candidate);
        continue;
      }
      if (writes.length >= budget) return { writes, openLinked, complete: false };
      writes.push(candidate);
    }
  }
  return { writes, openLinked, complete: true };
}

/** Write the new candidates in bounded batches; returns the ones actually inserted. */
async function writeCandidates(
  db: D1Database,
  candidates: readonly Candidate[],
  now: string,
  result: ReconciliationSweepResult,
): Promise<Candidate[]> {
  const inserted: Candidate[] = [];
  for (let start = 0; start < candidates.length; start += WRITE_BATCH) {
    const batch = candidates.slice(start, start + WRITE_BATCH);
    try {
      const results = await db.batch(
        batch.map(({ proposal, digest }) =>
          db
            .prepare(INSERT_PROPOSAL_SQL)
            .bind(
              `rp_${digest}`,
              proposal.kind,
              proposal.stage,
              JSON.stringify(proposal.targetRefs),
              proposal.method,
              proposal.policyRelease,
              JSON.stringify(proposal.rationaleCodes),
              JSON.stringify(proposal.rejectionConditions),
              JSON.stringify(proposal.evidenceRefs),
              digest,
              now,
              digest,
            ),
        ),
      );
      for (const [index, entry] of results.entries())
        if (entry.meta.changes > 0) inserted.push(batch[index]!);
    } catch {
      // D1 rolled the batch back. The error text may carry values, so only
      // the count leaves this function; the next cycle retries these pairs.
      result.failed += 1;
    }
  }
  result.written += inserted.length;
  return inserted;
}

/**
 * One slice's page: pair the groups it touched and write their new
 * candidates, then move the slice's cursor. Returns the write budget spent.
 */
async function sweepSlice(
  db: D1Database,
  slice: ReconciliationSlice,
  budget: number,
  limits: Limits,
  now: string,
  result: ReconciliationSweepResult,
): Promise<number> {
  const cursor =
    (await db.prepare(CURSOR_SQL).bind(slice.sourceId).first<{ last_observation_id: number }>())
      ?.last_observation_id ?? 0;
  const statuses = JSON.stringify([...slice.pendingStatuses, ...slice.postedStatuses]);
  const page = (
    await db
      .prepare(factPageQuery)
      .bind(slice.sourceId, statuses, cursor, limits.scan)
      .all<FactRow>()
  ).results;
  result.scanned += page.length;

  // Groups in the order their first row appears on the page.
  const touched = new Map<string, TouchedGroup>();
  for (const row of page) {
    if (!comparablePayment(row)) continue;
    const period = statementPeriodOf(row);
    const key = groupKey(row.source_account, period);
    if (!touched.has(key))
      touched.set(key, {
        sourceAccount: row.source_account,
        period: period ?? "",
        firstId: row.id,
      });
  }
  const members = new Map<string, { size: number; ids: number[] }>();
  if (touched.size > 0)
    for (const row of (
      await db
        .prepare(groupMembersQuery)
        .bind(
          slice.sourceId,
          statuses,
          JSON.stringify([...new Set([...touched.values()].map((group) => group.sourceAccount))]),
          GROUP_LIMIT,
        )
        .all<
          Pick<
            FactRow,
            "source_account" | "source_id" | "statement_period" | "period_label" | "fetched_at"
          > & {
            n: number;
            ids: string | null;
          }
        >()
    ).results) {
      // A resolved group can gather several stored keys (MyJCB captures of
      // one payment month under different labels); a key over the limit
      // names no ids, and its count alone puts the group over it.
      const key = groupKey(row.source_account, statementPeriodOf(row));
      if (!touched.has(key)) continue;
      const member = members.get(key) ?? { size: 0, ids: [] };
      member.size += row.n;
      if (row.ids !== null) member.ids.push(...(JSON.parse(row.ids) as number[]));
      members.set(key, member);
    }

  // Take the page's groups in order while they fit the group read; the first
  // one that does not fit and every later one wait for the next tick. Rows
  // published into a taken group after this read are paired when a later
  // page reaches them.
  const taken: TouchedGroup[] = [];
  const takenIds: number[] = [];
  let deferredFrom: number | null = null;
  for (const [key, group] of touched) {
    const { size, ids } = members.get(key) ?? { size: 0, ids: [] };
    if (deferredFrom !== null) {
      result.groupsDeferred += 1;
      continue;
    }
    if (size > GROUP_LIMIT) {
      result.groupsSkipped += 1;
      continue;
    }
    if (taken.length > 0 && takenIds.length + ids.length > limits.groupRead) {
      result.groupsDeferred += 1;
      deferredFrom = group.firstId;
      continue;
    }
    taken.push(group);
    takenIds.push(...ids);
  }

  const proposals: ReconciliationProposal[] = [];
  if (taken.length > 0) {
    const rows = (
      await db
        .prepare(groupFactQuery)
        .bind(slice.sourceId, statuses, JSON.stringify(takenIds))
        .all<FactRow>()
    ).results;
    const groups = groupFacts(rows.filter(comparablePayment).map((row) => factOf(row, slice)));
    for (const group of taken) {
      const facts = groups.get(groupKey(group.sourceAccount, group.period)) ?? [];
      result.groups += 1;
      // Stage C (cross-source correspondence) needs an established owner on
      // both sides and a second source in the slice; it is not run yet.
      proposals.push(
        ...stageAProposals(facts, DEFAULT_MATCH_OPTIONS),
        ...stageBProposals(facts, DEFAULT_MATCH_OPTIONS),
      );
    }
  }
  result.proposed += proposals.length;

  const { writes, openLinked, complete } = await newCandidates(
    db,
    proposals,
    budget,
    limits.lookup,
    result,
  );
  const failedBefore = result.failed;
  const inserted = await writeCandidates(db, writes, now, result);
  // Every write this tick sent was rejected: holding the cursor would send the
  // same writes again next tick, for ever if D1 keeps rejecting them, and the
  // slice would never move on. The page is then left like any other, and its
  // pairs are retried on the next cycle.
  const stalled = result.failed > failedBefore && inserted.length === 0;
  for (const { proposal, digest } of [
    ...inserted.filter((candidate) => candidate.proposal.autoAcceptable),
    ...openLinked,
  ]) {
    const accepted = await acceptProposal(db, {
      operationId: `reconciliation-${digest}`,
      actorId: "rule:reconciliation-v1",
      actorVerification: "server",
      proposalId: `rp_${digest}`,
      expectedStatus: "proposed",
      method: "rule",
      reason: `provider link evidence: ${proposal.rationaleCodes.join(",")}`,
    });
    if (accepted.ok && !accepted.replayed) result.autoAccepted += 1;
  }

  // New pairs left for the budget: stay on this page, unless the tick wrote
  // nothing because D1 rejected every batch. A deferred group: stop before
  // its first row. Otherwise past the page, and back to 0 after the last one,
  // since a row below the cursor can pair with a later row.
  const holdPage = !complete && !stalled;
  const next = holdPage
    ? cursor
    : deferredFrom !== null
      ? deferredFrom - 1
      : page.length < limits.scan
        ? 0
        : page.at(-1)!.id;
  if (next !== cursor) await db.prepare(MOVE_CURSOR_SQL).bind(slice.sourceId, next, cursor).run();
  return writes.length;
}

/**
 * One bounded sweep. Per slice it reads at most `SCAN_LIMIT` rows after the
 * slice's cursor and at most `GROUP_READ_LIMIT` rows of the groups they
 * touched (the first group whatever its size), pairs groups of at most
 * `GROUP_LIMIT` rows, and looks the candidates' digests up `LOOKUP_CHUNK` at a
 * time; over all slices it writes at most `WRITE_LIMIT` new proposals, in
 * batches of `WRITE_BATCH`. It writes candidates and nothing else, unless a
 * candidate is strictly evidenced by a provider link id, in which case the
 * acceptance is still recorded as a decision through `acceptProposal`
 * (INV07). Re-running the sweep over the same published rows writes nothing
 * new: a candidate whose digest is stored is never sent again.
 */
export async function reconciliationSweep(
  db: D1Database,
  options: ReconciliationSweepOptions = {},
): Promise<ReconciliationSweepResult> {
  const slices = options.slices ?? RECONCILIATION_SLICES;
  const now = options.now ?? new Date().toISOString();
  const limits: Limits = {
    scan: bounded(options.scanLimit, SCAN_LIMIT, SCAN_LIMIT),
    groupRead: bounded(options.groupReadLimit, GROUP_READ_LIMIT, GROUP_READ_LIMIT),
    lookup: bounded(options.lookupChunk, LOOKUP_CHUNK, LOOKUP_CHUNK),
  };
  let budget = bounded(options.writeLimit, WRITE_LIMIT, WRITE_LIMIT);
  const result: ReconciliationSweepResult = {
    slices: slices.length,
    scanned: 0,
    groups: 0,
    groupsSkipped: 0,
    groupsDeferred: 0,
    proposed: 0,
    known: 0,
    written: 0,
    failed: 0,
    autoAccepted: 0,
  };
  for (const slice of slices) budget -= await sweepSlice(db, slice, budget, limits, now, result);
  return result;
}

/** MyJCB's posted amount can be an installment slice. Only a provider row with
 * equal, positive usage/payment amounts participates in pending-to-posted
 * matching. The rule is the domain's `comparableCardPayment`, which reads the
 * ledger parser's display text (`1,200円`) through the same grammar card
 * purchase recognition uses.
 *
 * A MyJCB confirmed row must also carry a known payment month, read as
 * recognition reads it (`statementPeriodOf`). The collector records a
 * confirmed page by the payment month the page names, and wrote the relative
 * fallback `detailMonth-N` for every month the past-months API does not label
 * before it did (docs/sources/myjcb.md, 明細の月: the first connection's menu
 * lists months 0..8 and the API only 9..17). That label is a position in the provider's
 * month list on the capture day, so it names a month only together with its
 * capture time, and a position the rule does not place (`detailMonth-2` and
 * beyond) names none. This job pairs only inside a known payment month; the
 * recognition lane's candidate pass pairs such a row by its usage month. */
function comparablePayment(row: FactRow): boolean {
  if (row.source_id === "myjcb" && row.status === "confirmed" && statementPeriodOf(row) === null)
    return false;
  return comparableCardPayment({
    sourceId: row.source_id,
    status: row.status,
    usageAmountText: row.usage_amount_text,
    paymentAmountText: row.payment_amount_text,
  });
}
