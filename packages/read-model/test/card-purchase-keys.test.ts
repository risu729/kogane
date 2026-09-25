// Recognition keys against current card usage (src/card-purchase-keys.ts):
// which live keys lost their provider row, and how many current rows no live
// revision holds. Rows come from the deployed Vpass and MyJCB parsers through
// the card store fixture; revisions are written through the guarded 0047
// batch builder, exactly as the purchase-recognition writer writes them. Every
// value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  cardPurchaseEventId,
  cardPurchaseRetirement,
  cardPurchaseRevision,
  classifyCardUsage,
  recognitionKey,
  type CardPurchaseDraft,
  type CardUsageFact,
} from "../../domain/src/card-purchase.ts";
import { exactQuantity, normalizeDecimal } from "../../domain/src/values.ts";
import { cardPurchaseRecognitionWrites } from "../../storage-d1/src/atomic/card-purchase-recognition.ts";
import {
  type CurrentCardUsageRow,
  currentCardUsageSql,
  type PageSql,
  STALE_CARD_PURCHASE_KEY_LIMIT,
  type StaleCardPurchaseKeyRow,
  staleCardPurchaseKeysSql,
  type UnrecognizedCardUsageCountRow,
  unrecognizedCardUsageCountSql,
} from "../src/index";
import {
  CardStore,
  myjcbRoot,
  type Parsed,
  TOKEN_A,
  type UsageRow,
  vpassCard,
} from "./card-usage-fixture";
import {
  LEGACY_CURRENT_CARD_USAGE_SQL,
  LEGACY_STALE_CARD_PURCHASE_KEYS_SQL,
  LEGACY_UNRECOGNIZED_CARD_USAGE_COUNT_SQL,
} from "./card-usage-legacy-sql";

const NOW = "2026-09-24T00:00:00.000Z";

/**
 * Runs one read and the shipped text it replaced (card-usage-legacy-sql.ts)
 * with the same arguments: every scenario below is also a differential check.
 */
function read<T>(db: Database, page: PageSql, legacy: string): T[] {
  const rows = db.query(page.sql).all(...(page.args as SQLQueryBindings[])) as T[];
  expect(rows).toEqual(db.query(legacy).all(...(page.args as SQLQueryBindings[])) as T[]);
  return rows;
}

function usage(db: Database): CurrentCardUsageRow[] {
  return read(db, currentCardUsageSql({ afterId: 0, limit: 1000 }), LEGACY_CURRENT_CARD_USAGE_SQL);
}

function stale(db: Database, limit = 100): StaleCardPurchaseKeyRow[] {
  return read(db, staleCardPurchaseKeysSql(limit), LEGACY_STALE_CARD_PURCHASE_KEYS_SQL);
}

function unrecognized(db: Database): number {
  return read<UnrecognizedCardUsageCountRow>(
    db,
    unrecognizedCardUsageCountSql(),
    LEGACY_UNRECOGNIZED_CARD_USAGE_COUNT_SQL,
  )[0]!.unrecognized;
}

/** The fact the writer reads from one current usage row. */
function factOf(row: CurrentCardUsageRow): CardUsageFact {
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
    amount: exactQuantity(
      row.unit_ref!,
      normalizeDecimal(BigInt(row.coefficient!), row.scale!),
      "decimal-v1",
    ),
    usageDate: row.as_of,
    paymentType: row.payment_type,
    statementPeriod: row.statement_period,
    capturedAt: row.snapshot_fetched_at,
    providerSaleCode: row.provider_sale_code,
    usageAmountText: row.usage_amount_text,
    paymentAmountText: row.payment_amount_text,
    newestRepresentation: true,
  };
}

/** Applies one guarded batch in a transaction; true when its decision was written. */
function write(db: Database, draft: CardPurchaseDraft, expectedRevision: number | null): boolean {
  const writes = cardPurchaseRecognitionWrites({ draft, expectedRevision, now: NOW });
  return db.transaction(() => {
    const changes = writes.map(
      (entry) => db.run(entry.sql, entry.binds as SQLQueryBindings[]).changes,
    );
    return changes[0]! > 0;
  })();
}

