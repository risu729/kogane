// The knowledge selector's pure half (src/knowledge-selector.ts) on
// hand-built loaded rows: instant cuts and equal instants, the cut before the
// log, revisions the log does not place, supersession checks, identity epochs
// and pins, conflicts that are listed and never washed, unsupported shapes,
// the scope applied after resolution, bounds, exact keys, and the set version
// under permutation and later commits. Every id, amount and date is invented.
import { describe, expect, test } from "bun:test";
import {
  ADOPTED_SELECTION_INPUT,
  SELECTOR_BOUNDS,
  canonicalCutInstant,
  resolveInstantCut,
  selectAdopted,
  validSelectionScope,
  type AdoptedSelection,
  type LoadedClaim,
  type LoadedCommit,
  type LoadedLeg,
  type LoadedRevision,
  type LoadedSeal,
  type SelectionScope,
  type SelectorInput,
} from "../src/knowledge-selector.ts";

const EPOCH = "core-epoch-test";
const A = "acct-test-a";
const B = "acct-test-b";
const KEY = JSON.stringify(["smbc-bank", "producer-test", "ns-test", "bank-test", "row-1"]);
const KEY2 = JSON.stringify(["smbc-bank", "producer-test", "ns-test", "bank-test", "row-2"]);
const ALIAS = JSON.stringify(["smbc-bank", ["row-1"], A, "rule-test-v1"]);

interface History {
  revisions: LoadedRevision[];
  legs: LoadedLeg[];
  claims: LoadedClaim[];
  seals: LoadedSeal[];
  commits: LoadedCommit[];
  times: SelectorInput["times"];
  effects: SelectorInput["effects"];
  pins: SelectorInput["pins"];
}

const empty = (): History => ({
  revisions: [],
  legs: [],
  claims: [],
  seals: [],
  commits: [],
  times: [],
  effects: [],
  pins: [],
});
const knownAt = (seq: number) => `2026-03-${String(seq).padStart(2, "0")}T00:00:00.000Z`;

interface WriteSpec {
  eventId: string;
  revision: number;
  /** The commit sequence, or null for a revision no commit finalizes. */
  seq: number | null;
  subject?: string;
  amount?: string;
  supersedes?: [string, number][];
  claims?: { key: string; alias?: string | null; book?: string }[];
  state?: string;
  epoch?: string;
  pins?: Record<string, number>;
  knownAt?: string;
}

/** Append one revision (and its commit) to a history, moving its priors' pointers. */
function write(h: History, spec: WriteSpec): History {
  const supersedes =
    spec.supersedes ?? (spec.revision > 1 ? [[spec.eventId, spec.revision - 1]] : []);
  for (const [eventId, revision] of supersedes) {
    const prior = h.revisions.find((row) => row.eventId === eventId && row.revision === revision)!;
    prior.supersededBy = `${spec.eventId}@${spec.revision}`;
  }
  const state = spec.state ?? "debited";
  h.revisions.push({
    eventId: spec.eventId,
    revision: spec.revision,
    kind: "card_settlement",
    state,
    unknownReason: state === "unknown" ? "conflicting_evidence" : null,
    createdAt: "2026-03-01T00:00:00.000Z",
    supersededBy: null,
  });
  const legs = state === "unknown" ? [] : [spec.subject ?? A];
  for (const [legIndex, subject] of legs.entries())
    h.legs.push({
      eventId: spec.eventId,
      revision: spec.revision,
      legIndex,
      subjectRef: subject,
      unitRef: "JPY",
      valueStatus: "exact",
      coefficient: spec.amount ?? "100",
      scale: 0,
      valueReasonCode: null,
      role: "decrease",
      basis: "cash-movement",
    });
  for (const claim of spec.claims ?? [])
    h.claims.push({
      eventId: spec.eventId,
      revision: spec.revision,
      book: claim.book ?? "cash-movement",
      consumptionKey: claim.key,
      aliasClass: claim.alias ?? null,
    });
  if (spec.seq !== null) {
    h.seals.push({
      eventId: spec.eventId,
      revision: spec.revision,
      writerRelease: "writer-test-v1",
      legCount: legs.length,
      claimCount: spec.claims?.length ?? 0,
      timeCount: 0,
      effectCount: 0,
      contentDigest: "c".repeat(64),
      identityPinsJson: JSON.stringify(spec.pins ?? {}),
      identityEpoch: spec.epoch ?? "identity-epoch-1",
      coreEpoch: EPOCH,
      commitSeq: spec.seq,
    });
    h.commits.push({
      coreEpoch: EPOCH,
      commitSeq: spec.seq,
      kind: "test.adopt",
      knownAt: spec.knownAt ?? knownAt(spec.seq),
      membersJson: JSON.stringify([{ eventId: spec.eventId, revision: spec.revision, supersedes }]),
    });
  }
  return h;
}

