// Hand-built selections for the C adapter (src/lot-adapter.ts): what a
// knowledge selector release that admits the `security-quantity` book and the
// reserved `trade` kind would hand over (`AdoptedSelection`, ADR 0058), built
// directly because no writer, kind or selector release admits them today.
// The set version is computed by the selector's own `adoptedSetVersion`.
// Every id, unit, amount and date is invented.
import type { EventTimeRole, LegEffect } from "../src/economic-contract.ts";
import type { EconomicEventKind, EventState, LegRole } from "../src/events.ts";
import {
  ADOPTED_SELECTION_CONTRACT,
  adoptedSetVersion,
  KNOWLEDGE_SELECTOR_RELEASE,
  type AdoptedSelection,
  type AdoptedSelectionBody,
  type AdoptedStatus,
  type CutStanding,
  type KnowledgeCoverage,
  type SelectedAdoptedRevision,
  type SelectedConflict,
  type SelectedLeg,
  type SelectionFlag,
  type UnloggedReason,
  type UnsupportedEntry,
} from "../src/knowledge-selector.ts";
import type { LotAdapterRequest, LotInstrumentMapping } from "../src/lot-adapter.ts";
import type { LotPolicy } from "../src/lots.ts";
import type { TemporalValue } from "../src/time.ts";
import { absentQuantity } from "../src/values.ts";
import { q } from "./helpers.ts";

export const EPOCH = "core-epoch-test";
/** The securities account every fixture trade moves; a second one for out-of-request legs. */
export const HOLDER = "acct-test-sec";
export const OTHER = "acct-test-other";
export const BANK = "acct-test-bank";
/** Leg units are instrument identifier ids; the book's instrument is what they map to. */
export const ALPHA_UNIT = "ii-test-alpha";
export const ALPHA = "instrument:test-alpha";
export const BETA_UNIT = "ii-test-beta";
export const BETA = "instrument:test-beta";
export const WRAPPER = "wrapper:test:general";
export const WRITER = "synthetic-securities-writer-v1";

export const day = (value: string): TemporalValue => ({
  kind: "local-date",
  value,
  zone: "Asia/Tokyo",
  basis: "provider",
});
export const trade = (value: string): [EventTimeRole, TemporalValue] => ["trade", day(value)];
export const settle = (value: string): [EventTimeRole, TemporalValue] => ["settlement", day(value)];

export interface FixtureLeg {
  /** A resolved account id, or null for a subject that names none. */
  account?: string | null;
  unit?: string;
  amount: string | null;
  role: LegRole;
  effect?: LegEffect | "undeclared";
  of?: number;
}

export interface FixtureRevision {
  eventId: string;
  revision?: number;
  kind?: string;
  state?: string;
  status?: AdoptedStatus;
  /** Null: no seal and no commit (a revision the log does not place). */
  seq?: number | null;
  legs?: FixtureLeg[];
  times?: [EventTimeRole, TemporalValue][];
  /** Security-quantity claims by row name; `book` overrides. */
  claims?: {
    row: string;
    book?: "card-usage" | "cash-movement" | "security-quantity";
    alias?: string;
  }[];
  /** Seal pins; default: `instrument_mapping:<unit>` at 1 for every instrument unit of its legs. */
  pins?: Record<string, number>;
  flags?: SelectionFlag[];
  /** The stored pointer as the selector shows it at the cut. */
  supersededBy?: string;
  /** Why the log does not place it (default: `no_commit` for a revision without a commit). */
  unloggedReason?: UnloggedReason;
}

const INSTRUMENT_UNITS = new Set([ALPHA_UNIT, BETA_UNIT, "ii-test-unmapped", "ii-test-loose"]);

export const rowKey = (row: string) =>
  JSON.stringify(["synthetic-broker", "producer-test", "ns-test", "broker-test", row]);

