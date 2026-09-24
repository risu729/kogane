// The current card usage read (src/card-usage.ts) and the Transactions page it
// shares its snapshot currentness with. Seeded through the deployed Vpass and
// MyJCB parsers on CORE migrations 0017+ over the synthetic Layer A stub (see
// card-usage-fixture.ts); every value is synthetic.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CARD_USAGE_PAGE_LIMIT,
  CARD_USAGE_TEXT_BOUND,
  CURRENT_CARD_USAGE_SQL,
  type CurrentCardUsageRow,
  currentCardUsageSql,
} from "../src/index";
import {
  MYJCB_LEDGER_SNAPSHOT_CTES,
  transactionsSql,
  VPASS_STATEMENT_SNAPSHOT_CTES,
} from "../src/sql";
import {
  baseWorld,
  CardStore,
  MYJCB_NAMESPACE,
  myjcbRoot,
  type Parsed,
  PRODUCER,
  TOKEN_A,
  TOKEN_B,
  type UsageRow,
  VPASS_NAMESPACE,
  vpassCard,
} from "./card-usage-fixture";
import { LEGACY_CURRENT_CARD_USAGE_SQL } from "./card-usage-legacy-sql";

const MIGRATIONS = join(import.meta.dir, "../../../packages/storage-d1/migrations/core");
const TOKEN_C = `vpass-card-v1-${"c".repeat(64)}`;

interface TransactionRow {
  id: number;
  source_id: string;
  source_account: string;
  as_of: string | null;
  amount_minor: string | null;
  amount_text: string | null;
  currency: string | null;
  description: string | null;
  counterparty: string | null;
  external_id: string | null;
  status: string | null;
  parser: string;
}

/**
 * One page of current usage. Every scenario below is also a differential
 * check: the page must equal what the shipped query text returns.
 */
function usage(db: Database, afterId = 0, limit = CARD_USAGE_PAGE_LIMIT): CurrentCardUsageRow[] {
  const page = currentCardUsageSql({ afterId, limit });
  const rows = db.query(page.sql).all(...(page.args as never[])) as CurrentCardUsageRow[];
  expect(rows).toEqual(
    db.query(LEGACY_CURRENT_CARD_USAGE_SQL).all(...(page.args as never[])) as CurrentCardUsageRow[],
  );
  return rows;
}

function transactions(db: Database): TransactionRow[] {
  const page = transactionsSql({}, 0);
  return db.query(page.sql).all(...(page.args as never[])) as TransactionRow[];
}

function productionSchema(): Database {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return db;
}

const ids = (rows: readonly { observation_id: number }[]): number[] =>
  rows.map((row) => row.observation_id);

/**
 * The query's per-parse identity lookup agrees with the named
 * `current_identity_observations` view, `current_account_mappings` and
 * `identity_run_contexts`, field by field, including "no identity".
 */
function expectNamedIdentity(db: Database, rows: readonly CurrentCardUsageRow[]): void {
  for (const row of rows) {
    const named = db
      .query(
        `SELECT o.source_account_id, m.account_id, m.status AS account_status,
                o.policy_version, ctx.policy_family
           FROM current_identity_observations o
           JOIN current_account_mappings m ON m.source_account_id = o.source_account_id
           JOIN identity_run_contexts ctx ON ctx.identity_run_id = o.identity_run_id
          WHERE o.kind = 'transaction' AND o.observation_id = ?`,
      )
      .all(row.observation_id);
    expect(named).toEqual(
      row.source_account_id === null
        ? []
        : [
            {
              source_account_id: row.source_account_id,
              account_id: row.account_id,
              account_status: row.account_status,
              policy_version: row.policy_version,
              policy_family: row.policy_family,
            },
          ],
    );
  }
}
const cardTransactionIds = (db: Database): number[] =>
  transactions(db)
    .filter((row) => row.source_id === "vpass" || row.source_id === "myjcb")
    .map((row) => row.id)
    .sort((left, right) => left - right);

