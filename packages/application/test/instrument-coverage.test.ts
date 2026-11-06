// Per-source instrument resolution counts (src/query/instrument-coverage.ts,
// ADR 0073): the identifier states of the candidate read (ADR 0055 §9),
// counted per source. The store is the resolution tests' synthetic world
// (instrument-resolution-world.ts): identifiers written by the production
// identity writer, decisions through the change lifecycle. Every code, name
// and account here is invented.
import { beforeAll, describe, expect, test } from "bun:test";
import { IDENTIFIER_RESOLUTION_STATES } from "../../domain/src/instrument-candidates.ts";
import { validInstrumentCoverage } from "../../observation-shared/src/instrument-coverage-contract.ts";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import {
  IDENTITY_OBSERVATION_COUNT_SQL,
  INSTRUMENT_FACTS_SQL,
} from "../../read-model/src/instrument-resolution.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import type { Grant } from "../src/grants.ts";
import {
  instrumentCoverageBySource,
  readInstrumentCoverage,
  type InstrumentCoverage,
} from "../src/query/instrument-coverage.ts";
import {
  queryInstrumentResolution,
  type ResolutionIdentifier,
} from "../src/query/instrument-resolution.ts";
import {
  BROKER_B,
  candidateOf,
  decide,
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
const DOMESTIC = "sbi-securities:domestic";

/** A store that fails the test if anything reads it. */
const untouched: SqlExecutor = {
  all: async () => {
    throw new Error("read");
  },
  first: async () => {
    throw new Error("read");
  },
};

type States = Record<(typeof IDENTIFIER_RESOLUTION_STATES)[number], number>;
function states(counts: Partial<States> = {}): States {
  return Object.fromEntries(
    IDENTIFIER_RESOLUTION_STATES.map((state) => [state, counts[state] ?? 0]),
  ) as States;
}

async function coverage(
  sql: SqlExecutor,
  source: string | null = null,
  grant: Grant = READER,
): Promise<InstrumentCoverage> {
  const outcome = await readInstrumentCoverage({ grant, sql, source });
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}`);
  // Every answer the service gives passes the browser's wire check.
  expect(validInstrumentCoverage(outcome.coverage)).toBe(true);
  expect(validApiResponse("/api/identity/instrument-coverage", outcome.coverage)).toBe(true);
  return outcome.coverage;
}

/**
 * Only SBI Securities: `SYN8001` held on XTKS and traded on a venue the SBI
 * rule does not map, so its two identifiers are one proposed candidate and
 * nothing else is in scope.
 */
async function unresolvedOnly(): Promise<World> {
  const w = new World();
  await w.capture(
    "sbi-securities",
    [
      {
        account: DOMESTIC,
        code: "SYN8001",
        name: "Synthetic Eight",
        market: "TKY",
        currency: "JPY",
      },
    ],
    [
      {
        account: DOMESTIC,
        currency: "JPY",
        extra: {
          issueCode: "SYN8001",
          issueName: "Synthetic Eight",
          marketLabel: "SYNTHETIC-VENUE",
          accountLabel: "synthetic",
        },
      },
    ],
  );
  return w;
}

beforeAll(() => {
  stubDatabase().close();
}, 60_000);

describe("counts per source", () => {
  test("an empty store has no row, not a row of zeros", async () => {
    const w = new World();
    expect(await coverage(w.sql)).toEqual({
      schemaVersion: "kogane-instrument-coverage-v1",
      policy: "instrument-candidates-v1",
      query: { source: null },
      rows: [],
    });
  });

  test("a store whose only identifiers wait on a candidate counts them as unresolved", async () => {
    const w = await unresolvedOnly();
    const before = w.snapshot();
    expect((await coverage(w.sql)).rows).toEqual([
      { source: "sbi-securities", identifiers: 2, states: states({ "unresolved-candidates": 2 }) },
    ]);
    expect(w.snapshot()).toBe(before);
  });

  test("mixed sources: each source counts the identifiers it uses, in their candidate states", async () => {
    const w = await world();
    const before = w.snapshot();
    const answer = await coverage(w.sql);
    expect(answer.rows).toEqual([
      {
        source: "sbi-securities",
        identifiers: 8,
        states: states({ "unresolved-candidates": 4, "no-candidate": 4 }),
      },
      {
        source: BROKER_B,
        identifiers: 3,
        states: states({ "unresolved-candidates": 1, "no-candidate": 2 }),
      },
    ]);
    // The candidate read's own states: the counts and the candidate page agree.
    const resolution = await queryInstrumentResolution(w.sql);
    for (const state of IDENTIFIER_RESOLUTION_STATES)
      expect(answer.rows.reduce((sum, row) => sum + row.states[state], 0)).toBe(
        resolution.identifiers.filter((row) => row.state === state).length,
      );
    expect(resolution.summary.unresolved).toBe(5);
    expect(w.snapshot()).toBe(before);
  });

  test("a source filter keeps that source's row; an unknown source has none", async () => {
    const w = await world();
    expect(await coverage(w.sql, BROKER_B)).toMatchObject({
      query: { source: BROKER_B },
      rows: [{ source: BROKER_B, identifiers: 3 }],
    });
    expect(await coverage(w.sql, "synthetic-absent")).toMatchObject({
      query: { source: "synthetic-absent" },
      rows: [],
    });
  });
});

describe("only the current decision counts", () => {
  test("an adoption resolves both identifiers; a later correction reopens them; a rejection keeps them apart", async () => {
    const w = await unresolvedOnly();
    const listing = w.identifier("mic-symbol", "XTKS", "SYN8001");
    const venue = w.identifier("sbi-security-code", "JP", "SYN8001");
    const candidate = candidateOf(await queryInstrumentResolution(w.sql), listing, venue);
    const subject = candidate.subjectIdentifierId;
    const own = (
      w.db
        .query("SELECT instrument_id AS id FROM current_instrument_mappings WHERE identifier_id=?")
        .get(subject) as { id: string }
    ).id;

    const adopted = await decide(
      w,
      OPERATOR,
      "identity.assign",
      { ...candidate.commands!.adopt!.payload, reason: "synthetic: one listing" },
      "op-coverage-adopt",
    );
    expect(adopted.stage === "commit" && adopted.result.ok).toBe(true);
    expect((await coverage(w.sql)).rows).toEqual([
      { source: "sbi-securities", identifiers: 2, states: states({ "resolved-by-decision": 2 }) },
    ]);

    // A person corrects the adoption: a later manual revision maps the subject
    // back to its own instrument. The adoption stays in the history, and is
    // no longer counted.
    const corrected = await decide(
      w,
      OPERATOR,
      "identity.assign",
      {
        subject: "instrument",
        referenceId: subject,
        targetId: own,
        reason: "synthetic: correct the adoption",
      },
      "op-coverage-correct",
    );
    expect(corrected.stage === "commit" && corrected.result.ok).toBe(true);
    expect(
      w.db
        .query(
          "SELECT revision,method FROM instrument_mappings WHERE identifier_id=? ORDER BY revision",
        )
        .all(subject),
    ).toEqual([
      { revision: 1, method: "rule" },
      { revision: 2, method: "manual" },
      { revision: 3, method: "manual" },
    ]);
    expect((await coverage(w.sql)).rows).toEqual([
      { source: "sbi-securities", identifiers: 2, states: states({ "unresolved-candidates": 2 }) },
    ]);

    const reopened = candidateOf(await queryInstrumentResolution(w.sql), listing, venue);
    const rejected = await decide(
      w,
      OPERATOR,
      "relation.reject",
      { ...reopened.commands!.keepApart.payload, reason: "synthetic: two products" },
      "op-coverage-reject",
    );
    expect(rejected.stage === "commit" && rejected.result.ok).toBe(true);
    expect((await coverage(w.sql)).rows).toEqual([
      { source: "sbi-securities", identifiers: 2, states: states({ "kept-separate": 2 }) },
    ]);
  });
});

describe("grouping", () => {
  const identifier = (
    identifierId: string,
    sources: string[],
    state: ResolutionIdentifier["state"],
  ): ResolutionIdentifier => ({ identifierId, sources, state }) as unknown as ResolutionIdentifier;

  test("an identifier two sources use counts under each, so rows have no total", () => {
    expect(
      instrumentCoverageBySource({
        identifiers: [
          identifier("a", ["source-b", "source-a"], "resolved-by-decision"),
          identifier("b", ["source-a"], "unresolved-candidates"),
        ],
      }),
    ).toEqual([
      {
        source: "source-a",
        identifiers: 2,
        states: states({ "resolved-by-decision": 1, "unresolved-candidates": 1 }),
      },
      { source: "source-b", identifiers: 1, states: states({ "resolved-by-decision": 1 }) },
    ]);
  });
});

describe("refusals", () => {
  test("capability, perimeter and a malformed source are refused before anything is read", async () => {
    expect(
      await readInstrumentCoverage({
        grant: { ...READER, capabilities: ["records.read"] },
        sql: untouched,
        source: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "unauthorized", refs: ["capability:summary.read"] },
    });
    expect(
      await readInstrumentCoverage({
        grant: { ...READER, scopes: { sources: ["sbi-securities"], accounts: ["a"] } },
        sql: untouched,
        source: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "evidence_restricted", refs: ["scope:source", "scope:account"] },
    });
    for (const source of ["", "x".repeat(129), "a\u0001", 1])
      expect(await readInstrumentCoverage({ grant: READER, sql: untouched, source })).toMatchObject(
        { ok: false, error: { code: "invalid_query", refs: ["source"] } },
      );
  });

  test("the candidate read's bounds refuse the whole answer, never a partial or zero count", async () => {
    const counted = (n: number): SqlExecutor => ({
      all: async () => [],
      first: async <T>(text: string) => {
        expect(text).toBe(IDENTITY_OBSERVATION_COUNT_SQL);
        return { n } as T;
      },
    });
    expect(
      await readInstrumentCoverage({ grant: READER, sql: counted(500_000), source: null }),
    ).toMatchObject({ ok: true, coverage: { rows: [] } });
    expect(
      await readInstrumentCoverage({ grant: READER, sql: counted(500_001), source: null }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_exceeded", refs: ["budget:identityObservations=500000"] },
    });
    const facts: SqlExecutor = {
      all: async <T>(text: string) =>
        (text === INSTRUMENT_FACTS_SQL ? Array.from({ length: 10_001 }, () => ({})) : []) as T[],
      first: async () => null,
    };
    expect(await readInstrumentCoverage({ grant: READER, sql: facts, source: null })).toMatchObject(
      { ok: false, error: { code: "budget_exceeded", refs: ["budget:instrumentResolution"] } },
    );
  });
});