/** A buy: the security in, cash out (a fee breakdown when `fee` is given). */
export function buy(
  eventId: string,
  date: string,
  quantity: string,
  cash: string,
  fields: Partial<FixtureRevision> & { fee?: string } = {},
): FixtureRevision {
  return {
    eventId,
    times: [trade(date), settle(date)],
    legs: [
      { unit: ALPHA_UNIT, amount: quantity, role: "increase", effect: "movement" },
      { account: BANK, amount: cash, role: "decrease", effect: "movement" },
      ...(fields.fee === undefined
        ? []
        : [
            {
              account: BANK,
              amount: fields.fee,
              role: "fee" as const,
              effect: "breakdown" as const,
              of: 1,
            },
          ]),
    ],
    claims: [{ row: `row-${eventId}` }],
    ...fields,
  };
}

/** A sale: the security out, cash in (a fee deducted from it when `fee` is given). */
export function sell(
  eventId: string,
  date: string,
  quantity: string,
  cash: string,
  fields: Partial<FixtureRevision> & { fee?: string } = {},
): FixtureRevision {
  return {
    eventId,
    times: [trade(date), settle(date)],
    legs: [
      { unit: ALPHA_UNIT, amount: quantity, role: "decrease", effect: "movement" },
      { account: BANK, amount: cash, role: "increase", effect: "movement" },
      ...(fields.fee === undefined
        ? []
        : [
            {
              account: BANK,
              amount: fields.fee,
              role: "fee" as const,
              effect: "breakdown" as const,
              of: 1,
            },
          ]),
    ],
    claims: [{ row: `row-${eventId}` }],
    ...fields,
  };
}

function legOf(spec: FixtureLeg, legIndex: number): SelectedLeg {
  const unit = spec.unit ?? "JPY";
  const account = spec.account === undefined ? HOLDER : spec.account;
  const instrument = INSTRUMENT_UNITS.has(unit);
  return {
    legIndex,
    subjectRef: account === null ? "claim:test-unknown" : `account:${account}`,
    accountId: account,
    subjectForm: account === null ? "unrecognized" : "account-prefixed",
    quantity:
      spec.amount === null
        ? absentQuantity(unit, "missing", "synthetic_value_unknown")
        : q(unit, spec.amount),
    role: spec.role,
    basis: instrument ? "trade-date" : "cash-movement",
    effect: spec.effect ?? "undeclared",
    ofLegIndex:
      spec.effect === undefined || spec.effect === "movement" || spec.effect === "undeclared"
        ? null
        : (spec.of ?? 0),
  };
}

