// Hand-built loaded rows for the knowledge selector and the B adapter: one
// call per committed (or unlogged) revision, with typed legs, effects, times
// and claims, in the shapes the SQL half hands over. Every id, amount and date
// is invented.
import type { EventTimeRole, LegEffect } from "../src/economic-contract.ts";
import type { EconomicEventKind, LegRole, RecognitionBasis } from "../src/events.ts";
import {
  ADOPTED_SELECTION_INPUT,
  selectAdopted,
  type AdoptedSelection,
  type LoadedClaim,
  type LoadedCommit,
  type LoadedEffect,
  type LoadedLeg,
  type LoadedRevision,
  type LoadedSeal,
  type LoadedTime,
  type SelectionScope,
  type SelectorInput,
} from "../src/knowledge-selector.ts";
import type { TemporalValue } from "../src/time.ts";

export const EPOCH = "core-epoch-test";
export const A = "acct-test-a";
export const B = "acct-test-b";
export const CARD = "acct-test-card";
const ACCOUNTS = [A, B, CARD];

export interface FixtureLeg {
  subject?: string;
  unit?: string;
  amount: string | null;
  role?: LegRole;
  basis?: RecognitionBasis;
  effect?: LegEffect;
  of?: number;
}

export interface FixtureRevision {
  eventId: string;
  revision?: number;
  kind?: EconomicEventKind;
  state?: string;
  seq: number | null;
  knownAt?: string;
  legs?: FixtureLeg[];
  times?: [EventTimeRole, TemporalValue][];
  claims?: { key: string; book?: string; alias?: string | null }[];
  supersedes?: [string, number][];
  epoch?: string;
  writerRelease?: string;
  createdAt?: string;
}

export const posting = (value: string): [EventTimeRole, TemporalValue] => [
  "posting",
  { kind: "local-date", value, zone: "Asia/Tokyo", basis: "provider" },
];

export class Rows {
  revisions: LoadedRevision[] = [];
  legs: LoadedLeg[] = [];
  claims: LoadedClaim[] = [];
  times: LoadedTime[] = [];
  effects: LoadedEffect[] = [];
  seals: LoadedSeal[] = [];
  commits: LoadedCommit[] = [];

  add(spec: FixtureRevision): this {
    const revision = spec.revision ?? 1;
    const supersedes = spec.supersedes ?? (revision > 1 ? [[spec.eventId, revision - 1]] : []);
    for (const [eventId, prior] of supersedes) {
      const row = this.revisions.find((r) => r.eventId === eventId && r.revision === prior);
      if (row === undefined) throw new Error(`no ${eventId}@${prior}`);
      row.supersededBy = `${spec.eventId}@${revision}`;
    }
    const state = spec.state ?? "debited";
    this.revisions.push({
      eventId: spec.eventId,
      revision,
      kind: spec.kind ?? "card_settlement",
      state,
      unknownReason: state === "unknown" ? "conflicting_evidence" : null,
      createdAt: spec.createdAt ?? "2026-04-01T00:00:00.000Z",
      supersededBy: null,
    });
    const legs = spec.legs ?? [];
    for (const [legIndex, leg] of legs.entries()) {
      const exact = leg.amount !== null;
      const [integer, fraction = ""] = (leg.amount ?? "0").split(".");
      this.legs.push({
        eventId: spec.eventId,
        revision,
        legIndex,
        subjectRef: leg.subject ?? A,
        unitRef: leg.unit ?? "JPY",
        valueStatus: exact ? "exact" : "missing",
        coefficient: exact ? String(BigInt(`${integer}${fraction}`)) : null,
        scale: exact ? fraction.length : null,
        valueReasonCode: exact ? null : "synthetic_value_unknown",
        role: leg.role ?? "decrease",
        basis: leg.basis ?? "cash-movement",
      });
      if (leg.effect !== undefined)
        this.effects.push({
          eventId: spec.eventId,
          revision,
          legIndex,
          effect: leg.effect,
          ofLegIndex: leg.effect === "movement" ? null : (leg.of ?? 0),
        });
    }
    for (const [role, time] of spec.times ?? [])
      this.times.push({
        eventId: spec.eventId,
        revision,
        role,
        temporalJson: JSON.stringify(time),
      });
    for (const claim of spec.claims ?? [])
      this.claims.push({
        eventId: spec.eventId,
        revision,
        book: claim.book ?? "cash-movement",
        consumptionKey: claim.key,
        aliasClass: claim.alias ?? null,
      });
    if (spec.seq !== null) {
      this.seals.push({
        eventId: spec.eventId,
        revision,
        writerRelease: spec.writerRelease ?? "card-statement-settlement-v1:economic-guard-v1",
        legCount: legs.length,
        claimCount: spec.claims?.length ?? 0,
        timeCount: spec.times?.length ?? 0,
        effectCount: legs.filter((leg) => leg.effect !== undefined).length,
        contentDigest: "c".repeat(64),
        identityPinsJson: "{}",
        identityEpoch: spec.epoch ?? "identity-epoch-1",
        coreEpoch: EPOCH,
        commitSeq: spec.seq,
      });
      this.commits.push({
        coreEpoch: EPOCH,
        commitSeq: spec.seq,
        kind: "test.adopt",
        knownAt: spec.knownAt ?? `2026-04-${String(spec.seq).padStart(2, "0")}T00:00:00.000Z`,
        membersJson: JSON.stringify([{ eventId: spec.eventId, revision, supersedes }]),
      });
    }
    return this;
  }

