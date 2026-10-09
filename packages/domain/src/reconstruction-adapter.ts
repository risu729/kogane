// The B adapter (ADR 0058): what the knowledge selector resolved at a cut
// (`knowledge-selector.ts`) as the reconstruction fold's provisional input
// (`provisional-adopted-events-v1`, ADR 0052), resolved at the cut.
//
// The fold re-checks only one committed revision per event
// (`resolved-at-cut`); chain resolution is the selector's. The adapter adds
// nothing the selector did not load:
//
//   * typed movement: a leg's `economic_leg_effects` row says whether it moves
//     (`movement`), divides a movement (`breakdown`: 101 out = 100 principal +
//     1 fee counts 101 once) or restates one (`correspondence`); a legacy leg
//     without a row keeps 0070's reading (increase and decrease move, fee and
//     unresolved have no effect of their own; see `legacyLeg`);
//   * times: `economic_event_times` roles as they are, so a basis reads exactly
//     its own role and a missing role is the fold's unknown time. The 0032
//     `effective_time_json` is not read: 0070 says a role without a row is
//     unknown, never the effective time;
//   * claims: `(book, key)`, the key as `sha256:<hex>` of its stored text (the
//     fold bounds a key at 512 characters; the selector keeps the full text);
//   * dispositions: `identity_changed`, `claim_conflict` and `alias_conflict`
//     become fold flags, `knowledge_unlogged` a revision without a commit, and
//     anything the fold cannot take `writer_unsupported`, so the fold reports
//     needs-review or an absent figure rather than applying through them;
//   * coverage: no producer of family or history coverage exists, so none is
//     declared (`coverage-producer-none-v1`), and the fold names every scope
//     `family_not_evented` and `history_coverage_unknown`.
//
// Pure apart from hashing; no I/O, no clock.
import { canonicalJson, sha256Hex } from "./context.ts";
import { CARD_PURCHASE_WRITER_RELEASE } from "./card-purchase.ts";
import type { EconomicEventKind } from "./events.ts";
import type {
  AdoptedSelection,
  SelectedAdoptedRevision,
  SelectedLeg,
} from "./knowledge-selector.ts";
import {
  explainLate,
  PROVISIONAL_EVENT_CONTRACT,
  selectKnowledge,
  type KnowledgeSelection,
  type LateExplanationResult,
  type ProvisionalAdoptedEventSet,
  type ProvisionalClaim,
  type ProvisionalEventRevision,
  type ProvisionalKnowledgeCut,
  type ProvisionalLeg,
  type ProvisionalRevisionFlag,
  type ProvisionalWriter,
  type ReconstructionError,
  validProvisionalEventRevision,
} from "./reconstruction.ts";
import { validInstantText } from "./time.ts";

export const RECONSTRUCTION_ADAPTER_RELEASE = "reconstruction-adapter-b-v1";
/** No producer states family or history coverage yet; pinned so a producer changes the id. */
export const COVERAGE_PRODUCER_NONE = "coverage-producer-none-v1";

/**
 * The writer each kind comes from today, and the seal releases that writer
 * stamps (`CARD_PURCHASE_WRITER_RELEASE`; the settlement writer's
 * `CARD_SETTLEMENT_WRITER_RELEASE` in services/processor, compared by a
 * test). A kind no fold writer covers, or a seal of another release, is
 * `writer_unsupported`.
 */
const WRITER_OF_KIND: Partial<Record<EconomicEventKind, ProvisionalWriter>> = {
  purchase: "card-purchase-recognition-v1",
  refund: "card-purchase-recognition-v1",
  card_settlement: "card-settlement-review",
};
export const KNOWN_WRITER_RELEASES: Readonly<Record<ProvisionalWriter, readonly string[]>> = {
  "card-purchase-recognition-v1": [CARD_PURCHASE_WRITER_RELEASE],
  "card-settlement-review": ["card-statement-settlement-v1:economic-guard-v1"],
};

