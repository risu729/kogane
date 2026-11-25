// The cursor sweeps wait for a change once a pass has read every row (ADR
// 0129, slice 3; migration 0109; src/sweep-pass.ts): a tick after a complete
// pass reads the gate and stops, and a write on the CORE dependency ledger,
// or a new sweep policy, starts the next pass.
import { afterAll, expect } from "bun:test";
import { type Miniflare } from "miniflare";
import { startPipeline } from "./harness.ts";
import {
  CARD_DEBIT_READING_MARK_SQL,
  CARD_SETTLEMENT_STATEMENTS_SQL,
  CARD_SETTLEMENT_SWEEP_POLICY,
  CARD_SETTLEMENT_SWEEP_VIEWS,
  cardSettlementSweep,
} from "../src/card-settlement-job.ts";
import {
  CARD_PURCHASE_SWEEP_POLICY,
  CARD_PURCHASE_SWEEP_VIEWS,
  cardPurchaseSweep,
} from "../src/card-purchase-job.ts";
import { finishSweepPass, openSweepTick } from "../src/sweep-pass.ts";
import { sweepViewsDigest } from "./support/sweep-views.ts";
import { settledTest } from "./support/settle.ts";

let mf: Miniflare, env: Env;
// Started while the module loads, never in a hook (test/support/settle.ts).
({ mf, env } = await startPipeline());
const test = settledTest();
afterAll(async () => {
  await mf?.dispose();
});

