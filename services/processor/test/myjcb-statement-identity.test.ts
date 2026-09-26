// A MyJCB statement keeps its purchase events while its position in the
// provider's list moves (docs/observations.md, "MyJCB statements keep their
// identity when their position moves"). The provider lists the newest closed
// statement at position 1 and moves it to position 2 when the next one
// closes. The ledger parser hashes the period into each row's external id, so
// while the collector recorded that period as the position (`detailMonth-1`,
// then `detailMonth-2`), the same row got a new recognition key every month and
// the purchase lane retired its event and recognised a new one. The collector
// now records the month the page names; the read model gives every confirmed
// capture of one statement one snapshot slot. Every card, amount, merchant and
// date here is synthetic.
import { afterEach, expect, test } from "bun:test";
import type { CardPurchaseSweepResult } from "../src/card-purchase-job.ts";
import { disposeWorlds, world, type UsageRow, type World } from "./card-purchase-world.ts";

afterEach(disposeWorlds);

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

const row = (date: string, merchant: string, amount: string): UsageRow => ({
  date,
  merchant,
  amount,
  paymentType: "1回払",
  other: amount,
});
/** Closed in the cycle paid in 2026-09. */
const A = row("2026/08/03", "架空店舗A", "1,000");
/** Pending on 2026-09-10, closed in the cycle paid in 2026-10. */
const P = row("2026/09/05", "架空店舗P", "700");
/** Pending on 2026-10-10, closed in the cycle paid in 2026-11. */
const Q = row("2026/10/02", "架空店舗Q", "300");

/** Every live purchase event: id, revision, state. */
async function events(w: World) {
  return w.all<{ event_id: string; revision: number; state: string }>(
    `SELECT event_id,revision,state FROM current_economic_events
     WHERE kind='purchase' ORDER BY event_id`,
  );
}

/**
 * One daily run of connection conn-a on `day` (a JST day 1–15, so position 0
 * is the cycle paid two months on): the pending position 0 and the closed
 * statements from position 1 on, each confirmed page recorded by its month.
 */
async function run(
  w: World,
  day: string,
  pending: readonly UsageRow[],
  closed: readonly { period: string; rows: readonly UsageRow[] }[],
): Promise<void> {
  await w.myjcb({
    state: "unconfirmed",
    period: "detailMonth-0",
    fetchedAt: `${day}T00:00:00.000Z`,
    rows: pending,
  });
  for (const [index, statement] of closed.entries())
    await w.myjcb({
      state: "confirmed",
      period: statement.period,
      detailMonth: index + 1,
      fetchedAt: `${day}T00:00:0${index + 1}.000Z`,
      rows: statement.rows,
    });
}

test("a closed statement keeps its events from position 1 to 2 to 3; a pending row becomes captured once", async () => {
  const w = await world();
  // 2026-09-10: A's statement (paid in September) is position 1; P is pending.
  await run(w, "2026-09-10", [P], [{ period: "2026-09", rows: [A] }]);
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 2 });
  const september = await events(w);
  expect(september.map((event) => event.state).sort()).toEqual(["authorized", "captured"]);
  const [captured] = september.filter((event) => event.state === "captured");
  expect(await w.totals()).toMatchObject({ captured: "1000", authorized: "700" });

  // 2026-10-10: P's statement closed and is position 1, A's moved to position
  // 2, and Q is pending. A keeps its key, so its event is untouched: no
  // retire, no new recognition. P's pending event is retired and its posted
  // row recognised as captured (a pending and a posted row are two keys, and
  // the pair is left to review); P is counted once.
  await run(
    w,
    "2026-10-10",
    [Q],
    [
      { period: "2026-10", rows: [P] },
      { period: "2026-09", rows: [A] },
    ],
  );
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 2, retired: 1 });
  expect((await events(w)).find((event) => event.event_id === captured!.event_id)).toEqual(
    captured,
  );
  expect(await w.totals()).toMatchObject({ captured: "1700", authorized: "300" });
  expect(counts(await w.sweep())).toEqual(NOTHING);

  // 2026-11-10: every statement moves down once more. A and P keep their
  // events; only Q's pending event becomes captured, once.
  const october = await events(w);
  await run(
    w,
    "2026-11-10",
    [],
    [
      { period: "2026-11", rows: [Q] },
      { period: "2026-10", rows: [P] },
      { period: "2026-09", rows: [A] },
    ],
  );
  const november = await w.sweep();
  expect(counts(november)).toEqual({ ...NOTHING, recognized: 1, retired: 1 });
  const after = await events(w);
  for (const event of october.filter((entry) => entry.state === "captured"))
    expect(after).toContainEqual(event);
  expect(await w.totals()).toMatchObject({ captured: "2000", authorized: "0" });
  expect(
    await w.count(
      "SELECT count(*) AS n FROM economic_event_revisions WHERE event_id=? AND superseded_by IS NULL",
      captured!.event_id,
    ),
  ).toBe(1);
}, 180_000);