/** Why the adapter could not hand a revision, or a leg of it, over as stored. */
export const ADAPTER_NOTES = [
  /** No fold writer covers the kind, or the seal names another writer release. */
  "writer_unsupported",
  /** The selector reported a shape the fold cannot take. */
  "selector_unsupported",
  /** A fee or unresolved leg without an effect row that is not a restatement of the revision's one movement. */
  "legacy_leg_effect_undeclared",
  /** A leg the fold cannot hold at all (no movement in its revision to refer to): left out. */
  "leg_left_out",
  /** Neither the stored created_at nor the commit's known_at is an instant: the revision is left out. */
  "revision_left_out",
  /** One revision of an inconsistent event: the fold cannot see two, so it is flagged. */
  "chain_inconsistent_single",
] as const;
export type AdapterNoteCode = (typeof ADAPTER_NOTES)[number];
export interface AdapterNote {
  /** `eventId@revision`, or `eventId@revision#legIndex`. */
  ref: string;
  code: AdapterNoteCode;
}

export interface AdaptedSelection {
  set: ProvisionalAdoptedEventSet;
  cut: ProvisionalKnowledgeCut;
  notes: AdapterNote[];
  /** The alias rule versions of the claims handed over (the last element of each stored class). */
  aliasRuleVersions: string[];
}

const refOf = (row: { eventId: string; revision: number }) => `${row.eventId}@${row.revision}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const moves = (leg: SelectedLeg) =>
  leg.effect === "movement" ||
  (leg.effect === "undeclared" && (leg.role === "increase" || leg.role === "decrease"));

/**
 * A leg as the fold takes it, or null when it cannot hold it. The second
 * value says whether the revision must be flagged.
 */
function adaptLeg(
  revision: SelectedAdoptedRevision,
  leg: SelectedLeg,
  notes: AdapterNote[],
): { leg: ProvisionalLeg | null; flag: boolean } {
  const base = {
    legIndex: leg.legIndex,
    accountId: leg.accountId,
    quantity: leg.quantity,
    basis: leg.basis,
  };
  const movements = revision.legs.filter(moves);
  const firstMovement = movements[0];
  const fallback = (code: AdapterNoteCode): { leg: ProvisionalLeg | null; flag: boolean } => {
    notes.push({ ref: `${refOf(revision)}#${leg.legIndex}`, code });
    // The revision is flagged, so every leg of it is held whatever its shape;
    // the shape only has to let the fold reach the leg's cell.
    if (firstMovement === undefined || firstMovement.legIndex === leg.legIndex) {
      notes.push({ ref: `${refOf(revision)}#${leg.legIndex}`, code: "leg_left_out" });
      return { leg: null, flag: true };
    }
    return {
      leg: {
        ...base,
        effect: "correspondence",
        role: leg.role,
        ofLegIndex: firstMovement.legIndex,
      },
      flag: true,
    };
  };
  if (leg.effect === "movement" || (leg.effect === "undeclared" && moves(leg))) {
    if (leg.role !== "increase" && leg.role !== "decrease") return fallback("selector_unsupported");
    return { leg: { ...base, effect: "movement", role: leg.role, ofLegIndex: null }, flag: false };
  }
  if (leg.effect === "breakdown" || leg.effect === "correspondence") {
    const target = revision.legs.find((other) => other.legIndex === leg.ofLegIndex);
    if (
      target === undefined ||
      !moves(target) ||
      (leg.effect === "breakdown" && target.quantity.unitRef !== leg.quantity.unitRef)
    )
      return fallback("selector_unsupported");
    return {
      leg: { ...base, effect: leg.effect, role: leg.role, ofLegIndex: target.legIndex },
      flag: false,
    };
  }
  return legacyLeg(revision, leg, movements, fallback, base);
}

/**
 * A fee or unresolved leg without an effect row has no effect of its own
 * (0070). When its revision has exactly one movement and the leg is on
 * another basis, it restates that movement on another reading (the settlement
 * writer's `unresolved` obligation-change leg beside its cash debit): a
 * correspondence, never added. Otherwise whether it divides a movement or
 * moves on its own is undeclared (ADR 0052 held item 5): the revision is
 * flagged `writer_unsupported`.
 */
