// Cross-identifier instrument candidates (src/instrument-candidates.ts,
// ADR 0048). Every identifier, code, name and ISIN here is synthetic; the
// "ISINs" are invented strings of the ISIN shape.
import { describe, expect, test } from "bun:test";
import {
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
        gaps: [],
        crossSource: true,
        status: "proposed",
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
      gaps: ["market-unconfirmed"],
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
      gaps: [],
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