test("a statement captured under the relative label before the collector named months moves to its named key once", async () => {
  const w = await world();
  // 2026-09-26, as captured before the collector named months: the statement
  // paid in October is position 1 under `detailMonth-1`.
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    detailMonth: 1,
    fetchedAt: "2026-09-26T00:00:00.000Z",
    rows: [P],
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1 });
  // 2026-10-26: the same statement at position 2, named by its page. One
  // snapshot slot (2026-10) holds both captures, so only the newer one is
  // current: its row has a new key once, and the lane retires the old event
  // and recognises the new one. The purchase is counted once throughout.
  await w.myjcb({
    state: "confirmed",
    period: "2026-10",
    detailMonth: 2,
    fetchedAt: "2026-10-26T00:00:00.000Z",
    rows: [P],
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1, retired: 1 });
  expect(await w.totals()).toMatchObject({ captured: "700", authorized: "0" });
  // From then on the named key stays: a month later at position 3, nothing.
  await w.myjcb({
    state: "confirmed",
    period: "2026-10",
    detailMonth: 3,
    fetchedAt: "2026-11-26T00:00:00.000Z",
    rows: [P],
  });
  expect(counts(await w.sweep())).toEqual(NOTHING);
  expect(await w.totals()).toMatchObject({ captured: "700", authorized: "0" });
}, 180_000);

test("a relative label at a position no rule places is never current, so a statement is never counted twice", async () => {
  const w = await world();
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    detailMonth: 1,
    fetchedAt: "2026-09-26T00:00:00.000Z",
    rows: [P],
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1 });
  // The same statement a month later at position 2 under `detailMonth-2`,
  // which names a position, not a statement. With one slot per position both
  // captures were current, under two keys: the purchase twice. Now the
  // position-2 capture is not current, and the earlier capture of the
  // statement stays the one that is.
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-2",
    detailMonth: 2,
    fetchedAt: "2026-10-26T00:00:00.000Z",
    rows: [P],
  });
  expect(counts(await w.sweep())).toEqual(NOTHING);
  expect(await w.totals()).toMatchObject({ captured: "700" });
}, 180_000);

/** Closed on 2026-09-15, paid in 2026-10; unconfirmed until the provider confirms it. */
const M = row("2026/09/05", "架空店舗M", "1,200");
/** Accumulating from 2026-09-16, paid in 2026-11. */
const N = row("2026/09/18", "架空店舗N", "400");
const O = row("2026/09/21", "架空店舗O", "250");

test("two pending statements on one day are both current, and each is recognised once through confirmation (ADR 0016)", async () => {
  const w = await world();
  const pending = async (day: string, zero: readonly UsageRow[], one?: readonly UsageRow[]) => {
    await w.myjcb({
      state: "unconfirmed",
      period: "detailMonth-0",
      detailMonth: 0,
      fetchedAt: `${day}T00:00:00.000Z`,
      rows: zero,
    });
    if (one)
      await w.myjcb({
        state: "unconfirmed",
        period: "detailMonth-1",
        detailMonth: 1,
        fetchedAt: `${day}T00:00:01.000Z`,
        rows: one,
      });
  };
  // 2026-09-20 (JST, after the 15th): position 0 is the cycle paid in
  // November, position 1 the closed cycle paid in October, not yet confirmed.
  // With one pending slot per connection only position 1 was current, and N
  // was neither listed nor recognised.
  await pending("2026-09-20", [N], [M]);
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 2 });
  expect((await events(w)).map((event) => event.state)).toEqual(["authorized", "authorized"]);
  expect(await w.totals()).toMatchObject({ captured: "0", authorized: "1600" });
  const before = await events(w);

  // 2026-09-21: position 0 is captured again, first alone (as when its parse
  // is published before position 1's). It replaces only position 0: M stays
  // current, so nothing is retired, and O is recognised once. Position 1's
  // capture then changes nothing.
  await pending("2026-09-21", [N, O]);
  expect(counts(await w.sweep())).toMatchObject({
    recognized: 1,
    retired: 0,
    conflicts: 0,
    failed: 0,
  });
  await pending("2026-09-21", [N, O], [M]);
  expect(counts(await w.sweep())).toMatchObject({
    recognized: 0,
    retired: 0,
    conflicts: 0,
    failed: 0,
  });
  const live = await events(w);
  expect(live.map((event) => event.state)).toEqual(["authorized", "authorized", "authorized"]);
  for (const event of before) expect(live.map((entry) => entry.event_id)).toContain(event.event_id);
  expect(await w.totals()).toMatchObject({ captured: "0", authorized: "1850" });

  // 2026-09-25: the closed cycle is confirmed and its page names October.
  // Its confirmed capture ends the pending one: M's pending event is retired
  // and its posted row recognised as captured, counted once.
  await w.myjcb({
    state: "unconfirmed",
    period: "detailMonth-0",
    detailMonth: 0,
    fetchedAt: "2026-09-25T00:00:00.000Z",
    rows: [N, O],
  });
  await w.myjcb({
    state: "confirmed",
    period: "2026-10",
    detailMonth: 1,
    fetchedAt: "2026-09-25T00:00:01.000Z",
    rows: [M],
  });
  expect(counts(await w.sweep())).toMatchObject({
    recognized: 1,
    retired: 1,
    conflicts: 0,
    failed: 0,
  });
  expect(await w.totals()).toMatchObject({ captured: "1200", authorized: "650" });
  expect((await events(w)).map((event) => event.state).sort()).toEqual([
    "authorized",
    "authorized",
    "captured",
    "unknown",
  ]);
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 180_000);
