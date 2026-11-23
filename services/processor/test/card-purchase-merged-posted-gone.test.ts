// A merged card purchase follows its posted row (INV06, docs/economic-events.md,
// "Revisions, retirement and idempotency"). MyJCB keeps a pending (unconfirmed)
// capture current beside a confirmed one until the pending position is
// captured again, so a reviewed merge can hold a pending key that is still
// current. When the posted row then leaves the display under its key (a newer
// confirmed capture shows the same purchase under another key), the merged
// event must not stay captured beside the new row's event: that would count
// one purchase twice. Every card, amount and merchant is synthetic.
import { afterEach, expect, test } from "bun:test";
import type { CardPurchaseCandidate } from "../../../packages/domain/src/card-purchase-view.ts";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  type ChangeKind,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { queryCardPurchases } from "../../../packages/application/src/query/card-purchases.ts";
import type { SqlExecutor } from "../../../packages/read-model/src/reader.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";
import { disposeWorlds, world, type UsageRow, type World } from "./card-purchase-world.ts";

afterEach(disposeWorlds);

const ROW: UsageRow = {
  date: "2026/05/10",
  merchant: "架空店舗J",
  amount: "800",
  paymentType: "1回払",
};

function executor(w: World): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      (
        await w.db
          .prepare(sql)
          .bind(...args)
          .all<T>()
      ).results,
    first: async <T>(sql: string, args: readonly unknown[]) =>
      w.db
        .prepare(sql)
        .bind(...args)
        .first<T>(),
  };
}

const OPERATOR: Principal = {
  id: "synthetic-human",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const COMMAND_NOW = "2098-01-01T00:00:00.000Z";

async function review(
  w: World,
  kind: ChangeKind,
  candidate: CardPurchaseCandidate,
  operationId = "merged-posted-gone-1",
) {
  const store = d1CommandStore(w.db);
  const planned = await createPlan(
    kind,
    { ...candidate.relation, reason: "reviewed against the statement" },
    {
      actor: OPERATOR,
      baseContextId: `card-purchase-link:${candidate.proposalId}`,
      now: COMMAND_NOW,
      ttlSeconds: 600,
    },
    store,
  );
  if (!planned.ok) throw new Error("plan " + JSON.stringify(planned));
  const approval = await approve(store, {
    planId: planned.plan.planId,
    planDigest: planned.plan.planDigest,
    actor: OPERATOR,
    scope: [],
    ttlSeconds: 600,
    now: COMMAND_NOW,
  });
  if (!approval.ok) throw new Error("approval " + JSON.stringify(approval));
  const result = await commit(store, {
    operationId,
    principal: OPERATOR,
    planId: planned.plan.planId,
    approvalId: approval.approval.approvalId,
    planners: changeMutationPlanners(w.db),
    now: COMMAND_NOW,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

/** Per live event: its state and the roles of the keys it holds. */
async function events(w: World) {
  return w.all<{ event_id: string; state: string; roles: string }>(
    `SELECT r.event_id,r.state,
      (SELECT group_concat(k.role,',') FROM (SELECT role FROM card_purchase_recognition_keys k
        WHERE k.event_id=r.event_id AND k.revision=r.revision ORDER BY role DESC) k) AS roles
     FROM current_economic_events r WHERE r.kind IN ('purchase','refund') ORDER BY r.event_id`,
  );
}

test("a merged event whose posted row left the display is retired even while its pending row is current", async () => {
  const w = await world();
  // One purchase, shown on the pending ledger and on the confirmed one.
  await w.myjcb({
    state: "unconfirmed",
    period: "detailMonth-0",
    fetchedAt: "2026-06-12T00:00:00.000Z",
    rows: [ROW],
  });
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    fetchedAt: "2026-06-12T00:00:00.000Z",
    rows: [ROW],
  });
  expect(await w.sweep()).toMatchObject({ recognized: 2, proposed: 1, conflicts: 0, failed: 0 });
  const posted = (await events(w)).find((event) => event.roles === "posted")!;
  const page = await queryCardPurchases(executor(w), { eventId: posted.event_id });
  const [candidate] = page.items[0]?.candidates ?? [];
  if (!candidate) throw new Error("no candidate");
  await review(w, "relation.accept", candidate);
  const [merged] = await events(w);
  expect(await events(w)).toEqual([
    { event_id: merged!.event_id, state: "captured", roles: "posted,pending" },
  ]);
  expect(await w.totals()).toMatchObject({ captured: "800", authorized: "0" });

  // A newer confirmed capture shows the same purchase under another key (its
  // merchant cell reads differently); the pending capture is not taken again,
  // so its row stays current.
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    fetchedAt: "2026-06-13T00:00:00.000Z",
    rows: [{ ...ROW, merchant: "架空店舗J 本店" }],
  });
  const result = await w.sweep();
  expect(result).toMatchObject({ retired: 1, recognized: 1, conflicts: 0, failed: 0 });
  // The merged event is retired holding both keys; the new row is the one
  // captured purchase, so the captured total still counts the purchase once.
  const after = await events(w);
  expect(after.find((event) => event.event_id === merged!.event_id)).toEqual({
    event_id: merged!.event_id,
    state: "unknown",
    roles: "posted,pending",
  });
  expect(after.filter((event) => event.state === "captured")).toHaveLength(1);
  expect(await w.totals()).toMatchObject({ captured: "800", authorized: "0", unresolved: 1 });
  // The pending row is still held by the retired event: nothing re-recognises
  // it, and a second pass changes nothing.
  expect(await w.sweep()).toMatchObject({
    recognized: 0,
    revised: 0,
    retired: 0,
    conflicts: 0,
    failed: 0,
  });
}, 120_000);

