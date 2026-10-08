// Cross-identifier instrument candidates (src/instrument-candidates.ts,
// ADR 0055). Every identifier, code, name and ISIN here is synthetic; the
// "ISINs" are invented strings of the ISIN shape.
import { describe, expect, test } from "bun:test";
import {
  CANDIDATE_HINT_LIMIT,
  CANDIDATE_PAIR_LIMIT,
  compareIdentifierFacts,
  identifierResolutions,
  instrumentCandidates,
  INSTRUMENT_CANDIDATE_POLICY,
  listedAsKey,
  normalisedDisplayName,
  type InstrumentCandidateSet,
  type InstrumentIdentifierFacts,
} from "../src/instrument-candidates.ts";
import type { StoredRelationStatus } from "../src/decisions.ts";

/** An invented value in the ISIN shape; never a real security's. */
function isin(body: string): string {
  return `${body}0`;
}

function facts(
  id: string,
  overrides: Partial<InstrumentIdentifierFacts> = {},
): InstrumentIdentifierFacts {
  return {
    identifierId: id,
    instrumentId: `instrument-${id}`,
    mappingMethod: "rule",
    kind: "security",
    namespace: "synthetic-code",
    scope: "ZZ",
    value: id,
    sources: ["synthetic-broker-a"],
    isin: null,
    countryCode: null,
    securityCode: null,
    mic: null,
    ric: null,
    shareClass: null,
    productClass: null,
    currencies: [],
    currencyUnconfirmed: false,
    label: `Synthetic ${id}`,
    ...overrides,
  };
}

function set(
  rows: readonly InstrumentIdentifierFacts[],
  listedAs: ReadonlyMap<string, StoredRelationStatus> = new Map(),
): InstrumentCandidateSet {
  const result = instrumentCandidates(rows, listedAs);
  if (!result.ok) throw new Error(result.error);
  return result.set;
}

/** Deeply frozen copies: the matcher must not write to what it reads. */
function frozen(rows: InstrumentIdentifierFacts[]): readonly InstrumentIdentifierFacts[] {
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        ...row,
        sources: Object.freeze([...row.sources]),
        currencies: Object.freeze([...row.currencies]),
      }),
    ),
  );
}

// Two brokers' identifiers for one listed security: a listing identifier at
// one, a provider code at the other, the same country-scoped code on both.
const listing = facts("a-listing", {
  namespace: "mic-symbol",
  scope: "XSYN",
  value: "9999",
  countryCode: "ZZ",
  securityCode: "9999",
  mic: "XSYN",
  currencies: ["JPY"],
});
const brokerB = facts("b-code", {
  namespace: "synthetic-broker-b-code",
  scope: "ZZ",
  value: "9999",
  sources: ["synthetic-broker-b"],
  countryCode: "ZZ",
  securityCode: "9999",
  mic: "XSYN",
  currencies: ["JPY"],
});