const scopeOf = (fields: Partial<SelectionScope> = {}): SelectionScope => ({
  accounts: [A],
  instruments: null,
  kinds: null,
  legEffects: null,
  basis: null,
  range: null,
  ...fields,
});

function input(h: History, cut: number, fields: Partial<SelectorInput> = {}): SelectorInput {
  const seqs = h.commits.map((commit) => commit.commitSeq);
  const first = seqs.length === 0 ? null : Math.min(...seqs);
  const last = seqs.length === 0 ? null : Math.max(...seqs);
  const subjects = [...new Set(h.legs.map((leg) => leg.subjectRef))].map((subjectRef) => {
    const id = subjectRef.startsWith("account:") ? subjectRef.slice(8) : subjectRef;
    return [A, B].includes(id)
      ? {
          subjectRef,
          accountId: id,
          form: subjectRef.startsWith("account:")
            ? ("account-prefixed" as const)
            : ("bare-account" as const),
        }
      : { subjectRef, accountId: null, form: "unrecognized" as const };
  });
  return {
    contract: ADOPTED_SELECTION_INPUT,
    requestedCut:
      cut === 0
        ? { coreEpoch: EPOCH, instant: "2026-02-01T00:00:00.000Z" }
        : { coreEpoch: EPOCH, commitSeq: cut },
    cut: { coreEpoch: EPOCH, commitSeq: cut },
    cutKnownAt: cut === 0 ? null : h.commits.find((commit) => commit.commitSeq === cut)!.knownAt,
    currentCoreEpoch: EPOCH,
    currentIdentityEpoch: "identity-epoch-1",
    log: {
      firstSeq: first,
      firstKnownAt: first === null ? null : h.commits.find((c) => c.commitSeq === first)!.knownAt,
      lastSeq: last,
      lastKnownAt: last === null ? null : h.commits.find((c) => c.commitSeq === last)!.knownAt,
    },
    scope: scopeOf(),
    subjects,
    ...structuredClone(h),
    ...fields,
  };
}

