// Read side of the A10 vertical slice: activity with an explicit basis, events
// with their legs and allocations, obligations whose outstanding amount is
// computed from settlements with exact arithmetic, and the difference between
// what a provider reported and what the adopted events imply.
//
// Two rules shape every query here.
//   * A figure always says which basis it is on. Cash that left an account and
//     cost recognised at purchase are different readings of the same purchase
//     (addendum 07 section 6, SC02/SC04), so they are never one column.
//   * A provider-reported value and an event-derived value are two parallel
//     sources. Their difference is returned as a `difference` observation with
//     its reason codes; it is never written back as an adjustment entry (root
//     review 09 section 4).
//
// Arithmetic stays in `@kogane/domain`: SQL selects rows, TypeScript adds them
// with the exact decimal arithmetic, so no sum is ever computed by casting a
// coefficient to a SQLite INTEGER.
//
// Nothing here reads a superseded revision as current, and nothing removes a
// superseded revision: a report that cited an old event revision keeps
// resolving it through `explanationRefs` (addendum 07 section 7).
import type { AllocationRole } from "../../domain/src/decisions.ts";
import {
  legTotal,
  type EconomicEventKind,
  type EventState,
  type LegRole,
  type ObligationState,
  type RecognitionBasis,
  type SourceFactRef,
  type UnknownStateReason,
} from "../../domain/src/events.ts";
import type { DataCoverage, Page } from "../../domain/src/result.ts";
import type { TemporalValue } from "../../domain/src/time.ts";
import {
  exactQuantity,
  negateDecimal,
  subtractDecimals,
  sumQuantities,
  type Quantity,
} from "../../domain/src/values.ts";
import type { SqlExecutor } from "./reader";

/** Which reading of an activity list the caller asked for. */
export const ACTIVITY_BASES = ["cash-movement", "purchase-recognition"] as const;
export type ActivityBasis = (typeof ACTIVITY_BASES)[number];
export function isActivityBasis(value: string): value is ActivityBasis {
  return (ACTIVITY_BASES as readonly string[]).includes(value);
}

export const EVENTS_POLICY_RELEASE = "economic-events-v1";

export interface LegView {
  legIndex: number;
  subjectRef: string;
  role: LegRole;
  basis: RecognitionBasis;
  quantity: Quantity;
}
export interface AllocationView {
  allocationId: string;
  sourceComponentRef: string;
  targetEffectRef: string;
  role: AllocationRole;
  quantity: Quantity;
}
export interface BasisTotal {
  basis: RecognitionBasis;
  quantity: Quantity;
}
export interface EventView {
  eventId: string;
  revision: number;
  kind: EconomicEventKind;
  state: EventState;
  unknownReason: UnknownStateReason | null;
  basis: RecognitionBasis;
  effectiveTime: TemporalValue;
  legs: LegView[];
  allocations: AllocationView[];
  /** One total per basis and unit present in the legs; bases are never merged. */
  totals: BasisTotal[];
  evidence: SourceFactRef[];
  decisionRevisionRef: string;
  /** event → legs → allocations → source facts → raw locators. */
  explanationRefs: string[];
}

export interface SettlementView {
  settlementId: string;
  settlementComponentRef: string;
  allocated: Quantity;
  occurred: TemporalValue;
  unresolvedDifference: Quantity | null;
}
export interface ObligationView {
  obligationId: string;
  revision: number;
  creditorRef: string;
  debtorRef: string;
  state: ObligationState;
  unknownReason: UnknownStateReason | null;
  principal: Quantity;
  settlements: SettlementView[];
  /** Sum of the settlement allocations; null when a settlement amount is not exact. */
  settled: Quantity | null;
  /** `principal − settled`; null when either side is not exact, never zero-filled. */
  outstanding: Quantity | null;
  outstandingReasonCode: string | null;
  confirmedFees: Quantity | null;
  projectedFees: Quantity | null;
  /** Differences the settlements declared; kept beside the obligation, never netted. */
  unresolvedDifferences: Quantity[];
  stateEvidenceRefs: string[];
  explanationRefs: string[];
}

/**
 * A provider-reported figure and the figure the adopted events imply, with
 * their difference. `kind` is always `difference`: this is a reconciliation
 * signal, not an entry, and the caller must show both sources rather than make
 * them agree.
 */
