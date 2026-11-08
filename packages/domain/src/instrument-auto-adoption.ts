// The one automatic instrument adoption (ADR 0055, amendment 2026-11-08):
// rule `instrument-auto-v1`.
//
// The candidate read (`instrument-candidates.ts`) only proposes. This module
// picks, from a proposed candidate set, the candidates of one shape that is
// certain from stored identifier facts alone, so the Processor can adopt them
// as a recorded rule decision instead of waiting for a person:
//
//   SBI Securities states a domestic security under its Tokyo, Nagoya,
//   Fukuoka or Sapporo listing (`mic-symbol/<MIC>/<code>`) and, for a trade on
//   a venue its identity rule does not map (a PTS, an off-auction trade, no
//   market), under its bare code (`sbi-security-code/JP/<code>`). A Japanese
//   securities code names one issue on every Japanese venue, so the two
//   identifiers are one instrument.
//
// Everything else, including the same shape at two brokers, foreign codes
// (tickers can be reused), ISIN-only and RIC pairs, stays a candidate for a
// person or an agent over MCP. Like every other decision, an adoption is a
// new mapping revision with its decision; a person corrects it with a later
// `identity.assign` (and keeps the pair apart with `relation.reject`), and the
// rule never adopts a pair a person has decided anything about.
import {
  type InstrumentCandidateSet,
  type InstrumentIdentifierFacts,
  type ListedAsStatuses,
} from "./instrument-candidates.ts";

/** The rule's name and version; a change to what it adopts is a new version. */
export const INSTRUMENT_AUTO_ADOPTION_POLICY = "instrument-auto-v1";

/** The decision log actor of the rule's adoptions (`decision_revisions.actor_id`). */
export const INSTRUMENT_AUTO_ADOPTION_ACTOR = `rule:${INSTRUMENT_AUTO_ADOPTION_POLICY}`;

/** The only source whose identifiers the rule pairs: both sides are its own. */
export const INSTRUMENT_AUTO_ADOPTION_SOURCE = "sbi-securities";

/** The Japanese exchanges the SBI identity rule maps to a MIC (`packages/identity/src/sbi.ts`). */
export const JAPANESE_LISTING_MICS = ["XFKA", "XNGO", "XSAP", "XTKS"] as const;

/**
 * A Japanese securities code: four characters, the first and third digits,
 * the second and fourth digits or capital letters (JPX's alphanumeric codes
 * since 2024, such as `130A`). A fund's eight-digit association code and
 * anything else is not one.
 */
export const JAPANESE_SECURITIES_CODE = /^[0-9][0-9A-Z][0-9][0-9A-Z]$/u;

/** The instrument and identifier a `listedAsKey` names. */
const LISTED_AS_KEY = /^instrument:(.+)\|identifier:(.+)$/su;

/** One adoption the rule makes: re-map `subject` onto `anchor`'s instrument. */
export interface InstrumentAutoAdoption {
  candidateId: string;
  anchorIdentifierId: string;
  subjectIdentifierId: string;
  /** The anchor's current instrument, the adoption's target. */
  targetInstrumentId: string;
  /** The shared code, for the decision's reason. */
  securityCode: string;
  /** The anchor's MIC, for the decision's reason. */
  mic: string;
}

const onlySource = (facts: InstrumentIdentifierFacts) =>
  facts.sources.length === 1 && facts.sources[0] === INSTRUMENT_AUTO_ADOPTION_SOURCE;

const onlyYen = (facts: InstrumentIdentifierFacts) =>
  !facts.currencyUnconfirmed && facts.currencies.length === 1 && facts.currencies[0] === "JPY";

/**
 * The candidates of `set` that rule `instrument-auto-v1` adopts, in candidate
 * order. A candidate is adopted only when every condition holds:
 *
 * 1. it is `proposed` with no hold, its only evidence is `security-code-equal`
 *    and it agrees on kind, country and currency (a conflict would have
 *    separated it);
 * 2. the anchor is `mic-symbol` on a Japanese MIC and the subject is
 *    `sbi-security-code` scoped `JP` with no RIC, both of kind `security`,
 *    country `JP`, the same code, and the code is a Japanese securities code;
 *    neither states an ISIN, a share class or a product class (none is
 *    recorded by any identity rule today);
 * 3. both are used by SBI Securities only, and every use states JPY;
 * 4. nobody decided anything about either: both current mappings are the
 *    identity rule's own (`rule`, not adopted by this rule), every identifier
 *    on the anchor's instrument is mapped by rule, the subject shares its
 *    instrument with nobody, and no `listed_as` relation (in any status)
 *    joins either identifier to the other's instrument;
 * 5. the subject is unambiguous: this is its only candidate and it is in no
 *    separated pair (a code on two exchanges, say, is left to a person).
 *
 * Pure: the caller supplies the facts, the candidate set computed from them
 * and the current `listed_as` statuses, as the candidate read does.
 */
