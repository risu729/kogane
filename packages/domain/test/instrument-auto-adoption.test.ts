// Rule `instrument-auto-v1` (src/instrument-auto-adoption.ts, ADR 0055
// amendment 2026-11-08). Codes, ids and names are synthetic.
import { describe, expect, test } from "bun:test";
import {
  INSTRUMENT_AUTO_ADOPTION_ACTOR,
  INSTRUMENT_AUTO_ADOPTION_POLICY,
  instrumentAutoAdoptions,
  JAPANESE_SECURITIES_CODE,
} from "../src/instrument-auto-adoption.ts";
import {
  identifierResolutions,
  instrumentCandidates,
  listedAsKey,
  type InstrumentIdentifierFacts,
} from "../src/instrument-candidates.ts";
import type { StoredRelationStatus } from "../src/decisions.ts";

/** SBI's listing identifier for `code` on `mic`. */
function listing(code: string, overrides: Partial<InstrumentIdentifierFacts> = {}) {
  return identifier(`ii-listing-${code}`, {
    namespace: "mic-symbol",
    scope: "XTKS",
    value: code,
    mic: "XTKS",
    securityCode: code,
    ...overrides,
  });
}

/** SBI's bare domestic code identifier for `code`. */
function bare(code: string, overrides: Partial<InstrumentIdentifierFacts> = {}) {
  return identifier(`ii-bare-${code}`, {
    namespace: "sbi-security-code",
    scope: "JP",
    value: code,
    securityCode: code,
    ...overrides,
  });
}

function identifier(
  id: string,
  overrides: Partial<InstrumentIdentifierFacts>,
): InstrumentIdentifierFacts {
  return {
    identifierId: id,
    instrumentId: `instrument-${id}`,
    mappingMethod: "rule",
    kind: "security",
    namespace: "sbi-security-code",
    scope: "JP",
    value: "0000",
    sources: ["sbi-securities"],
    isin: null,
    countryCode: "JP",
    securityCode: null,
    mic: null,
    ric: null,
    shareClass: null,
    productClass: null,
    currencies: ["JPY"],
    currencyUnconfirmed: false,
    label: `Synthetic ${id}`,
    ...overrides,
  };
}

function adoptions(
  rows: readonly InstrumentIdentifierFacts[],
  listedAs: ReadonlyMap<string, StoredRelationStatus> = new Map(),
) {
  const result = instrumentCandidates(rows, listedAs);
  if (!result.ok) throw new Error(result.error);
  return instrumentAutoAdoptions(rows, result.set, listedAs);
}