export interface ReconciliationSignal {
  kind: "difference";
  subjectRef: string;
  unitRef: string;
  providerReported: Quantity;
  eventDerived: Quantity;
  difference: Quantity | null;
  reasonCodes: string[];
  evidenceRefs: string[];
}

const LIVE_EVENT = "e.superseded_by IS NULL";

/**
 * Current event revisions with at least one leg on the requested basis, in a
 * deterministic order so paging is stable. `?1` basis, `?2` limit, `?3` offset.
 */
export const activityEventsSql = `SELECT e.event_id,e.revision,e.kind,e.state,e.unknown_reason,
 e.effective_time_json,e.basis,e.evidence_support_json,e.decision_revision_id
FROM economic_event_revisions e
WHERE ${LIVE_EVENT} AND EXISTS(SELECT 1 FROM economic_legs l
 WHERE l.event_id=e.event_id AND l.revision=e.revision AND l.basis=?1)
ORDER BY e.event_id,e.revision
LIMIT ?2 OFFSET ?3`;

/** Every leg of a bounded set of live event revisions (`?1` is a JSON array of event ids). */
export const eventLegsSql = `SELECT l.event_id,l.revision,l.leg_index,l.subject_ref,l.unit_ref,
 l.value_status,l.coefficient,l.scale,l.value_reason_code,l.role,l.basis
FROM economic_legs l
JOIN economic_event_revisions e ON e.event_id=l.event_id AND e.revision=l.revision
WHERE ${LIVE_EVENT} AND l.event_id IN (SELECT value FROM json_each(?1))
ORDER BY l.event_id,l.leg_index`;

/**
 * Live allocations targeting a bounded set of effects. A superseded allocation
 * is excluded here and stays readable by id, so correcting an allocation never
 * rewrites the report that cited the old one.
 */
export const eventAllocationsSql = `SELECT a.id,a.source_component_ref,a.target_effect_ref,a.role,
 a.unit_ref,a.coefficient,a.scale
FROM allocations a
WHERE a.superseded_by IS NULL AND a.target_effect_ref IN (SELECT value FROM json_each(?1))
ORDER BY a.target_effect_ref,a.id`;

/** Current obligation revisions, deterministically ordered. `?1` limit, `?2` offset. */
export const obligationsSql = `SELECT o.obligation_id,o.revision,o.creditor_ref,o.debtor_ref,
 o.principal_unit_ref,o.principal_status,o.principal_coefficient,o.principal_scale,
 o.fee_components_json,o.schedule_json,o.state,o.unknown_reason,o.state_evidence_refs_json,
 o.decision_revision_id
FROM obligation_revisions o
WHERE o.superseded_by IS NULL
ORDER BY o.obligation_id,o.revision
LIMIT ?1 OFFSET ?2`;

/** Live settlements of a bounded set of obligations (`?1` is a JSON array of ids). */
export const obligationSettlementsSql = `SELECT s.id,s.obligation_id,s.settlement_component_ref,
 s.unit_ref,s.coefficient,s.scale,s.occurred_json,s.unresolved_coefficient,s.unresolved_scale
FROM settlement_relations s
WHERE s.superseded_by IS NULL AND s.obligation_id IN (SELECT value FROM json_each(?1))
ORDER BY s.obligation_id,s.id`;

/**
 * The raw locator behind a bounded set of transaction observations, so an event
 * explains itself down to the bytes it was read from. Only published parses are
 * followed (docs/publication-gate.md). `?1` is a JSON array of observation ids.
 */
export const evidenceLocatorsSql = `SELECT t.id,t.raw_locator,a.sha256
FROM transaction_observations t
JOIN parse_runs p ON p.id=t.parse_run_id
JOIN published_parse_runs pub ON pub.parse_run_id=p.id
JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
WHERE t.id IN (SELECT value FROM json_each(?1))
ORDER BY t.id`;

/**
 * The legs that move a bounded set of subjects, and the latest published
 * provider-reported balance of the same subject. Both are returned as rows; the
 * comparison and the arithmetic happen in TypeScript, and this query writes
 * nothing. `?1` is a JSON array of subject refs.
 */