describe("evidence-backed candidates", () => {
  test("the same country-scoped code on the same market is proposed, never adopted", () => {
    const result = set(frozen([brokerB, listing]));
    expect(result.policy).toBe(INSTRUMENT_CANDIDATE_POLICY);
    expect(result.candidates).toEqual([
      {
        candidateId: "instrument-candidate:a-listing|b-code",
        anchorIdentifierId: "a-listing",
        subjectIdentifierId: "b-code",
        evidence: ["security-code-equal"],
        agreements: ["kind-agrees", "country-agrees", "market-agrees", "currency-agrees"],
        // No identity rule records an ISIN, share class or product class yet.
        gaps: ["isin-unconfirmed", "share-class-unconfirmed", "product-class-unconfirmed"],
        crossSource: true,
        status: "proposed",
        hold: null,
      },
    ]);
    expect(result.separated).toEqual([]);
    expect(result.hints).toEqual([]);
  });

  test("a code without a stated market is a candidate with the market named as unconfirmed", () => {
    const bare = facts("b-bare", {
      sources: ["synthetic-broker-a"],
      countryCode: "ZZ",
      securityCode: "9999",
      currencies: ["JPY"],
    });
    const [candidate] = set([listing, bare]).candidates;
    expect(candidate).toMatchObject({
      anchorIdentifierId: "a-listing",
      subjectIdentifierId: "b-bare",
      evidence: ["security-code-equal"],
      gaps: [
        "isin-unconfirmed",
        "market-unconfirmed",
        "share-class-unconfirmed",
        "product-class-unconfirmed",
      ],
      crossSource: false,
      status: "proposed",
    });
  });

  test("equal ISINs are evidence; an ISIN on one side only is a gap, not a conflict", () => {
    const code = isin("ZZSYNTH0001");
    const a = facts("isin-a", { isin: code, mic: "XSYN", currencies: ["USD"] });
    const b = facts("isin-b", {
      isin: code,
      mic: "XSYN",
      currencies: ["USD"],
      sources: ["synthetic-broker-b"],
    });
    expect(set([a, b]).candidates[0]).toMatchObject({
      evidence: ["isin-equal"],
      gaps: ["share-class-unconfirmed", "product-class-unconfirmed"],
      status: "proposed",
    });
    const codeOnly = compareIdentifierFacts(
      facts("c1", { isin: code, countryCode: "ZZ", securityCode: "S1" }),
      facts("c2", { countryCode: "ZZ", securityCode: "S1" }),
    );
    expect(codeOnly.evidence).toEqual(["security-code-equal"]);
    expect(codeOnly.conflicts).toEqual([]);
    expect(codeOnly.gaps).toContain("isin-unconfirmed");
  });

  test("an equal RIC is evidence and states the market; a code alone does not", () => {
    const ricA = facts("ric-a", { ric: "SYN.X", countryCode: "ZZ", securityCode: "SYN" });
    const codeB = facts("code-b", { countryCode: "ZZ", securityCode: "SYN" });
    const [candidate] = set([ricA, codeB]).candidates;
    expect(candidate).toMatchObject({
      anchorIdentifierId: "ric-a",
      subjectIdentifierId: "code-b",
      evidence: ["security-code-equal"],
    });
    expect(candidate!.gaps).toContain("market-unconfirmed");
    const both = compareIdentifierFacts(ricA, facts("ric-b", { ric: "SYN.X" }));
    expect(both.evidence).toEqual(["ric-equal"]);
    expect(both.agreements).toContain("market-agrees");
  });
});