async function at(
  h: History,
  cut: number,
  fields: Partial<SelectorInput> = {},
): Promise<AdoptedSelection> {
  const result = await selectAdopted(input(h, cut, fields));
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.refs.join(",")}`);
  return result.selection;
}

const refs = (selection: AdoptedSelection) =>
  selection.revisions.map((row) => `${row.eventId}@${row.revision}:${row.status}`);

describe("instant cuts", () => {
  test("the largest sequence at or before the instant, every equal instant included", () => {
    const log = [
      { commitSeq: 1, knownAt: "2026-03-01T00:00:00.000Z" },
      { commitSeq: 2, knownAt: "2026-03-01T00:00:00.000Z" },
      { commitSeq: 3, knownAt: "2026-03-01T00:00:00.001Z" },
    ];
    expect(resolveInstantCut(log, "2026-03-01T00:00:00.000Z")).toBe(2);
    expect(resolveInstantCut(log, "2026-03-01T09:00:00.0009+09:00")).toBe(2);
    expect(resolveInstantCut(log, "2026-03-01T00:00:00.001Z")).toBe(3);
    expect(resolveInstantCut(log, "2026-02-28T23:59:59.999Z")).toBe(0);
    expect(resolveInstantCut(log, "not an instant")).toBeNull();
  });

  test("an instant is floored to the stored millisecond form, never rounded up", () => {
    expect(canonicalCutInstant("2026-03-01T00:00:00.0009Z")).toBe("2026-03-01T00:00:00.000Z");
    expect(canonicalCutInstant("2026-03-01T09:00:00+09:00")).toBe("2026-03-01T00:00:00.000Z");
    expect(canonicalCutInstant("2026-03-01")).toBeNull();
  });
});

describe("resolution at the cut", () => {
  test("B1: an account correction never revives the old revision at any later cut", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1 });
    write(h, { eventId: "ev-1", revision: 2, seq: 2, subject: B });
    write(h, { eventId: "ev-2", revision: 1, seq: 3 });
    expect(refs(await at(h, 1))).toEqual(["ev-1@1:active"]);
    for (const cut of [2, 3]) {
      const selection = await at(h, cut);
      expect(refs(selection)).not.toContain("ev-1@1:active");
      expect(selection.revisions.find((row) => row.eventId === "ev-1")!.legs[0]!.accountId).toBe(B);
    }
  });

  test("the scope is applied after resolution: a withdrawal without legs still decides", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1 });
    write(h, { eventId: "ev-1", revision: 2, seq: 2, state: "unknown" });
    const selection = await at(h, 2);
    expect(refs(selection)).toEqual(["ev-1@2:active"]);
    expect(selection.revisions[0]!.supersedes).toEqual([{ eventId: "ev-1", revision: 1 }]);
    // A narrower scope, by kind, keeps nothing; by effect, the old leg reaches it.
    expect(refs(await at(h, 2, { scope: scopeOf({ kinds: ["purchase"] }) }))).toEqual([]);
    expect(refs(await at(h, 2, { scope: scopeOf({ legEffects: ["undeclared"] }) }))).toEqual([
      "ev-1@2:active",
    ]);
  });

  test("B2: a later commit leaves an earlier cut's selection and set version unchanged", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1, claims: [{ key: KEY }] });
    const before = await at(h, 1);
    write(h, { eventId: "ev-1", revision: 2, seq: 2, amount: "120" });
    write(h, { eventId: "ev-3", revision: 1, seq: 3, claims: [{ key: KEY }] });
    const again = await at(h, 1);
    expect(again).toEqual(before);
    expect((await at(h, 3)).setVersion).not.toBe(before.setVersion);
  });

  test("B13 (selector half): any order of the loaded rows gives the same selection", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1, claims: [{ key: KEY }] });
    write(h, {
      eventId: "ev-2",
      revision: 1,
      seq: 2,
      subject: `account:${A}`,
      claims: [{ key: KEY2 }],
    });
    write(h, { eventId: "ev-1", revision: 2, seq: 3 });
    const forward = await at(h, 3);
    const reversed: History = {
      revisions: [...h.revisions].reverse(),
      legs: [...h.legs].reverse(),
      claims: [...h.claims].reverse(),
      seals: [...h.seals].reverse(),
      commits: [...h.commits].reverse(),
      times: [],
      effects: [],
      pins: [],
    };
    expect(await at(reversed, 3)).toEqual(forward);
  });

  test("a cut before the log's first commit is indeterminate", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1 });
    const selection = await at(h, 0);
    expect(selection.revisions).toEqual([]);
    expect(selection.coverage).toEqual({
      status: "indeterminate",
      reasons: ["cut_before_log_start"],
      logStart: { commitSeq: 1, knownAt: knownAt(1) },
    });
  });

  test("an unlogged revision is reported, not applied; a logged successor places it", async () => {
    const h = empty();
    write(h, { eventId: "ev-pre", revision: 1, seq: null });
    write(h, { eventId: "ev-1", revision: 1, seq: 1 });
    const unlogged = await at(h, 1);
    expect(refs(unlogged)).toEqual(["ev-1@1:active", "ev-pre@1:knowledge_unlogged"]);
    expect(unlogged.revisions[1]!.commit).toBeNull();
    expect(unlogged.unlogged).toEqual([
      { eventId: "ev-pre", revision: 1, reasonCode: "no_commit" },
    ]);
    expect(unlogged.coverage.status).toBe("partial");
    write(h, { eventId: "ev-pre", revision: 2, seq: 2 });
    const placed = await at(h, 2);
    expect(refs(placed)).toEqual(["ev-1@1:active", "ev-pre@2:active"]);
    expect(placed.coverage.status).toBe("logged");
  });

  test("a pre-log chain of two revisions ends where a logged correction supersedes its last", async () => {
    const h = empty();
    write(h, { eventId: "ev:x", revision: 1, seq: null });
    write(h, { eventId: "ev:x", revision: 2, seq: null });
    write(h, { eventId: "ev:x", revision: 3, seq: 1 });
    const selection = await at(h, 1);
    expect(refs(selection)).toEqual(["ev:x@3:active"]);
    expect(selection.unlogged).toEqual([]);
    expect(selection.coverage.status).toBe("logged");
    // At the cut before the correction neither pre-log revision is placed.
    expect(refs(await at(h, 0))).toEqual([
      "ev:x@1:knowledge_unlogged",
      "ev:x@2:knowledge_unlogged",
    ]);
  });

  test("a cross-event merge of a pre-log chain places every revision of it", async () => {
    const h = empty();
    write(h, { eventId: "ev:q", revision: 1, seq: null });
    write(h, { eventId: "ev:q", revision: 2, seq: null });
    write(h, { eventId: "ev:p", revision: 1, seq: 1, supersedes: [["ev:q", 2]] });
    const selection = await at(h, 1);
    expect(refs(selection)).toEqual(["ev:p@1:active"]);
    expect(selection.unlogged).toEqual([]);
  });

  test("an older build's successor makes the event unlogged at every cut after its prior", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1 });
    write(h, { eventId: "ev-1", revision: 2, seq: null });
    expect((await at(h, 1)).unlogged).toEqual([
      { eventId: "ev-1", revision: 1, reasonCode: "successor_unlogged" },
      { eventId: "ev-1", revision: 2, reasonCode: "no_commit" },
    ]);
  });

  test("another core epoch's commit is not placed in this history", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1 });
    write(h, { eventId: "ev-2", revision: 1, seq: 2 });
    h.seals[0]!.coreEpoch = "core-epoch-old";
    h.commits[0]!.coreEpoch = "core-epoch-old";
    const selection = await at(h, 2);
    expect(selection.unlogged).toEqual([
      { eventId: "ev-1", revision: 1, reasonCode: "other_core_epoch" },
    ]);
  });

  test("two revisions in force, or a pointer the log does not declare, is chain_inconsistent", async () => {
    const two = empty();
    write(two, { eventId: "ev-1", revision: 1, seq: 1 });
    write(two, { eventId: "ev-1", revision: 2, seq: 2, supersedes: [] });
    const both = await at(two, 2);
    expect(refs(both)).toEqual(["ev-1@1:chain_inconsistent", "ev-1@2:chain_inconsistent"]);
    expect(both.inconsistent).toEqual([{ eventId: "ev-1", reasonCode: "two_in_force_at_cut" }]);
    const undeclared = empty();
    write(undeclared, { eventId: "ev-1", revision: 1, seq: 1 });
    write(undeclared, { eventId: "ev-1", revision: 2, seq: 2, supersedes: [] });
    undeclared.revisions[0]!.supersededBy = "ev-1@2";
    expect((await at(undeclared, 2)).inconsistent.map((entry) => entry.reasonCode)).toEqual([
      "supersession_undeclared",
      "two_in_force_at_cut",
    ]);
    const counts = empty();
    write(counts, { eventId: "ev-1", revision: 1, seq: 1 });
    counts.seals[0]!.legCount = 2;
    expect((await at(counts, 1)).inconsistent).toEqual([
      { eventId: "ev-1", reasonCode: "seal_count_mismatch" },
    ]);
  });

  test("a commit that names a revision whose pointer is elsewhere is inconsistent on both events", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1 });
    write(h, { eventId: "ev-2", revision: 1, seq: 2, supersedes: [] });
    h.commits[1]!.membersJson = JSON.stringify([
      { eventId: "ev-2", revision: 1, supersedes: [["ev-1", 1]] },
    ]);
    const selection = await at(h, 2);
    expect(selection.inconsistent).toEqual([
      { eventId: "ev-1", reasonCode: "supersession_pointer_mismatch" },
      { eventId: "ev-2", reasonCode: "supersession_pointer_mismatch" },
    ]);
  });
});

describe("set version and cut standing", () => {
  test("one sequence asked by number or by instant has one set version", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1, claims: [{ key: KEY }] });
    write(h, { eventId: "ev-2", revision: 1, seq: 2 });
    const bySeq = await at(h, 1);
    const byInstant = await at(h, 1, {
      requestedCut: { coreEpoch: EPOCH, instant: "2026-03-01T12:00:00.000Z" },
    });
    expect(byInstant.requestedCut).toEqual({
      coreEpoch: EPOCH,
      instant: "2026-03-01T12:00:00.000Z",
    });
    expect(byInstant.setVersion).toBe(bySeq.setVersion);
    expect([bySeq.cutStanding, byInstant.cutStanding]).toEqual(["final", "final"]);
  });

  test("an instant at or after the log's last known_at is provisional", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1 });
    const at2 = (instant: string) => at(h, 1, { requestedCut: { coreEpoch: EPOCH, instant } });
    expect((await at2(knownAt(1))).cutStanding).toBe("provisional");
    expect((await at2("2026-03-05T00:00:00.000Z")).cutStanding).toBe("provisional");
    const before = await selectAdopted(input(empty(), 0));
    expect(before.ok && before.selection.cutStanding).toBe("provisional");
  });
});

describe("holders, identity and shapes", () => {
  test("two holders of one key at the cut are listed and flagged, never resolved", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1, claims: [{ key: KEY }] });
    write(h, { eventId: "ev-2", revision: 1, seq: 2, subject: B, claims: [{ key: KEY }] });
    const selection = await at(h, 2);
    expect(selection.conflicts).toEqual([
      { dimension: "key", book: "cash-movement", ref: KEY, holders: ["ev-1@1", "ev-2@1"] },
    ]);
    expect(selection.revisions.map((row) => row.flags)).toEqual([["claim_conflict"]]);
    // The holder out of scope is reported, not selected.
    expect(refs(selection)).toEqual(["ev-1@1:active"]);
    // At the cut before the second holder there is none.
    expect((await at(h, 1)).conflicts).toEqual([]);
  });

  test("one fact under two keys in one alias class is an alias conflict", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1, claims: [{ key: KEY, alias: ALIAS }] });
    write(h, { eventId: "ev-2", revision: 1, seq: 2, claims: [{ key: KEY2, alias: ALIAS }] });
    const selection = await at(h, 2);
    expect(selection.conflicts).toEqual([
      { dimension: "alias", book: "cash-movement", ref: ALIAS, holders: ["ev-1@1", "ev-2@1"] },
    ]);
    // A correction restating its own key under its class is no conflict.
    write(h, { eventId: "ev-2", revision: 2, seq: 3, state: "unknown" });
    write(h, { eventId: "ev-1", revision: 2, seq: 4, claims: [{ key: KEY, alias: ALIAS }] });
    expect((await at(h, 4)).conflicts).toEqual([]);
  });

  test("a seal under an older identity epoch, or with a moved or unreadable pin, is identity_changed; the holder is kept", async () => {
    const h = empty();
    write(h, {
      eventId: "ev-1",
      revision: 1,
      seq: 1,
      claims: [{ key: KEY }],
      pins: { "account_mapping:sa-1": 1, "ownership:x": 1 },
    });
    const selection = await at(h, 1, {
      currentIdentityEpoch: "identity-epoch-2",
      pins: [
        { subject: "account_mapping:sa-1", currentRevision: 2 },
        { subject: "ownership:x", currentRevision: null },
      ],
    });
    expect(selection.identityChanged).toEqual([
      {
        eventId: "ev-1",
        revision: 1,
        reasons: ["identity_epoch_changed", "identity_pin_moved", "identity_pin_unreadable"],
      },
    ]);
    expect(selection.claims.map((claim) => claim.eventId)).toEqual(["ev-1"]);
  });

  test("a book, key, time or effect the contract does not have is unsupported", async () => {
    const h = empty();
    write(h, {
      eventId: "ev-1",
      revision: 1,
      seq: 1,
      claims: [{ key: KEY, book: "security-quantity" }, { key: "not-a-key" }],
    });
    h.seals[0]!.timeCount = 1;
    h.seals[0]!.effectCount = 1;
    h.times.push({
      eventId: "ev-1",
      revision: 1,
      role: "posting",
      temporalJson: '{"kind":"later"}',
    });
    h.effects.push({
      eventId: "ev-1",
      revision: 1,
      legIndex: 0,
      effect: "breakdown",
      ofLegIndex: 0,
    });
    const selection = await at(h, 1);
    expect(selection.unsupported.map((entry) => entry.reasonCode)).toEqual([
      "book_unsupported",
      "claim_key_unreadable",
      "time_unreadable",
      "leg_effect_unreadable",
    ]);
    expect(selection.revisions[0]!.flags).toEqual(["unsupported"]);
  });

  test("an inexact leg value stays absent with its reason, never zero", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1 });
    Object.assign(h.legs[0]!, {
      valueStatus: "missing",
      coefficient: null,
      scale: null,
      valueReasonCode: "amount_not_stated",
    });
    const leg = (await at(h, 1)).revisions[0]!.legs[0]!;
    expect(leg.quantity).toEqual({
      unitRef: "JPY",
      value: { status: "missing", reasonCode: "amount_not_stated" },
    });
  });
});

describe("refusals", () => {
  test("a load past a bound is refused", async () => {
    const h = empty();
    const result = await selectAdopted(
      input(h, 0, {
        legs: Array.from({ length: SELECTOR_BOUNDS.legs + 1 }, (_, legIndex) => ({
          eventId: "ev",
          revision: 1,
          legIndex,
          subjectRef: A,
          unitRef: "JPY",
          valueStatus: "exact",
          coefficient: "1",
          scale: 0,
          valueReasonCode: null,
          role: "decrease",
          basis: "cash-movement",
        })),
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "selector_bound_exceeded", refs: [`legs:${SELECTOR_BOUNDS.legs + 1}`] },
    });
  });

  test("a cut past the log's end, an unknown key or a child of no revision is refused", async () => {
    const h = empty();
    write(h, { eventId: "ev-1", revision: 1, seq: 1 });
    const past = input(h, 1);
    past.cut = { coreEpoch: EPOCH, commitSeq: 2 };
    past.requestedCut = { coreEpoch: EPOCH, commitSeq: 2 };
    past.cutKnownAt = knownAt(2);
    expect((await selectAdopted(past)).ok).toBe(false);
    expect(
      await selectAdopted({ ...input(h, 1), extra: true } as unknown as SelectorInput),
    ).toEqual({
      ok: false,
      error: { code: "invalid_input", refs: ["$"] },
    });
    const orphan = input(h, 1);
    orphan.legs.push({ ...orphan.legs[0]!, eventId: "ev-none" });
    expect(await selectAdopted(orphan)).toEqual({
      ok: false,
      error: { code: "invalid_input", refs: ["legs[1]"] },
    });
  });

  test("a scope needs an account, and a range needs a basis", () => {
    expect(validSelectionScope(scopeOf())).toBe(true);
    expect(validSelectionScope(scopeOf({ accounts: [] }))).toBe(false);
    expect(validSelectionScope(scopeOf({ range: { from: "2026-03-01", to: "2026-03-31" } }))).toBe(
      false,
    );
    expect(
      validSelectionScope(
        scopeOf({
          basis: { legBasis: "cash-movement", timeRole: "posting" },
          range: { from: "2026-03-31", to: "2026-03-01" },
        }),
      ),
    ).toBe(false);
  });
});