export const eventDerivedLegsSql = `SELECT l.subject_ref,l.unit_ref,l.role,
 l.value_status,l.coefficient,l.scale,l.value_reason_code
FROM economic_legs l
JOIN economic_event_revisions e ON e.event_id=l.event_id AND e.revision=l.revision
WHERE ${LIVE_EVENT} AND l.role IN ('increase','decrease')
 AND l.subject_ref IN (SELECT value FROM json_each(?1))
ORDER BY l.subject_ref,l.unit_ref`;

export const reportedBalancesSql = `SELECT b.source_account AS subject_ref,
 b.instrument AS unit_ref,b.id AS observation_id,
 coalesce(d.status,'missing') AS value_status,d.coefficient,d.scale
FROM balance_observations b
JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
LEFT JOIN observation_decimal_values d
 ON d.kind='balance' AND d.observation_id=b.id AND d.policy_version='decimal-v1'
WHERE b.source_account IN (SELECT value FROM json_each(?1))
 AND b.id=(SELECT max(b2.id) FROM balance_observations b2
  JOIN published_parse_runs pub2 ON pub2.parse_run_id=b2.parse_run_id
  WHERE b2.source_account=b.source_account AND b2.instrument=b.instrument)
ORDER BY b.source_account,b.instrument`;

interface EventRow {
  event_id: string;
  revision: number;
  kind: string;
  state: string;
  unknown_reason: string | null;
  effective_time_json: string;
  basis: string;
  evidence_support_json: string;
  decision_revision_id: string;
}
interface LegRow {
  event_id: string;
  revision: number;
  leg_index: number;
  subject_ref: string;
  unit_ref: string;
  value_status: string;
  coefficient: string | null;
  scale: number | null;
  value_reason_code: string | null;
  role: string;
  basis: string;
}
interface AllocationRow {
  id: string;
  source_component_ref: string;
  target_effect_ref: string;
  role: string;
  unit_ref: string;
  coefficient: string;
  scale: number;
}
interface ObligationRow {
  obligation_id: string;
  revision: number;
  creditor_ref: string;
  debtor_ref: string;
  principal_unit_ref: string;
  principal_status: string;
  principal_coefficient: string | null;
  principal_scale: number | null;
  fee_components_json: string;
  schedule_json: string;
  state: string;
  unknown_reason: string | null;
  state_evidence_refs_json: string;
  decision_revision_id: string;
}
interface SettlementRow {
  id: string;
  obligation_id: string;
  settlement_component_ref: string;
  unit_ref: string;
  coefficient: string;
  scale: number;
  occurred_json: string;
  unresolved_coefficient: string | null;
  unresolved_scale: number | null;
}
interface DerivedLegRow {
  subject_ref: string;
  unit_ref: string;
  role: string;
  value_status: string;
  coefficient: string | null;
  scale: number | null;
  value_reason_code: string | null;
}
interface ReportedBalanceRow {
  subject_ref: string;
  unit_ref: string;
  observation_id: number;
  value_status: string;
  coefficient: string | null;
  scale: number | null;
}