describe("the Transactions page composes the shared snapshot currentness", () => {
  test("its rows on the seeded card store are unchanged by the extraction", () => {
    // Pinned from the Transactions query as it was before the MyJCB and Vpass
    // snapshot CTEs moved into shared definitions, on this fixture: [id,
    // source, account, as_of, amount_minor, amount_text, currency,
    // description, counterparty, external_id, status, parser] per row.
    // vpass-statement-page@1.2.0 changed only the parser label and the id of
    // row 7, the one row on a later page (answer-001), which now names it.
    const pinned = [
      '[19,"myjcb","myjcb:conn-a:root","2026-06-02","-300","-300","JPY","1回払い","架空店舗J","myjcb-credit-ledger:unconfirmed:43973f46589c6f9a489c7ed4218dc116:0","unconfirmed","myjcb-credit-ledger@1.1.1"]',
      '[7,"vpass","vpass:card-001","2026-06-02","-3300","-3300","JPY","1回払い","架空店舗E","vpass:card-001:202606:customized:5b6f6dfe410320aa57f741f484c71cae:answer-001:0","unconfirmed","vpass-statement-page@1.2.0"]',
      '[6,"vpass","vpass:card-001","2026-06-01","-1234","-1234","JPY","1回払い","架空店舗D","vpass:card-001:202606:customized:ea8cf62a0b9c5d36f0a122146a2e1a1a:0","unconfirmed","vpass-statement-page@1.2.0"]',
      '[22,"smbc-bank","smbc-bank:ordinary-yen","2026-05-20","-500","-500","JPY","synthetic",null,"synthetic-bank-1","posted","synthetic-bank-history@1"]',
      '[18,"myjcb","myjcb:conn-a:root","2026-05-10","-800","-800","JPY","1回払い","架空店舗I","myjcb-credit-ledger:unconfirmed:bb6bbdd395fa78f7170f01ed1d734c23:0","unconfirmed","myjcb-credit-ledger@1.1.1"]',
      '[5,"vpass","vpass:card-001","2026-05-06",null,null,"JPY","1回払い","架空店舗C","vpass:card-001:202605:web:0702f13a372bb72634d3126c1fd1908a:0","posted","vpass-statement-page@1.2.0"]',
      '[4,"vpass","vpass:card-001","2026-05-05","-5000","-5000","JPY","2回払い","架空店舗B","vpass:card-001:202605:web:1176787a086c350ee4e2c060982565ea:0","posted","vpass-statement-page@1.2.0"]',
      '[3,"vpass","vpass:card-001","2026-05-03","-2000","-2000","JPY","1回払い","架空店舗A","vpass:card-001:202605:web:5ce5da3937a69cfd96ab9fdf5b2ba6a9:0","posted","vpass-statement-page@1.2.0"]',
      '[17,"myjcb","myjcb:conn-a:root","2026-04-21","-4000","-4000","JPY","分割","架空店舗H","myjcb-credit-ledger:confirmed:375466d7e2ff11f3949a2a81daafb267:0","confirmed","myjcb-credit-ledger@1.1.1"]',
      '[16,"myjcb","myjcb:conn-a:root","2026-04-20","-1000","-1000","JPY","1回払い","架空店舗G","myjcb-credit-ledger:confirmed:56609643544b87efe207ed214986fa93:0","confirmed","myjcb-credit-ledger@1.1.1"]',
      '[14,"myjcb","myjcb:conn-a:root","2026-03-15","-2500","-2500","JPY","1回払い","架空店舗L","myjcb-credit-ledger:confirmed:2552391aa286539e07de30e0fe9e530a:0","confirmed","myjcb-credit-ledger@1.1.1"]',
    ];
    const { store } = baseWorld();
    expect(
      transactions(store.db).map((row) =>
        JSON.stringify([
          row.id,
          row.source_id,
          row.source_account,
          row.as_of,
          row.amount_minor,
          row.amount_text,
          row.currency,
          row.description,
          row.counterparty,
          row.external_id,
          row.status,
          row.parser,
        ]),
      ),
    ).toEqual(pinned);
  });

  test("both reads carry the same snapshot CTE text, defined once", () => {
    const transactionsText = transactionsSql({}, 0).sql;
    for (const ctes of [MYJCB_LEDGER_SNAPSHOT_CTES, VPASS_STATEMENT_SNAPSHOT_CTES]) {
      expect(transactionsText).toContain(ctes);
      expect(CURRENT_CARD_USAGE_SQL).toContain(ctes);
    }
    expect(MYJCB_LEDGER_SNAPSHOT_CTES).toContain("current_myjcb_snapshots AS (");
    expect(VPASS_STATEMENT_SNAPSHOT_CTES).toContain("current_vpass_snapshots AS (");
  });
});

