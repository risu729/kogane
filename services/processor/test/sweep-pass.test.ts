// The cursor sweeps wait for a change once a pass has read every row (ADR
// 0129, slice 3; migration 0109; src/sweep-pass.ts): a tick after a complete
// pass reads the gate and stops, and a write on the CORE dependency ledger,
// or a new sweep policy, starts the next pass.
import { afterAll, expect } from "bun:test";
import { type Miniflare } from "miniflare";
import { startPipeline } from "./harness.ts";
import { CARD_SETTLEMENT_STATEMENTS_SQL, cardSettlementSweep } from "../src/card-settlement-job.ts";
import { cardPurchaseSweep } from "../src/card-purchase-job.ts";
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

  // Nothing moved: the tick reads the cursor and the gate, and stops.
  const quiet: string[] = [];
  const skipped = await cardSettlementSweep(recording(env.DB, quiet));
  expect(skipped).toMatchObject({ scanned: 0, proposed: 0, written: 0 });
  expect(quiet).toHaveLength(2);
  expect(quiet).not.toContain(CARD_SETTLEMENT_STATEMENTS_SQL);

  // A ledger write starts the next pass.
  await ledgerWrite();
  const moved: string[] = [];
  await cardSettlementSweep(recording(env.DB, moved));
  expect(moved).toContain(CARD_SETTLEMENT_STATEMENTS_SQL);
  expect((await gateRow("card_settlement"))!.clean_source_revision).toBeGreaterThan(
    cleaned!.clean_source_revision!,
  );

  // So does a pass recorded under another policy (a deploy that changes what a pass decides).
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
      pass_core_epoch=NULL, clean_source_revision=NULL, clean_visibility_revision=NULL,
      clean_core_epoch=NULL, clean_policy=NULL WHERE sweep='card_settlement'`,
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