/** A stored decimal becomes a Quantity; a non-exact status is carried, never zeroed (INV05). */
export function storedQuantity(
  unitRef: string,
  status: string,
  coefficient: string | null,
  scale: number | null,
  reasonCode: string | null,
): Quantity {
  if (status === "exact" && coefficient !== null && scale !== null)
    return {
      unitRef,
      value: { status: "exact", value: { coefficient, scale }, normalizationVersion: "decimal-v1" },
    };
  const absent =
    status === "missing" || status === "unparsed" || status === "conflict" ? status : "unparsed";
  return { unitRef, value: { status: absent, reasonCode: reasonCode ?? `stored:${status}` } };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function temporal(text: string): TemporalValue {
  const parsed = parseJson<TemporalValue | null>(text, null);
  return parsed !== null && typeof parsed === "object" && "kind" in parsed
    ? parsed
    : { kind: "unknown", reasonCode: "stored_time_unreadable" };
}

/** Totals per (basis, unit). Two bases are never added, and two units never are (INV03). */
export function basisTotals(legs: readonly LegView[]): BasisTotal[] {
  const groups = new Map<string, { basis: RecognitionBasis; unitRef: string }>();
  for (const leg of legs) {
    const key = `${leg.basis} ${leg.quantity.unitRef}`;
    if (!groups.has(key)) groups.set(key, { basis: leg.basis, unitRef: leg.quantity.unitRef });
  }
  const totals: BasisTotal[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const total = legTotal(
      legs.map((leg) => ({
        eventId: "",
        revision: 1,
        legIndex: leg.legIndex,
        subjectRef: leg.subjectRef,
        quantity: leg.quantity,
        role: leg.role,
        basis: leg.basis,
      })),
      { unitRef: group.unitRef, basis: group.basis },
    );
    if (total.ok) totals.push({ basis: group.basis, quantity: total.quantity });
  }
  return totals;
}

const coverage = (scopeRef: string, truncated: boolean): DataCoverage => ({
  scopeRef,
  coveredRef: `${scopeRef}#${EVENTS_POLICY_RELEASE}`,
  gaps: [],
  truncated,
});

export interface EventsReaderOptions {
  /** Rows per page; one more is fetched to decide whether a next page exists. */
  pageSize?: number;
}

export interface EventsReader {
  activity(query: { basis: ActivityBasis; offset: number }): Promise<Page<EventView>>;
  obligations(query: { offset: number }): Promise<Page<ObligationView>>;
  /** Provider-reported against event-derived, per subject and unit. */
  reconciliationSignals(query: { subjectRefs: readonly string[] }): Promise<ReconciliationSignal[]>;
}

const DEFAULT_PAGE = 100;
const TRANSACTION_REF = /^transaction:(\d{1,15})$/u;

export function createEventsReader(
  sql: SqlExecutor,
  options: EventsReaderOptions = {},
): EventsReader {
  const pageSize = options.pageSize ?? DEFAULT_PAGE;

  const legRowToView = (row: LegRow): LegView => ({
    legIndex: row.leg_index,
    subjectRef: row.subject_ref,
    role: row.role as LegRole,
    basis: row.basis as RecognitionBasis,
    quantity: storedQuantity(
      row.unit_ref,
      row.value_status,
      row.coefficient,
      row.scale,
      row.value_reason_code,
    ),
  });

  async function grouped<Row, View>(
    statement: string,
    keys: readonly string[],
    key: (row: Row) => string,
    map: (row: Row) => View,
  ): Promise<Map<string, View[]>> {
    const out = new Map<string, View[]>();
    if (keys.length === 0) return out;
    for (const row of await sql.all<Row>(statement, [JSON.stringify([...keys])])) {
      const list = out.get(key(row)) ?? [];
      list.push(map(row));
      out.set(key(row), list);
    }
    return out;
  }

  return {
    async activity(query) {
      const rows = await sql.all<EventRow>(activityEventsSql, [
        query.basis,
        pageSize + 1,
        query.offset,
      ]);
      const page = rows.slice(0, pageSize);
      const eventIds = page.map((row) => row.event_id);
      const legs = await grouped<LegRow, LegView>(
        eventLegsSql,
        eventIds,
        (row) => row.event_id,
        legRowToView,
      );
      const allocations = await grouped<AllocationRow, AllocationView>(
        eventAllocationsSql,
        eventIds.map((id) => `event:${id}`),
        (row) => row.target_effect_ref,
        (row) => ({
          allocationId: row.id,
          sourceComponentRef: row.source_component_ref,
          targetEffectRef: row.target_effect_ref,
          role: row.role as AllocationRole,
          quantity: storedQuantity(row.unit_ref, "exact", row.coefficient, row.scale, null),
        }),
      );
      const evidenceByEvent = new Map<string, SourceFactRef[]>(
        page.map((row) => [
          row.event_id,
          parseJson<SourceFactRef[]>(row.evidence_support_json, []),
        ]),
      );
      const observationIds = [
        ...new Set(
          [...evidenceByEvent.values()]
            .flat()
            .map((ref) => TRANSACTION_REF.exec(ref.id)?.[1])
            .filter((id): id is string => id !== undefined),
        ),
      ];
      const locators = new Map<string, string[]>();
      if (observationIds.length > 0) {
        const rawRows = await sql.all<{ id: number; raw_locator: string; sha256: string }>(
          evidenceLocatorsSql,
          [JSON.stringify(observationIds.map(Number))],
        );
        for (const row of rawRows)
          locators.set(String(row.id), [
            `raw_locator:${row.raw_locator}`,
            `raw_object:${row.sha256}`,
          ]);
      }
      const items = page.map((row): EventView => {
        const eventLegs = legs.get(row.event_id) ?? [];
        const eventAllocations = allocations.get(`event:${row.event_id}`) ?? [];
        const evidence = evidenceByEvent.get(row.event_id) ?? [];
        return {
          eventId: row.event_id,
          revision: row.revision,
          kind: row.kind as EconomicEventKind,
          state: row.state as EventState,
          unknownReason: row.unknown_reason as UnknownStateReason | null,
          basis: row.basis as RecognitionBasis,
          effectiveTime: temporal(row.effective_time_json),
          legs: eventLegs,
          allocations: eventAllocations,
          totals: basisTotals(eventLegs),
          evidence,
          decisionRevisionRef: row.decision_revision_id,
          explanationRefs: [
            `event:${row.event_id}@${row.revision}`,
            ...eventLegs.map((leg) => `leg:${row.event_id}@${row.revision}#${leg.legIndex}`),
            ...eventAllocations.map((allocation) => `allocation:${allocation.allocationId}`),
            ...evidence.flatMap((ref) => [
              `${ref.kind}:${ref.id}@${ref.revision}`,
              ...(locators.get(TRANSACTION_REF.exec(ref.id)?.[1] ?? "") ?? []),
            ]),
            `decision_revision:${row.decision_revision_id}`,
          ],
        };
      });
      return {
        items,
        nextCursor: rows.length > pageSize ? String(query.offset + pageSize) : null,
        dataCoverage: coverage(`activity:${query.basis}`, rows.length > pageSize),
      };
    },

    async obligations(query) {
      const rows = await sql.all<ObligationRow>(obligationsSql, [pageSize + 1, query.offset]);
      const page = rows.slice(0, pageSize);
      const settlements = await grouped<SettlementRow, SettlementView>(
        obligationSettlementsSql,
        page.map((row) => row.obligation_id),
        (row) => row.obligation_id,
        (row) => ({
          settlementId: row.id,
          settlementComponentRef: row.settlement_component_ref,
          allocated: storedQuantity(row.unit_ref, "exact", row.coefficient, row.scale, null),
          occurred: temporal(row.occurred_json),
          unresolvedDifference:
            row.unresolved_coefficient === null || row.unresolved_scale === null
              ? null
              : storedQuantity(
                  row.unit_ref,
                  "exact",
                  row.unresolved_coefficient,
                  row.unresolved_scale,
                  null,
                ),
        }),
      );
      const items = page.map((row): ObligationView => {
        const principal = storedQuantity(
          row.principal_unit_ref,
          row.principal_status,
          row.principal_coefficient,
          row.principal_scale,
          null,
        );
        const rowSettlements = settlements.get(row.obligation_id) ?? [];
        const settledResult = sumQuantities(
          row.principal_unit_ref,
          rowSettlements.map((settlement) => settlement.allocated),
        );
        const settled = settledResult.ok ? settledResult.quantity : null;
        const fees = feeTotals(row.fee_components_json, row.principal_unit_ref);
        let outstanding: Quantity | null = null;
        let outstandingReasonCode: string | null = null;
        if (settled === null || settled.value.status !== "exact")
          outstandingReasonCode = settledResult.ok
            ? "settlement_value_not_exact"
            : settledResult.error.code;
        else if (principal.value.status !== "exact")
          outstandingReasonCode = `principal_${principal.value.status}`;
        else
          outstanding = exactQuantity(
            row.principal_unit_ref,
            subtractDecimals(principal.value.value, settled.value.value),
          );
        return {
          obligationId: row.obligation_id,
          revision: row.revision,
          creditorRef: row.creditor_ref,
          debtorRef: row.debtor_ref,
          state: row.state as ObligationState,
          unknownReason: row.unknown_reason as UnknownStateReason | null,
          principal,
          settlements: rowSettlements,
          settled,
          outstanding,
          outstandingReasonCode,
          confirmedFees: fees.confirmed,
          projectedFees: fees.projected,
          unresolvedDifferences: rowSettlements.flatMap((settlement) =>
            settlement.unresolvedDifference === null ? [] : [settlement.unresolvedDifference],
          ),
          stateEvidenceRefs: parseJson<string[]>(row.state_evidence_refs_json, []),
          explanationRefs: [
            `obligation:${row.obligation_id}@${row.revision}`,
            ...rowSettlements.flatMap((settlement) => [
              `settlement:${settlement.settlementId}`,
              `component:${settlement.settlementComponentRef}`,
            ]),
            `decision_revision:${row.decision_revision_id}`,
          ],
        };
      });
      return {
        items,
        nextCursor: rows.length > pageSize ? String(query.offset + pageSize) : null,
        dataCoverage: coverage("obligations", rows.length > pageSize),
      };
    },

    async reconciliationSignals(query) {
      if (query.subjectRefs.length === 0) return [];
      const subjects = JSON.stringify([...query.subjectRefs]);
      const legRows = await sql.all<DerivedLegRow>(eventDerivedLegsSql, [subjects]);
      const reported = await sql.all<ReportedBalanceRow>(reportedBalancesSql, [subjects]);
      const derived = new Map<string, Quantity[]>();
      for (const row of legRows) {
        const key = `${row.subject_ref} ${row.unit_ref}`;
        const quantity = storedQuantity(
          row.unit_ref,
          row.value_status,
          row.coefficient,
          row.scale,
          row.value_reason_code,
        );
        // A decrease is a negative movement of the subject; the sign is a role,
        // never a guess from the provider's own sign convention.
        const signed =
          row.role === "decrease" && quantity.value.status === "exact"
            ? exactQuantity(row.unit_ref, negateDecimal(quantity.value.value))
            : quantity;
        derived.set(key, [...(derived.get(key) ?? []), signed]);
      }
      return reported.map((row): ReconciliationSignal => {
        const key = `${row.subject_ref} ${row.unit_ref}`;
        const legs = derived.get(key);
        const providerReported = storedQuantity(
          row.unit_ref,
          row.value_status,
          row.coefficient,
          row.scale,
          null,
        );
        const derivedResult = legs ? sumQuantities(row.unit_ref, legs) : null;
        const eventDerived: Quantity =
          derivedResult && derivedResult.ok
            ? derivedResult.quantity
            : {
                unitRef: row.unit_ref,
                value: {
                  status: "missing",
                  reasonCode: derivedResult ? derivedResult.error.code : "no_adopted_events",
                },
              };
        const reasonCodes: string[] = [];
        let difference: Quantity | null = null;
        if (providerReported.value.status === "exact" && eventDerived.value.status === "exact") {
          difference = exactQuantity(
            row.unit_ref,
            subtractDecimals(providerReported.value.value, eventDerived.value.value),
          );
          if (difference.value.status === "exact" && difference.value.value.coefficient !== "0")
            // Why a difference can exist. The caller shows them; nothing is adjusted
            // and no entry is created to make the two agree.
            reasonCodes.push(
              "snapshot_boundary_unknown",
              "events_incomplete",
              "timing_difference",
              "fees_not_modelled",
            );
        } else {
          if (providerReported.value.status !== "exact")
            reasonCodes.push(`provider_${providerReported.value.status}`);
          if (eventDerived.value.status !== "exact")
            reasonCodes.push(`derived_${eventDerived.value.reasonCode}`);
        }
        return {
          kind: "difference",
          subjectRef: row.subject_ref,
          unitRef: row.unit_ref,
          providerReported,
          eventDerived,
          difference,
          reasonCodes,
          evidenceRefs: [`balance:${String(row.observation_id)}`],
        };
      });
    },
  };
}

function feeTotals(
  json: string,
  unitRef: string,
): { confirmed: Quantity | null; projected: Quantity | null } {
  const components = parseJson<{ quantity?: Quantity; confirmed?: boolean }[]>(json, []);
  const pick = (confirmed: boolean): Quantity | null => {
    const quantities = components.flatMap((component) =>
      component.confirmed === confirmed && component.quantity ? [component.quantity] : [],
    );
    if (quantities.length === 0) return null;
    const total = sumQuantities(unitRef, quantities);
    return total.ok ? total.quantity : null;
  };
  return { confirmed: pick(true), projected: pick(false) };
}
