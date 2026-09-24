// The card purchase explanation read (src/query/card-purchases.ts) on every
// CORE migration, with purchases written by the guarded recognition builder
// and statements, bank debits and settlement reviews seeded the way their own
// writers store them (card-purchase-world.ts). Synthetic values only.
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { classifyCardUsage, type CardUsageFact } from "../../domain/src/card-purchase.ts";
import { exactQuantity } from "../../domain/src/values.ts";
import { currentCardUsageSql, type CurrentCardUsageRow } from "../../read-model/src/card-usage.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { baseWorld, PRODUCER, VPASS_NAMESPACE } from "../../read-model/test/card-usage-fixture.ts";
import { factOf } from "../../storage-d1/test/card-purchase-fixture.ts";
import { CARD_PURCHASE_PAGE_SIZE, queryCardPurchases } from "../src/query/card-purchases.ts";
import { PurchaseWorld, recognise } from "./card-purchase-world.ts";

const worlds: { close(): void }[] = [];
function world(): PurchaseWorld {
  const created = new PurchaseWorld();
  worlds.push(created);
  return created;
}
afterEach(() => {
  for (const created of worlds.splice(0)) created.close();
});

const jpy = (coefficient: string) => ({
  unitRef: "JPY",
  value: { status: "exact", value: { coefficient, scale: 0 } },
});