/** Recognises every recognisable current row nothing holds yet; returns the drafts by observation id. */
async function recognizeAll(db: Database): Promise<Map<number, CardPurchaseDraft>> {
  const drafts = new Map<number, CardPurchaseDraft>();
  for (const row of usage(db)) {
    if (
      db
        .query("SELECT 1 FROM current_card_purchase_keys WHERE recognition_key=?")
        .get(row.recognition_key)
    )
      continue;
    const fact = factOf(row);
    const classified = classifyCardUsage(fact);
    const key = recognitionKey(fact);
    if (!classified.ok || key === null) continue;
    const draft = await cardPurchaseRevision({
      action: "recognize",
      eventId: await cardPurchaseEventId(classified.kind, key),
      revision: 1,
      fact,
    });
    if (draft === null) throw new Error("draft rejected");
    expect(JSON.stringify(key)).toBe(row.recognition_key!);
    expect(write(db, draft, null)).toBe(true);
    drafts.set(row.observation_id, draft);
  }
  return drafts;
}

const PENDING_ROWS: readonly UsageRow[] = [
  { date: "26/05/03", merchant: "架空店舗A", amount: "1,200", paymentType: "1回払い" },
  { date: "26/05/04", merchant: "架空返金A", amount: "-1,500", paymentType: "1回払い" },
];

/** One bound Vpass card-month capture of card-001, identified through the trusted binding. */
function vpassCapture(
  store: CardStore,
  family: "web" | "customized",
  fetchedAt: string,
  rows: readonly UsageRow[],
): Parsed {
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
  store.identify(parsed, vpassCard(TOKEN_A, "acct-card-a"), {
    version: 2,
    bindingArtifact: binding,
    token: TOKEN_A,
  });
  return parsed;
}

/** A MyJCB confirmed ledger: one single payment and one installment slice. */
function myjcbCapture(store: CardStore): Parsed {
  const parsed = store.myjcbLedger({
    run: store.run("myjcb"),
    connection: "conn-a",
    detailMonth: 1,
    state: "confirmed",
    period: "2026年6月お支払い分",
    fetchedAt: "2026-05-12T00:00:00.000Z",
    rows: [
      { date: "2026/04/20", merchant: "架空店舗G", amount: "1,000", paymentType: "1回払い" },
      {
        date: "2026/04/21",
        merchant: "架空店舗H",
        amount: "4,000",
        paymentType: "分割",
        other: "12,000",
        installment: "1",
      },
    ],
  });
  store.identify(parsed, myjcbRoot("conn-a", "acct-jcb"), { version: 1 });
  return parsed;
}

