// The instrument candidate review (src/query/instrument-candidates-review.ts,
// ADR 0055 amendment 2026-10-09): one bounded page of the candidate read for
// whoever the grant allows. The store is the resolution tests' synthetic world
// (instrument-resolution-world.ts): identifiers written by the production
// identity writer, decisions through the change lifecycle. Every code, name
// and account here is invented.
import { beforeAll, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { INSTRUMENT_FACTS_SQL } from "../../read-model/src/instrument-resolution.ts";
import { validPayload } from "../src/command/contract.ts";
import type { Grant } from "../src/grants.ts";
import {
  INSTRUMENT_CANDIDATES_MANIFEST,
  INSTRUMENT_CANDIDATES_PAGE_SIZE,
  parseInstrumentCandidatesRequest,
  reviewInstrumentCandidates,
  type InstrumentCandidateReview,
  type InstrumentCandidatesRequest,
  type ReviewCandidate,
} from "../src/query/instrument-candidates-review.ts";
import {
  AGENT,
  BROKER_B,
  decide,
  ids,
  OPERATOR,
  stubDatabase,
  World,
  world,
} from "./instrument-resolution-world.ts";

/** The reader authority a signed-in browser has (services/app `readerGrant`). */
const READER: Grant = {
  principal: "reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read", "evidence.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};

function request(input: Partial<InstrumentCandidatesRequest> = {}): InstrumentCandidatesRequest {
  return { view: "open", offset: 0, identifierId: null, ...input };
}

async function review(
  sql: SqlExecutor,
  input: Partial<InstrumentCandidatesRequest> = {},
  grant: Grant = READER,
): Promise<InstrumentCandidateReview> {
  const outcome = await reviewInstrumentCandidates({ grant, sql, request: request(input) });
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}`);
  return outcome.review;
}

/** A store that fails the test if anything reads it. */
const untouched: SqlExecutor = {
  all: async () => {
    throw new Error("read");
  },
  first: async () => {
    throw new Error("read");
  },
};

beforeAll(() => {
  stubDatabase().close();
}, 60_000);

describe("a page of the candidate read", () => {
  test("the open view lists proposed candidates with their evidence refs, commands and identifiers", async () => {
    const w = await world();
    const id = ids(w);
    const before = w.snapshot();
    const page = await review(w.sql);
    expect(w.snapshot()).toBe(before);
    expect(page.schemaVersion).toBe("kogane-instrument-candidates-v1");
    expect(page.decisions).toBe("change-lifecycle");
    expect(page.manifest).toEqual(INSTRUMENT_CANDIDATES_MANIFEST);
    expect(page.query).toEqual(request());
    expect(page.total).toBe(page.items.length);
    expect(page.nextOffset).toBeNull();
    expect(page.summary).toMatchObject({ adopted: 0, rejected: 0, held: 0, hints: 1 });
    expect(page.summary.proposed).toBe(page.items.length);

    const cross = (page.items as ReviewCandidate[]).find(
      (item) => item.subjectIdentifierId === id.broker9001,
    )!;
    expect(cross).toMatchObject({
      anchorIdentifierId: id.listing9001,
      status: "proposed",
      hold: null,
      evidenceRefs: [`identifier:${id.listing9001}`, `identifier:${id.broker9001}`],
    });
    expect(cross.commands!.adopt!.payload).toEqual({
      subject: "instrument",
      referenceId: id.broker9001,
      targetId: page.identifiers.find((row) => row.identifierId === id.listing9001)!.instrumentId,
    });
    // Every identifier an item names is in the page, and nothing else.
    const named = new Set(
      (page.items as ReviewCandidate[]).flatMap((item) => [
        item.anchorIdentifierId,
        item.subjectIdentifierId,
      ]),
    );
    expect(page.identifiers.map((row) => row.identifierId)).toEqual([...named].sort());
    // A command is a plan payload only: with a reason it is valid, and nothing was planned.
    for (const item of page.items as ReviewCandidate[]) {
      const commands = item.commands!;
      expect(
        validPayload(commands.adopt!.kind, { ...commands.adopt!.payload, reason: "synthetic" }),
      ).toBe(true);
      expect(
        validPayload(commands.keepApart.kind, {
          ...commands.keepApart.payload,
          reason: "synthetic",
        }),
      ).toBe(true);
    }
  });

  test("separated pairs and name hints are their own views, with every identifier they name", async () => {
    const w = await world();
    const id = ids(w);
    const separated = await review(w.sql, { view: "separated" });
    expect(separated.items.length).toBe(separated.summary.separated);
    const market = separated.items.find(
      (item) => "conflicts" in item && item.conflicts.includes("market-differs"),
    )!;
    expect(market.evidenceRefs).toEqual(
      [id.tokyo9002, id.nagoya9002].sort().map((value) => `identifier:${value}`),
    );
    const hints = await review(w.sql, { view: "hints" });
    expect(hints.items).toHaveLength(1);
    expect(hints.items[0]).toMatchObject({ reason: "same-display-name" });
    expect(hints.identifiers.map((row) => row.identifierId)).toEqual(
      [id.shared9004, id.broker9005].sort(),
    );
    expect(await review(w.sql, { view: "decided" })).toMatchObject({ items: [], total: 0 });
  });

  test("one identifier's pairs only; an identifier the read does not hold is refused", async () => {
    const w = await world();
    const id = ids(w);
    const page = await review(w.sql, { identifierId: id.broker9001 });
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items as ReviewCandidate[])
      expect([item.anchorIdentifierId, item.subjectIdentifierId]).toContain(id.broker9001);
    expect(page.summary.proposed).toBeGreaterThan(page.items.length);
    const outcome = await reviewInstrumentCandidates({
      grant: READER,
      sql: w.sql,
      request: request({ identifierId: "ii_unknown" }),
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "evidence_restricted", refs: ["identifierId"] },
    });
  });

  test("a decision through the change lifecycle moves the candidate to the decided view", async () => {
    const w = await world();
    const id = ids(w);
    const open = await review(w.sql, { identifierId: id.broker9001 });
    const cross = (open.items as ReviewCandidate[]).find(
      (item) => item.anchorIdentifierId === id.listing9001,
    )!;
    const adopt = cross.commands!.adopt!;
    // Under today's grants an agent may plan the adoption and not approve it.
    const agent = await decide(
      w,
      AGENT,
      adopt.kind,
      { ...adopt.payload, reason: "synthetic agent plan" },
      "op-agent",
    );
    expect(agent.stage).toBe("approve");
    expect((await review(w.sql, { identifierId: id.broker9001 })).items).toContainEqual(cross);
    const operator = await decide(
      w,
      OPERATOR,
      adopt.kind,
      { ...adopt.payload, reason: "synthetic decision" },
      "op-operator",
    );
    expect(operator).toMatchObject({ stage: "commit", result: { ok: true } });
    const decided = await review(w.sql, { view: "decided" });
    expect(decided.items).toHaveLength(1);
    expect(decided.items[0]).toMatchObject({
      candidateId: cross.candidateId,
      status: "adopted",
      commands: null,
    });
    expect(decided.summary.adopted).toBe(1);
  });

  test("a candidate whose subject is decided elsewhere is held: keep apart only", async () => {
    const w = new World();
    const domestic = "sbi-securities:domestic";
    await w.capture(
      "sbi-securities",
      [
        { account: domestic, code: "SYN9101", name: "Synthetic A", market: "TKY", currency: "JPY" },
        { account: domestic, code: "SYN9102", name: "Synthetic B", market: "TKY", currency: "JPY" },
      ],
      [],
    );
    await w.capture(BROKER_B, [
      {
        account: "synthetic-broker-b:custody",
        code: "SYN9101",
        name: "Synthetic A",
        currency: "JPY",
        extra: { country: "JP" },
      },
    ]);
    const listing = w.identifier("mic-symbol", "XTKS", "SYN9101");
    const other = w.identifier("mic-symbol", "XTKS", "SYN9102");
    const broker = w.identifier("synthetic-broker-b-code", "JP", "SYN9101");
    // A person maps broker B's code onto another listing's instrument, then
    // confirms the listing's own mapping: both sides are settled.
    const instrumentOf = w.db
      .query("SELECT instrument_id AS id FROM current_instrument_mappings WHERE identifier_id=?")
      .get(other) as { id: string };
    expect(
      await decide(
        w,
        OPERATOR,
        "identity.assign",
        {
          subject: "instrument",
          referenceId: broker,
          targetId: instrumentOf.id,
          reason: "synthetic earlier decision",
        },
        "op-first",
      ),
    ).toMatchObject({ stage: "commit", result: { ok: true } });
    const sameListing = w.db
      .query("SELECT instrument_id AS id FROM current_instrument_mappings WHERE identifier_id=?")
      .get(listing) as { id: string };
    expect(
      await decide(
        w,
        OPERATOR,
        "identity.assign",
        {
          subject: "instrument",
          referenceId: listing,
          targetId: sameListing.id,
          reason: "synthetic confirmation",
        },
        "op-second",
      ),
    ).toMatchObject({ stage: "commit" });
    const held = await review(w.sql, { view: "held" });
    expect(held.summary.held).toBe(held.items.length);
    expect(held.items).toContainEqual(
      expect.objectContaining({
        anchorIdentifierId: listing,
        subjectIdentifierId: broker,
        hold: "subject-decided-elsewhere",
      }),
    );
    for (const item of held.items as ReviewCandidate[]) {
      expect(item.status).toBe("proposed");
      expect(item.hold).not.toBeNull();
      expect(item.commands!.adopt).toBeNull();
      expect(item.commands!.keepApart.kind).toBe("relation.reject");
    }
    const open = await review(w.sql);
    for (const item of open.items as ReviewCandidate[]) expect(item.hold).toBeNull();
  });

  test("pages hold at most the page size and name the next offset", async () => {
    const w = new World();
    const count = INSTRUMENT_CANDIDATES_PAGE_SIZE + 5;
    const codes = Array.from({ length: count }, (_, index) => `SYN${String(5000 + index)}`);
    await w.capture(
      "sbi-securities",
      codes.map((code) => ({
        account: "sbi-securities:domestic",
        code,
        name: `Synthetic ${code}`,
        market: "TKY",
        currency: "JPY",
      })),
    );
    await w.capture(
      BROKER_B,
      codes.map((code) => ({
        account: "synthetic-broker-b:custody",
        code,
        name: `Other ${code}`,
        currency: "JPY",
        extra: { country: "JP" },
      })),
    );
    const first = await review(w.sql);
    expect(first.total).toBe(count);
    expect(first.items).toHaveLength(INSTRUMENT_CANDIDATES_PAGE_SIZE);
    expect(first.nextOffset).toBe(INSTRUMENT_CANDIDATES_PAGE_SIZE);
    const second = await review(w.sql, { offset: first.nextOffset! });
    expect(second.items).toHaveLength(5);
    expect(second.nextOffset).toBeNull();
    const seen = [...first.items, ...second.items].map(
      (item) => (item as ReviewCandidate).candidateId,
    );
    expect(new Set(seen).size).toBe(count);
  });
});

describe("the grant decides, before anything is read", () => {
  test("records.read is required", async () => {
    const outcome = await reviewInstrumentCandidates({
      grant: { ...READER, capabilities: ["summary.read"] },
      sql: untouched,
      request: request(),
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "unauthorized", refs: ["capability:records.read"] },
    });
  });

  test("a listed perimeter is refused whole", async () => {
    const outcome = await reviewInstrumentCandidates({
      grant: { ...READER, scopes: { sources: ["sbi-securities"], accounts: ["synthetic"] } },
      sql: untouched,
      request: request(),
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "evidence_restricted", refs: ["scope:source", "scope:account"] },
    });
  });

  test("a page past the grant's maxRows is refused", async () => {
    const outcome = await reviewInstrumentCandidates({
      grant: { ...READER, budget: { ...READER.budget, maxRows: 100 } },
      sql: untouched,
      request: request({ offset: 60 }),
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "budget_exceeded", refs: ["budget:maxRows=100"] },
    });
  });

  test("a store past the read's bound is refused, never cut", async () => {
    const stub: SqlExecutor = {
      all: async <T>(text: string) =>
        (text === INSTRUMENT_FACTS_SQL ? Array.from({ length: 10_001 }, () => ({})) : []) as T[],
      first: async () => null,
    };
    expect(
      await reviewInstrumentCandidates({ grant: READER, sql: stub, request: request() }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_exceeded", refs: ["budget:instrumentResolution"] },
    });
  });
});

describe("requests are closed", () => {
  test("defaults, accepted values and refusals", () => {
    expect(parseInstrumentCandidatesRequest(undefined)).toEqual({ ok: true, value: request() });
    expect(
      parseInstrumentCandidatesRequest({ view: "held", offset: 50, identifierId: "ii_abc" }),
    ).toEqual({
      ok: true,
      value: { view: "held", offset: 50, identifierId: "ii_abc" },
    });
    expect(parseInstrumentCandidatesRequest({ source: "x" })).toEqual({
      ok: false,
      code: "unsupported_semantics",
      refs: ["source"],
    });
    for (const [body, ref] of [
      [{ view: "all" }, "view"],
      [{ offset: -1 }, "offset"],
      [{ offset: 5_001 }, "offset"],
      [{ offset: "1" }, "offset"],
      [{ identifierId: "" }, "identifierId"],
      [{ identifierId: "a b" }, "identifierId"],
      [{ identifierId: "x".repeat(129) }, "identifierId"],
    ] as const)
      expect(parseInstrumentCandidatesRequest(body)).toEqual({
        ok: false,
        code: "invalid_query",
        refs: [ref],
      });
    expect(parseInstrumentCandidatesRequest([])).toMatchObject({
      ok: false,
      code: "invalid_query",
    });
  });
});
