// The purchase recognition lane's `lane` audit record end to end (ADR 0064,
// plan slice S7): the deployed lane, on MyJCB rows produced by the deployed
// parser on the real CORE schema, writes rule decisions with their commit rows
// (ADR 0054) and pending-to-posted candidates; its record names exactly those
// rows by range and copies none of the tick's counts. Every card, amount and
// merchant is synthetic.
import { afterEach, expect, test } from "bun:test";
import { CARD_PURCHASE_ACTOR } from "../../../packages/domain/src/card-purchase.ts";
import { cardPurchaseSweep } from "../src/card-purchase-job.ts";
import { resolveLaneRef } from "../src/lane-audit.ts";
import { runScheduled, type ScheduledStages } from "../src/worker.ts";
import { disposeWorlds, NOW, world, type UsageRow, type World } from "./card-purchase-world.ts";

afterEach(disposeWorlds);

const STAGES: ScheduledStages = {
  parse: () => Promise.resolve({ parsed: 0 }),
  identity: () => Promise.resolve({ processedRuns: 0 }),
  balanceProjection: () => Promise.resolve({ enabled: false, status: "skipped" }),
  purchases: (target) => cardPurchaseSweep(target.DB, { now: NOW }),
};

async function tick(w: World, lines: Record<string, unknown>[] = []): Promise<void> {
  await runScheduled(
    { ...w.env, PURCHASE_RECOGNITION_ENABLED: "true" } as unknown as Env,
    STAGES,
    (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  );
}

const MATCHING: UsageRow = {
  date: "2026/05/10",
  merchant: "架空店舗J",
  amount: "800",
  paymentType: "1回払",
};

test("a recognising tick is one record naming exactly its rule decisions, its commits and its candidates", async () => {
  const w = await world();
  await w.myjcb({
    state: "unconfirmed",
    period: "detailMonth-1",
    fetchedAt: "2026-06-12T00:00:00.000Z",
    rows: [MATCHING],
  });
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    fetchedAt: "2026-06-12T00:00:00.000Z",
    rows: [MATCHING, MATCHING],
  });
  const lines: Record<string, unknown>[] = [];
  await tick(w, lines);
  const logged = lines.find((line) => line.event === "purchase_recognition")!;
  expect(logged).toMatchObject({ recognized: 3, proposed: 2 });

  const records = await w.all<Record<string, string | null>>(
    "SELECT * FROM audit_records WHERE path='lane'",
  );
  expect(records).toHaveLength(1);
  const [record] = records;
  expect(record).toMatchObject({
    principal: "lane:purchase-recognition",
    principal_kind: "automatic",
    subject: null,
    operation: "lane.tick",
    risk_class: "R2",
    result: "applied",
  });
  const refs = JSON.parse(record!.refs_json!) as string[];
  expect(refs.map((ref) => ref.replace(/\d+-\d+$/u, ""))).toEqual([
    "decision-revisions:",
    "commit-seq:core-epoch-1:",
    "proposals:reconciliation-pending-to-posted:",
  ]);
  const [decisions, commits, proposals] = await Promise.all(
    refs.map((ref) => resolveLaneRef(w.db, "purchase_recognition", ref)),
  );
  // Exactly what the lane wrote: every rule decision under its actor, every
  // commit row under its principal, every stage-B candidate.
  expect(decisions!.sort()).toEqual(
    (
      await w.all<{ id: string }>(
        "SELECT id FROM decision_revisions WHERE actor_id=? AND method='rule'",
        CARD_PURCHASE_ACTOR,
      )
    )
      .map((row) => row.id)
      .sort(),
  );
  expect(commits).toEqual(
    (
      await w.all<{ seq: string }>(
        "SELECT core_epoch||':'||commit_seq AS seq FROM economic_commit_log WHERE principal=? ORDER BY commit_seq",
        CARD_PURCHASE_ACTOR,
      )
    ).map((row) => row.seq),
  );
  expect(proposals!.sort()).toEqual(
    (await w.all<{ id: string }>("SELECT id FROM reconciliation_proposals"))
      .map((row) => row.id)
      .sort(),
  );
  expect(decisions!.length).toBeGreaterThan(0);
  expect(commits!.length).toBeGreaterThan(0);
  expect(JSON.parse(record!.diff_json!)).toEqual({
    kind: "lane",
    decisionRevisions: decisions!.length,
    commits: commits!.length,
    proposals: [{ kind: "reconciliation-pending-to-posted", count: 2 }],
  });
  // Nothing of the tick's own counts, nor any provider text. (The amount is
  // not checked as a substring: random ids may contain its digits; the diff
  // above is exactly counts.)
  const text = JSON.stringify(record);
  for (const field of ["scanned", "recognized", "revised", "skipped", "merged", "groupsSkipped"])
    expect(text).not.toContain(`"${field}"`);
  expect(text).not.toContain("架空店舗J");

  // The next tick recognises nothing new: no second record.
  await tick(w);
  expect(await w.count("SELECT count(*) AS n FROM audit_records WHERE path='lane'")).toBe(1);
}, 120_000);