describe("pairs that state different facts stay apart", () => {
  test("the same code on two markets is separated, never a candidate", () => {
    const other = { ...brokerB, mic: "XSYM" };
    const result = set([listing, other]);
    expect(result.candidates).toEqual([]);
    expect(result.separated).toEqual([
      {
        pairId: "instrument-pair:a-listing|b-code",
        identifierIds: ["a-listing", "b-code"],
        evidence: ["security-code-equal"],
        conflicts: ["market-differs"],
        via: [],
        sharedInstrument: false,
      },
    ]);
  });

  test("two different RICs are two listings, whatever code they share", () => {
    const a = facts("ric-a", { ric: "SYN.X", countryCode: "ZZ", securityCode: "SYN" });
    const b = facts("ric-b", { ric: "SYN.Y", countryCode: "ZZ", securityCode: "SYN" });
    const result = set([a, b]);
    expect(result.candidates).toEqual([]);
    expect(result.separated[0]!.conflicts).toEqual(["ric-differs"]);
  });

  test("the same code in two currencies is separated", () => {
    const result = set([listing, { ...brokerB, currencies: ["USD"] }]);
    expect(result.candidates).toEqual([]);
    expect(result.separated[0]!.conflicts).toEqual(["currency-differs"]);
    // Disjoint sets differ too; overlapping sets with more than one currency
    // are not comparable, so they are a gap, never an agreement.
    expect(
      compareIdentifierFacts(
        facts("x", { currencies: ["JPY", "USD"] }),
        facts("y", { currencies: ["AUD", "EUR"] }),
      ).conflicts,
    ).toEqual(["currency-differs"]);
    const overlapping = compareIdentifierFacts(
      facts("x", { currencies: ["JPY", "USD"] }),
      facts("y", { currencies: ["USD"] }),
    );
    expect(overlapping.conflicts).toEqual([]);
    expect(overlapping.gaps).toContain("currency-unconfirmed");
  });

  test("a currency a use states but the rules could not resolve is unconfirmed, never agreeing or differing", () => {
    for (const other of [["JPY"], ["USD"]]) {
      const comparison = compareIdentifierFacts(
        facts("x", { currencies: ["JPY"], currencyUnconfirmed: true }),
        facts("y", { currencies: other }),
      );
      expect(comparison.agreements).not.toContain("currency-agrees");
      expect(comparison.conflicts).toEqual([]);
      expect(comparison.gaps).toContain("currency-unconfirmed");
    }
  });

  test("one ISIN in two share classes is separated; a share class on one side only is a gap", () => {
    const code = isin("ZZSYNTH0002");
    const a = facts("fund-a", { isin: code, shareClass: "class-1" });
    const b = facts("fund-b", { isin: code, shareClass: "class-2" });
    const result = set([a, b]);
    expect(result.candidates).toEqual([]);
    expect(result.separated[0]).toMatchObject({
      evidence: ["isin-equal"],
      conflicts: ["share-class-differs"],
    });
    const unstated = set([a, { ...b, shareClass: null }]).candidates[0];
    expect(unstated!.gaps).toContain("share-class-unconfirmed");
    expect(unstated!.status).toBe("proposed");
  });

  test("a product, a coin and a security never pair, even on one shared value", () => {
    const code = isin("ZZSYNTH0003");
    const result = set([
      facts("security", { isin: code }),
      facts("product", { isin: code, kind: "product" }),
      facts("coin", { isin: code, kind: "crypto" }),
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.separated.map((pair) => pair.conflicts)).toEqual([
      ["kind-differs"],
      ["kind-differs"],
      ["kind-differs"],
    ]);
  });

  test("different product classes and different countries are separated", () => {
    const code = isin("ZZSYNTH0004");
    expect(
      set([
        facts("p1", { isin: code, productClass: "fund" }),
        facts("p2", { isin: code, productClass: "etf" }),
      ]).separated[0]!.conflicts,
    ).toEqual(["product-class-differs"]);
    expect(
      set([
        facts("c1", { isin: code, countryCode: "ZZ" }),
        facts("c2", { isin: code, countryCode: "ZY" }),
      ]).separated[0]!.conflicts,
    ).toEqual(["country-differs"]);
  });

  test("a stated conflict on two identifiers a person already joined is reported, not undone", () => {
    const joined = {
      ...brokerB,
      instrumentId: listing.instrumentId,
      mappingMethod: "manual" as const,
      mic: "XSYM",
    };
    const result = set([listing, joined]);
    expect(result.separated[0]).toMatchObject({
      conflicts: ["market-differs"],
      sharedInstrument: true,
    });
    expect(identifierResolutions([listing, joined], result).map((row) => row.state)).toEqual([
      "resolved-by-decision",
      "resolved-by-decision",
    ]);
  });
});

describe("display names are never evidence", () => {
  test("equal names with different codes are a hint only, with nothing to adopt", () => {
    const a = facts("name-a", {
      countryCode: "ZZ",
      securityCode: "1111",
      label: "Synthetic Growth Fund",
    });
    const b = facts("name-b", {
      countryCode: "ZZ",
      securityCode: "2222",
      label: "ＳＹＮＴＨＥＴＩＣ  growth fund",
      sources: ["synthetic-broker-b"],
    });
    const result = set([a, b]);
    expect(result.candidates).toEqual([]);
    expect(result.separated).toEqual([]);
    expect(result.hints).toEqual([
      {
        pairId: "instrument-pair:name-a|name-b",
        identifierIds: ["name-a", "name-b"],
        reason: "same-display-name",
        conflicts: [],
      },
    ]);
    // A hint has no status and no subject: it cannot be adopted.
    expect(Object.keys(result.hints[0]!).sort()).toEqual([
      "conflicts",
      "identifierIds",
      "pairId",
      "reason",
    ]);
    expect(identifierResolutions([a, b], result).map((row) => row.state)).toEqual([
      "no-candidate",
      "no-candidate",
    ]);
  });

  test("same-name products with different ISINs and share classes stay apart, the differences named", () => {
    const hedged = facts("fund-hedged", {
      isin: isin("ZZSYNTH0005"),
      shareClass: "hedged",
      label: "Synthetic Index Fund",
    });
    const unhedged = facts("fund-unhedged", {
      isin: isin("ZZSYNTH0006"),
      shareClass: "unhedged",
      label: "Synthetic Index Fund",
    });
    const result = set([hedged, unhedged]);
    expect(result.candidates).toEqual([]);
    expect(result.separated).toEqual([]);
    expect(result.hints[0]!.conflicts).toEqual(["isin-differs", "share-class-differs"]);
  });

  test("a name never changes a candidate: renaming either side leaves the evidence as it was", () => {
    const before = set([listing, brokerB]);
    const after = set([
      { ...listing, label: "Completely different" },
      { ...brokerB, label: "Another wording" },
    ]);
    expect(after.candidates).toEqual(before.candidates);
    expect(after.hints).toEqual([]);
  });

  test("normalisation is width, case and whitespace only", () => {
    expect(normalisedDisplayName("  ＡＢＣ　 Fund ")).toBe("abc fund");
    expect(normalisedDisplayName("ABC Fund (A)")).not.toBe(normalisedDisplayName("ABC Fund (B)"));
  });
});

describe("only a stored mapping adopts; only a stored rejection rejects", () => {
  test("an accepted listed_as relation alone does not adopt", () => {
    const accepted = new Map([
      [listedAsKey(listing.instrumentId, brokerB.identifierId), "accepted" as const],
    ]);
    expect(set([listing, brokerB], accepted).candidates[0]!.status).toBe("proposed");
  });

  test("a mapping to the anchor's instrument is adoption", () => {
    const assigned = {
      ...brokerB,
      instrumentId: listing.instrumentId,
      mappingMethod: "manual" as const,
    };
    const result = set([listing, assigned]);
    expect(result.candidates[0]!.status).toBe("adopted");
    expect(identifierResolutions([listing, assigned], result)).toEqual([
      {
        identifierId: "a-listing",
        state: "resolved-by-decision",
        sharedWith: ["b-code"],
        candidateIds: ["instrument-candidate:a-listing|b-code"],
      },
      {
        identifierId: "b-code",
        state: "resolved-by-decision",
        sharedWith: ["a-listing"],
        candidateIds: ["instrument-candidate:a-listing|b-code"],
      },
    ]);
  });

  test("a rejection in either orientation keeps the pair apart; a released one reopens it", () => {
    for (const key of [
      listedAsKey(listing.instrumentId, brokerB.identifierId),
      listedAsKey(brokerB.instrumentId, listing.identifierId),
    ]) {
      const result = set([listing, brokerB], new Map([[key, "rejected" as const]]));
      expect(result.candidates[0]!.status).toBe("rejected");
      expect(identifierResolutions([listing, brokerB], result).map((row) => row.state)).toEqual([
        "kept-separate",
        "kept-separate",
      ]);
    }
    const released = new Map([
      [listedAsKey(listing.instrumentId, brokerB.identifierId), "released" as const],
    ]);
    expect(set([listing, brokerB], released).candidates[0]!.status).toBe("proposed");
  });

  test("an open candidate is unresolved; two identifiers sharing an instrument without a manual mapping are not read as resolved", () => {
    const open = set([listing, brokerB]);
    expect(identifierResolutions([listing, brokerB], open).map((row) => row.state)).toEqual([
      "unresolved-candidates",
      "unresolved-candidates",
    ]);
    const unexplained = { ...brokerB, instrumentId: listing.instrumentId };
    const shared = set([listing, unexplained]);
    expect(identifierResolutions([listing, unexplained], shared).map((row) => row.state)).toEqual([
      "shared-without-decision",
      "shared-without-decision",
    ]);
  });
});

describe("determinism and bounds", () => {
  test("input order does not change the answer", () => {
    const code = isin("ZZSYNTH0007");
    const rows = [
      listing,
      brokerB,
      facts("b-bare", { countryCode: "ZZ", securityCode: "9999" }),
      facts("i1", { isin: code }),
      facts("i2", { isin: code, sources: ["synthetic-broker-b"] }),
      facts("n1", { label: "Same" }),
      facts("n2", { label: "same" }),
    ];
    const expected = set(rows);
    expect(set([...rows].reverse())).toEqual(expected);
    expect(set([rows[3]!, rows[0]!, rows[6]!, rows[1]!, rows[5]!, rows[2]!, rows[4]!])).toEqual(
      expected,
    );
  });

  test("money and reward identifiers are not paired", () => {
    const result = set([
      facts("m1", { kind: "money", countryCode: "ZZ", securityCode: "X", label: "Same" }),
      facts("m2", { kind: "money", countryCode: "ZZ", securityCode: "X", label: "Same" }),
      facts("r1", { kind: "reward", label: "Same" }),
    ]);
    expect(result).toEqual({
      policy: INSTRUMENT_CANDIDATE_POLICY,
      candidates: [],
      separated: [],
      hints: [],
    });
  });

  test("a store with more pairs than the bound is refused, not cut", () => {
    const group = Array.from({ length: 101 }, (_, index) =>
      facts(`g${String(index).padStart(3, "0")}`, { countryCode: "ZZ", securityCode: "SAME" }),
    );
    expect((101 * 100) / 2).toBeGreaterThan(CANDIDATE_PAIR_LIMIT);
    expect(instrumentCandidates(group)).toEqual({ ok: false, error: "candidate_limit_exceeded" });
    expect(instrumentCandidates([listing, listing])).toEqual({
      ok: false,
      error: "duplicate_identifier",
    });
  });
});

describe("a decision binds every identifier that shares the decided instrument", () => {
  // One code listed on two markets and seen bare at a venue no rule maps.
  const tokyo = facts("a-tokyo", {
    namespace: "mic-symbol",
    scope: "XSYN",
    value: "SYNC001",
    countryCode: "ZZ",
    securityCode: "SYNC001",
    mic: "XSYN",
    currencies: ["JPY"],
  });
  const nagoya = { ...tokyo, identifierId: "b-nagoya", instrumentId: "instrument-b-nagoya" };
  const nagoyaListing = { ...nagoya, scope: "XSYM", mic: "XSYM" };
  const venue = facts("c-venue", {
    countryCode: "ZZ",
    securityCode: "SYNC001",
    currencies: ["JPY"],
  });

  test("S1: once a person maps the bare code onto one listing, the other listing is separated from it", () => {
    const open = set([tokyo, nagoyaListing, venue]);
    expect(
      open.candidates.map((row) => [row.anchorIdentifierId, row.subjectIdentifierId, row.status]),
    ).toEqual([
      ["a-tokyo", "c-venue", "proposed"],
      ["b-nagoya", "c-venue", "proposed"],
    ]);

    const decided = {
      ...venue,
      instrumentId: tokyo.instrumentId,
      mappingMethod: "manual" as const,
    };
    const after = set([tokyo, nagoyaListing, decided]);
    expect(after.candidates).toEqual([
      expect.objectContaining({
        candidateId: "instrument-candidate:a-tokyo|c-venue",
        anchorIdentifierId: "a-tokyo",
        subjectIdentifierId: "c-venue",
        status: "adopted",
        hold: null,
      }),
    ]);
    expect(after.separated).toEqual([
      {
        pairId: "instrument-pair:a-tokyo|b-nagoya",
        identifierIds: ["a-tokyo", "b-nagoya"],
        evidence: ["security-code-equal"],
        conflicts: ["market-differs"],
        via: [],
        sharedInstrument: false,
      },
      {
        // The bare code states no market itself; the listing it now shares
        // an instrument with does, and that market differs.
        pairId: "instrument-pair:b-nagoya|c-venue",
        identifierIds: ["b-nagoya", "c-venue"],
        evidence: ["security-code-equal"],
        conflicts: ["market-differs"],
        via: ["a-tokyo"],
        sharedInstrument: false,
      },
    ]);
    expect(
      identifierResolutions([tokyo, nagoyaListing, decided], after).map((row) => row.state),
    ).toEqual(["resolved-by-decision", "no-candidate", "resolved-by-decision"]);
  });

  test("S2: an identifier a person already mapped is the anchor, whatever the ids", () => {
    // Two id spellings, so the decided identifier sorts after and before the new one.
    for (const [decidedId, freshId] of [
      ["z-decided", "c-fresh"],
      ["c-decided", "z-fresh"],
    ] as const) {
      const listingS2 = facts("a-listing", {
        namespace: "mic-symbol",
        scope: "XSYN",
        value: "SYNC002",
        countryCode: "ZZ",
        securityCode: "SYNC002",
        mic: "XSYN",
      });
      const decided = facts(decidedId, {
        instrumentId: listingS2.instrumentId,
        mappingMethod: "manual",
        sources: ["synthetic-broker-b"],
        countryCode: "ZZ",
        securityCode: "SYNC002",
      });
      const fresh = facts(freshId, {
        sources: ["synthetic-broker-c"],
        countryCode: "ZZ",
        securityCode: "SYNC002",
      });
      const result = set([listingS2, decided, fresh]);
      const between = result.candidates.find(
        (row) =>
          row.candidateId === `instrument-candidate:${[decidedId, freshId].sort().join("|")}`,
      );
      expect(between).toMatchObject({
        anchorIdentifierId: decidedId,
        subjectIdentifierId: freshId,
        status: "proposed",
        hold: null,
      });
      expect(
        result.candidates.find(
          (row) => row.candidateId === `instrument-candidate:a-listing|${freshId}`,
        ),
      ).toMatchObject({ anchorIdentifierId: "a-listing", subjectIdentifierId: freshId });
    }
  });

  test("a candidate whose subject is already decided or shared names why no command fits", () => {
    const left = facts("p-left", {
      countryCode: "ZZ",
      securityCode: "SYNC003",
      mappingMethod: "manual",
    });
    const right = facts("q-right", {
      countryCode: "ZZ",
      securityCode: "SYNC003",
      mappingMethod: "manual",
      sources: ["synthetic-broker-b"],
    });
    expect(set([left, right]).candidates[0]).toMatchObject({
      anchorIdentifierId: "p-left",
      subjectIdentifierId: "q-right",
      status: "proposed",
      hold: "subject-decided-elsewhere",
    });

    // The subject shares a rule instrument with another identifier: moving
    // it would split that instrument, so no command is named either.
    const listed = facts("r-listed", {
      mic: "XSYN",
      countryCode: "ZZ",
      securityCode: "SYNC004",
      mappingMethod: "manual",
    });
    const sharedA = facts("s-shared", { countryCode: "ZZ", securityCode: "SYNC004" });
    const sharedB = facts("t-shared", {
      countryCode: "ZZ",
      securityCode: "SYNC004",
      instrumentId: sharedA.instrumentId,
      sources: ["synthetic-broker-b"],
    });
    const shared = set([listed, sharedA, sharedB]);
    expect(
      shared.candidates.map((row) => [
        row.anchorIdentifierId,
        row.subjectIdentifierId,
        row.status,
        row.hold,
      ]),
    ).toEqual([
      ["r-listed", "s-shared", "proposed", "subject-shares-instrument"],
      ["r-listed", "t-shared", "proposed", "subject-shares-instrument"],
      ["s-shared", "t-shared", "adopted", null],
    ]);
  });
});

describe("a fact neither side states is still named", () => {
  test("ISIN, share class and product class are gaps when both sides lack them", () => {
    const gaps = compareIdentifierFacts(
      facts("x", { countryCode: "ZZ", securityCode: "S1", mic: "XSYN", currencies: ["JPY"] }),
      facts("y", { countryCode: "ZZ", securityCode: "S1", mic: "XSYN", currencies: ["JPY"] }),
    ).gaps;
    expect(gaps).toEqual([
      "isin-unconfirmed",
      "share-class-unconfirmed",
      "product-class-unconfirmed",
    ]);
  });
});

describe("hint bound", () => {
  test("more name hints than the bound are refused, not cut", () => {
    const named = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        facts(`h${String(index).padStart(3, "0")}`, { label: "Synthetic same name" }),
      );
    // 45 identifiers make 990 hints; 46 make 1,035.
    expect(instrumentCandidates(named(45))).toMatchObject({ ok: true });
    expect((46 * 45) / 2).toBeGreaterThan(CANDIDATE_HINT_LIMIT);
    expect(instrumentCandidates(named(46))).toEqual({
      ok: false,
      error: "candidate_limit_exceeded",
    });
  });
});