function legacyLeg(
  revision: SelectedAdoptedRevision,
  leg: SelectedLeg,
  movements: SelectedLeg[],
  fallback: (code: AdapterNoteCode) => { leg: ProvisionalLeg | null; flag: boolean },
  base: Pick<ProvisionalLeg, "legIndex" | "accountId" | "quantity" | "basis">,
): { leg: ProvisionalLeg | null; flag: boolean } {
  const only = movements.length === 1 ? movements[0]! : undefined;
  if (only !== undefined && only.basis !== leg.basis)
    return {
      leg: { ...base, effect: "correspondence", role: leg.role, ofLegIndex: only.legIndex },
      flag: false,
    };
  return fallback("legacy_leg_effect_undeclared");
}

async function claimKey(book: string, key: string): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson([book, key]))}`;
}

/**
 * The selection as the fold's input at its cut. Every revision the selector
 * selected is handed over: one per active event, every revision of a
 * `knowledge_unlogged` or `chain_inconsistent` event it named (the fold then
 * holds their cells). A revision committed at the cut carries its commit; one
 * the log does not place carries none.
 */
export async function adaptSelection(selection: AdoptedSelection): Promise<AdaptedSelection> {
  const notes: AdapterNote[] = [];
  const writers = new Set<ProvisionalWriter>();
  const aliasRules = new Set<string>();
  const revisions: ProvisionalEventRevision[] = [];
  const committedPerEvent = new Map<string, number>();
  for (const revision of selection.revisions)
    if (revision.commit !== null)
      committedPerEvent.set(revision.eventId, (committedPerEvent.get(revision.eventId) ?? 0) + 1);

  for (const revision of selection.revisions) {
    const ref = refOf(revision);
    const recordedAt = validInstantText(revision.createdAt)
      ? revision.createdAt
      : (revision.commit?.knownAt ?? null);
    if (recordedAt === null) {
      notes.push({ ref, code: "revision_left_out" });
      continue;
    }
    const flags = new Set<ProvisionalRevisionFlag>();
    for (const flag of revision.flags)
      if (flag === "identity_changed" || flag === "claim_conflict" || flag === "alias_conflict")
        flags.add(flag);
    if (revision.flags.includes("unsupported")) {
      flags.add("writer_unsupported");
      notes.push({ ref, code: "selector_unsupported" });
    }
    const writer = WRITER_OF_KIND[revision.kind];
    if (
      writer === undefined ||
      (revision.seal !== null &&
        !KNOWN_WRITER_RELEASES[writer].includes(revision.seal.writerRelease))
    ) {
      flags.add("writer_unsupported");
      notes.push({ ref, code: "writer_unsupported" });
    } else writers.add(writer);
    if (
      revision.status === "chain_inconsistent" &&
      revision.commit !== null &&
      (committedPerEvent.get(revision.eventId) ?? 0) < 2
    ) {
      // The fold sees an inconsistency only as two committed revisions of one event.
      flags.add("writer_unsupported");
      notes.push({ ref, code: "chain_inconsistent_single" });
    }
    const legs: ProvisionalLeg[] = [];
    for (const leg of revision.legs) {
      const adapted = adaptLeg(revision, leg, notes);
      if (adapted.flag) flags.add("writer_unsupported");
      if (adapted.leg !== null) legs.push(adapted.leg);
    }
    // A breakdown or correspondence must name a leg the fold holds as a movement.
    const held = new Map(legs.map((leg) => [leg.legIndex, leg]));
    for (const leg of [...legs])
      if (leg.ofLegIndex !== null && held.get(leg.ofLegIndex)?.effect !== "movement") {
        legs.splice(legs.indexOf(leg), 1);
        flags.add("writer_unsupported");
        notes.push({ ref: `${ref}#${leg.legIndex}`, code: "leg_left_out" });
      }
    const claims: ProvisionalClaim[] = [];
    for (const claim of revision.claims) {
      claims.push({ book: claim.book, key: await claimKey(claim.book, claim.key) });
      if (claim.aliasClass !== null) {
        try {
          const parsed = JSON.parse(claim.aliasClass) as unknown;
          if (Array.isArray(parsed) && typeof parsed[3] === "string") aliasRules.add(parsed[3]);
        } catch {
          // A stored class always parses (0070 checks json_valid); nothing to pin otherwise.
        }
      }
    }
    const adapted: ProvisionalEventRevision = {
      eventId: revision.eventId,
      revision: revision.revision,
      kind: revision.kind,
      state: revision.state,
      unknownReason: revision.unknownReason,
      times: revision.times.map((time) => ({ role: time.role, time: time.time })),
      commitRef:
        revision.commit === null
          ? null
          : { coreEpoch: revision.commit.coreEpoch, commitSeq: revision.commit.commitSeq },
      recordedAt,
      // Resolved at the cut: supersession is the selector's, never re-read here.
      supersededBy: null,
      legs,
      evidenceIds: [],
      claims,
      flags: (
        ["identity_changed", "alias_conflict", "claim_conflict", "writer_unsupported"] as const
      ).filter((flag) => flags.has(flag)),
    };
    // Whatever the fold would refuse (an event id with `@`, a bound) is left
    // out by name rather than failing the whole set.
    if (validProvisionalEventRevision(adapted)) revisions.push(adapted);
    else notes.push({ ref, code: "revision_left_out" });
  }
  const aliasRuleVersions = [...aliasRules].sort(cmp);
  const cut = { coreEpoch: selection.cut.coreEpoch, commitSeq: selection.cut.commitSeq };
  return {
    cut,
    notes: notes.sort((a, b) => cmp(a.ref, b.ref) || cmp(a.code, b.code)),
    aliasRuleVersions,
    set: {
      contract: PROVISIONAL_EVENT_CONTRACT,
      resolution: "resolved-at-cut",
      setVersion: selection.setVersion,
      adapterRelease: RECONSTRUCTION_ADAPTER_RELEASE,
      writers: [...writers].sort(cmp),
      pins: {
        identityRelease: selection.currentIdentityEpoch,
        evidenceAliasRelease:
          aliasRuleVersions.length === 0
            ? "alias-rules:none"
            : `alias-rules:${aliasRuleVersions.join(",")}`.slice(0, 256),
        coverageRelease: COVERAGE_PRODUCER_NONE,
        fxReferenceRef: null,
        policyRefs: [],
      },
      revisions,
      familyCoverage: [],
      historyCoverage: [],
    },
  };
}

export type AdaptedKnowledgeResult =
  | { ok: true; adapted: AdaptedSelection; selection: KnowledgeSelection }
  | { ok: false; error: ReconstructionError };

/** Adapt and run the fold's own step 1 (it only checks one committed revision per event). */
export async function adaptedKnowledge(
  selection: AdoptedSelection,
): Promise<AdaptedKnowledgeResult> {
  const adapted = await adaptSelection(selection);
  const selected = selectKnowledge(adapted.set, adapted.cut);
  return selected.ok
    ? { ok: true, adapted, selection: selected.selection }
    : { ok: false, error: selected.error };
}

/**
 * The late part of an explanation from two selections of one scope (the cut
 * of the end capture, then the asked cut): which revisions entered or left.
 * A pure diff of what the selector resolved; no timestamp is read.
 */
export async function explainLateSelections(
  baseline: AdoptedSelection,
  now: AdoptedSelection,
): Promise<LateExplanationResult> {
  const before = await adaptedKnowledge(baseline);
  if (!before.ok) return { ok: false, error: before.error };
  const after = await adaptedKnowledge(now);
  if (!after.ok) return { ok: false, error: after.error };
  return explainLate(before.selection, after.selection);
}
