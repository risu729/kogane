import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { startPipeline, seedArtifact, publishParse } from "./harness.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";

let mf: Miniflare,
  env: Env,
  db: D1Database,
  sequence = 800;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  db = env.DB;
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});
const resolver: IdentityResolver = (input) => ({
  account: {
    key: [input.sourceAccount],
    label: "synthetic ownership",
    role: "deposit",
    status: "provider-local",
    reason: "synthetic-policy",
  },
  instruments: [],
  issues: [],
});
async function account(): Promise<{ accountId: string; observationId: number }> {
  const id = ++sequence;
  await seedArtifact(env, id, "myjcb", "synthetic", "ownership-" + id, {});
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'synthetic','1','2026-09-13','ok','[]')",
    )
    .bind(id, id)
    .run();
  const observation = await db
    .prepare(
      "INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json) VALUES(?,?,'synthetic','JPY','synthetic','{}') RETURNING id",
    )
    .bind(id, "myjcb:ownership-" + id)
    .first<{ id: number }>();
  await publishParse(db, id);
  await identifyParse(
    db,
    {
      id,
      artifact_id: id,
      source_id: "myjcb",
      producer_id: "collector-r2-importer",
      fetch_run_id: id,
    },
    resolver,
  );
  const mapping = await db
    .prepare(
      "SELECT m.account_id FROM current_identity_observations o JOIN current_account_mappings m ON m.source_account_id=o.source_account_id WHERE o.kind='balance' AND o.observation_id=?",
    )
    .bind(observation!.id)
    .first<{ account_id: string }>();
  if (!mapping) throw new Error("synthetic identity missing");
  return { accountId: mapping.account_id, observationId: observation!.id };
}
async function relation(from: string, to: string, status: "accepted" | "rejected", dated = false) {
  const id = "ownership-relation-" + ++sequence,
    decision = "decision-" + id;
  await db.batch([
    db
      .prepare(`INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,reason,evidence_refs_json,created_at)
  VALUES(?,'relation',?,1,?,'manual','synthetic-human','Explicit synthetic ownership proof','[]','2026-09-13')`)
      .bind(decision, id, status === "accepted" ? "accept" : "reject"),
    db
      .prepare(`INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
  VALUES(?,'liable_party',?,?,?,?,?,?,'[]','2026-09-13')`)
      .bind(
        id,
        from,
        to,
        dated ? "2026-09-01" : null,
        dated ? "2026-09-30" : null,
        status,
        decision,
      ),
  ]);
}
async function owner(observationId: number): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT owner_ref FROM card_settlement_fact_ownership WHERE kind='balance' AND observation_id=?",
    )
    .bind(observationId)
    .first<{ owner_ref: string | null }>();
  return row?.owner_ref ?? null;
}
test("a conflicting dated owner cannot be discarded in favor of a timeless owner", async () => {
  const { accountId, observationId } = await account();
  await relation("account:" + accountId, "party:original", "accepted");
  expect(await owner(observationId)).toBe("party:original");
  await relation("account:" + accountId, "party:other", "accepted", true);
  expect(await owner(observationId)).toBeNull();
});
test("timeless-only review fails closed even when the dated claim names the same owner", async () => {
  const { accountId, observationId } = await account();
  await relation(accountId, "party:original", "accepted");
  await relation("account:" + accountId, "party:original", "accepted", true);
  expect(await owner(observationId)).toBeNull();
});
test("rejecting an ownership claim through the prefixed alias retracts the bare alias claim", async () => {
  const { accountId, observationId } = await account();
  await relation(accountId, "party:original", "accepted");
  expect(await owner(observationId)).toBe("party:original");
  await relation("account:" + accountId, "party:original", "rejected");
  expect(await owner(observationId)).toBeNull();
});
test("rejecting through the bare alias also retracts a prefixed claim", async () => {
  const { accountId, observationId } = await account();
  await relation("account:" + accountId, "party:original", "accepted");
  await relation(accountId, "party:original", "rejected");
  expect(await owner(observationId)).toBeNull();
});
test("a dated claim rejected through another alias no longer vetoes an independent timeless owner", async () => {
  const { accountId, observationId } = await account();
  await relation("account:" + accountId, "party:original", "accepted");
  await relation("account:" + accountId, "party:other", "accepted", true);
  expect(await owner(observationId)).toBeNull();
  await relation(accountId, "party:other", "rejected");
  expect(await owner(observationId)).toBe("party:original");
});
