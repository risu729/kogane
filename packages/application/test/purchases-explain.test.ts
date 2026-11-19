// `kogane.purchases.explain` (src/query/purchases-explain.ts): the operator's
// card purchase page, for an agent, on every CORE migration with purchases
// written by the guarded recognition builder, a statement settled by an
// accepted bank debit and a stage-B pending-to-posted candidate stored the way
// the matcher stores one (card-purchase-world.ts). Synthetic values only.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { SourceFactRef } from "../../domain/src/events.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import {
  validAgentCardPurchasePage,
  validCardPurchasePage,
} from "../../observation-shared/src/card-purchase-contract.ts";
import { ERROR_STATUS } from "../src/errors.ts";
import {
  queryCardPurchaseCards,
  queryCardPurchaseLines,
  queryCardPurchases,
} from "../src/query/card-purchases.ts";
import {
  answerPurchasesExplain,
  explainCardPurchaseCards,
  explainCardPurchaseLines,
  explainCardPurchases,
  parsePurchasesExplainRequest,
  type PurchasesExplainOutcome,
  withoutReviewAffordances,
} from "../src/query/purchases-explain.ts";
import { PurchaseWorld } from "./card-purchase-world.ts";
import { migratedDatabase } from "./sqlite-store.ts";
import { grant } from "./fixture.ts";

// The first build of the migrated CORE image runs every migration; pay it
// here under its own budget, not inside whichever test first asks for a copy
// (see ./sqlite-store.ts).
beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

const worlds: PurchaseWorld[] = [];
afterEach(() => {
  for (const created of worlds.splice(0)) created.close();
});

/**
 * Every table's row count, the CORE source revision and the connection's
 * change counter (which an UPDATE of a pointer also moves).
 */
