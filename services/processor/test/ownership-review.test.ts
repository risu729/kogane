import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { startPipeline, seedArtifact, publishParse } from "./harness.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";
import { cardSettlementSweep } from "../src/card-settlement-job.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";
import {
  createPlan,
  approve,
  commit,
  d1CommandStore,
  type Principal,
  type RelationPayload,
  type CommandStore,
} from "../../../packages/application/src/index.ts";
import {
  ownershipReviewEvidenceRefs,
  ownershipReviewPartyRef,
} from "../../../packages/domain/src/ownership-review.ts";
import type { CardSettlementFacts } from "../../../packages/domain/src/card-settlement.ts";

let mf: Miniflare,
  env: Env,
  db: D1Database,
  next = 900,
  operation = 0;
const now = "2098-01-01T00:00:00.000Z";
const human: Principal = {
  id: "synthetic-human",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const agent: Principal = {
  ...human,
  id: "synthetic-agent",
  kind: "agent",
  capabilities: ["interpretation.propose"],
};
const resolver: IdentityResolver = (input) => ({
  account: {
    key: [input.sourceAccount],
    label: "synthetic",
    role: "deposit",
    status: "provider-local",
    reason: "test",
  },
  instruments: [],
  issues: [],
});
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  db = env.DB;
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});
async function candidate() {
  const statement = ++next,
    bank = ++next,
    amount = statement * 10;
  for (const [id, source] of [
    [statement, "myjcb"],
    [bank, "smbc-bank"],
  ] as const) {
    await seedArtifact(env, id, source, "synthetic", "ownership-command-" + id, {});
    await db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1','2026-09-13','ok','[]')",
      )
      .bind(
        id,
        id,
        source === "myjcb" ? "myjcb-credit-statement-total" : "smbc-direct-transactions",
      )
      .run();
  }
  await db
    .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,raw_locator,extra_json)
 VALUES(?,?,'credit_statement_payment_amount',?,?,0,'JPY','synthetic-total',?)`)
    .bind(
      statement,
      "myjcb:ownership-" + statement,
      amount,
      String(amount),
      JSON.stringify({
        _kogane: {
          period: "2026-09",
          paymentDate: "2026-09-10",
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
  await db
    .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,as_of,raw_locator,extra_json)
 VALUES(?,?,?,'posted',?,?,0,'JPY','2026-09-10T00:00:00+09:00','synthetic-debit',?)`)
    .bind(
      bank,
      "smbc-bank:ownership-" + bank,
      "provider-" + bank,
      -amount,
      String(-amount),
      JSON.stringify({ _kogane: { direction: "outflow", amountSignSource: "direction" } }),
    )
    .run();
  for (const [id, source] of [
    [statement, "myjcb"],
    [bank, "smbc-bank"],
  ] as const) {
    await publishParse(db, id);
    await identifyParse(
      db,
      {
        id,
        artifact_id: id,
        source_id: source,
        producer_id: "collector-r2-importer",
        fetch_run_id: id,
      },
      resolver,
    );
  }
  await cardSettlementSweep(db);
  const c = await db
    .prepare("SELECT id,facts_json FROM card_settlement_candidates WHERE statement_parse_run_id=?")
    .bind(statement)
    .first<{ id: string; facts_json: string }>();
  if (!c) throw new Error("synthetic candidate missing");
  const facts = JSON.parse(c.facts_json) as CardSettlementFacts;
  const fact = facts.statement.ref,
    observation = Number(fact.id.split(":")[1]);
  const mapping = await db
    .prepare(
      "SELECT m.id,m.source_account_id,m.account_id FROM current_identity_observations o JOIN current_account_mappings m ON m.source_account_id=o.source_account_id WHERE o.kind='balance' AND o.observation_id=?",
    )
    .bind(observation)
    .first<{ id: string; source_account_id: string; account_id: string }>();
  if (!mapping) throw new Error("synthetic mapping missing");
  const payload: RelationPayload = {
    relationKind: "liable_party",
    fromRef: "account:" + mapping.account_id,
    toRef: "party:本人A",
    validFrom: null,
    validTo: null,
    evidenceRefs: ownershipReviewEvidenceRefs(c.id, fact, mapping.id),
    reason: "Statement evidence and account ownership verified by operator",
  };
  return { proposalId: c.id, payload, statement, bank, mapping, facts };
}
async function planned(payload: RelationPayload, actor = human) {
  const store = d1CommandStore(db);
  const p = await createPlan(
    "relation.accept",
    payload,
    { actor, baseContextId: "identity-current-v1", now, ttlSeconds: 600 },
    store,
  );
  if (!p.ok) throw new Error(JSON.stringify(p));
  return p.plan;
}
async function prepared(payload: RelationPayload) {
  const store = d1CommandStore(db),
    plan = await planned(payload);
  const a = await approve(store, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    actor: human,
    scope: [],
    ttlSeconds: 600,
    now,
  });
  if (!a.ok) throw new Error(JSON.stringify(a));
  const operationId = "ownership-review-" + ++operation;
  return {
    plan,
    approvalId: a.approval.approvalId,
    run: (alternate: CommandStore = store) =>
      commit(alternate, {
        operationId,
        principal: human,
        planId: plan.planId,
        approvalId: a.approval.approvalId,
        now,
        planners: changeMutationPlanners(db),
      }),
  };
}
test("explicit Unicode party and evidence pass human lifecycle without accepting any financial match", async () => {
  expect(ownershipReviewPartyRef("party:本人A")).toBe(true);
  expect(ownershipReviewPartyRef("party:")).toBe(false);
  expect(ownershipReviewPartyRef("party:A|B")).toBe(false);
  const c = await candidate(),
    p = await prepared(c.payload);
  expect(p.plan.simulation.targets).toHaveLength(4);
  expect(p.plan.simulation.invalidations).toContain("review:card-ownership");
  expect((await p.run()).ok).toBe(true);
  const status = await db
    .prepare("SELECT status FROM card_settlement_reviews WHERE id=?")
    .bind(c.proposalId)
    .first<{ status: string }>();
  expect(status?.status).toBe("proposed");
  expect(
    (await db.prepare("SELECT count(*) AS n FROM allocations").first<{ n: number }>())!.n,
  ).toBe(0);

  const bankMapping = await db
    .prepare(
      "SELECT m.id,m.account_id FROM current_identity_observations o JOIN current_account_mappings m ON m.source_account_id=o.source_account_id WHERE o.kind='transaction' AND o.parse_run_id=?",
    )
    .bind(c.bank)
    .first<{ id: string; account_id: string }>();
  if (!bankMapping) throw new Error("bank mapping missing");
  const bankPayload: RelationPayload = {
    ...c.payload,
    relationKind: "beneficial_owner",
    fromRef: "account:" + bankMapping.account_id,
    evidenceRefs: ownershipReviewEvidenceRefs(c.proposalId, c.facts.bankDebit.ref, bankMapping.id),
  };
  expect((await (await prepared(bankPayload)).run()).ok).toBe(true);
  await cardSettlementSweep(db);
  const refreshed = await db
    .prepare(
      "SELECT id FROM card_settlement_reviews WHERE statement_parse_run_id=? AND json_extract(facts_json,'$.ownership')='established-same' AND status='proposed'",
    )
    .bind(c.statement)
    .first<{ id: string }>();
  expect(refreshed?.id).toBeDefined();
  expect(refreshed?.id).not.toBe(c.proposalId);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM allocations").first<{ n: number }>())!.n,
  ).toBe(0);
});
test("agent may propose but cannot approve ownership; missing/spoofed proof or account is rejected", async () => {
  const c = await candidate(),
    plan = await planned(c.payload, agent),
    store = d1CommandStore(db);
  expect(
    (
      await approve(store, {
        planId: plan.planId,
        planDigest: plan.planDigest,
        actor: agent,
        scope: [],
        ttlSeconds: 600,
        now,
      })
    ).ok,
  ).toBe(false);
  for (const payload of [
    { ...c.payload, evidenceRefs: c.payload.evidenceRefs.slice(0, 3) },
    {
      ...c.payload,
      evidenceRefs: [...c.payload.evidenceRefs.slice(0, 3), "account_mapping:invented"],
    },
    { ...c.payload, toRef: "party:bad|identifier" },
    { ...c.payload, fromRef: "account:invented" },
    { ...c.payload, validFrom: "2026-09-01" },
  ]) {
    expect(
      (
        await createPlan(
          "relation.accept",
          payload,
          { actor: human, baseContextId: "identity-current-v1", now, ttlSeconds: 600 },
          store,
        )
      ).ok,
    ).toBe(false);
  }
});
test("a competing owner claim arriving at batch time invalidates the approved plan atomically", async () => {
  const c = await candidate(),
    first = await prepared(c.payload),
    other = await prepared({ ...c.payload, toRef: "party:本人B" });
  const store = d1CommandStore(db);
  let injected = false;
  const racing: CommandStore = {
    ...store,
    batch: async (writes) => {
      if (!injected) {
        injected = true;
        expect((await other.run()).ok).toBe(true);
      }
      return store.batch(writes);
    },
  };
  expect((await first.run(racing)).ok).toBe(false);
  expect(
    (await db
      .prepare("SELECT uses_remaining FROM approvals WHERE approval_id=?")
      .bind(first.approvalId)
      .first<{ uses_remaining: number }>())!.uses_remaining,
  ).toBe(1);
  const rows = await db
    .prepare("SELECT to_ref FROM entity_relations WHERE kind='liable_party' AND from_ref=?")
    .bind(c.payload.fromRef)
    .all<{ to_ref: string }>();
  expect(rows.results.map((row) => row.to_ref)).toEqual(["party:本人B"]);
});
test("changed publication at batch time writes no ownership, receipt, or spent approval", async () => {
  const c = await candidate(),
    p = await prepared(c.payload),
    store = d1CommandStore(db);
  const before = (await db
    .prepare("SELECT count(*) AS n FROM operation_receipts")
    .first<{ n: number }>())!.n;
  let injected = false;
  const racing: CommandStore = {
    ...store,
    batch: async (writes) => {
      if (!injected) {
        injected = true;
        // A successful replacement parse publishes no old statement observation.
        const newer = ++next;
        await db
          .prepare(
            "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'myjcb-credit-statement-total','2','2026-09-14','ok','[]')",
          )
          .bind(newer, c.statement)
          .run();
        await publishParse(db, newer);
      }
      return store.batch(writes);
    },
  };
  expect((await p.run(racing)).ok).toBe(false);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM operation_receipts").first<{ n: number }>())!.n,
  ).toBe(before);
  expect(
    (await db
      .prepare("SELECT uses_remaining FROM approvals WHERE approval_id=?")
      .bind(p.approvalId)
      .first<{ uses_remaining: number }>())!.uses_remaining,
  ).toBe(1);
  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM entity_relations WHERE from_ref=?")
      .bind(c.payload.fromRef)
      .first<{ n: number }>())!.n,
  ).toBe(0);
});