describe("rule instrument-auto-v1", () => {
  test("names itself and its actor", () => {
    expect(INSTRUMENT_AUTO_ADOPTION_POLICY).toBe("instrument-auto-v1");
    expect(INSTRUMENT_AUTO_ADOPTION_ACTOR).toBe("rule:instrument-auto-v1");
  });

  test("adopts SBI's bare domestic code onto SBI's listing of the same code", () => {
    const rows = [listing("7203"), bare("7203"), listing("1306"), bare("1306")];
    expect(adoptions(rows)).toEqual([
      {
        candidateId: "instrument-candidate:ii-bare-1306|ii-listing-1306",
        anchorIdentifierId: "ii-listing-1306",
        subjectIdentifierId: "ii-bare-1306",
        targetInstrumentId: "instrument-ii-listing-1306",
        securityCode: "1306",
        mic: "XTKS",
      },
      {
        candidateId: "instrument-candidate:ii-bare-7203|ii-listing-7203",
        anchorIdentifierId: "ii-listing-7203",
        subjectIdentifierId: "ii-bare-7203",
        targetInstrumentId: "instrument-ii-listing-7203",
        securityCode: "7203",
        mic: "XTKS",
      },
    ]);
  });

  test("every Japanese MIC of the SBI rule, and an alphanumeric code", () => {
    for (const mic of ["XNGO", "XFKA", "XSAP"])
      expect(adoptions([listing("130A", { scope: mic, mic }), bare("130A")])).toHaveLength(1);
    expect(JAPANESE_SECURITIES_CODE.test("130A")).toBe(true);
    for (const code of ["89311199", "130", "A130", "1306 ", "13a6"])
      expect(JAPANESE_SECURITIES_CODE.test(code)).toBe(false);
  });

  test("a code that is not a Japanese securities code is left to a person", () => {
    expect(adoptions([listing("89311199"), bare("89311199")])).toEqual([]);
  });

  test("another shape is left to a person: foreign, other namespaces, other sources", () => {
    // A foreign bare code against a listing: country differs, so no pair at all.
    expect(adoptions([listing("7203"), bare("7203", { scope: "US", countryCode: "US" })])).toEqual(
      [],
    );
    // A listing without a Japanese MIC.
    expect(adoptions([listing("7203", { scope: "XSYN", mic: "XSYN" }), bare("7203")])).toEqual([]);
    // Two brokers: the same code at a second source.
    expect(adoptions([listing("7203"), bare("7203", { sources: ["synthetic-broker"] })])).toEqual(
      [],
    );
    expect(
      adoptions([
        listing("7203", { sources: ["sbi-securities", "synthetic-broker"] }),
        bare("7203"),
      ]),
    ).toEqual([]);
    // Another provider's code namespace.
    expect(adoptions([listing("7203"), bare("7203", { namespace: "synthetic-code" })])).toEqual([]);
    // A product, not a security.
    expect(
      adoptions([listing("7203", { kind: "product" }), bare("7203", { kind: "product" })]),
    ).toEqual([]);
  });

  test("an ISIN, a RIC or a share class on either side is left to a person", () => {
    expect(adoptions([listing("7203", { isin: "JPSYN0000000" }), bare("7203")])).toEqual([]);
    expect(adoptions([listing("7203"), bare("7203", { ric: "7203.T" })])).toEqual([]);
    expect(adoptions([listing("7203", { shareClass: "A" }), bare("7203")])).toEqual([]);
    expect(adoptions([listing("7203"), bare("7203", { productClass: "ETF" })])).toEqual([]);
  });

  test("a currency other than JPY, several, none or unconfirmed is left to a person", () => {
    expect(adoptions([listing("7203"), bare("7203", { currencyUnconfirmed: true })])).toEqual([]);
    expect(adoptions([listing("7203", { currencies: [] }), bare("7203")])).toEqual([]);
    expect(
      adoptions([listing("7203", { currencies: ["USD"] }), bare("7203", { currencies: ["USD"] })]),
    ).toEqual([]);
    expect(adoptions([listing("7203"), bare("7203", { currencies: ["JPY", "USD"] })])).toEqual([]);
  });

  test("a person's decision on either side stops the rule", () => {
    // The subject was mapped by hand elsewhere: held, no adoption.
    expect(adoptions([listing("7203"), bare("7203", { mappingMethod: "manual" })])).toEqual([]);
    // The anchor was mapped by hand (onto its own instrument, say).
    expect(adoptions([listing("7203", { mappingMethod: "manual" }), bare("7203")])).toEqual([]);
    // Someone else is mapped by hand onto the anchor's instrument.
    const other = identifier("ii-other", {
      namespace: "synthetic-code",
      scope: "ZZ",
      value: "x",
      countryCode: null,
      instrumentId: "instrument-ii-listing-7203",
      mappingMethod: "manual",
    });
    expect(adoptions([listing("7203"), bare("7203"), other])).toEqual([]);
    // Any listed_as relation on the pair, whatever its status.
    for (const status of ["proposed", "accepted", "rejected", "released"] as const) {
      const keys = [
        listedAsKey("instrument-ii-listing-7203", "ii-bare-7203"),
        listedAsKey("instrument-ii-bare-7203", "ii-listing-7203"),
      ];
      for (const key of keys)
        expect(adoptions([listing("7203"), bare("7203")], new Map([[key, status]]))).toEqual([]);
    }
    // A listed_as relation joining either side to a third instrument.
    for (const key of [
      listedAsKey("instrument-third", "ii-bare-7203"),
      listedAsKey("instrument-ii-listing-7203", "ii-third"),
    ])
      expect(
        adoptions([listing("7203"), bare("7203")], new Map([[key, "rejected" as const]])),
      ).toEqual([]);
    // A relation elsewhere does not stop it.
    expect(
      adoptions(
        [listing("7203"), bare("7203")],
        new Map([[listedAsKey("instrument-third", "ii-third"), "accepted" as const]]),
      ),
    ).toHaveLength(1);
  });

  test("an ambiguous subject is left to a person: two listings of one code", () => {
    // XTKS and XNGO both list the code: two candidates for the bare code.
    const rows = [
      listing("7203"),
      listing("7203", { identifierId: "ii-listing-7203-ngo", scope: "XNGO", mic: "XNGO" }),
      bare("7203"),
    ];
    expect(adoptions(rows)).toEqual([]);
  });

  test("an adopted pair is not adopted again and reads resolved-by-rule", () => {
    const anchor = listing("7203");
    const subject = bare("7203", {
      instrumentId: anchor.instrumentId,
      adoptedByRule: true,
    });
    const rows = [anchor, subject];
    expect(adoptions(rows)).toEqual([]);
    const result = instrumentCandidates(rows);
    if (!result.ok) throw new Error(result.error);
    expect(result.set.candidates.map((candidate) => candidate.status)).toEqual(["adopted"]);
    expect(identifierResolutions(rows, result.set).map((row) => row.state)).toEqual([
      "resolved-by-rule",
      "resolved-by-rule",
    ]);
  });

  test("a person's mapping among the sharers still reads resolved-by-decision", () => {
    const anchor = listing("7203");
    const rows = [
      anchor,
      bare("7203", { instrumentId: anchor.instrumentId, adoptedByRule: true }),
      identifier("ii-other", {
        namespace: "synthetic-code",
        scope: "ZZ",
        value: "x",
        countryCode: null,
        instrumentId: anchor.instrumentId,
        mappingMethod: "manual",
      }),
    ];
    const result = instrumentCandidates(rows);
    if (!result.ok) throw new Error(result.error);
    expect(new Set(identifierResolutions(rows, result.set).map((row) => row.state))).toEqual(
      new Set(["resolved-by-decision"]),
    );
  });

  test("a subject a person moved back by hand is not re-adopted", () => {
    // Undoing an adoption is an identity.assign onto the bare code's own
    // instrument: a manual mapping, which the rule never touches.
    const rows = [listing("7203"), bare("7203", { mappingMethod: "manual" })];
    const result = instrumentCandidates(rows);
    if (!result.ok) throw new Error(result.error);
    expect(result.set.candidates[0]!.status).toBe("proposed");
    expect(instrumentAutoAdoptions(rows, result.set, new Map())).toEqual([]);
  });
});