function revisionOf(spec: FixtureRevision, defaultSeq: number): SelectedAdoptedRevision {
  const revision = spec.revision ?? 1;
  const seq = spec.seq === undefined ? defaultSeq : spec.seq;
  const legs = (spec.legs ?? []).map(legOf);
  const pins =
    spec.pins ??
    Object.fromEntries(
      [
        ...new Set(
          legs.map((leg) => leg.quantity.unitRef).filter((unit) => INSTRUMENT_UNITS.has(unit)),
        ),
      ].map((unit) => [`instrument_mapping:${unit}`, 1]),
    );
  return {
    eventId: spec.eventId,
    revision,
    kind: (spec.kind ?? "trade") as EconomicEventKind,
    state: (spec.state ?? "executed") as EventState,
    unknownReason: spec.state === "unknown" ? "conflicting_evidence" : null,
    status: spec.status ?? (seq === null ? "knowledge_unlogged" : "active"),
    createdAt: "2030-02-01T00:00:00.000Z",
    commit:
      seq === null
        ? null
        : {
            coreEpoch: EPOCH,
            commitSeq: seq,
            knownAt: `2030-02-${String(seq).padStart(2, "0")}T00:00:00.000Z`,
            kind: "test.adopt",
          },
    supersedes:
      revision > 1 && seq !== null ? [{ eventId: spec.eventId, revision: revision - 1 }] : [],
    supersededBy: spec.supersededBy ?? null,
    seal:
      seq === null
        ? null
        : {
            writerRelease: WRITER,
            contentDigest: "c".repeat(64),
            identityPins: pins,
            identityEpoch: "identity-epoch-1",
          },
    legs,
    times: (spec.times ?? [])
      .map(([role, time]) => ({ role, time }))
      .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)),
    claims: (spec.claims ?? [])
      .map((claim) => ({
        eventId: spec.eventId,
        revision,
        book: claim.book ?? ("security-quantity" as const),
        key: rowKey(claim.row),
        aliasClass: claim.alias ?? null,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    flags: spec.flags ?? [],
  };
}

export interface SelectionFields {
  cut?: number;
  conflicts?: SelectedConflict[];
  unsupported?: UnsupportedEntry[];
  coverage?: KnowledgeCoverage;
  cutStanding?: CutStanding;
}

/** A selection at `cut` (default: the highest commit given) of these revisions, in any order. */
export async function selection(
  specs: FixtureRevision[],
  fields: SelectionFields = {},
): Promise<AdoptedSelection> {
  const revisions = specs
    .map((spec, index) => revisionOf(spec, index + 1))
    .sort((a, b) =>
      a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : a.revision - b.revision,
    );
  const seqs = revisions.flatMap((revision) =>
    revision.commit === null ? [] : [revision.commit.commitSeq],
  );
  const cut = fields.cut ?? (seqs.length === 0 ? 0 : Math.max(...seqs));
  const body: AdoptedSelectionBody = {
    contract: ADOPTED_SELECTION_CONTRACT,
    selectorRelease: KNOWLEDGE_SELECTOR_RELEASE,
    requestedCut: { coreEpoch: EPOCH, commitSeq: cut },
    cut: { coreEpoch: EPOCH, commitSeq: cut },
    cutKnownAt: cut === 0 ? null : `2030-02-${String(cut).padStart(2, "0")}T00:00:00.000Z`,
    scope: {
      accounts: [HOLDER],
      instruments: [ALPHA_UNIT],
      kinds: null,
      legEffects: null,
      basis: null,
      range: null,
    },
    currentIdentityEpoch: "identity-epoch-1",
    revisions,
    claims: revisions.flatMap((revision) => revision.claims),
    conflicts: fields.conflicts ?? [],
    unlogged: revisions
      .filter((revision) => revision.status === "knowledge_unlogged")
      .flatMap((revision) => {
        const spec = specs.find(
          (entry) =>
            entry.eventId === revision.eventId && (entry.revision ?? 1) === revision.revision,
        )!;
        const reasonCode =
          spec.unloggedReason ?? (revision.commit === null ? ("no_commit" as const) : null);
        return reasonCode === null
          ? []
          : [{ eventId: revision.eventId, revision: revision.revision, reasonCode }];
      }),
    inconsistent: [],
    identityChanged: revisions
      .filter((revision) => revision.flags.includes("identity_changed"))
      .map((revision) => ({
        eventId: revision.eventId,
        revision: revision.revision,
        reasons: ["identity_pin_moved" as const],
      })),
    unsupported: fields.unsupported ?? [],
    coverage: fields.coverage ?? {
      status: revisions.some((revision) => revision.status === "knowledge_unlogged")
        ? "partial"
        : "logged",
      reasons: revisions.some((revision) => revision.status === "knowledge_unlogged")
        ? ["knowledge_unlogged"]
        : [],
      logStart: { commitSeq: 1, knownAt: "2030-02-01T00:00:00.000Z" },
    },
  };
  return {
    ...body,
    setVersion: await adoptedSetVersion(body),
    cutStanding: fields.cutStanding ?? "final",
  };
}

export const ALPHA_MAPPING: LotInstrumentMapping = {
  unitRef: ALPHA_UNIT,
  mappingRevision: 1,
  instrumentRef: ALPHA,
  status: "identified",
  instrumentClass: "listed-equity",
};

export function policy(overrides: Partial<LotPolicy> = {}): LotPolicy {
  return {
    policyId: "lot-policy:test",
    version: 1,
    purpose: "investment-analysis",
    method: "fifo",
    scope: "holder-instrument-wrapper",
    timeBasis: "trade-date",
    ordering: "temporal-then-indeterminate",
    acquisitionFee: "capitalize",
    disposalFee: "reduce-proceeds",
    fx: "lot-currency",
    fxPolicyRef: "fx-policy:test@1",
    costUnitRef: null,
    rounding: null,
    ...overrides,
  };
}

export function request(fields: Partial<LotAdapterRequest> = {}): LotAdapterRequest {
  return {
    holders: [{ accountId: HOLDER, wrapperKey: WRAPPER }],
    instruments: [ALPHA_MAPPING],
    lotSelections: [],
    policy: policy(),
    ...fields,
  };
}