/** Every row of every table a read could conceivably touch, to prove it wrote nothing. */
function tables(db: Database): Record<string, number> {
  return Object.fromEntries(
    [
      "decision_revisions",
      "economic_event_revisions",
      "economic_legs",
      "allocations",
      "card_purchase_recognitions",
      "card_purchase_recognition_keys",
      "card_settlement_candidates",
      "card_settlement_decisions",
    ].map((table) => [
      table,
      (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  );
}

describe("card purchase explanation", () => {
  test("the chain reaches the statement, the accepted settlement and the bank debit", async () => {
    const w = world();
    const eventId = await w.recognise(factOf(1));
    const statement = w.statement({
      source: "vpass",
      sourceAccount: "vpass:card-001",
      accountId: "acct-card",
      period: "2026-09",
      total: 1734,
      paymentDate: "2026-10-10",
    });
    const bank = w.bankDebit(1734);
    const settled = w.settle({
      statement,
      bank,
      source: "vpass",
      accountId: "acct-card",
      period: "2026-09",
      total: 1734,
      status: "accepted",
    });
    const before = tables(w.db);
    const page = await queryCardPurchases(w.sql);
    expect(tables(w.db)).toEqual(before);
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(item).toMatchObject({
      eventId,
      kind: "purchase",
      state: "captured",
      sourceId: "vpass",
      accountId: "acct-card",
      usageDate: "2026-08-15",
      statementPeriod: "2026-09",
      amount: jpy("1234"),
      lastKnownAmount: jpy("1234"),
      statement: {
        status: "linked",
        ref: {
          kind: "balance",
          id: `balance:${statement.observationId}`,
          revision: `parse_run:${statement.parseRunId}`,
        },
        period: "2026-09",
        paymentDate: { kind: "local-date", value: "2026-10-10" },
        providerTotal: jpy("1734"),
      },
      settlement: {
        proposalId: settled.proposalId,
        reviewStatus: "accepted",
        settlementEventId: settled.eventId,
        allocationId: settled.allocationId,
        bankDebit: {
          ref: {
            kind: "transaction",
            id: `transaction:${bank.observationId}`,
            revision: `parse_run:${bank.parseRunId}`,
          },
          sourceId: "smbc-bank",
          amount: jpy("1734"),
          occurred: { kind: "local-date", value: "2026-10-10" },
        },
      },
      sourceRows: [
        {
          role: "posted",
          ref: { kind: "transaction", id: "transaction:1", revision: "parse_run:1" },
          usageDate: "2026-08-15",
          counterparty: "synthetic merchant",
          current: false,
          rawLocator: "json:$.rows[0]",
        },
      ],
      history: [{ revision: 1, action: "recognize", state: "captured" }],
      historyTruncated: false,
    });
    expect(item!.explanationRefs).toEqual(
      expect.arrayContaining([
        `event:${eventId}@1`,
        `leg:${eventId}@1#0`,
        "transaction:1@parse_run:1",
        `balance:${statement.observationId}@parse_run:${statement.parseRunId}`,
        `card-settlement:${settled.proposalId}`,
        `event:${settled.eventId}`,
        `allocation:${settled.allocationId}`,
        `transaction:${bank.observationId}@parse_run:${bank.parseRunId}`,
      ]),
    );
    // The statement total sits beside the figures; nothing compares or subtracts it.
    expect(page.summary.statementTotals).toEqual([
      {
        sourceId: "vpass",
        accountId: "acct-card",
        period: "2026-09",
        ref: {
          kind: "balance",
          id: `balance:${statement.observationId}`,
          revision: `parse_run:${statement.parseRunId}`,
        },
        total: exactQuantity("JPY", { coefficient: "1734", scale: 0 }, "decimal-v1"),
      },
    ]);
    expect(JSON.stringify(page)).not.toMatch(/difference|remaining|unexplained/iu);
    expect(page.coverage).toEqual({
      scope: "card-purchase-recognition",
      completeTransactionHistory: false,
      unsupportedShapes: expect.arrayContaining([
        "payment_type_unsupported",
        "installment_amount_differs",
      ]),
      unrecognizedCurrentRows: 0,
      limit: CARD_PURCHASE_PAGE_SIZE,
    });
  });

  test("an accepted settlement leaves the captured figure unchanged", async () => {
    const w = world();
    await w.recognise(factOf(1));
    await w.recognise(factOf(5));
    const before = await queryCardPurchases(w.sql);
    const statement = w.statement({
      source: "vpass",
      sourceAccount: "vpass:card-001",
      accountId: "acct-card",
      period: "2026-09",
      total: 1234,
      paymentDate: "2026-10-10",
    });
    w.settle({
      statement,
      bank: w.bankDebit(1234),
      source: "vpass",
      accountId: "acct-card",
      period: "2026-09",
      total: 1234,
      status: "accepted",
    });
    const after = await queryCardPurchases(w.sql);
    expect(before.summary.units).toEqual([
      {
        unitRef: "JPY",
        captured: expect.objectContaining({
          value: expect.objectContaining({ value: { coefficient: "1734", scale: 0 } }),
        }),
        authorized: expect.objectContaining({
          value: expect.objectContaining({ value: { coefficient: "0", scale: 0 } }),
        }),
        capturedRefunds: expect.anything(),
        authorizedRefunds: expect.anything(),
      },
    ]);
    expect(after.summary.units).toEqual(before.summary.units);
    expect(after.summary.settlementAddsPurchaseExpense).toBe(false);
    // The settlement event is a cash movement, not a purchase: it is not listed.
    expect(after.items.map((item) => item.kind)).toEqual(["purchase", "purchase"]);
    expect(after.summary.events).toBe(2);
    const purchaseCash = w.db
      .query(
        `SELECT count(*) AS n FROM economic_legs l JOIN card_purchase_recognitions c
          ON c.event_id=l.event_id AND c.revision=l.revision WHERE l.basis<>'purchase-recognition'`,
      )
      .get() as { n: number };
    expect(purchaseCash.n).toBe(0);
  });

  test("authorized and captured are never summed, and refunds stay apart", async () => {
    const w = world();
    await w.recognise(factOf(1));
    const pending = await w.recognise(factOf(2));
    await w.recognise(w.usage({ externalId: "vpass:card-001:202608:web:refund:0", amount: 300 }));
    const page = await queryCardPurchases(w.sql);
    expect(page.summary.units).toHaveLength(1);
    const unit = page.summary.units[0]!;
    expect(Object.keys(unit).sort()).toEqual([
      "authorized",
      "authorizedRefunds",
      "captured",
      "capturedRefunds",
      "unitRef",
    ]);
    expect(unit.captured.value).toMatchObject({ value: { coefficient: "1234", scale: 0 } });
    expect(unit.authorized.value).toMatchObject({ value: { coefficient: "1200", scale: 0 } });
    expect(unit.capturedRefunds.value).toMatchObject({ value: { coefficient: "300", scale: 0 } });
    expect(unit.authorizedRefunds.value).toMatchObject({ value: { coefficient: "0", scale: 0 } });
    expect(JSON.stringify(page.summary)).not.toContain('"2434"');
    expect(JSON.stringify(page.summary)).not.toContain('"934"');
    const item = page.items.find((entry) => entry.eventId === pending)!;
    expect(item).toMatchObject({
      state: "authorized",
      amount: jpy("1200"),
      statement: { status: "unlinked", reasonCode: "not_posted" },
      settlement: null,
      sourceRows: [{ role: "pending" }],
    });
    expect(page.items.find((entry) => entry.kind === "refund")).toMatchObject({
      state: "captured",
      amount: jpy("300"),
    });
  });

  test("a retired pending row is unresolved, keeps its last known amount and adds nothing", async () => {
    const w = world();
    await w.recognise(factOf(1));
    const pending = await w.recognise(factOf(2));
    await w.retire(pending);
    const page = await queryCardPurchases(w.sql);
    const item = page.items.find((entry) => entry.eventId === pending)!;
    expect(item).toMatchObject({
      revision: 2,
      state: "unknown",
      unknownReason: "provider_status_absent",
      amount: null,
      lastKnownAmount: jpy("1200"),
      statement: { status: "unlinked", reasonCode: "not_posted" },
      history: [
        {
          revision: 2,
          action: "retire",
          state: "unknown",
          unknownReason: "provider_status_absent",
        },
        { revision: 1, action: "recognize", state: "authorized", unknownReason: null },
      ],
    });
    expect(item.history[0]!.decisionRevisionId).toMatch(/^dr_cp_[0-9a-f]{64}$/u);
    expect(page.summary.unresolved).toBe(1);
    expect(page.summary.units[0]!.authorized.value).toMatchObject({
      value: { coefficient: "0", scale: 0 },
    });
    expect(page.summary.units[0]!.captured.value).toMatchObject({
      value: { coefficient: "1234", scale: 0 },
    });
  });

  test("a revision is listed newest first and the live amount is the newest one", async () => {
    const w = world();
    const eventId = await w.recognise(factOf(1));
    await w.revise(eventId, factOf(4));
    const [item] = (await queryCardPurchases(w.sql, { eventId })).items;
    expect(item).toMatchObject({
      revision: 2,
      amount: jpy("1300"),
      history: [
        { revision: 2, action: "revise" },
        { revision: 1, action: "recognize" },
      ],
      sourceRows: [{ ref: { id: "transaction:4", revision: "parse_run:3" } }],
    });
  });

  test("a missing statement is a reason, never a zero total", async () => {
    const w = world();
    const posted = await w.recognise(factOf(1));
    const noPeriod = await w.recognise(
      w.usage({ externalId: "vpass:card-001:x:web:row-p:0", statementPeriod: "detailMonth-1" }),
    );
    // A statement whose own source account is not resolved joins nothing.
    w.statement({
      source: "vpass",
      sourceAccount: "vpass:card-001",
      accountId: null,
      period: "2026-09",
      total: 1234,
      paymentDate: "2026-10-10",
    });
    const page = await queryCardPurchases(w.sql);
    expect(page.items.find((item) => item.eventId === posted)).toMatchObject({
      statement: { status: "unlinked", reasonCode: "statement_not_collected" },
      settlement: null,
    });
    expect(page.items.find((item) => item.eventId === noPeriod)).toMatchObject({
      statementPeriod: null,
      statement: { status: "unlinked", reasonCode: "period_unrecognized" },
      settlement: null,
    });
    expect(page.summary.statementTotals).toEqual([]);
    expect(JSON.stringify(page)).not.toContain("providerTotal");
  });

  test("a changed card ordinal joins the statement by resolved account", async () => {
    const w = world();
    const eventId = await w.recognise(factOf(1));
    // Another card of another account in the same month is not this purchase's statement.
    w.statement({
      source: "vpass",
      sourceAccount: "vpass:card-003",
      accountId: "acct-card-2",
      period: "2026-09",
      total: 999,
      paymentDate: "2026-10-10",
      recordedAtMs: 5000,
    });
    const older = w.statement({
      source: "vpass",
      sourceAccount: "vpass:card-001",
      accountId: "acct-card",
      period: "2026-09",
      total: 1000,
      paymentDate: "2026-10-10",
      recordedAtMs: 2000,
    });
    const renumbered = w.statement({
      source: "vpass",
      sourceAccount: "vpass:card-002",
      accountId: "acct-card",
      period: "2026-09",
      total: 1234,
      paymentDate: "2026-10-10",
      recordedAtMs: 4000,
    });
    const [item] = (await queryCardPurchases(w.sql, { eventId })).items;
    expect(item!.statement).toMatchObject({
      status: "linked",
      ref: { id: `balance:${renumbered.observationId}` },
      providerTotal: jpy("1234"),
    });
    expect(JSON.stringify(item)).not.toContain(`balance:${older.observationId}@`);
    // A proposed review of that statement is named, without a bank debit or allocation.
    const proposed = w.settle({
      statement: renumbered,
      bank: w.bankDebit(1234),
      source: "vpass",
      accountId: "acct-card",
      period: "2026-09",
      total: 1234,
      status: "proposed",
    });
    const [reviewed] = (await queryCardPurchases(w.sql, { eventId })).items;
    expect(reviewed!.settlement).toEqual({
      proposalId: proposed.proposalId,
      reviewStatus: "proposed",
      decisionRevisionId: null,
      settlementEventId: null,
      allocationId: null,
      bankDebit: null,
    });
  });

  test("an accepted review is preferred to a newer rejected one", async () => {
    const w = world();
    const eventId = await w.recognise(factOf(5));
    const statement = w.statement({
      source: "myjcb",
      sourceAccount: "myjcb:connection-a:root",
      accountId: "acct-jcb",
      period: "2026-09",
      total: 500,
      paymentDate: "2026-09-10",
    });
    const accepted = w.settle({
      statement,
      bank: w.bankDebit(500),
      source: "myjcb",
      accountId: "acct-jcb",
      period: "2026-09",
      total: 500,
      status: "accepted",
      createdAt: "2026-09-11T00:00:00Z",
    });
    w.settle({
      statement,
      bank: w.bankDebit(500),
      source: "myjcb",
      accountId: "acct-jcb",
      period: "2026-09",
      total: 500,
      status: "rejected",
      createdAt: "2026-09-12T00:00:00Z",
    });
    const [item] = (await queryCardPurchases(w.sql, { eventId })).items;
    expect(item!.statement).toMatchObject({ status: "linked", period: "2026-09" });
    expect(item!.settlement).toMatchObject({
      proposalId: accepted.proposalId,
      reviewStatus: "accepted",
      allocationId: accepted.allocationId,
    });
  });

  test("paging neither drops nor duplicates, and the figures cover the whole filter", async () => {
    const w = world();
    const ids: string[] = [];
    for (let index = 0; index < 60; index++)
      ids.push(
        await w.recognise(
          w.usage({
            externalId: `vpass:card-001:202608:web:row-${index}:0`,
            amount: -(index + 1),
            usageDate: `2026-08-${String((index % 28) + 1).padStart(2, "0")}`,
          }),
        ),
      );
    const first = await queryCardPurchases(w.sql);
    const second = await queryCardPurchases(w.sql, { offset: first.nextOffset! });
    expect(first.items).toHaveLength(CARD_PURCHASE_PAGE_SIZE);
    expect(first.nextOffset).toBe(CARD_PURCHASE_PAGE_SIZE);
    expect(second.items).toHaveLength(10);
    expect(second.nextOffset).toBeNull();
    const seen = [...first.items, ...second.items].map((item) => item.eventId);
    expect(new Set(seen).size).toBe(60);
    expect(new Set(seen)).toEqual(new Set(ids));
    const dates = [...first.items, ...second.items].map((item) => item.usageDate);
    expect(dates).toEqual([...dates].sort().reverse());
    // 1 + 2 + … + 60, on both pages alike.
    expect(first.summary).toEqual(second.summary);
    expect(first.summary.events).toBe(60);
    expect(first.summary.units[0]!.captured.value).toMatchObject({
      value: { coefficient: "1830", scale: 0 },
    });
    expect((await queryCardPurchases(w.sql, { offset: 60 })).items).toEqual([]);
  });

  test("a statement period and an exact event id narrow the read", async () => {
    const w = world();
    const september = await w.recognise(factOf(1));
    await w.recognise(
      w.usage({ externalId: "vpass:card-001:202610:web:row-o:0", statementPeriod: "202610" }),
    );
    const filtered = await queryCardPurchases(w.sql, { period: "2026-09" });
    expect(filtered.items.map((item) => item.eventId)).toEqual([september]);
    expect(filtered.summary.events).toBe(1);
    const empty = await queryCardPurchases(w.sql, { period: "2026-11" });
    expect(empty.items).toEqual([]);
    expect(empty.summary).toMatchObject({ units: [], unresolved: 0, events: 0 });
    expect((await queryCardPurchases(w.sql, { eventId: september })).items).toHaveLength(1);
    expect(
      (await queryCardPurchases(w.sql, { eventId: `purchase_${"0".repeat(64)}` })).items,
    ).toEqual([]);
    await expect(queryCardPurchases(w.sql, { offset: -1 })).rejects.toThrow("invalid_offset");
    await expect(queryCardPurchases(w.sql, { period: "2026-13" })).rejects.toThrow(
      "invalid_period",
    );
    await expect(queryCardPurchases(w.sql, { eventId: "purchase_1" })).rejects.toThrow(
      "invalid_event_id",
    );
  });
});

/** The read model's current row as the recognition writer reads it. */
function factFrom(row: CurrentCardUsageRow): CardUsageFact {
  return {
    observationId: row.observation_id,
    parseRunId: row.parse_run_id,
    sourceId: row.source_id,
    producerId: row.producer_id,
    externalIdNamespace: row.external_id_namespace,
    sourceAccount: row.source_account,
    externalId: row.external_id,
    accountId: row.account_id,
    identityPolicyFamily: row.policy_family,
    providerStatus: row.provider_status,
    amount:
      row.value_status === "exact" && row.coefficient !== null && row.scale !== null
        ? exactQuantity(
            row.unit_ref ?? "JPY",
            { coefficient: row.coefficient, scale: row.scale },
            "decimal-v1",
          )
        : {
            unitRef: row.unit_ref ?? "JPY",
            value: { status: "missing", reasonCode: "synthetic" },
          },
    usageDate: row.as_of,
    paymentType: row.payment_type,
    statementPeriod: row.statement_period,
    providerSaleCode: row.provider_sale_code,
    usageAmountText: row.usage_amount_text,
    paymentAmountText: row.payment_amount_text,
    newestRepresentation: true,
  };
}

describe("current provider rows", () => {
  test("rows the provider still shows are current, and unrecognised current rows are counted", async () => {
    // The read model's snapshot world: published captures, a Vpass month that
    // flipped from pending to posted, installment and amountless rows.
    const { store, replacedCustomized } = baseWorld();
    const db = store.db;
    try {
      const sql: SqlExecutor = {
        all: async <T>(query: string, args: readonly unknown[]) =>
          db.query(query).all(...(args as never[])) as T[],
        first: async <T>(query: string, args: readonly unknown[]) =>
          (db.query(query).get(...(args as never[])) as T | null) ?? null,
      };
      const page = currentCardUsageSql({ afterId: 0, limit: 1000 });
      const rows = db.query(page.sql).all(...(page.args as never[])) as CurrentCardUsageRow[];
      const recognisable = rows.map(factFrom).filter((fact) => classifyCardUsage(fact).ok);
      expect(recognisable.length).toBeGreaterThan(0);
      expect(recognisable.length).toBeLessThan(rows.length);
      for (const fact of recognisable) await recognise(db, fact);
      // A pending sale of the month the web capture replaced: no longer displayed.
      const vanished = db
        .query(
          `SELECT t.id,t.parse_run_id,t.source_account,t.external_id,t.as_of,
            json_extract(t.extra_json,'$.bunkatsuYaku') AS payment_type,
            json_extract(t.extra_json,'$._kogane.statementMonth') AS statement_period,
            d.coefficient,d.scale
           FROM transaction_observations t JOIN observation_decimal_values d
            ON d.kind='transaction' AND d.observation_id=t.id
           WHERE t.parse_run_id=? AND t.status='unconfirmed' AND t.amount_minor<0`,
        )
        .get(replacedCustomized.parse) as {
        id: number;
        parse_run_id: number;
        source_account: string;
        external_id: string;
        as_of: string;
        payment_type: string;
        statement_period: string;
        coefficient: string;
        scale: number;
      };
      const replaced = await recognise(db, {
        observationId: vanished.id,
        parseRunId: vanished.parse_run_id,
        sourceId: "vpass",
        producerId: PRODUCER,
        externalIdNamespace: VPASS_NAMESPACE,
        sourceAccount: vanished.source_account,
        externalId: vanished.external_id,
        accountId: "acct-card-a",
        identityPolicyFamily: "vpass-card-binding",
        providerStatus: "unconfirmed",
        amount: exactQuantity(
          "JPY",
          { coefficient: vanished.coefficient, scale: vanished.scale },
          "decimal-v1",
        ),
        usageDate: vanished.as_of,
        paymentType: vanished.payment_type,
        statementPeriod: vanished.statement_period,
        providerSaleCode: "5",
        usageAmountText: null,
        paymentAmountText: null,
        newestRepresentation: true,
      });
      const result = await queryCardPurchases(sql);
      expect(result.coverage.unrecognizedCurrentRows).toBe(rows.length - recognisable.length);
      expect(result.items).toHaveLength(recognisable.length + 1);
      for (const item of result.items)
        expect(item.sourceRows.every((row) => row.current)).toBe(item.eventId !== replaced);
      expect(result.items.find((item) => item.eventId === replaced)).toMatchObject({
        state: "authorized",
        statement: { status: "unlinked", reasonCode: "not_posted" },
        sourceRows: [{ role: "pending", current: false }],
      });
    } finally {
      db.close();
    }
  });
});