function tables(db: Database): Record<string, unknown> {
  const names = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  return {
    counts: Object.fromEntries(
      names.map((name) => [
        name,
        (db.query(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n,
      ]),
    ),
    sourceRevision: db.query("SELECT * FROM core_source_revision").all(),
    changes: (db.query("SELECT total_changes() AS n").get() as { n: number }).n,
  };
}

/** The executor with every query recorded, and optionally a store past the summary bound. */
function recorded(
  inner: SqlExecutor,
  options: { overfull?: boolean } = {},
): { sql: SqlExecutor; queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    sql: {
      all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> => {
        queries.push(query);
        if (options.overfull && query.includes("FROM current_card_purchase_recognitions c"))
          return Array.from({ length: Number(args.at(-1)) }, () => ({}) as T);
        return inner.all<T>(query, args);
      },
      first: (query, args) => {
        queries.push(query);
        return inner.first(query, args);
      },
    },
  };
}

const refOf = (fact: { observationId: number; parseRunId: number }): SourceFactRef => ({
  kind: "transaction",
  id: `transaction:${fact.observationId}`,
  revision: `parse_run:${fact.parseRunId}`,
});

/**
 * A MyJCB pending authorisation of 1,200 and the posted charge of 1,234, each
 * its own recognised event, with the stage-B candidate that names both (still
 * open: it may be accepted or rejected), and the posted charge's statement
 * settled by an accepted SMBC debit.
 */
async function world() {
  const w = new PurchaseWorld();
  worlds.push(w);
  const pendingFact = w.usage({
    source: "myjcb",
    externalId: "myjcb-credit-ledger:unconfirmed:row-p:0",
    status: "unconfirmed",
    amount: -1200,
    usageDate: "2026-08-20",
  });
  const postedFact = w.usage({
    source: "myjcb",
    externalId: "myjcb-credit-ledger:confirmed:row-q:0",
    status: "posted",
    amount: -1234,
    usageDate: "2026-08-21",
  });
  const pendingEvent = await w.recognise(pendingFact);
  const postedEvent = await w.recognise(postedFact);
  const proposalId = `rp_${"1".padStart(64, "0")}`;
  w.run(
    `INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,rationale_codes_json,
      rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
     VALUES(?,'pending_to_posted','B',?,'rule','reconciliation-rules-v1',?,?,?,'proposed',NULL,?,?)`,
    proposalId,
    JSON.stringify([refOf(pendingFact), refOf(postedFact)]),
    JSON.stringify(["status_pending_to_posted", "same_source_account", "no_provider_link_id"]),
    JSON.stringify(["provider_link_absent", "amount_differs"]),
    JSON.stringify([refOf(pendingFact).id, refOf(postedFact).id]),
    "1".padStart(64, "0"),
    "2026-09-24T01:00:00.000Z",
  );
  const statement = w.statement({
    source: "myjcb",
    sourceAccount: "myjcb:connection-a:root",
    accountId: "acct-card",
    period: "2026-09",
    total: 1234,
    paymentDate: "2026-10-10",
  });
  w.settle({
    statement,
    bank: w.bankDebit(1234),
    source: "myjcb",
    accountId: "acct-card",
    period: "2026-09",
    total: 1234,
    status: "accepted",
  });
  return { w, pendingEvent, postedEvent, proposalId };
}

function explained(outcome: PurchasesExplainOutcome) {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}`);
  return outcome.explanation;
}

describe("the agent reads the operator's page", () => {
  test("the same figures, chain, coverage and candidates, without the review affordances", async () => {
    const { w, postedEvent, proposalId } = await world();
    for (const request of [{}, { period: "2026-09" }, { eventId: postedEvent }, { offset: 50 }]) {
      const page = await queryCardPurchases(w.sql, request);
      const explanation = explained(
        await explainCardPurchases({ grant: grant(), sql: w.sql, request }),
      );
      expect(explanation).toEqual({
        schemaVersion: "kogane-card-purchases-v1",
        query: {
          period: "period" in request ? request.period : null,
          eventId: "eventId" in request ? request.eventId : null,
          offset: "offset" in request ? request.offset : 0,
        },
        decisions: "operator-only",
        // Two events: no page follows the first, so none is offered.
        nextPage: "none",
        data: withoutReviewAffordances(page),
      });
      // Nothing but the candidates' affordances differs from the page.
      const bare = (items: { candidates: unknown[] }[]) =>
        items.map((item) => ({ ...item, candidates: item.candidates.length }));
      expect({ ...explanation.data, items: bare(explanation.data.items) }).toEqual({
        ...page,
        items: bare(page.items),
      });
      page.items.forEach((item, index) =>
        item.candidates.forEach((candidate, position) => {
          const { actions: _actions, relation: _relation, ...facts } = candidate;
          expect(explanation.data.items[index]!.candidates[position]).toEqual(facts);
        }),
      );
      expect(validAgentCardPurchasePage(explanation.data)).toBe(true);
      // The agent is told, as the page tells the operator, that no refund is allocated.
      expect(explanation.data.coverage.refundsAllocated).toBe(false);
    }

    const page = await queryCardPurchases(w.sql);
    const data = explained(
      await explainCardPurchases({ grant: grant(), sql: w.sql, request: {} }),
    ).data;
    // The chain an agent is asked about: statement, accepted settlement, bank debit.
    const posted = data.items.find((item) => item.eventId === postedEvent)!;
    expect(posted).toMatchObject({
      state: "captured",
      statement: { status: "linked", period: "2026-09" },
      settlement: { reviewStatus: "accepted", bankDebit: { sourceId: "smbc-bank" } },
    });
    expect(posted.explanationRefs).toContain(`proposal:${proposalId}`);
    // The operator is offered accept and reject with the plan payload; the agent neither.
    const offered = page.items.find((item) => item.eventId === postedEvent)!.candidates[0]!;
    expect(offered).toMatchObject({ proposalId, actions: ["accept", "reject"], blockers: [] });
    expect(offered.relation.evidenceRefs[0]).toBe(`reconciliation-proposal:${proposalId}`);
    const candidate = posted.candidates[0]!;
    expect(candidate).toMatchObject({ proposalId, proposalStatus: "proposed", blockers: [] });
    expect(Object.keys(candidate)).not.toContain("actions");
    expect(Object.keys(candidate)).not.toContain("relation");
    expect(JSON.stringify(data)).not.toContain("reconciliation-proposal:");
    // Each contract refuses the other's candidate.
    expect(validCardPurchasePage(page)).toBe(true);
    expect(validAgentCardPurchasePage(page)).toBe(false);
    expect(validCardPurchasePage(data)).toBe(false);
  });
});

describe("authorization is the grant's", () => {
  test("records.read is required, and nothing is read without it", async () => {
    const { w } = await world();
    for (const capabilities of [[], ["summary.read"], ["summary.read", "evidence.read"]] as const) {
      const probe = recorded(w.sql);
      const outcome = await explainCardPurchases({
        grant: grant({ capabilities: [...capabilities, "interpretation.propose"] }),
        sql: probe.sql,
        request: {},
      });
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: "unauthorized", refs: ["capability:records.read"] },
      });
      expect(probe.queries).toEqual([]);
    }
    expect(
      (
        await explainCardPurchases({
          grant: grant({ capabilities: ["records.read"] }),
          sql: w.sql,
          request: {},
        })
      ).ok,
    ).toBe(true);
    expect(ERROR_STATUS.unauthorized).toBe(403);
  });

  test("a perimeter narrower than the store is refused before anything is read", async () => {
    const { w } = await world();
    for (const [scopes, refs] of [
      [{ sources: ["vpass"], accounts: "*" }, ["scope:source"]],
      [{ sources: ["vpass", "smbc-bank"], accounts: "*" }, ["scope:source"]],
      [{ sources: "*", accounts: ["vpass:card-001"] }, ["scope:account"]],
      [{ sources: [], accounts: [] }, ["scope:source", "scope:account"]],
    ] as const) {
      const probe = recorded(w.sql);
      const outcome = await explainCardPurchases({
        grant: grant({ scopes: { sources: scopes.sources, accounts: scopes.accounts } }),
        sql: probe.sql,
        request: {},
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: "evidence_restricted", refs } });
      // A refusal is the same whatever the store holds: nothing was read.
      expect(probe.queries).toEqual([]);
      expect(JSON.stringify(outcome)).not.toMatch(/acct-card|smbc|1234|synthetic merchant/u);
    }
    expect(ERROR_STATUS.evidence_restricted).toBe(403);
  });
});

describe("bounds", () => {
  test("the grant's rows bound how deep a caller pages; an exact read is one row", async () => {
    const { w, postedEvent } = await world();
    const budget = (maxRows: number) => ({
      maxRows,
      maxProposalTargets: 1,
      maxExplainDepth: 1,
    });
    const run = async (maxRows: number, request: Record<string, unknown>) => {
      const probe = recorded(w.sql);
      const outcome = await explainCardPurchases({
        grant: grant({ budget: budget(maxRows) }),
        sql: probe.sql,
        request,
      });
      return { outcome, queries: probe.queries.length };
    };
    const refused = await run(49, {});
    expect(refused.outcome).toMatchObject({
      ok: false,
      error: { code: "budget_exceeded", refs: ["budget:maxRows=49"] },
    });
    expect(refused.queries).toBe(0);
    expect((await run(50, {})).outcome.ok).toBe(true);
    expect((await run(99, { offset: 50 })).outcome.ok).toBe(false);
    expect((await run(100, { offset: 50 })).outcome.ok).toBe(true);
    expect((await run(1, { eventId: postedEvent })).outcome.ok).toBe(true);
    expect(ERROR_STATUS.budget_exceeded).toBe(413);
  });

  test("a next page the same grant would be refused is not offered, and says why", async () => {
    // Two full pages and one more event: 101 Vpass charges, all synthetic.
    const w = new PurchaseWorld();
    worlds.push(w);
    for (let index = 0; index < 101; index += 1)
      await w.recognise(
        w.usage({ externalId: `vpass-web:row-${String(index)}`, amount: -(100 + index) }),
      );
    const budget = (maxRows: number) => ({ maxRows, maxProposalTargets: 1, maxExplainDepth: 1 });
    const read = async (maxRows: number, offset: number) =>
      explainCardPurchases({
        grant: grant({ budget: budget(maxRows) }),
        sql: w.sql,
        request: { offset },
      });
    const page = async (maxRows: number, offset: number) => explained(await read(maxRows, offset));

    // The grant reaches the next page: it is offered, and that request is answered.
    const first = await page(100, 0);
    expect(first.data.summary.events).toBe(101);
    expect([first.data.nextOffset, first.nextPage]).toEqual([50, "offered"]);
    expect((await read(100, 50)).ok).toBe(true);
    // It does not: no next offset, the closed reason instead, and the request
    // the next offset would have named is refused with that code.
    const bounded = await page(100, 50);
    expect(bounded.data.items).toHaveLength(50);
    expect([bounded.data.nextOffset, bounded.nextPage]).toEqual([null, "budget_exceeded"]);
    expect(await read(100, 100)).toMatchObject({
      ok: false,
      error: { code: "budget_exceeded", refs: ["budget:maxRows=100"] },
    });
    // The same at the first page of a smaller grant.
    expect(await page(50, 0)).toMatchObject({
      nextPage: "budget_exceeded",
      data: { nextOffset: null },
    });
    // A grant that reaches the last page is offered it; past it there is none.
    const last = await page(150, 100);
    expect([last.data.items.length, last.data.nextOffset, last.nextPage]).toEqual([
      1,
      null,
      "none",
    ]);
    expect((await page(150, 50)).nextPage).toBe("offered");
    // Everything else is the operator page's own answer.
    const operator = await queryCardPurchases(w.sql, { offset: 50 });
    expect(operator.nextOffset).toBe(100);
    expect(bounded.data).toEqual({ ...withoutReviewAffordances(operator), nextOffset: null });
    expect(validAgentCardPurchasePage(bounded.data)).toBe(true);
  });

  test("a filter past the summary bound is refused, never partially summed", async () => {
    const { w } = await world();
    for (const request of [{}, { period: "2026-09" }]) {
      const probe = recorded(w.sql, { overfull: true });
      const outcome = await explainCardPurchases({ grant: grant(), sql: probe.sql, request });
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: "budget_exceeded", refs: ["budget:cardPurchaseEvents=10000"] },
      });
      // The one bounded selection, and nothing summed or linked after it.
      expect(probe.queries).toHaveLength(1);
    }
  });

  test("an event id that names no live event is refused like one outside the grant", async () => {
    const { w } = await world();
    const outcome = await explainCardPurchases({
      grant: grant(),
      sql: w.sql,
      request: { eventId: `refund_${"0".repeat(64)}` },
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "evidence_restricted", refs: ["eventId"] },
    });
  });
});

describe("the request is closed", () => {
  test("only period, eventId and offset, each in its published shape", () => {
    const event = `purchase_${"a".repeat(64)}`;
    expect(parsePurchasesExplainRequest(undefined)).toEqual({ ok: true, value: {} });
    expect(parsePurchasesExplainRequest(null)).toEqual({ ok: true, value: {} });
    expect(parsePurchasesExplainRequest({})).toEqual({ ok: true, value: {} });
    expect(parsePurchasesExplainRequest({ period: "2026-09", offset: 50 })).toEqual({
      ok: true,
      value: { period: "2026-09", offset: 50 },
    });
    expect(parsePurchasesExplainRequest({ eventId: event })).toEqual({
      ok: true,
      value: { eventId: event },
    });
    for (const [body, code, refs] of [
      [[], "invalid_query", []],
      ["2026-09", "invalid_query", []],
      [{ source: "vpass" }, "unsupported_semantics", ["source"]],
      [{ sql: "SELECT 1", period: "2026-09" }, "unsupported_semantics", ["sql"]],
      [{ period: "202609" }, "invalid_query", ["period"]],
      [{ period: "2026-13" }, "invalid_query", ["period"]],
      [{ period: 202609 }, "invalid_query", ["period"]],
      [{ eventId: "purchase_1" }, "invalid_query", ["eventId"]],
      [{ eventId: `event_${"a".repeat(64)}` }, "invalid_query", ["eventId"]],
      [{ offset: -1 }, "invalid_query", ["offset"]],
      [{ offset: 1.5 }, "invalid_query", ["offset"]],
      [{ offset: "0" }, "invalid_query", ["offset"]],
      [{ offset: 1_000_001 }, "invalid_query", ["offset"]],
      [{ eventId: event, offset: 0 }, "invalid_query", ["eventId", "offset"]],
      [{ eventId: event, period: "2026-09" }, "invalid_query", ["eventId", "period"]],
    ] as const)
      expect(parsePurchasesExplainRequest(body)).toEqual({ ok: false, code, refs: [...refs] });
  });

  test("a view: events is the page's request, cards takes a period or a usage month (ADR 0125)", () => {
    const event = `purchase_${"a".repeat(64)}`;
    expect(parsePurchasesExplainRequest({ view: "events", period: "2026-09" })).toEqual({
      ok: true,
      value: { period: "2026-09" },
    });
    for (const [body, value] of [
      [
        { view: "cards", period: "2026-09" },
        { view: "cards", period: "2026-09" },
      ],
      [
        { view: "cards", usageMonth: "2026-08" },
        { view: "cards", usageMonth: "2026-08" },
      ],
    ] as const)
      expect(parsePurchasesExplainRequest(body)).toEqual({ ok: true, value });
    for (const [body, refs] of [
      [{ view: "summary" }, ["view"]],
      [{ view: null }, ["view"]],
      [{ usageMonth: "2026-08" }, ["usageMonth"]],
      [{ view: "events", usageMonth: "2026-08" }, ["usageMonth"]],
      [{ view: "cards", usageMonth: "202608" }, ["usageMonth"]],
      [{ view: "cards", usageMonth: 202608 }, ["usageMonth"]],
      [{ view: "cards", period: "2026-09", usageMonth: "2026-08" }, ["period", "usageMonth"]],
      [{ view: "cards" }, ["period", "usageMonth"]],
      [{ view: "cards", period: "2026-09", offset: 0 }, ["offset"]],
      [{ view: "cards", usageMonth: "2026-08", eventId: event }, ["eventId"]],
    ] as const)
      expect(parsePurchasesExplainRequest(body)).toEqual({
        ok: false,
        code: "invalid_query",
        refs: [...refs],
      });
  });
});

describe("the per-card view (ADR 0125)", () => {
  test("is graded like the page, refused past the budget, and answers the page's per-card reader", async () => {
    const { w } = await world();
    const before = tables(w.db);
    const ok = await explainCardPurchaseCards({
      grant: grant(),
      sql: w.sql,
      request: { period: "2026-09" },
    });
    expect(ok).toEqual({
      ok: true,
      explanation: {
        schemaVersion: "kogane-card-purchases-cards-v1",
        query: { view: "cards", period: "2026-09", usageMonth: null },
        decisions: "operator-only",
        data: await queryCardPurchaseCards(w.sql, { period: "2026-09" }),
      },
    });
    // The dispatcher picks the view.
    expect(
      await answerPurchasesExplain({
        grant: grant(),
        sql: w.sql,
        request: { view: "cards", period: "2026-09" },
      }),
    ).toEqual(ok);
    for (const [refused, code, refs] of [
      [grant({ capabilities: ["summary.read"] }), "unauthorized", ["capability:records.read"]],
      [
        grant({ scopes: { sources: ["vpass"], accounts: "*" } }),
        "evidence_restricted",
        ["scope:source"],
      ],
      [
        grant({ budget: { maxRows: 99, maxProposalTargets: 1, maxExplainDepth: 1 } }),
        "budget_exceeded",
        ["budget:maxRows=99"],
      ],
    ] as const) {
      const outcome = await explainCardPurchaseCards({
        grant: refused,
        sql: w.sql,
        request: { usageMonth: "2026-08" },
      });
      expect(outcome).toMatchObject({ ok: false, error: { code, refs: [...refs] } });
    }
    expect(tables(w.db)).toEqual(before);
  });
});

describe("the line view (ADR 0125 amendment)", () => {
  test("takes one month, an account, a sort and its own cursor, and nothing else", async () => {
    const { w } = await world();
    for (let row = 0; row < 30; row += 1)
      await w.recognise(
        w.usage({
          externalId: `vpass:card-001:202609:web:row-${row}:0`,
          amount: -(100 + row),
          usageDate: "2026-08-10",
        }),
      );
    const cursor = (await queryCardPurchaseLines(w.sql, { period: "2026-09", sort: "amount" }))
      .nextCursor!;
    for (const [body, value] of [
      [
        { view: "lines", period: "2026-09" },
        { view: "lines", period: "2026-09" },
      ],
      [
        { view: "lines", usageMonth: "2026-08", account: "acct-card", sort: "date" },
        { view: "lines", usageMonth: "2026-08", account: "acct-card", sort: "date" },
      ],
      [
        { view: "lines", period: "2026-09", sort: "amount", cursor },
        { view: "lines", period: "2026-09", sort: "amount", cursor },
      ],
    ] as const)
      expect(parsePurchasesExplainRequest(body)).toEqual({ ok: true, value });
    const event = `purchase_${"a".repeat(64)}`;
    for (const [body, refs] of [
      [{ view: "lines" }, ["period", "usageMonth"]],
      [{ view: "lines", period: "2026-09", usageMonth: "2026-08" }, ["period", "usageMonth"]],
      [{ view: "lines", period: "2026-09", offset: 0 }, ["offset"]],
      [{ view: "lines", period: "2026-09", eventId: event }, ["eventId"]],
      [{ view: "lines", period: "2026-09", account: "" }, ["account"]],
      [{ view: "lines", period: "2026-09", account: "a b" }, ["account"]],
      [{ view: "lines", period: "2026-09", account: 7 }, ["account"]],
      [{ view: "lines", period: "2026-09", sort: "merchant" }, ["sort"]],
      [{ view: "lines", period: "2026-09", cursor: "garbage" }, ["cursor"]],
      [{ view: "lines", period: "2026-09", cursor: 1 }, ["cursor"]],
      [{ view: "lines", period: "2026-09", cursor: "a".repeat(2049) }, ["cursor"]],
      // Another request's cursor: its sort, account or month differs.
      [{ view: "lines", period: "2026-09", cursor }, ["cursor"]],
      [
        { view: "lines", period: "2026-09", sort: "amount", account: "acct-card", cursor },
        ["cursor"],
      ],
      [{ view: "lines", usageMonth: "2026-09", sort: "amount", cursor }, ["cursor"]],
      // The line view's keys beside another view.
      [{ period: "2026-09", sort: "amount" }, ["sort"]],
      [{ view: "events", account: "acct-card" }, ["account"]],
      [{ view: "cards", period: "2026-09", account: "acct-card", cursor }, ["account", "cursor"]],
    ] as const)
      expect(parsePurchasesExplainRequest(body), JSON.stringify(body)).toEqual({
        ok: false,
        code: "invalid_query",
        refs: [...refs],
      });
  });

  test("is graded like the page, bounded by maxRows across pages, and answers the route's reader", async () => {
    const { w } = await world();
    for (let row = 0; row < 30; row += 1)
      await w.recognise(
        w.usage({
          externalId: `vpass:card-001:202609:web:row-${row}:0`,
          amount: -(100 + row),
          usageDate: "2026-08-10",
        }),
      );
    const before = tables(w.db);
    const request = { period: "2026-09", sort: "amount" } as const;
    const data = await queryCardPurchaseLines(w.sql, request);
    expect(data.nextCursor).not.toBeNull();
    const ok = await explainCardPurchaseLines({ grant: grant(), sql: w.sql, request });
    expect(ok).toEqual({
      ok: true,
      explanation: {
        schemaVersion: "kogane-card-purchases-lines-v1",
        query: {
          view: "lines",
          account: null,
          period: "2026-09",
          usageMonth: null,
          sort: "amount",
        },
        decisions: "operator-only",
        nextPage: "offered",
        data,
      },
    });
    // The dispatcher picks the view.
    expect(
      await answerPurchasesExplain({
        grant: grant(),
        sql: w.sql,
        request: { view: "lines", ...request },
      }),
    ).toEqual(ok);
    // The last page offers nothing more.
    const last = await explainCardPurchaseLines({
      grant: grant(),
      sql: w.sql,
      request: { ...request, cursor: data.nextCursor! },
    });
    expect(last).toMatchObject({
      ok: true,
      explanation: { nextPage: "none", data: { nextCursor: null } },
    });
    // A grant that may read one page but not two: the next page is withheld and said.
    const narrow = grant({ budget: { maxRows: 30, maxProposalTargets: 1, maxExplainDepth: 1 } });
    if (!ok.ok) throw new Error("refused");
    expect(await explainCardPurchaseLines({ grant: narrow, sql: w.sql, request })).toEqual({
      ok: true,
      explanation: {
        ...ok.explanation,
        nextPage: "budget_exceeded",
        data: { ...data, nextCursor: null },
      },
    });
    // And a cursor past it is refused before anything is read.
    const probe = recorded(w.sql);
    expect(
      await explainCardPurchaseLines({
        grant: narrow,
        sql: probe.sql,
        request: { ...request, cursor: data.nextCursor! },
      }),
    ).toMatchObject({ ok: false, error: { code: "budget_exceeded", refs: ["budget:maxRows=30"] } });
    expect(probe.queries).toEqual([]);
    for (const [refused, code, refs] of [
      [grant({ capabilities: ["summary.read"] }), "unauthorized", ["capability:records.read"]],
      [
        grant({ scopes: { sources: "*", accounts: ["acct-card"] } }),
        "evidence_restricted",
        ["scope:account"],
      ],
      [
        grant({ budget: { maxRows: 24, maxProposalTargets: 1, maxExplainDepth: 1 } }),
        "budget_exceeded",
        ["budget:maxRows=24"],
      ],
    ] as const) {
      const probe = recorded(w.sql);
      const outcome = await explainCardPurchaseLines({
        grant: refused,
        sql: probe.sql,
        request: { usageMonth: "2026-08", account: "acct-card" },
      });
      expect(outcome).toMatchObject({ ok: false, error: { code, refs: [...refs] } });
      expect(probe.queries).toEqual([]);
    }
    // The summary bound refuses the month, never a part of it.
    expect(
      await explainCardPurchaseLines({
        grant: grant(),
        sql: recorded(w.sql, { overfull: true }).sql,
        request,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_exceeded", refs: ["budget:cardPurchaseEvents=10000"] },
    });
    expect(tables(w.db)).toEqual(before);
  });
});

describe("no path writes", () => {
  test("every answer and every refusal leaves every table and the source revision unchanged", async () => {
    const { w, postedEvent } = await world();
    const before = tables(w.db);
    expect(before["sourceRevision"]).toHaveLength(1);
    for (const request of [
      {},
      { period: "2026-09", offset: 50 },
      { eventId: postedEvent },
      { eventId: `refund_${"0".repeat(64)}` },
    ])
      await explainCardPurchases({ grant: grant(), sql: w.sql, request });
    await explainCardPurchases({
      grant: grant(),
      sql: recorded(w.sql, { overfull: true }).sql,
      request: {},
    });
    await explainCardPurchases({
      grant: grant({ scopes: { sources: ["vpass"], accounts: "*" } }),
      sql: w.sql,
      request: {},
    });
    await explainCardPurchases({
      grant: grant({ capabilities: ["summary.read"] }),
      sql: w.sql,
      request: {},
    });
    expect(tables(w.db)).toEqual(before);
  });
});