  input(cut: number, fields: Partial<SelectorInput> = {}): SelectorInput {
    const commits = [...this.commits].sort((a, b) => a.commitSeq - b.commitSeq);
    const first = commits[0];
    const last = commits[commits.length - 1];
    const subjects = [...new Set(this.legs.map((leg) => leg.subjectRef))].map((subjectRef) => {
      const id = subjectRef.startsWith("account:") ? subjectRef.slice(8) : subjectRef;
      return ACCOUNTS.includes(id)
        ? {
            subjectRef,
            accountId: id,
            form: subjectRef.startsWith("account:")
              ? ("account-prefixed" as const)
              : ("bare-account" as const),
          }
        : { subjectRef, accountId: null, form: "unrecognized" as const };
    });
    const scope: SelectionScope = {
      accounts: [A],
      instruments: null,
      kinds: null,
      legEffects: null,
      basis: null,
      range: null,
    };
    return {
      contract: ADOPTED_SELECTION_INPUT,
      requestedCut:
        cut === 0
          ? { coreEpoch: EPOCH, instant: "2026-03-01T00:00:00.000Z" }
          : { coreEpoch: EPOCH, commitSeq: cut },
      cut: { coreEpoch: EPOCH, commitSeq: cut },
      cutKnownAt: cut === 0 ? null : commits.find((commit) => commit.commitSeq === cut)!.knownAt,
      currentCoreEpoch: EPOCH,
      currentIdentityEpoch: "identity-epoch-1",
      log: {
        firstSeq: first?.commitSeq ?? null,
        firstKnownAt: first?.knownAt ?? null,
        lastSeq: last?.commitSeq ?? null,
        lastKnownAt: last?.knownAt ?? null,
      },
      scope,
      revisions: structuredClone(this.revisions),
      legs: structuredClone(this.legs),
      subjects,
      claims: structuredClone(this.claims),
      times: structuredClone(this.times),
      effects: structuredClone(this.effects),
      seals: structuredClone(this.seals),
      commits: structuredClone(this.commits),
      pins: [],
      ...fields,
    };
  }

  async select(cut: number, fields: Partial<SelectorInput> = {}): Promise<AdoptedSelection> {
    const result = await selectAdopted(this.input(cut, fields));
    if (!result.ok) throw new Error(`${result.error.code} ${result.error.refs.join(",")}`);
    return result.selection;
  }
}