export function instrumentAutoAdoptions(
  facts: readonly InstrumentIdentifierFacts[],
  set: InstrumentCandidateSet,
  listedAs: ListedAsStatuses,
): InstrumentAutoAdoption[] {
  const byId = new Map(facts.map((row) => [row.identifierId, row]));
  const byInstrument = new Map<string, InstrumentIdentifierFacts[]>();
  for (const row of facts) {
    const members = byInstrument.get(row.instrumentId) ?? [];
    members.push(row);
    byInstrument.set(row.instrumentId, members);
  }
  const appearances = new Map<string, number>();
  const count = (id: string) => appearances.set(id, (appearances.get(id) ?? 0) + 1);
  for (const candidate of set.candidates) {
    count(candidate.anchorIdentifierId);
    count(candidate.subjectIdentifierId);
  }
  const separated = new Set(set.separated.flatMap((pair) => pair.identifierIds));
  const relatedInstruments = new Set<string>();
  const relatedIdentifiers = new Set<string>();
  for (const key of listedAs.keys()) {
    const match = LISTED_AS_KEY.exec(key);
    if (match === null) continue;
    relatedInstruments.add(match[1]!);
    relatedIdentifiers.add(match[2]!);
  }

  const adoptions: InstrumentAutoAdoption[] = [];
  for (const candidate of set.candidates) {
    const anchor = byId.get(candidate.anchorIdentifierId);
    const subject = byId.get(candidate.subjectIdentifierId);
    if (anchor === undefined || subject === undefined) continue;
    // 1. An open, unheld candidate on code equality alone, agreeing on kind,
    // country and currency.
    if (candidate.status !== "proposed" || candidate.hold !== null) continue;
    if (candidate.evidence.length !== 1 || candidate.evidence[0] !== "security-code-equal")
      continue;
    if (
      !candidate.agreements.includes("kind-agrees") ||
      !candidate.agreements.includes("country-agrees") ||
      !candidate.agreements.includes("currency-agrees")
    )
      continue;
    // 2. SBI's listing against SBI's bare domestic code.
    if (
      anchor.namespace !== "mic-symbol" ||
      anchor.mic === null ||
      !(JAPANESE_LISTING_MICS as readonly string[]).includes(anchor.mic) ||
      subject.namespace !== "sbi-security-code" ||
      subject.scope !== "JP" ||
      subject.mic !== null ||
      subject.ric !== null
    )
      continue;
    if (anchor.kind !== "security" || subject.kind !== "security") continue;
    // The shape as SBI states it today: no ISIN, share class or product class
    // on either side. A rule that starts recording one is a new shape.
    const unstated = (row: InstrumentIdentifierFacts) =>
      row.isin === null && row.shareClass === null && row.productClass === null;
    if (!unstated(anchor) || !unstated(subject)) continue;
    if (anchor.countryCode !== "JP" || subject.countryCode !== "JP") continue;
    const code = anchor.securityCode;
    if (code === null || code !== subject.securityCode || !JAPANESE_SECURITIES_CODE.test(code))
      continue;
    // 3. One source, yen only.
    if (!onlySource(anchor) || !onlySource(subject) || candidate.crossSource) continue;
    if (!onlyYen(anchor) || !onlyYen(subject)) continue;
    // 4. Nobody decided anything about either side.
    const untouched = (row: InstrumentIdentifierFacts) =>
      row.mappingMethod === "rule" && row.adoptedByRule !== true;
    if (!untouched(anchor) || !untouched(subject)) continue;
    const anchorGroup = byInstrument.get(anchor.instrumentId) ?? [];
    if (!anchorGroup.every((row) => row.mappingMethod === "rule")) continue;
    if ((byInstrument.get(subject.instrumentId) ?? []).length !== 1) continue;
    // Any `listed_as` relation, in any status, naming either identifier or
    // either instrument: a person or an agent has looked at one of them.
    if (
      relatedIdentifiers.has(anchor.identifierId) ||
      relatedIdentifiers.has(subject.identifierId) ||
      relatedInstruments.has(anchor.instrumentId) ||
      relatedInstruments.has(subject.instrumentId)
    )
      continue;
    // 5. The subject is unambiguous.
    if (appearances.get(subject.identifierId) !== 1 || separated.has(subject.identifierId))
      continue;
    adoptions.push({
      candidateId: candidate.candidateId,
      anchorIdentifierId: anchor.identifierId,
      subjectIdentifierId: subject.identifierId,
      targetInstrumentId: anchor.instrumentId,
      securityCode: code,
      mic: anchor.mic,
    });
  }
  return adoptions;
}