describe("current card usage", () => {
  test("compiles on the full production schema and is empty on an empty store", () => {
    const db = productionSchema();
    expect(usage(db)).toEqual([]);
    db.close();
  });

  test("the identity lookup runs once per current parse, after currentness", () => {
    // Per observation, the Vpass binding provenance behind
    // `eligible_identity_runs` was re-checked for every row of every card
    // artifact before the snapshot filter, which grew quadratically with the
    // store (bun:sqlite, 180 synthetic days of captures: about 7 s, now under 0.1 s).
    const db = productionSchema();
    const page = currentCardUsageSql({ afterId: 0, limit: 500 });
    const plan = db.query(`EXPLAIN QUERY PLAN ${page.sql}`).all(...(page.args as never[])) as {
      id: number;
      parent: number;
      detail: string;
    }[];
    const byId = new Map(plan.map((step) => [step.id, step]));
    const within = (step: { parent: number }, detail: string): boolean => {
      for (let at = byId.get(step.parent); at !== undefined; at = byId.get(at.parent))
        if (at.detail === detail) return true;
      return false;
    };
    const details = plan.map((step) => step.detail);
    expect(details).toContain("MATERIALIZE current_rows");
    expect(details).toContain("MATERIALIZE parse_identity");
    const bindingChecks = plan.filter((step) => step.detail.includes("identity_vpass_bindings"));
    expect(bindingChecks.length).toBeGreaterThan(0);
    for (const step of bindingChecks)
      expect(within(step, "MATERIALIZE parse_identity"), step.detail).toBe(true);
    db.close();
  });

  test("current usage equals the Transactions page's current Vpass/MyJCB rows", () => {
    const world = baseWorld();
    const rows = usage(world.store.db);
    expect(ids(rows)).toEqual(cardTransactionIds(world.store.db));
    expect(ids(rows)).toEqual([
      ...world.web202605.observations,
      ...world.customized202606.flatMap((page) => page.observations),
      ...world.confirmed202604.observations,
      ...world.confirmed202605.observations,
      ...world.unconfirmed.observations,
    ]);
    // The same identity fields as the page, row by row; the bank row is not card usage.
    const byId = new Map(transactions(world.store.db).map((row) => [row.id, row]));
    for (const row of rows) {
      const shown = byId.get(row.observation_id)!;
      expect([row.source_id, row.source_account, row.external_id, row.as_of]).toEqual([
        shown.source_id,
        shown.source_account,
        shown.external_id,
        shown.as_of,
      ]);
      expect(row.provider_status).toBe(shown.status);
      // The extra_json paths read the payment type each parser also wrote to `description`.
      expect(row.payment_type).toBe(shown.description);
    }
    expect(ids(rows)).not.toContain(world.bank.observations[0]!);
    expect(rows.every((row) => row.account_id !== null)).toBe(true);
    expectNamedIdentity(world.store.db, rows);
  });

  test("a newer complete card-month snapshot replaces customized rows with web rows", () => {
    const store = new CardStore();
    const card = vpassCard(TOKEN_A, "acct-card-a");
    const capture = (
      family: "web" | "customized",
      fetchedAt: string,
      rows: readonly UsageRow[],
    ): Parsed => {
      const run = store.run("vpass");
      const binding = store.bind(run, "card-001", TOKEN_A);
      const parsed = store.vpassPage({
        run,
        card: "card-001",
        month: "202605",
        family,
        fetchedAt,
        rows,
      });
      store.identify(parsed, card, { version: 2, bindingArtifact: binding, token: TOKEN_A });
      return parsed;
    };
    const pending = capture("customized", "2026-05-10T00:00:00.000Z", [
      { date: "26/05/03", merchant: "架空店舗A", amount: "1,200", paymentType: "1回払い" },
      { date: "26/05/04", merchant: "架空返金A", amount: "-1,500", paymentType: "1回払い" },
    ]);
    expect(
      usage(store.db).map((row) => [
        row.observation_id,
        row.display_state,
        row.provider_status,
        row.provider_family,
        row.provider_sale_code,
        row.coefficient,
      ]),
    ).toEqual([
      [pending.observations[0]!, "pending", "unconfirmed", "customized", "5", "-1200"],
      [pending.observations[1]!, "pending", "unconfirmed", "customized", "6", "1500"],
    ]);

    const posted = capture("web", "2026-06-10T00:00:00.000Z", [
      { date: "26/05/03", merchant: "架空店舗A", amount: "1,234", paymentType: "1回払い" },
    ]);
    const rows = usage(store.db);
    expect(
      rows.map((row) => [
        row.observation_id,
        row.display_state,
        row.provider_status,
        row.provider_family,
        row.provider_sale_code,
        row.coefficient,
      ]),
    ).toEqual([[posted.observations[0]!, "posted", "posted", "web", null, "-1234"]]);
    expect(ids(rows)).toEqual(cardTransactionIds(store.db));
  });

  test("incomplete or unpublished snapshots are not current", () => {
    const world = baseWorld();
    const { store } = world;
    // A capture on a fetch run that did not succeed, published or not, is never current.
    const failedPage = store.vpassPage({
      run: store.run("vpass", "failure"),
      card: "card-001",
      month: "202606",
      family: "web",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      rows: [{ date: "26/06/09", merchant: "架空店舗M", amount: "600", paymentType: "1回払い" }],
    });
    // A newer capture whose second page was never parsed at all.
    const partial = store.run("vpass");
    const partialPage = store.vpassPage({
      run: partial,
      card: "card-001",
      month: "202605",
      family: "web",
      fetchedAt: "2026-07-02T00:00:00.000Z",
      rows: [{ date: "26/05/03", merchant: "架空店舗A", amount: "2,000", paymentType: "1回払い" }],
    });
    store.vpassPage({
      run: partial,
      card: "card-001",
      month: "202605",
      page: "top-001",
      family: "web",
      fetchedAt: "2026-07-02T00:00:00.000Z",
      publication: "none",
      rows: [],
    });

    const current = ids(usage(store.db));
    const never = [
      ...world.incomplete202606.flatMap((page) => page.observations),
      ...world.unpublished202607.observations,
      ...world.unpublishedConfirmed202605.observations,
      ...failedPage.observations,
      ...partialPage.observations,
    ];
    expect(never).toHaveLength(8);
    for (const id of never) expect(current).not.toContain(id);
    // The older complete, published captures of the same slots stay current.
    for (const id of [
      ...world.web202605.observations,
      ...world.customized202606.flatMap((page) => page.observations),
      ...world.confirmed202605.observations,
    ])
      expect(current).toContain(id);
    // Superseded captures are not current either.
    for (const id of [
      ...world.replacedCustomized.observations,
      ...world.olderConfirmed202605.observations,
      ...world.olderUnconfirmed.observations,
    ])
      expect(current).not.toContain(id);
    expect(current).toEqual(cardTransactionIds(store.db));
  });

  test("newest representation of one resolved account and month wins across card ordinals", () => {
    const store = new CardStore();
    const cardA = vpassCard(TOKEN_A, "acct-card-a");
    const row = (date: string, merchant: string, amount: string): UsageRow => ({
      date,
      merchant,
      amount,
      paymentType: "1回払い",
    });
    // 2026-05-10: the card is ordinal card-001; card-005 is fetched but never identified.
    const may = store.run("vpass");
    const mayBinding = store.bind(may, "card-001", TOKEN_A);
    const oldOrdinal = store.vpassPage({
      run: may,
      card: "card-001",
      month: "202605",
      family: "web",
      fetchedAt: "2026-05-10T00:00:00.000Z",
      rows: [row("26/05/03", "架空店舗A", "2,000")],
    });
    const oldOrdinalApril = store.vpassPage({
      run: may,
      card: "card-001",
      month: "202604",
      family: "web",
      fetchedAt: "2026-05-10T00:00:00.000Z",
      rows: [row("26/04/03", "架空店舗W", "900")],
    });
    for (const parsed of [oldOrdinal, oldOrdinalApril])
      store.identify(parsed, cardA, { version: 2, bindingArtifact: mayBinding, token: TOKEN_A });
    const unidentified = store.vpassPage({
      run: may,
      card: "card-005",
      month: "202605",
      family: "web",
      fetchedAt: "2026-05-10T00:00:00.000Z",
      rows: [row("26/05/08", "架空店舗V", "450")],
    });

    // 2026-06-10: the same card (token A) is now card-002; token B is another
    // card; card-004 has no trusted binding and falls back to the default policy.
    const june = store.run("vpass");
    const newOrdinal = store.vpassPage({
      run: june,
      card: "card-002",
      month: "202605",
      family: "web",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      rows: [row("26/05/03", "架空店舗A", "2,000"), row("26/05/09", "架空店舗X", "3,000")],
    });
    store.identify(newOrdinal, cardA, {
      version: 2,
      bindingArtifact: store.bind(june, "card-002", TOKEN_A),
      token: TOKEN_A,
    });
    // A second card (token C) a reviewed mapping resolves to the same account,
    // captured a little later in the same run: one run never shadows itself.
    const cardC = vpassCard(TOKEN_C, "acct-card-c");
    store.mapAccount(cardC);
    store.mapAccount({ ...cardC, account: "acct-card-a" }, "manual");
    const sameRunCard = store.vpassPage({
      run: june,
      card: "card-006",
      month: "202605",
      family: "web",
      fetchedAt: "2026-06-10T00:05:00.000Z",
      rows: [row("26/05/11", "架空店舗U", "1,100")],
    });
    store.identify(
      sameRunCard,
      { ...cardC, account: "acct-card-a" },
      { version: 2, bindingArtifact: store.bind(june, "card-006", TOKEN_C), token: TOKEN_C },
    );
    const otherCard = store.vpassPage({
      run: june,
      card: "card-003",
      month: "202605",
      family: "web",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      rows: [row("26/05/04", "架空店舗Y", "700")],
    });
    store.identify(otherCard, vpassCard(TOKEN_B, "acct-card-b"), {
      version: 2,
      bindingArtifact: store.bind(june, "card-003", TOKEN_B),
      token: TOKEN_B,
    });
    const unbound = store.vpassPage({
      run: june,
      card: "card-004",
      month: "202605",
      family: "web",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      rows: [row("26/05/05", "架空店舗Z", "800")],
    });
    store.identify(
      unbound,
      {
        ref: `sa-card-004-run-${june}`,
        reference: ["vpass:card-004", "fetch-run", String(june)],
        account: `acct-card-004-run-${june}`,
        status: "unresolved",
      },
      { version: 1 },
    );

    // MyJCB: connection conn-a was replaced by conn-b; a reviewed mapping
    // resolves both roots to one account.
    const jcbRow = (date: string, amount: string): UsageRow => ({
      date,
      merchant: "架空店舗J",
      amount,
      paymentType: "1回払い",
    });
    const first = store.run("myjcb");
    const oldConnection = [
      store.myjcbLedger({
        run: first,
        connection: "conn-a",
        detailMonth: 1,
        state: "confirmed",
        period: "202605",
        fetchedAt: "2026-05-12T00:00:00.000Z",
        rows: [jcbRow("2026/04/20", "1,000")],
      }),
      store.myjcbLedger({
        run: first,
        connection: "conn-a",
        detailMonth: 0,
        state: "unconfirmed",
        period: "202606",
        fetchedAt: "2026-05-12T00:00:00.000Z",
        rows: [jcbRow("2026/05/10", "800")],
      }),
    ];
    for (const parsed of oldConnection)
      store.identify(parsed, myjcbRoot("conn-a", "acct-jcb"), { version: 1 });
    const connB = myjcbRoot("conn-b", "acct-jcb-b");
    store.mapAccount(connB);
    store.mapAccount({ ...connB, account: "acct-jcb" }, "manual");
    const second = store.run("myjcb");
    const newConnection = [
      store.myjcbLedger({
        run: second,
        connection: "conn-b",
        detailMonth: 1,
        state: "confirmed",
        period: "202605",
        fetchedAt: "2026-06-12T00:00:00.000Z",
        rows: [jcbRow("2026/04/20", "1,000")],
      }),
      store.myjcbLedger({
        run: second,
        connection: "conn-b",
        detailMonth: 0,
        state: "unconfirmed",
        period: "202607",
        fetchedAt: "2026-06-12T00:00:00.000Z",
        rows: [jcbRow("2026/06/01", "500")],
      }),
    ];
    for (const parsed of newConnection)
      store.identify(parsed, { ...connB, account: "acct-jcb" }, { version: 1 });

    const rows = usage(store.db);
    expect(ids(rows)).toEqual(
      [
        ...oldOrdinalApril.observations,
        ...unidentified.observations,
        ...newOrdinal.observations,
        ...sameRunCard.observations,
        ...otherCard.observations,
        ...unbound.observations,
        ...newConnection.flatMap((parsed) => parsed.observations),
      ].sort((left, right) => left - right),
    );
    // The Transactions page knows no accounts: it still shows both ordinals
    // and both connections, and card usage is exactly that set minus the
    // older representations.
    const shown = cardTransactionIds(store.db);
    const superseded = [
      ...oldOrdinal.observations,
      ...oldConnection.flatMap((parsed) => parsed.observations),
    ];
    expect(shown).toEqual([...ids(rows), ...superseded].sort((left, right) => left - right));

    const view = (id: number) => rows.find((entry) => entry.observation_id === id)!;
    // A binding-resolved Vpass row is distinguishable from one resolved otherwise.
    expect(view(newOrdinal.observations[0]!)).toMatchObject({
      account_id: "acct-card-a",
      policy_version: 2,
      policy_family: "vpass-card-binding",
      snapshot_unit: "card-002",
    });
    expect(view(unbound.observations[0]!)).toMatchObject({
      account_id: `acct-card-004-run-${june}`,
      account_status: "unresolved",
      policy_version: 1,
      policy_family: "identity-default",
    });
    expect(view(unidentified.observations[0]!)).toMatchObject({
      source_account_id: null,
      account_id: null,
      policy_version: null,
      policy_family: null,
      snapshot_unit: "card-005",
    });
    expect(view(newConnection[0]!.observations[0]!)).toMatchObject({
      account_id: "acct-jcb",
      account_status: "aggregate",
      snapshot_unit: "conn-b",
    });
    expectNamedIdentity(store.db, rows);
  });

  test("cursor paging with afterId/limit neither drops nor duplicates rows", () => {
    const world = baseWorld();
    const { store } = world;
    const all = usage(store.db);
    expect(all.length).toBeGreaterThan(4);
    for (const limit of [1, 2, 3, all.length - 1, all.length, all.length + 1]) {
      const pages: CurrentCardUsageRow[][] = [];
      let afterId = 0;
      for (;;) {
        const page = usage(store.db, afterId, limit);
        pages.push(page);
        if (page.length < limit) break;
        afterId = page[page.length - 1]!.observation_id;
      }
      expect(pages.every((page) => page.length <= limit)).toBe(true);
      expect(pages.flat()).toEqual(all);
    }
    const seen = ids(all);
    expect(seen).toEqual([...new Set(seen)].sort((left, right) => left - right));
    // A cursor on a row that is not current still finds every later current row.
    const gap = world.incomplete202606[0].observations[0]!;
    expect(seen).not.toContain(gap);
    expect(usage(store.db, gap)).toEqual(all.filter((row) => row.observation_id > gap));
    expect(usage(store.db, seen[seen.length - 1]!)).toEqual([]);
    for (const bad of [
      { afterId: -1, limit: 10 },
      { afterId: 1.5, limit: 10 },
      { afterId: 0, limit: 0 },
      { afterId: 0, limit: CARD_USAGE_PAGE_LIMIT + 1 },
      { afterId: 0, limit: Number.NaN },
    ])
      expect(() => currentCardUsageSql(bad)).toThrow("read-model:");
    expect(currentCardUsageSql({ afterId: 7, limit: 3 }).args).toEqual([7, 3]);
  });

  test("amounts come back as decimal-v1 fields, not integers", () => {
    const world = baseWorld();
    const rows = usage(world.store.db);
    for (const row of rows) {
      expect(row).not.toHaveProperty("amount_minor");
      expect(row).not.toHaveProperty("amount_text");
      expect(row.unit_ref).toBe("JPY");
      if (row.value_status === "exact") {
        expect(typeof row.coefficient).toBe("string");
        expect(Number.isInteger(row.scale)).toBe(true);
      }
    }
    const view = (id: number) => rows.find((row) => row.observation_id === id)!;
    expect(view(world.web202605.observations[0]!)).toMatchObject({
      value_status: "exact",
      coefficient: "-2000",
      scale: 0,
      value_basis: "agreement",
      unit_ref: "JPY",
    });
    // The amountless web row stays amountless; it is never a zero.
    expect(view(world.web202605.observations[2]!)).toMatchObject({
      value_status: "missing",
      coefficient: null,
      scale: null,
      value_basis: "none",
    });
    // The exact decimal row is what the query returns, whatever it holds.
    const [id] = world.confirmed202605.observations;
    const stored = world.store.db
      .query(
        "SELECT coefficient,scale FROM observation_decimal_values WHERE kind='transaction' AND observation_id=?",
      )
      .get(id!) as { coefficient: string; scale: number };
    expect([view(id!).coefficient, view(id!).scale]).toEqual([stored.coefficient, stored.scale]);
  });

  test("the key, display state and provider extras are what the parsers emit", () => {
    const world = baseWorld();
    const rows = usage(world.store.db);
    for (const row of rows) {
      const namespace = row.source_id === "vpass" ? VPASS_NAMESPACE : MYJCB_NAMESPACE;
      expect([row.producer_id, row.external_id_namespace]).toEqual([PRODUCER, namespace]);
      // The shape of `bank_key` in migration 0044.
      expect(JSON.parse(row.recognition_key!)).toEqual([
        row.source_id,
        row.producer_id,
        row.external_id_namespace,
        row.source_account,
        row.external_id,
      ]);
    }
    const view = (id: number) => rows.find((row) => row.observation_id === id)!;
    expect(view(world.web202605.observations[1]!)).toMatchObject({
      source_id: "vpass",
      provider_status: "posted",
      provider_family: "web",
      display_state: "posted",
      as_of: "2026-05-05",
      statement_period: "202605",
      snapshot_unit: "card-001",
      snapshot_fetched_at: "2026-06-10T00:00:00.000Z",
      payment_type: "2回払い",
      provider_sale_code: null,
      usage_amount_text: null,
    });
    expect(view(world.customized202606[1].observations[0]!)).toMatchObject({
      provider_status: "unconfirmed",
      provider_family: "customized",
      display_state: "pending",
      statement_period: "202606",
      payment_type: "1回払い",
      provider_sale_code: "5",
    });
    // SC04: an installment slice keeps its usage, payment and 今回回数 apart.
    expect(view(world.confirmed202605.observations[1]!)).toMatchObject({
      source_id: "myjcb",
      source_account: "myjcb:conn-a:root",
      provider_status: "confirmed",
      provider_family: "confirmed",
      display_state: "posted",
      statement_period: "202605",
      snapshot_unit: "conn-a",
      payment_type: "分割",
      usage_amount_text: "12,000",
      payment_amount_text: "4,000",
      installment_count_text: "1",
      provider_sale_code: null,
    });
    // The provider period label is returned verbatim; normalizing it is the domain's job.
    expect(view(world.confirmed202604.observations[0]!).statement_period).toBe(
      "2026年4月お支払い分",
    );
    expect(view(world.unconfirmed.observations[1]!)).toMatchObject({
      provider_status: "unconfirmed",
      provider_family: "unconfirmed",
      display_state: "pending",
      statement_period: "202607",
      usage_amount_text: "300",
      payment_amount_text: "300",
      installment_count_text: null,
    });
  });

  test("identical Vpass rows on two pages of one capture are two keys and two current rows", () => {
    // The Vpass parser counts repeated rows per page artifact, so before
    // vpass-statement-page@1.2.0 an identical row on two pages of one
    // customized capture carried one external id and step 4 kept only the
    // later observation. A page after the first now names itself in the id:
    // two keys, both current, exactly the rows the Transactions page lists.
    const store = new CardStore();
    const run = store.run("vpass");
    const binding = store.bind(run, "card-001", TOKEN_A);
    const same: UsageRow = {
      date: "26/05/03",
      merchant: "架空店舗A",
      amount: "500",
      paymentType: "1回払い",
    };
    const pages = [
      store.vpassPage({
        run,
        card: "card-001",
        month: "202605",
        family: "customized",
        fetchedAt: "2026-05-10T00:00:00.000Z",
        rows: [same],
      }),
      store.vpassPage({
        run,
        card: "card-001",
        month: "202605",
        page: "answer-001",
        family: "customized",
        fetchedAt: "2026-05-10T00:00:00.000Z",
        rows: [same],
      }),
    ];
    for (const parsed of pages)
      store.identify(parsed, vpassCard(TOKEN_A, "acct-card-a"), {
        version: 2,
        bindingArtifact: binding,
        token: TOKEN_A,
      });
    const observations = pages.flatMap((page) => page.observations);
    const shown = transactions(store.db).sort((left, right) => left.id - right.id);
    expect(shown.map((row) => row.id)).toEqual(observations);
    // Same row content, so the same fingerprint; only the later page's segment differs.
    const first = shown[0]!.external_id!;
    const later = shown[1]!.external_id!;
    expect(later).toBe(first.replace(/:0$/u, ":answer-001:0"));
    expect(first).toMatch(/^vpass:card-001:202605:customized:[0-9a-f]{32}:0$/u);

    const rows = usage(store.db);
    expect(ids(rows)).toEqual(observations);
    expect(rows.map((row) => row.external_id)).toEqual([first, later]);
    expect(new Set(rows.map((row) => row.recognition_key)).size).toBe(2);
    expect(rows.map((row) => [row.account_id, row.display_state, row.coefficient])).toEqual([
      ["acct-card-a", "pending", "-500"],
      ["acct-card-a", "pending", "-500"],
    ]);
  });

  test("a month that flips family under a new card ordinal leaves no pending row current", () => {
    // Why the Vpass slot is the statement month alone: the customized
    // (pending) capture sits under card-001, the web (posted) capture of the
    // same month under card-002, so step 2 keeps both. A slot that also held
    // the provider state would keep the stale pending row current next to the
    // posted one.
    const store = new CardStore();
    const card = vpassCard(TOKEN_A, "acct-card-a");
    const may = store.run("vpass");
    const pending = store.vpassPage({
      run: may,
      card: "card-001",
      month: "202605",
      family: "customized",
      fetchedAt: "2026-05-10T00:00:00.000Z",
      rows: [{ date: "26/05/03", merchant: "架空店舗A", amount: "1,200", paymentType: "1回払い" }],
    });
    store.identify(pending, card, {
      version: 2,
      bindingArtifact: store.bind(may, "card-001", TOKEN_A),
      token: TOKEN_A,
    });
    const june = store.run("vpass");
    const binding = store.bind(june, "card-002", TOKEN_A);
    const posted = store.vpassPage({
      run: june,
      card: "card-002",
      month: "202605",
      family: "web",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      rows: [{ date: "26/05/03", merchant: "架空店舗A", amount: "1,234", paymentType: "1回払い" }],
    });
    // Until identity runs for the new ordinal its rows resolve to no account,
    // so they cannot shadow anything yet: both captures are current.
    expect(usage(store.db).map((row) => [row.observation_id, row.account_id])).toEqual([
      [pending.observations[0]!, "acct-card-a"],
      [posted.observations[0]!, null],
    ]);
    store.identify(posted, card, { version: 2, bindingArtifact: binding, token: TOKEN_A });
    expect(
      usage(store.db).map((row) => [row.observation_id, row.display_state, row.snapshot_unit]),
    ).toEqual([[posted.observations[0]!, "posted", "card-002"]]);
    // The Transactions page knows no accounts and still lists both ordinals.
    expect(cardTransactionIds(store.db)).toEqual([...pending.observations, ...posted.observations]);
  });

  test("a MyJCB confirmed capture never retires the unconfirmed capture; a newer unconfirmed one does", () => {
    // Plan §4: stale unconfirmed snapshots coexist with confirmed ones. The
    // states are separate slots, reported as pending and posted, never summed.
    const store = new CardStore();
    const root = myjcbRoot("conn-a", "acct-jcb");
    const usageRow: UsageRow = {
      date: "2026/05/10",
      merchant: "架空店舗I",
      amount: "800",
      paymentType: "1回払い",
      other: "800",
    };
    const pending = store.myjcbLedger({
      run: store.run("myjcb"),
      connection: "conn-a",
      detailMonth: 0,
      state: "unconfirmed",
      period: "202606",
      fetchedAt: "2026-05-20T00:00:00.000Z",
      rows: [usageRow],
    });
    store.identify(pending, root, { version: 1 });
    const posted = store.myjcbLedger({
      run: store.run("myjcb"),
      connection: "conn-a",
      detailMonth: 1,
      state: "confirmed",
      period: "202606",
      fetchedAt: "2026-06-12T00:00:00.000Z",
      rows: [usageRow],
    });
    store.identify(posted, root, { version: 1 });
    expect(usage(store.db).map((row) => [row.observation_id, row.display_state])).toEqual([
      [pending.observations[0]!, "pending"],
      [posted.observations[0]!, "posted"],
    ]);
    // An empty newer unconfirmed capture is a complete snapshot of "nothing pending".
    store.myjcbLedger({
      run: store.run("myjcb"),
      connection: "conn-a",
      detailMonth: 0,
      state: "unconfirmed",
      period: "202607",
      fetchedAt: "2026-06-20T00:00:00.000Z",
      rows: [],
    });
    expect(ids(usage(store.db))).toEqual(posted.observations);
    expect(ids(usage(store.db))).toEqual(cardTransactionIds(store.db));
  });

  test("identity equals the named views for every mapping status and policy fallback", () => {
    const store = new CardStore();
    const run = store.run("vpass");
    const page = (card: string): Parsed =>
      store.vpassPage({
        run,
        card,
        month: "202605",
        family: "web",
        fetchedAt: "2026-06-10T00:00:00.000Z",
        rows: [
          { date: "26/05/03", merchant: "架空店舗A", amount: "2,000", paymentType: "1回払い" },
        ],
      });
    const perRun = (card: string) => ({
      ref: `sa-${card}-run-${run}`,
      reference: [`vpass:${card}`, "fetch-run", String(run)],
      account: `acct-${card}-run-${run}`,
      status: "unresolved" as const,
    });
    // card-001: v1 and v2 sealed, so v2 (the binding family) wins; its mapping
    // is then superseded by a manual `identified` revision.
    const bindingA = store.bind(run, "card-001", TOKEN_A);
    const bound = page("card-001");
    store.identify(bound, perRun("card-001"), { version: 1 });
    const cardA = vpassCard(TOKEN_A, "acct-card-a");
    store.identify(bound, cardA, { version: 2, bindingArtifact: bindingA, token: TOKEN_A });
    store.mapAccount({ ...cardA, account: "acct-card-a-reviewed", status: "identified" }, "manual");
    // card-002: the v2 run is not sealed, so the sealed v1 run organizes it.
    const bindingB = store.bind(run, "card-002", TOKEN_B);
    const unsealed = page("card-002");
    store.identify(unsealed, perRun("card-002"), { version: 1 });
    store.identify(
      unsealed,
      vpassCard(TOKEN_B, "acct-card-b"),
      { version: 2, bindingArtifact: bindingB, token: TOKEN_B },
      false,
    );
    // card-003: the v2 run was sealed, then its binding run was excluded, so
    // `eligible_identity_runs` drops it and the v1 run organizes it again.
    const bindingC = store.bind(run, "card-003", TOKEN_C);
    const excluded = page("card-003");
    store.identify(excluded, perRun("card-003"), { version: 1 });
    store.identify(excluded, vpassCard(TOKEN_C, "acct-card-c"), {
      version: 2,
      bindingArtifact: bindingC,
      token: TOKEN_C,
    });
    const beforeExclusion = usage(store.db).find(
      (row) => row.observation_id === excluded.observations[0],
    );
    expect(beforeExclusion?.policy_family).toBe("vpass-card-binding");
    store.excludeBinding(bindingC);
    // card-004: never identified.
    const none = page("card-004");
    const ledger = store.myjcbLedger({
      run: store.run("myjcb"),
      connection: "conn-a",
      detailMonth: 1,
      state: "confirmed",
      period: "202605",
      fetchedAt: "2026-06-12T00:00:00.000Z",
      rows: [
        { date: "2026/04/20", merchant: "架空店舗G", amount: "1,000", paymentType: "1回払い" },
      ],
    });
    store.identify(ledger, myjcbRoot("conn-a", "acct-jcb"), { version: 1 });

    const rows = usage(store.db);
    const view = (parsed: Parsed) =>
      rows.find((row) => row.observation_id === parsed.observations[0])!;
    const identity = (row: CurrentCardUsageRow) => [
      row.account_id,
      row.account_status,
      row.policy_version,
      row.policy_family,
    ];
    expect(identity(view(bound))).toEqual([
      "acct-card-a-reviewed",
      "identified",
      2,
      "vpass-card-binding",
    ]);
    expect(identity(view(unsealed))).toEqual([
      `acct-card-002-run-${run}`,
      "unresolved",
      1,
      "identity-default",
    ]);
    expect(identity(view(excluded))).toEqual([
      `acct-card-003-run-${run}`,
      "unresolved",
      1,
      "identity-default",
    ]);
    expect(identity(view(none))).toEqual([null, null, null, null]);
    expect(identity(view(ledger))).toEqual(["acct-jcb", "aggregate", 1, "identity-default"]);
    expectNamedIdentity(store.db, rows);
  });

  test("provider extras are NULL, never an error, for malformed, non-text, empty or oversized values", () => {
    const store = new CardStore();
    const run = store.run("vpass");
    const binding = store.bind(run, "card-001", TOKEN_A);
    const page = store.vpassPage({
      run,
      card: "card-001",
      month: "202605",
      family: "customized",
      fetchedAt: "2026-05-10T00:00:00.000Z",
      rows: [{ date: "26/05/03", merchant: "架空店舗A", amount: "2,000", paymentType: "1回払い" }],
    });
    store.identify(page, vpassCard(TOKEN_A, "acct-card-a"), {
      version: 2,
      bindingArtifact: binding,
      token: TOKEN_A,
    });
    const customized = (row: Record<string, unknown>, kogane: Record<string, unknown> = {}) =>
      JSON.stringify({ ...row, _kogane: { statementFamily: "customized", ...kogane } });
    const malformed = store.appendRow(page, {
      externalId: "synthetic-malformed",
      extraJson: '{"_kogane":{"statementFamily":"customized"',
    });
    const oversized = store.appendRow(page, {
      externalId: "synthetic-oversized",
      extraJson: customized(
        { bunkatsuYaku: "x".repeat(CARD_USAGE_TEXT_BOUND + 1) },
        { statementMonth: 202605, providerSaleCode: "" },
      ),
    });
    const atBound = store.appendRow(page, {
      externalId: "synthetic-at-bound",
      extraJson: customized({ bunkatsuYaku: "y".repeat(CARD_USAGE_TEXT_BOUND) }),
    });
    // Rows without an external id have no key and are never merged.
    const keyless = [
      store.appendRow(page, { externalId: null, extraJson: "{}" }),
      store.appendRow(page, { externalId: null, extraJson: "{}" }),
    ];

    const rows = usage(store.db);
    expect(ids(rows)).toEqual([...page.observations, malformed, oversized, atBound, ...keyless]);
    const view = (id: number) => rows.find((row) => row.observation_id === id)!;
    const extras = (row: CurrentCardUsageRow) => [
      row.provider_family,
      row.statement_period,
      row.payment_type,
      row.provider_sale_code,
    ];
    expect(extras(view(page.observations[0]!))).toEqual(["customized", "202605", "1回払い", "5"]);
    expect(extras(view(malformed))).toEqual([null, null, null, null]);
    expect(extras(view(oversized))).toEqual(["customized", null, null, null]);
    expect(view(atBound).payment_type).toBe("y".repeat(CARD_USAGE_TEXT_BOUND));
    for (const id of keyless) expect(view(id).recognition_key).toBeNull();
  });
});