/** The binding, recording the text of every statement prepared on it. */
function recording(db: D1Database, prepared: string[]): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          prepared.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let probe = 0;
/** One row on the CORE dependency ledger, which moves the source revision. */
async function ledgerWrite(): Promise<void> {
  probe += 1;
  const id = `dr_sweep_probe_${probe}`;
  await env.DB.prepare(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,
      actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES(?1,'relation',?1,1,'accept','manual','operator:1',NULL,
      'Synthetic: sweep gate probe.','[]',NULL,NULL,'2026-11-24T00:00:00Z')`,
  )
    .bind(id)
    .run();
}

const gateRow = (sweep: string) =>
  env.DB.prepare(
    "SELECT pass_source_revision, clean_source_revision, clean_policy FROM processor_sweep_passes WHERE sweep=?",
  )
    .bind(sweep)
    .first<{
      pass_source_revision: number | null;
      clean_source_revision: number | null;
      clean_policy: string | null;
    }>();

test("the settlement sweep reads its statements again only after the CORE revision moves", async () => {
  // A first pass: nothing is clean yet, and an empty page ends it.
  const first: string[] = [];
  await cardSettlementSweep(recording(env.DB, first));
  expect(first).toContain(CARD_SETTLEMENT_STATEMENTS_SQL);
  const cleaned = await gateRow("card_settlement");
  expect(cleaned?.clean_source_revision).not.toBeNull();
  expect(cleaned?.pass_source_revision).toBeNull();

  // Nothing moved: the tick reads the card information mark, then its cursor
  // and the gate in one statement, and stops.
  const quiet: string[] = [];
  const skipped = await cardSettlementSweep(recording(env.DB, quiet));
  expect(skipped).toMatchObject({ scanned: 0, proposed: 0, written: 0 });
  expect(quiet).toHaveLength(2);
  expect(quiet).toContain(CARD_DEBIT_READING_MARK_SQL);
  expect(quiet).not.toContain(CARD_SETTLEMENT_STATEMENTS_SQL);

  // A ledger write starts the next pass.
  await ledgerWrite();
  const moved: string[] = [];
  await cardSettlementSweep(recording(env.DB, moved));
  expect(moved).toContain(CARD_SETTLEMENT_STATEMENTS_SQL);
  expect((await gateRow("card_settlement"))!.clean_source_revision).toBeGreaterThan(
    cleaned!.clean_source_revision!,
  );

  // So does a pass recorded under another policy (a deploy that changes what
  // a pass decides, or a new card information reading off the ledger).
  await env.DB.prepare(
    "UPDATE processor_sweep_passes SET clean_policy='an-older-sweep' WHERE sweep='card_settlement'",
  ).run();
  const redeployed: string[] = [];
  await cardSettlementSweep(recording(env.DB, redeployed));
  expect(redeployed).toContain(CARD_SETTLEMENT_STATEMENTS_SQL);
});

test("a settlement pass under way when the gate was deployed marks nothing clean", async () => {
  await env.DB.prepare(
    `UPDATE processor_sweep_passes SET pass_source_revision=NULL, pass_visibility_revision=NULL,
      pass_core_epoch=NULL, pass_policy=NULL, pass_token=NULL, clean_source_revision=NULL,
      clean_visibility_revision=NULL, clean_core_epoch=NULL, clean_policy=NULL
     WHERE sweep='card_settlement'`,
  ).run();
  await env.DB.prepare(
    "UPDATE card_settlement_scan_cursor SET last_statement_id=1 WHERE singleton=1",
  ).run();
  await cardSettlementSweep(env.DB);
  // The page after the cursor ended the pass, which had no recorded start.
  expect(await gateRow("card_settlement")).toMatchObject({
    pass_source_revision: null,
    clean_source_revision: null,
  });
  // The next tick starts a pass from the first statement and records it.
  const next: string[] = [];
  await cardSettlementSweep(recording(env.DB, next));
  expect(next).toContain(CARD_SETTLEMENT_STATEMENTS_SQL);
  expect((await gateRow("card_settlement"))!.clean_source_revision).not.toBeNull();
});

test("the purchase recognition pass reads its usage rows again only after the CORE revision moves", async () => {
  const usage = (sql: string) => sql.startsWith("WITH ranked_myjcb_snapshots");
  const first: string[] = [];
  await cardPurchaseSweep(recording(env.DB, first));
  expect(first.some(usage)).toBe(true);
  expect((await gateRow("card_purchase_recognition"))?.clean_source_revision).not.toBeNull();

  const quiet: string[] = [];
  const skipped = await cardPurchaseSweep(recording(env.DB, quiet));
  expect(skipped).toMatchObject({ scanned: 0, recognized: 0, proposed: 0 });
  expect(quiet.some(usage)).toBe(false);

  await ledgerWrite();
  const moved: string[] = [];
  await cardPurchaseSweep(recording(env.DB, moved));
  expect(moved.some(usage)).toBe(true);
});

test("a pass's end marks only the pass it started, never one an overlapping tick started", async () => {
  const sweep = "card_purchase_recognition";
  const policy = "an-overlap-probe";
  // Stand-ins for the sweep's cursor: at the first row, or on a later page.
  const first = "SELECT 0";
  const later = "SELECT 7";
  await ledgerWrite();
  // Tick A starts a pass; an overlapping tick B starts another before A ends.
  const a = await openSweepTick(env.DB, sweep, policy, first);
  const b = await openSweepTick(env.DB, sweep, policy, first);
  if (a.skip || b.skip) throw new Error("no pass started");
  expect(a.token).not.toBe(b.token);
  await finishSweepPass(env.DB, sweep, a.token);
  expect((await gateRow(sweep))?.clean_policy).not.toBe(policy);
  // A later tick of B's pass continues it, and its end marks it clean.
  const next = await openSweepTick(env.DB, sweep, policy, later);
  expect(next).toEqual({ skip: false, cursor: 7, token: b.token });
  await finishSweepPass(env.DB, sweep, b.token);
  expect((await gateRow(sweep))?.clean_policy).toBe(policy);
  expect(await openSweepTick(env.DB, sweep, policy, first)).toEqual({ skip: true });
  // A tick past the first row of a pass no longer recorded marks nothing.
  expect(await openSweepTick(env.DB, sweep, policy, later)).toEqual({
    skip: false,
    cursor: 7,
    token: null,
  });
});

test("each sweep's policy pins the views its code reads, and fits the gate's column", () => {
  // A migration that redefines one of these views moves no revision: update
  // the pin, which changes the policy and runs a pass again.
  expect(sweepViewsDigest(`${import.meta.dir}/../src/card-settlement-job.ts`)).toBe(
    CARD_SETTLEMENT_SWEEP_VIEWS,
  );
  expect(sweepViewsDigest(`${import.meta.dir}/../src/card-purchase-job.ts`)).toBe(
    CARD_PURCHASE_SWEEP_VIEWS,
  );
  // The settlement policy also carries the card information mark (`@<id>`).
  expect(`${CARD_SETTLEMENT_SWEEP_POLICY}@${Number.MAX_SAFE_INTEGER}`.length).toBeLessThanOrEqual(
    256,
  );
  expect(CARD_PURCHASE_SWEEP_POLICY.length).toBeLessThanOrEqual(256);
});
