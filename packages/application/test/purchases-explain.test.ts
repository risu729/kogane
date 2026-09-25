// `kogane.purchases.explain` (src/query/purchases-explain.ts): the operator's
// card purchase page, for an agent, on every CORE migration with purchases
// written by the guarded recognition builder, a statement settled by an
// accepted bank debit and a stage-B pending-to-posted candidate stored the way
// the matcher stores one (card-purchase-world.ts). Synthetic values only.
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { SourceFactRef } from "../../domain/src/events.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import {
  validAgentCardPurchasePage,
  validCardPurchasePage,
} from "../../observation-shared/src/card-purchase-contract.ts";
import { ERROR_STATUS } from "../src/errors.ts";
import { queryCardPurchases } from "../src/query/card-purchases.ts";
import {
  explainCardPurchases,
  parsePurchasesExplainRequest,
  type PurchasesExplainOutcome,
  withoutReviewAffordances,
} from "../src/query/purchases-explain.ts";
import { PurchaseWorld } from "./card-purchase-world.ts";
import { grant } from "./fixture.ts";

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
 * settled by an accepted SMBC debit. The pair is MyJCB's: a Vpass pending
 * row is not recognised until the meaning of its payment-type field
 * (`bunkatsuYaku`) is verified.
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