test("account remapping at batch time cannot attach the approved ownership proof to a different account", async () => {
  const c = await candidate(),
    p = await prepared(c.payload),
    store = d1CommandStore(db);
  await db
    .prepare(
      "INSERT INTO accounts(id,label,role,status) VALUES('synthetic-remapped-account','synthetic remapping','deposit','identified')",
    )
    .run();
  let injected = false;
  const racing: CommandStore = {
    ...store,
    batch: async (writes) => {
      if (!injected) {
        injected = true;
        await db
          .prepare(`INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
    SELECT 'synthetic-remapping-proof',source_account_id,revision+1,'synthetic-remapped-account','manual','Explicit identity correction',policy_version,'2098','synthetic','identified'
    FROM account_mappings WHERE id=?`)
          .bind(c.mapping.id)
          .run();
      }
      return store.batch(writes);
    },
  };
  expect((await p.run(racing)).ok).toBe(false);
  expect(
    (await db
      .prepare("SELECT uses_remaining FROM approvals WHERE approval_id=?")
      .bind(p.approvalId)
      .first<{ uses_remaining: number }>())!.uses_remaining,
  ).toBe(1);
  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM entity_relations WHERE from_ref=?")
      .bind(c.payload.fromRef)
      .first<{ n: number }>())!.n,
  ).toBe(0);
});
