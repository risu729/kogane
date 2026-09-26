// What happens to recognised card purchases when a source's captures move
// from the retired importer's producer (`collector-r2-importer`) to the
// collector's own (`collector-<collector id>`), ADR 0014. Card-month and
// ledger-slot currentness ignore the producer, so the first collector capture
// of a statement makes the importer's capture non-current; the recognition
// key carries the producer, so the purchase lane retires every event held
// under the importer's key and recognises the row again under the collector's.
// Nothing is counted twice at any point. The captures below are seeded
// parsed, with their datasets: a collector capture reaches this state only
// once registration catalogues it with a dataset and the parser publishes it
// (ADR 0014, "Merge safety"). Every card, amount, merchant and token here is
// synthetic.
import { afterEach, expect, test } from "bun:test";
import type { CardPurchaseSweepResult } from "../src/card-purchase-job.ts";
import { disposeWorlds, PRODUCER, world, type UsageRow } from "./card-purchase-world.ts";

afterEach(disposeWorlds);

const COLLECTOR_MYJCB = "collector-myjcb";
const COLLECTOR_VPASS = "collector-vpass";

function counts(result: CardPurchaseSweepResult) {
  return {
    recognized: result.recognized,
    revised: result.revised,
    reanchored: result.reanchored,
    retired: result.retired,
    conflicts: result.conflicts,
    failed: result.failed,
  };
}
const NOTHING = { recognized: 0, revised: 0, reanchored: 0, retired: 0, conflicts: 0, failed: 0 };

const myjcbRow = (date: string, merchant: string, amount: string): UsageRow => ({
  date,
  merchant,
  amount,
  paymentType: "1回払",
  other: amount,
});
const vpassRow = (date: string, merchant: string, amount: string): UsageRow => ({
  date,
  merchant,
  amount,
  paymentType: "1",
});

/** Live (not retired) purchase events: their producer, account and state. */
const LIVE = `SELECT json_extract(k.recognition_key,'$[1]') AS producer, c.account_id, c.state
  FROM current_card_purchase_recognitions c
  JOIN current_card_purchase_keys k ON k.event_id=c.event_id AND k.revision=c.revision
  WHERE c.state IN ('captured','authorized') ORDER BY producer, c.account_id`;

test("MyJCB: the collector's capture of a statement retires the importer's events and recognises them again once, under a new account", async () => {
  const w = await world();
  const rows = [
    myjcbRow("2026/08/03", "架空店舗A", "1,000"),
    myjcbRow("2026/08/09", "架空店舗B", "250"),
  ];
  await w.myjcb({
    state: "confirmed",
    period: "2026-09",
    fetchedAt: "2026-09-10T00:00:00.000Z",
    rows,
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 2 });
  const before = await w.all<{ producer: string; account_id: string }>(LIVE);
  expect(before.map((row) => row.producer)).toEqual([PRODUCER, PRODUCER]);
  expect(await w.totals()).toMatchObject({ captured: "1250", unresolved: 0 });

  // The same statement, captured later by the collector under its own producer.
  await w.myjcb({
    state: "confirmed",
    period: "2026-09",
    fetchedAt: "2026-09-27T00:00:00.000Z",
    rows,
    producer: COLLECTOR_MYJCB,
  });
  // Only the newer capture is current: the slot ignores the producer.
  const usage = await w.usage();
  expect(usage.map((row) => row.producer_id)).toEqual([COLLECTOR_MYJCB, COLLECTOR_MYJCB]);

  // One sweep: two retired, two recognised, and at no point four live.
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 2, retired: 2 });
  const after = await w.all<{ producer: string; account_id: string }>(LIVE);
  expect(after.map((row) => row.producer)).toEqual([COLLECTOR_MYJCB, COLLECTOR_MYJCB]);
  // The source-account reference includes the producer, so the collector's
  // rows resolve to a different account than the importer's did.
  expect(new Set(after.map((row) => row.account_id))).not.toEqual(
    new Set(before.map((row) => row.account_id)),
  );
  expect(
    await w.count(
      "SELECT count(DISTINCT producer_id) AS n FROM source_accounts WHERE source_id='myjcb'",
    ),
  ).toBe(2);
  // The captured total is unchanged; the two retired events are `unknown`
  // revisions with no legs, which the summary counts as unresolved.
  expect(await w.totals()).toMatchObject({ captured: "1250", unresolved: 2 });
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 60_000);

test("Vpass: the collector's capture of a card-month retires the importer's events, and without the importer's binding its rows are not recognised", async () => {
  const w = await world();
  const rows = [vpassRow("26/05/03", "架空店舗C", "1,234")];
  await w.vpass({ family: "web", card: "card-001", fetchedAt: "2026-06-10T00:00:00.000Z", rows });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1 });
  expect(await w.totals()).toMatchObject({ captured: "1234" });

  // The collector's capture of the same card-month. The trusted binding view
  // (migrations 0020/0021) accepts only the importer's producer, so even a
  // binding-shaped sidecar under the collector's producer is not trusted.
  await w.vpass({
    family: "web",
    card: "card-001",
    fetchedAt: "2026-09-27T00:00:00.000Z",
    rows,
    producer: COLLECTOR_VPASS,
  });
  const usage = await w.usage();
  expect(usage.map((row) => [row.producer_id, row.policy_family])).toEqual([
    [COLLECTOR_VPASS, "identity-default"],
  ]);
  const result = await w.sweep();
  expect(counts(result)).toEqual({ ...NOTHING, retired: 1 });
  expect(result.skipped).toMatchObject({ account_not_resolved: 1 });
  expect(await w.all(LIVE)).toEqual([]);
  expect(await w.totals()).toMatchObject({ captured: "0", unresolved: 1 });
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 60_000);