test("a merged event whose posted row left with no replacement is unresolved until the link is withdrawn", async () => {
  const w = await world();
  await w.myjcb({
    state: "unconfirmed",
    period: "detailMonth-0",
    fetchedAt: "2026-06-12T00:00:00.000Z",
    rows: [ROW],
  });
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    fetchedAt: "2026-06-12T00:00:00.000Z",
    rows: [ROW],
  });
  await w.sweep();
  const posted = (await events(w)).find((event) => event.roles === "posted")!;
  const page = await queryCardPurchases(executor(w), { eventId: posted.event_id });
  const [candidate] = page.items[0]?.candidates ?? [];
  if (!candidate) throw new Error("no candidate");
  await review(w, "relation.accept", candidate);
  const [merged] = await events(w);

  // A newer confirmed capture no longer shows the purchase, while the pending
  // capture is not taken again. The merged event follows its posted row and is
  // retired; its pending row stays held by it, so the purchase is in neither
  // total, only an unresolved event (ADR 0002, amendment 2026-11-21: an open
  // limit).
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    fetchedAt: "2026-06-13T00:00:00.000Z",
    rows: [],
  });
  expect(await w.sweep()).toMatchObject({ retired: 1, recognized: 0, conflicts: 0, failed: 0 });
  expect(await events(w)).toEqual([
    { event_id: merged!.event_id, state: "unknown", roles: "posted,pending" },
  ]);
  expect(await w.totals()).toMatchObject({ captured: "0", authorized: "0", unresolved: 1 });

  // Withdrawing the link splits it: the pending row's own event is authorized
  // again on the next pass, and the posted event stays retired.
  await review(w, "relation.reject", candidate, "merged-posted-gone-2");
  await w.sweep();
  expect((await events(w)).map((event) => [event.state, event.roles]).sort()).toEqual([
    ["authorized", "pending"],
    ["unknown", "posted"],
  ]);
  expect(await w.totals()).toMatchObject({ captured: "0", authorized: "800", unresolved: 1 });
}, 120_000);