describe("recognition keys against current card usage", () => {
  test("stale keys are live recognised keys whose row is no longer current; retired ones are not reported", async () => {
    const store = new CardStore();
    const pending = vpassCapture(store, "customized", "2026-05-10T00:00:00.000Z", PENDING_ROWS);
    const jcb = myjcbCapture(store);
    const drafts = await recognizeAll(store.db);
    // The two pending Vpass rows and the MyJCB single payment; never the installment slice.
    expect([...drafts.keys()].sort((a, b) => a - b)).toEqual([
      ...pending.observations,
      jcb.observations[0]!,
    ]);
    expect(stale(store.db)).toEqual([]);

    // The web capture of the same card-month replaces the customized one.
    const posted = vpassCapture(store, "web", "2026-06-10T00:00:00.000Z", [
      { date: "26/05/03", merchant: "架空店舗A", amount: "1,234", paymentType: "1回払い" },
    ]);
    expect(usage(store.db).map((row) => row.observation_id)).toContain(posted.observations[0]!);
    const expected = pending.observations.map((observation): StaleCardPurchaseKeyRow => {
      const draft = drafts.get(observation)!;
      return {
        event_id: draft.revision.eventId,
        revision: 1,
        recognition_key: draft.keys[0]!.key,
        role: "pending",
        observation_id: observation,
        parse_run_id: pending.parse,
        kind: draft.revision.kind as StaleCardPurchaseKeyRow["kind"],
        state: "authorized",
        key_count: 1,
      };
    });
    expected.sort((a, b) => (a.event_id < b.event_id ? -1 : 1));
    expect(stale(store.db)).toEqual(expected);
    // The page is bounded and ordered by event.
    expect(stale(store.db, 1)).toEqual([expected[0]!]);

    // Retiring an event keeps its key but leaves the stale page: it is not
    // reported again, so the page cannot fill up with retired events.
    const first = drafts.get(expected[0]!.observation_id)!;
    const retirement = await cardPurchaseRetirement({
      live: first.revision,
      keys: first.keys,
      sidecar: first.sidecar,
    });
    expect(write(store.db, retirement!, 1)).toBe(true);
    expect(stale(store.db)).toEqual([expected[1]!]);
    expect(
      store.db
        .query("SELECT count(*) AS n FROM current_card_purchase_keys WHERE event_id=?")
        .get(first.revision.eventId),
    ).toEqual({ n: 1 });
  }, 30_000);

  test("a revision that still holds one current key is not stale; once none is current, all its keys are", async () => {
    const store = new CardStore();
    // A pending row, captured before its month's web capture replaces it.
    vpassCapture(store, "customized", "2026-05-10T00:00:00.000Z", [PENDING_ROWS[0]!]);
    const [pending] = usage(store.db);
    vpassCapture(store, "web", "2026-06-10T00:00:00.000Z", [
      { date: "26/05/03", merchant: "架空店舗A", amount: "1,234", paymentType: "1回払い" },
    ]);
    const [posted] = usage(store.db);
    expect(posted!.observation_id).not.toBe(pending!.observation_id);
    // One live revision holding the posted key and the pending key, the shape a
    // reviewed pending-to-posted merge leaves: the pending row is no longer
    // current, the posted one is.
    const fact = factOf(posted!);
    const classified = classifyCardUsage(fact);
    if (!classified.ok) throw new Error(classified.reasonCode);
    const draft = await cardPurchaseRevision({
      action: "recognize",
      eventId: await cardPurchaseEventId(classified.kind, recognitionKey(fact)!),
      revision: 1,
      fact,
    });
    const merged: CardPurchaseDraft = {
      ...draft!,
      keys: [
        ...draft!.keys,
        {
          key: pending!.recognition_key!,
          role: "pending",
          observationId: pending!.observation_id,
          parseRunId: pending!.parse_run_id,
        },
      ],
    };
    expect(write(store.db, merged, null)).toBe(true);
    // Still displayed through its posted row: nothing to retire, and its
    // vanished pending key never takes a place on the page.
    expect(stale(store.db)).toEqual([]);

    // A later web capture no longer shows the posted row: now every key of
    // the revision is stale, and both are reported together.
    vpassCapture(store, "web", "2026-06-20T00:00:00.000Z", [
      { date: "26/05/09", merchant: "架空店舗D", amount: "2,500", paymentType: "1回払い" },
    ]);
    expect(
      stale(store.db).map((row) => [row.event_id, row.recognition_key, row.key_count]),
    ).toEqual(
      [posted!.recognition_key!, pending!.recognition_key!]
        .sort()
        .map((key) => [draft!.revision.eventId, key, 2]),
    );
  }, 30_000);

  test("unrecognised current rows are the rows no live revision holds", async () => {
    const store = new CardStore();
    vpassCapture(store, "customized", "2026-05-10T00:00:00.000Z", PENDING_ROWS);
    myjcbCapture(store);
    const current = usage(store.db);
    expect(current).toHaveLength(4);
    expect(unrecognized(store.db)).toBe(4);
    await recognizeAll(store.db);
    // Only the installment slice is left.
    expect(unrecognized(store.db)).toBe(1);

    // A newer web capture: its row is current and not yet recognised, while
    // the replaced pending rows are held but no longer current, so they do
    // not count (they are stale keys instead).
    vpassCapture(store, "web", "2026-06-10T00:00:00.000Z", [
      { date: "26/05/03", merchant: "架空店舗A", amount: "1,234", paymentType: "1回払い" },
    ]);
    expect(unrecognized(store.db)).toBe(2);
    await recognizeAll(store.db);
    expect(unrecognized(store.db)).toBe(1);
    const staleBefore = stale(store.db);
    expect(staleBefore).toHaveLength(2);

    // A current row without an external id has no key and is never held.
    const [row] = usage(store.db).filter((entry) => entry.source_id === "myjcb");
    const parsed = { artifact: 0, parse: row!.parse_run_id, observations: [row!.observation_id] };
    store.appendRow(parsed, { externalId: null, extraJson: "{}" });
    expect(usage(store.db).some((entry) => entry.recognition_key === null)).toBe(true);
    expect(unrecognized(store.db)).toBe(2);
    // Nor does it hide a stale key: \`held_current\` is compared with \`NOT IN\`,
    // which a NULL would turn into "no row is stale".
    expect(stale(store.db)).toEqual(staleBefore);
  }, 30_000);

  test("both reads compile on an empty store and bound their page", () => {
    const store = new CardStore();
    expect(stale(store.db)).toEqual([]);
    expect(unrecognized(store.db)).toBe(0);
    expect(staleCardPurchaseKeysSql(STALE_CARD_PURCHASE_KEY_LIMIT).args).toEqual([
      0,
      -1,
      STALE_CARD_PURCHASE_KEY_LIMIT,
    ]);
    for (const limit of [0, STALE_CARD_PURCHASE_KEY_LIMIT + 1, 1.5, Number.NaN])
      expect(() => staleCardPurchaseKeysSql(limit)).toThrow();
  });
});
