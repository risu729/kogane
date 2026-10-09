// Cross-identifier instrument resolution (src/query/instrument-resolution.ts,
// ADR 0055) over CORE migrations 0017+ on the minimal Layer A stub. The
// identifiers are written by the production identity writer (`identifyParse`)
// from synthetic observations: SBI Securities rows go through the deployed SBI
// rules, and a second broker, `synthetic-broker-b`, through a test policy
// that states a code and a country the way a provider rule would. Decisions
// go through the change lifecycle (plan, approve, commit) with the same
// identity writer the Processor commits with. Every code, name and account
// here is invented; domestic codes are 7-character `SYN…` strings, a shape no
// exchange assigns.
import { beforeAll, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import {
  INSTRUMENT_FACTS_ROW_BOUND,
  INSTRUMENT_FACTS_SQL,
  INSTRUMENT_HISTORY_SQL,
  LISTED_AS_ROW_BOUND,
  LISTED_AS_SQL,
} from "../../read-model/src/instrument-resolution.ts";
import { validPayload } from "../src/command/contract.ts";
import {
  InstrumentResolutionLimitError,
  queryInstrumentHistory,
  queryInstrumentResolution,
} from "../src/query/instrument-resolution.ts";
import {
  AGENT,
  BROKER_B,
  candidateOf,
  decide,
  ids,
  OPERATOR,
  type Position,
  stateOf,
  stubDatabase,
  type Trade,
  World,
  world,
} from "./instrument-resolution-world.ts";

beforeAll(() => {
  stubDatabase().close();
}, 60_000);

describe("candidates from the identifiers the identity rules stored", () => {
  test("evidence-backed pairs are proposed, conflicting ones separated, equal names only hinted", async () => {
    const w = await world();
    const id = ids(w);
    const before = w.snapshot();
    const result = await queryInstrumentResolution(w.sql);
    expect(w.snapshot()).toBe(before);
    expect(result.policy).toBe("instrument-candidates-v1");

    // The same JP code on XTKS and on a venue the rule does not map: one
    // source, a proposal with the market unconfirmed.
    expect(candidateOf(result, id.listing9001, id.venue9001)).toMatchObject({
      anchorIdentifierId: id.listing9001,
      subjectIdentifierId: id.venue9001,
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
    // Across brokers: the listing anchors broker B's code.
    const cross = candidateOf(result, id.listing9001, id.broker9001);
    expect(cross).toMatchObject({
      anchorIdentifierId: id.listing9001,
      subjectIdentifierId: id.broker9001,
      agreements: ["kind-agrees", "country-agrees", "currency-agrees"],
      crossSource: true,
      status: "proposed",
    });
    // The foreign RIC and the RIC-less trade code: USD on both (the trade's
    // trade unit, not its JPY settlement unit).
    expect(candidateOf(result, id.ric, id.foreignCode)).toMatchObject({
      anchorIdentifierId: id.ric,
      evidence: ["security-code-equal"],
      agreements: ["kind-agrees", "country-agrees", "currency-agrees"],
      status: "proposed",
    });

    // Two listings, and two currencies, are kept apart.
    const separated = new Map(
      result.separated.map((pair) => [pair.identifierIds.join("|"), pair.conflicts]),
    );
    expect(separated.get([id.tokyo9002, id.nagoya9002].sort().join("|"))).toEqual([
      "market-differs",
    ]);
    expect(separated.get([id.listing9003, id.broker9003].sort().join("|"))).toEqual([
      "currency-differs",
    ]);
    for (const candidate of result.candidates) {
      const pair = [candidate.anchorIdentifierId, candidate.subjectIdentifierId];
      expect(pair.includes(id.nagoya9002) && pair.includes(id.tokyo9002)).toBe(false);
      expect(pair.includes(id.broker9003)).toBe(false);
    }

    // One display name, two codes: a hint, never a candidate.
    expect(result.hints).toEqual([
      {
        pairId: `instrument-pair:${[id.shared9004, id.broker9005].sort().join("|")}`,
        identifierIds: [id.shared9004, id.broker9005].sort() as [string, string],
        reason: "same-display-name",
        conflicts: [],
      },
    ]);
    expect(stateOf(result, id.broker9005)).toBe("no-candidate");
    expect(stateOf(result, id.shared9004)).toBe("no-candidate");

    // Nothing is adopted: every identifier still maps to its own instrument.
    expect(result.candidates.every((candidate) => candidate.status === "proposed")).toBe(true);
    expect(result.identifiers.every((row) => row.sharedWith.length === 0)).toBe(true);
    expect(stateOf(result, id.listing9001)).toBe("unresolved-candidates");
    expect(stateOf(result, id.nagoya9002)).toBe("no-candidate");
    expect(result.summary).toMatchObject({
      proposed: result.candidates.length,
      adopted: 0,
      rejected: 0,
    });

    // The provider's market wording is shown, never compared.
    expect(result.identifiers.find((row) => row.identifierId === id.venue9001)).toMatchObject({
      providerMarket: "SYNTHETIC-VENUE",
      mappingMethod: "rule",
      mappingRevision: 1,
      sources: ["sbi-securities"],
      currencies: ["JPY"],
    });
  });

  test("the commands a candidate names are valid change payloads once a person writes a reason", async () => {
    const w = await world();
    const result = await queryInstrumentResolution(w.sql);
    for (const candidate of result.candidates) {
      const commands = candidate.commands!;
      const adopt = commands.adopt!;
      expect(validPayload(adopt.kind, { ...adopt.payload, reason: "same security" })).toBe(true);
      expect(
        validPayload(commands.keepApart.kind, {
          ...commands.keepApart.payload,
          reason: "different security",
        }),
      ).toBe(true);
      // The adopted target is the anchor's instrument; the subject is re-mapped.
      expect(adopt.payload.referenceId).toBe(candidate.subjectIdentifierId);
    }
  });
});

describe("only a person's decision adopts or rejects, and the history keeps every revision", () => {
  test("an agent can plan an adoption but never approve or commit it", async () => {
    const w = await world();
    const id = ids(w);
    const candidate = candidateOf(
      await queryInstrumentResolution(w.sql),
      id.listing9001,
      id.broker9001,
    );
    const before = w.db.query("SELECT * FROM instrument_mappings ORDER BY id").all();
    const outcome = await decide(
      w,
      AGENT,
      "identity.assign",
      { ...candidate.commands!.adopt!.payload, reason: "agent proposal" },
      "op-agent-adopt",
    );
    expect(outcome.stage).toBe("approve");
    expect(outcome.result).toMatchObject({ ok: false, error: "approval_required" });
    expect(w.db.query("SELECT * FROM instrument_mappings ORDER BY id").all()).toEqual(before);
    expect(
      candidateOf(await queryInstrumentResolution(w.sql), id.listing9001, id.broker9001).status,
    ).toBe("proposed");
  });

  test("a person's identity.assign adopts the candidate as a new manual revision", async () => {
    const w = await world();
    const id = ids(w);
    const candidate = candidateOf(
      await queryInstrumentResolution(w.sql),
      id.listing9001,
      id.broker9001,
    );
    const outcome = await decide(
      w,
      OPERATOR,
      "identity.assign",
      { ...candidate.commands!.adopt!.payload, reason: "same security, checked" },
      "op-adopt",
    );
    expect(outcome.result.ok).toBe(true);

    const after = await queryInstrumentResolution(w.sql);
    const adopted = candidateOf(after, id.listing9001, id.broker9001);
    expect(adopted.status).toBe("adopted");
    expect(adopted.commands).toBeNull();
    expect(after.identifiers.find((row) => row.identifierId === id.broker9001)).toMatchObject({
      mappingMethod: "manual",
      mappingRevision: 2,
      sharedWith: [id.listing9001],
    });
    // Broker B's code shares its code with the venue identifier, and that
    // candidate is still open, so broker B's code is still unresolved: one
    // decision does not resolve a third identifier transitively.
    expect(stateOf(after, id.broker9001)).toBe("unresolved-candidates");
    expect(candidateOf(after, id.listing9001, id.venue9001).status).toBe("proposed");
    // The decided broker code anchors that open candidate, so adopting it
    // moves the venue code, never the decided one.
    expect(candidateOf(after, id.broker9001, id.venue9001)).toMatchObject({
      anchorIdentifierId: id.broker9001,
      subjectIdentifierId: id.venue9001,
      status: "proposed",
      hold: null,
    });

    const [history] = await queryInstrumentHistory(w.sql, [id.broker9001]);
    expect(
      history!.entries.map((entry) => [
        entry.entry,
        entry.revision,
        entry.method,
        entry.decisionKind,
      ]),
    ).toEqual([
      ["mapping", 1, "rule", null],
      ["decision", 2, "manual", "assign"],
      ["mapping", 2, "manual", null],
    ]);
    // The rule revision is still there, pointing where it pointed.
    expect(history!.entries[0]!.instrumentId).not.toBe(history!.entries[2]!.instrumentId);
  });

  test("a person's listed_as rejection keeps the pair apart and is in the history", async () => {
    const w = await world();
    const id = ids(w);
    const candidate = candidateOf(await queryInstrumentResolution(w.sql), id.ric, id.foreignCode);
    const outcome = await decide(
      w,
      OPERATOR,
      "relation.reject",
      { ...candidate.commands!.keepApart.payload, reason: "different listing, checked" },
      "op-keep-apart",
    );
    expect(outcome.result.ok).toBe(true);
    const after = await queryInstrumentResolution(w.sql);
    expect(candidateOf(after, id.ric, id.foreignCode).status).toBe("rejected");
    expect(stateOf(after, id.ric)).toBe("kept-separate");
    expect(stateOf(after, id.foreignCode)).toBe("kept-separate");
    // No mapping moved.
    expect(after.identifiers.find((row) => row.identifierId === id.foreignCode)).toMatchObject({
      mappingMethod: "rule",
      mappingRevision: 1,
      sharedWith: [],
    });
    const [history] = await queryInstrumentHistory(w.sql, [id.foreignCode]);
    expect(
      history!.entries.map((entry) => [entry.entry, entry.relationStatus, entry.decisionKind]),
    ).toEqual([
      ["mapping", null, null],
      ["relation", "rejected", "reject"],
    ]);
  });

  test("the history read is bounded", async () => {
    const w = await world();
    await expect(
      queryInstrumentHistory(
        w.sql,
        Array.from({ length: 101 }, (_, index) => `ii_${index}`),
      ),
    ).rejects.toBeInstanceOf(InstrumentResolutionLimitError);
    expect(await queryInstrumentHistory(w.sql, [])).toEqual([]);
  });
});

describe("a decision binds every identifier on the decided instrument", () => {
  const domestic = "sbi-securities:domestic";
  /** A domestic trade on a venue the SBI rule does not map: `sbi-security-code/JP/<code>`. */
  const venueTrade = (code: string, name: string): Trade => ({
    account: domestic,
    currency: "JPY",
    extra: {
      issueCode: code,
      issueName: name,
      marketLabel: "SYNTHETIC-VENUE",
      accountLabel: "synthetic",
    },
  });

  test("S1: a code a person mapped onto one listing is separated from the other listing", async () => {
    const w = new World();
    await w.capture(
      "sbi-securities",
      [
        {
          account: domestic,
          code: "SYN9102",
          name: "Synthetic Dual",
          market: "TKY",
          currency: "JPY",
        },
        {
          account: domestic,
          code: "SYN9102",
          name: "Synthetic Dual",
          market: "NGY",
          currency: "JPY",
        },
      ],
      [venueTrade("SYN9102", "Synthetic Dual")],
    );
    const tokyo = w.identifier("mic-symbol", "XTKS", "SYN9102");
    const nagoya = w.identifier("mic-symbol", "XNGO", "SYN9102");
    const venue = w.identifier("sbi-security-code", "JP", "SYN9102");

    const open = await queryInstrumentResolution(w.sql);
    const toTokyo = candidateOf(open, tokyo, venue);
    expect(toTokyo).toMatchObject({ anchorIdentifierId: tokyo, subjectIdentifierId: venue });
    expect(candidateOf(open, nagoya, venue)).toMatchObject({
      anchorIdentifierId: nagoya,
      subjectIdentifierId: venue,
    });
    const outcome = await decide(
      w,
      OPERATOR,
      "identity.assign",
      { ...toTokyo.commands!.adopt!.payload, reason: "the venue trade is the Tokyo listing" },
      "op-s1-adopt",
    );
    expect(outcome.result.ok).toBe(true);

    const after = await queryInstrumentResolution(w.sql);
    expect(candidateOf(after, tokyo, venue)).toMatchObject({ status: "adopted", commands: null });
    // No command now offers to move the decided code onto the Nagoya listing.
    expect(
      after.candidates.some(
        (row) =>
          [row.anchorIdentifierId, row.subjectIdentifierId].includes(nagoya) &&
          [row.anchorIdentifierId, row.subjectIdentifierId].includes(venue),
      ),
    ).toBe(false);
    expect(after.separated).toContainEqual({
      pairId: `instrument-pair:${[nagoya, venue].sort().join("|")}`,
      identifierIds: [nagoya, venue].sort() as [string, string],
      evidence: ["security-code-equal"],
      conflicts: ["market-differs"],
      via: [tokyo],
      sharedInstrument: false,
    });
    expect(stateOf(after, venue)).toBe("resolved-by-decision");
    expect(stateOf(after, nagoya)).toBe("no-candidate");
  });

  test("S2: the identifier a person mapped is the anchor even when a new code has a lower id", async () => {
    const w = new World();
    await w.capture("sbi-securities", [
      { account: domestic, code: "SYN9101", name: "Synthetic Tie", market: "TKY", currency: "JPY" },
    ]);
    await w.capture(BROKER_B, [
      {
        account: "synthetic-broker-b:custody",
        code: "SYN9101",
        name: "Synthetic Tie",
        currency: "JPY",
        extra: { country: "JP" },
      },
    ]);
    const listing = w.identifier("mic-symbol", "XTKS", "SYN9101");
    const broker = w.identifier("synthetic-broker-b-code", "JP", "SYN9101");
    const adopt = candidateOf(await queryInstrumentResolution(w.sql), listing, broker);
    expect(adopt).toMatchObject({ anchorIdentifierId: listing, subjectIdentifierId: broker });
    expect(
      (
        await decide(
          w,
          OPERATOR,
          "identity.assign",
          { ...adopt.commands!.adopt!.payload, reason: "same security, checked" },
          "op-s2-adopt",
        )
      ).result.ok,
    ).toBe(true);

    // A later trade on an unmapped venue adds a bare code whose hashed id
    // sorts before the decided broker code: the tie the anchor rule once broke by id.
    await w.capture("sbi-securities", [], [venueTrade("SYN9101", "Synthetic Tie")]);
    const venue = w.identifier("sbi-security-code", "JP", "SYN9101");
    expect(venue < broker).toBe(true);

    const after = await queryInstrumentResolution(w.sql);
    const listingInstrument = after.identifiers.find(
      (row) => row.identifierId === listing,
    )!.instrumentId;
    const tie = candidateOf(after, broker, venue);
    expect(tie).toMatchObject({
      anchorIdentifierId: broker,
      subjectIdentifierId: venue,
      status: "proposed",
      hold: null,
    });
    expect(tie.commands!.adopt!.payload).toEqual({
      subject: "instrument",
      referenceId: venue,
      targetId: listingInstrument,
    });
    expect(tie.commands!.keepApart.payload).toMatchObject({
      fromRef: `instrument:${listingInstrument}`,
      toRef: `identifier:${venue}`,
    });
    expect(candidateOf(after, listing, venue)).toMatchObject({
      anchorIdentifierId: listing,
      subjectIdentifierId: venue,
    });

    // Once a person maps the bare code somewhere else (here: onto its own
    // instrument), no candidate offers to move it again; keeping it apart is
    // still offered, so the candidate can be closed.
    const ownInstrument = after.identifiers.find((row) => row.identifierId === venue)!.instrumentId;
    expect(
      (
        await decide(
          w,
          OPERATOR,
          "identity.assign",
          {
            subject: "instrument",
            referenceId: venue,
            targetId: ownInstrument,
            reason: "kept on its own instrument, checked",
          },
          "op-s2-own",
        )
      ).result.ok,
    ).toBe(true);
    const held = await queryInstrumentResolution(w.sql);
    for (const other of [listing, broker]) {
      const candidate = candidateOf(held, other, venue);
      expect(candidate).toMatchObject({ status: "proposed", hold: "subject-decided-elsewhere" });
      expect(candidate.commands!.adopt).toBeNull();
      expect(
        validPayload(candidate.commands!.keepApart.kind, {
          ...candidate.commands!.keepApart.payload,
          reason: "different security, checked",
        }),
      ).toBe(true);
    }
    expect(held.summary.unresolved).toBe(3);

    // A person keeps the venue code apart from the listing's instrument. The
    // rejection names that instrument, so it closes the broker code's held
    // candidate too, and nothing is left unresolved.
    const closing = candidateOf(held, listing, venue).commands!.keepApart;
    expect(closing.payload).toMatchObject({
      fromRef: `instrument:${listingInstrument}`,
      toRef: `identifier:${venue}`,
    });
    expect(
      (
        await decide(
          w,
          OPERATOR,
          "relation.reject",
          { ...closing.payload, reason: "kept apart, checked" },
          "op-s2-keep-apart",
        )
      ).result.ok,
    ).toBe(true);
    const closed = await queryInstrumentResolution(w.sql);
    for (const other of [listing, broker])
      expect(candidateOf(closed, other, venue)).toMatchObject({
        status: "rejected",
        hold: null,
        commands: null,
      });
    expect(stateOf(closed, venue)).toBe("kept-separate");
    expect(stateOf(closed, listing)).toBe("resolved-by-decision");
    expect(stateOf(closed, broker)).toBe("resolved-by-decision");
    expect(closed.summary.unresolved).toBe(0);
  });
});

describe("currencies the observations state", () => {
  test("an unresolved trade currency is unconfirmed, never replaced by the settlement unit", async () => {
    const w = new World();
    await w.capture(
      "sbi-securities",
      [
        {
          account: "sbi-securities:foreign",
          code: "SYNVN01",
          name: "Synthetic Overseas",
          currency: "JPY",
          extra: {
            specificAccountCode: "SYNTHETIC",
            securities: { securitiesCode: "SYNVN01", ric: "SYNVN01.X", countryCode: "VN" },
          },
        },
      ],
      [
        {
          account: "sbi-securities:foreign",
          currency: "JPY",
          extra: {
            specificAccountCode: "SYNTHETIC",
            // Not in the explicit currency catalogue: the rule stores it unresolved.
            tradeCurrencyCode: "VND",
            settlementCurrencyCode: "JPY",
            securities: { securitiesCode: "SYNVN01", countryCode: "VN" },
          },
        },
      ],
    );
    const ric = w.identifier("ric", "", "SYNVN01.X");
    const code = w.identifier("sbi-security-code", "VN", "SYNVN01");
    const result = await queryInstrumentResolution(w.sql);
    expect(result.identifiers.find((row) => row.identifierId === code)).toMatchObject({
      currencies: [],
      currencyUnconfirmed: true,
    });
    expect(result.identifiers.find((row) => row.identifierId === ric)).toMatchObject({
      currencies: ["JPY"],
      currencyUnconfirmed: false,
    });
    const candidate = candidateOf(result, ric, code);
    expect(candidate.agreements).not.toContain("currency-agrees");
    expect(candidate.gaps).toContain("currency-unconfirmed");
  });

  test("a security use with no unit at all is unconfirmed, never left out", async () => {
    const w = new World();
    const foreign = {
      specificAccountCode: "SYNTHETIC",
      securities: { securitiesCode: "SYNNC01", ric: "SYNNC01.X", countryCode: "US" },
    };
    await w.capture(
      "sbi-securities",
      [
        {
          account: "sbi-securities:foreign",
          code: "SYNNC01",
          name: "Synthetic No Currency",
          currency: "USD",
          extra: foreign,
        },
        {
          // The provider row names no currency; the rule records no unit.
          account: "sbi-securities:foreign",
          code: "SYNNC01",
          name: "Synthetic No Currency",
          currency: null,
          extra: foreign,
        },
      ],
      [
        {
          account: "sbi-securities:foreign",
          currency: "JPY",
          extra: {
            specificAccountCode: "SYNTHETIC",
            tradeCurrencyCode: "USD",
            settlementCurrencyCode: "JPY",
            securities: { securitiesCode: "SYNNC01", countryCode: "US" },
          },
        },
      ],
    );
    const ric = w.identifier("ric", "", "SYNNC01.X");
    const code = w.identifier("sbi-security-code", "US", "SYNNC01");
    const result = await queryInstrumentResolution(w.sql);
    expect(result.identifiers.find((row) => row.identifierId === ric)).toMatchObject({
      currencies: ["USD"],
      currencyUnconfirmed: true,
    });
    const candidate = candidateOf(result, ric, code);
    expect(candidate.agreements).not.toContain("currency-agrees");
    expect(candidate.gaps).toContain("currency-unconfirmed");
  });

  test("an exchange product states its quote unit, not the coin it trades", async () => {
    const w = new World();
    await w.capture(
      "sbi-vc-trade",
      [],
      [
        {
          account: "sbi-vc-trade:main",
          currency: "JPY",
          extra: {
            productId: "SYNCOINJPY",
            _kogane: { currencyPair: { base: "SYNCOIN", quote: "JPY" } },
          },
        },
      ],
    );
    const product = w.identifier("provider-product", "sbi-vc-trade", "SYNCOINJPY");
    expect(
      (await queryInstrumentResolution(w.sql)).identifiers.find(
        (row) => row.identifierId === product,
      ),
    ).toMatchObject({ kind: "product", currencies: ["JPY"], currencyUnconfirmed: false });
  });
});

describe("only published identity observations are read", () => {
  test("an unpublished capture and a superseded parse contribute nothing", async () => {
    const w = new World();
    const position = (code: string): Position => ({
      account: "sbi-securities:domestic",
      code,
      name: "Synthetic Gate",
      market: "TKY",
      currency: "JPY",
    });
    const first = await w.capture("sbi-securities", [position("SYN9201")]);
    await w.capture("sbi-securities", [position("SYN9202")], [], { publish: false });
    await w.capture("sbi-securities", [position("SYN9203")], [], { reparseOf: first });
    const stored = ["SYN9201", "SYN9202", "SYN9203"].map((code) =>
      w.identifier("mic-symbol", "XTKS", code),
    );
    const read = (await queryInstrumentResolution(w.sql)).identifiers.map(
      (row) => row.identifierId,
    );
    // All three were identified; only the published parse of the artifact is read.
    expect(read).toEqual([stored[2]!]);
  });
});

describe("bounds refuse, never cut", () => {
  const stub = (bounded: string, rows: number): SqlExecutor => ({
    all: async <T>(text: string) =>
      (text === bounded ? Array.from({ length: rows }, () => ({})) : []) as T[],
    first: async () => null,
  });

  test("each read asks for one row past its bound", () => {
    expect(INSTRUMENT_FACTS_SQL).toEndWith(`LIMIT ${INSTRUMENT_FACTS_ROW_BOUND + 1}`);
    expect(LISTED_AS_SQL).toEndWith(`LIMIT ${LISTED_AS_ROW_BOUND + 1}`);
  });

  test("more fact rows than the bound are refused", async () => {
    await expect(
      queryInstrumentResolution(stub(INSTRUMENT_FACTS_SQL, INSTRUMENT_FACTS_ROW_BOUND + 1)),
    ).rejects.toBeInstanceOf(InstrumentResolutionLimitError);
  });

  test("more listed_as relations than the bound are refused", async () => {
    await expect(
      queryInstrumentResolution(stub(LISTED_AS_SQL, LISTED_AS_ROW_BOUND + 1)),
    ).rejects.toBeInstanceOf(InstrumentResolutionLimitError);
  });
});

describe("cost", () => {
  test("the reads scan no observation table, and reach mappings, decisions and relations by index", () => {
    const w = new World();
    const plan = (text: string, args: unknown[] = []) =>
      (w.db.query(`EXPLAIN QUERY PLAN ${text}`).all(...(args as never[])) as { detail: string }[])
        .map((row) => row.detail)
        .join("\n");
    const facts = plan(INSTRUMENT_FACTS_SQL);
    for (const table of [
      "transaction_observations",
      "balance_observations",
      "position_observations",
      "valuation_observations",
    ])
      expect(facts).not.toContain(table);
    // Identifier uses are reached from each current identity observation by
    // its primary key, never by scanning the use table.
    expect(facts).not.toMatch(/SCAN u\b/u);
    expect(facts).toContain("SEARCH u USING INDEX sqlite_autoindex_identity_instrument_uses_1");
    // A use's trade unit and unit are reached by the same primary key.
    for (const alias of ["t", "n"])
      expect(facts).toContain(
        `SEARCH ${alias} USING INDEX sqlite_autoindex_identity_instrument_uses_1 (identity_observation_id=? AND role=?) LEFT-JOIN`,
      );
    const listed = plan(LISTED_AS_SQL);
    expect(listed).toMatch(/SEARCH r USING INDEX entity_relations_(from|to)\b/u);
    expect(listed).not.toMatch(/SCAN r\b/u);
    const history = plan(INSTRUMENT_HISTORY_SQL, ["[]"]);
    expect(history).not.toMatch(/SCAN (m|d|r)\b/u);
    expect(history).toContain(
      "SEARCH m USING INDEX sqlite_autoindex_instrument_mappings_2 (identifier_id=?)",
    );
    expect(history).toContain(
      "SEARCH d USING INDEX decision_revisions_subject (subject_kind=? AND subject_ref=?)",
    );
    expect(history).toContain("SEARCH r USING INDEX entity_relations_to (kind=? AND to_ref=?)");
  });
});
