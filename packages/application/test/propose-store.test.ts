// The proposal store and the schema probe against the real migrations: the
// SQL the agent paths used to hold in services/app (ADR 0081 point 2).
import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { commandProposalStore, storeHasFeature, STORE_FEATURES } from "../src/index.ts";
import type { StoredProposal } from "../src/propose.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

beforeAll(() => migratedDatabase().close(), 60_000);

function executor(db: Database): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      db.query(sql).all(...(args as (string | number | null)[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (db.query(sql).get(...(args as (string | number | null)[])) as T | null) ?? null,
  };
}

const PROPOSAL: StoredProposal = {
  decisionRevisionId: "dr_prop_synthetic",
  relationId: "rel_synthetic",
  kind: "same_account",
  fromRef: "source_account:sa_1",
  toRef: "source_account:sa_2",
  method: "ai",
  actorId: "mcp-client:synthetic-owner",
  reason: "synthetic shared identifier",
  evidenceRefs: ["observation:transaction:1"],
  recordedAt: "2026-11-07T00:00:00.000Z",
};

describe("commandProposalStore", () => {
  test("resolves a source account to its source and account, and an unknown ref to nothing", async () => {
    const db = migratedDatabase();
    db.run(
      "INSERT INTO source_accounts VALUES('sa_1','sony-bank','collector-r2-importer','[\"synthetic-account\"]')",
    );
    const store = commandProposalStore(sqliteCommandStore(db));
    expect(await store.resolveTarget("source_account:sa_1")).toEqual({
      sourceId: "sony-bank",
      account: "synthetic-account",
    });
    expect(await store.resolveTarget("source_account:sa_missing")).toBeNull();
    expect(await store.resolveTarget("account:sa_1")).toBeNull();
    expect(await store.resolveEvidence("observation:transaction:1")).toBeNull();
    expect(await store.resolveEvidence("fetch_artifact:1")).toBeNull();
    db.close();
  });

  test("appends one propose decision and one proposed relation, and never replaces them", async () => {
    const db = migratedDatabase();
    const store = commandProposalStore(sqliteCommandStore(db));
    await store.appendProposal(PROPOSAL);
    expect(
      db.query("SELECT decision_kind,subject_ref,actor_id FROM decision_revisions").all(),
    ).toEqual([
      { decision_kind: "propose", subject_ref: "rel_synthetic", actor_id: PROPOSAL.actorId },
    ]);
    expect(db.query("SELECT id,status,decision_revision_id FROM entity_relations").all()).toEqual([
      { id: "rel_synthetic", status: "proposed", decision_revision_id: "dr_prop_synthetic" },
    ]);
    await expect(store.appendProposal(PROPOSAL)).rejects.toThrow();
    expect(db.query("SELECT count(*) n FROM entity_relations").get()).toEqual({ n: 1 });
    db.close();
  });
});

describe("storeHasFeature", () => {
  test("a fully migrated store serves every feature", async () => {
    const db = migratedDatabase();
    for (const feature of Object.keys(STORE_FEATURES) as (keyof typeof STORE_FEATURES)[])
      expect(await storeHasFeature(executor(db), feature)).toBe(true);
    db.close();
  });

  test("a store missing any one table or view does not", async () => {
    const empty = new Database(":memory:");
    for (const feature of Object.keys(STORE_FEATURES) as (keyof typeof STORE_FEATURES)[])
      expect(await storeHasFeature(executor(empty), feature)).toBe(false);
    // Every name but one: still not served.
    empty.exec(
      "CREATE TABLE dataset_snapshot_policies(x); CREATE VIEW card_statement_facts AS SELECT 1",
    );
    expect(await storeHasFeature(executor(empty), "datedState")).toBe(false);
    empty.exec("CREATE VIEW card_settlement_reviews AS SELECT 1");
    expect(await storeHasFeature(executor(empty), "datedState")).toBe(true);
    // A table where a view is expected is not the view.
    empty.exec("CREATE TABLE card_settlement_readiness(x)");
    expect(await storeHasFeature(executor(empty), "cardSettlements")).toBe(false);
    empty.close();
  });
});
