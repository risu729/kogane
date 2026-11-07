// The owner's default (ADR 0087) end to end: the sweep proposes a candidate
// whose two accounts have no recorded ownership with the default party on both
// sides, the settlement commands accept and withdraw it under the same guard
// as any other candidate, and a recorded contradiction takes the default away
// (the earlier candidate is refused at commit, the next one has unknown
// ownership and is refused at plan). Every value is synthetic.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";
import { cardSettlementSweep } from "../src/card-settlement-job.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  type ChangeKind,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";
import {
  OWNERSHIP_DEFAULT_PARTY,
  OWNERSHIP_DEFAULT_REF,
} from "../../../packages/domain/src/ownership-default.ts";
import type { CardSettlementFacts } from "../../../packages/domain/src/card-settlement.ts";
import { cardSettlementReadinessCtes } from "../../../packages/read-model/src/card-settlement-readiness.ts";

let mf: Miniflare, env: Env, db: D1Database;
const actor: Principal = {
  id: "synthetic-human",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const now = "2098-01-01T00:00:00.000Z";
let sequence = 0;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  db = env.DB;
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

/** One account per source account, as a provider-local identity. */
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

async function preparedCommand(kind: ChangeKind, payload: unknown) {
  const store = d1CommandStore(db);
  const planned = await createPlan(
    kind,
    payload,
    { actor, baseContextId: "identity-current-v1", now, ttlSeconds: 600 },
    store,
  );
  if (!planned.ok) throw new Error("plan " + JSON.stringify(planned));
  const approval = await approve(store, {
    planId: planned.plan.planId,
    planDigest: planned.plan.planDigest,
    actor,
    scope: [],
    ttlSeconds: 600,
    now,
  });
  if (!approval.ok) throw new Error("approval " + JSON.stringify(approval));
  return () =>
    commit(store, {
      operationId: "default-test-op-" + ++sequence,
      principal: actor,
      planId: planned.plan.planId,
      approvalId: approval.approval.approvalId,
      planners: changeMutationPlanners(db),
      now,
    });
}
const command = async (kind: ChangeKind, payload: unknown) =>
  (await preparedCommand(kind, payload))();
const count = async (sql: string): Promise<number> =>
  (await db.prepare(sql).first<{ n: number }>())!.n;

/**
 * A MyJCB statement total of 4000 due on the 10th of `period` and an SMBC
 * debit of 4000 on that day, each on its own source account (so its own
 * account), published and identified.
 */
async function pair(id: number, label: string, period: string): Promise<void> {
  const statement = id,
    debit = id + 1;
  for (const [parse, source, parser] of [
    [statement, "myjcb", "myjcb-credit-statement-total"],
    [debit, "smbc-bank", "smbc-direct-transactions"],
  ] as const) {
    await seedArtifact(env, parse, source, "synthetic", `owner-default-${parse}`, {});
    await db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1','2026-09-12','ok','[]')",
      )
      .bind(parse, parse, parser)
      .run();
  }
  await db
    .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
     VALUES(?,?,'credit_statement_payment_amount',4000,'4000',0,'JPY',?,'synthetic-total',?)`)
    .bind(
      statement,
      `myjcb:synthetic:${label}`,
      `${period}-01`,
      JSON.stringify({
        _kogane: {
          period,
          paymentDate: `${period}-10`,
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
  await db
    .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,as_of,raw_locator,extra_json)
     VALUES(?,?,?,'posted',-4000,'-4000',0,'JPY',?,'synthetic-debit',?)`)
    .bind(
      debit,
      `smbc-bank:synthetic-${label}`,
      `synthetic-debit-${label}`,
      `${period}-10T00:00:00+09:00`,
      JSON.stringify({
        id: `synthetic-debit-${label}`,
        _kogane: {
          direction: "outflow",
          amountSignSource: "direction",
          identityOrigin: "provider-id",
        },
      }),
    )
    .run();
  for (const [parse, source] of [
    [statement, "myjcb"],
    [debit, "smbc-bank"],
  ] as const) {
    await publishParse(db, parse);
    await identifyParse(
      db,
      {
        id: parse,
        artifact_id: parse,
        source_id: source,
        producer_id: "collector-r2-importer",
        fetch_run_id: parse,
      },
      resolver,
    );
  }
}

interface Candidate {
  id: string;
  facts: CardSettlementFacts;
}
async function candidatesOf(statementParse: number): Promise<Candidate[]> {
  return (
    await db
      .prepare(
        "SELECT id,facts_json FROM card_settlement_candidates WHERE statement_parse_run_id=? ORDER BY rowid",
      )
      .bind(statementParse)
      .all<{ id: string; facts_json: string }>()
  ).results.map((row) => ({
    id: row.id,
    facts: JSON.parse(row.facts_json) as CardSettlementFacts,
  }));
}
/** `ownership_current` as the shipped reads and the commit guard judge it. */
async function ownershipCurrent(id: string): Promise<number | undefined> {
  return (
    await db
      .prepare(
        `WITH chosen AS (SELECT ?1 AS id), ${cardSettlementReadinessCtes()} SELECT ownership_current FROM readiness`,
      )
      .bind(id)
      .first<{ ownership_current: number }>()
  )?.ownership_current;
}

test("with no recorded ownership, the default owns both sides, and the candidate is accepted and withdrawn like any other", async () => {
  await pair(1201, "a", "2026-09");
  await cardSettlementSweep(db);
  const [candidate, ...rest] = await candidatesOf(1201);
  expect(rest).toEqual([]);
  const facts = candidate!.facts;
  expect(facts.ownership).toBe("established-same");
  expect(facts.statement.ownerRef).toBe(OWNERSHIP_DEFAULT_PARTY);
  expect(facts.bankDebit.ownerRef).toBe(OWNERSHIP_DEFAULT_PARTY);
  // Each side cites its own mapping and the default, nothing else.
  expect(facts.ownershipEvidenceRefs).toHaveLength(3);
  expect(facts.ownershipEvidenceRefs.filter((ref) => ref === OWNERSHIP_DEFAULT_REF)).toHaveLength(
    1,
  );
  expect(
    facts.ownershipEvidenceRefs.filter((ref) => ref.startsWith("account_mapping:")),
  ).toHaveLength(2);
  expect(facts.rejectionConditions).not.toContain("owner_not_established");
  expect(await ownershipCurrent(candidate!.id)).toBe(1);

  const accepted = await command("card-settlement.accept", {
    proposalId: candidate!.id,
    reason: "synthetic acceptance under the owner's default",
  });
  if (!accepted.ok) throw new Error(JSON.stringify(accepted));
  expect(await count("SELECT count(*) AS n FROM current_allocations")).toBe(1);
  // The decision cites the default like any other ownership evidence.
  const evidence = await db
    .prepare(
      `SELECT d.evidence_refs_json FROM card_settlement_decisions s
       JOIN decision_revisions d ON d.id=s.decision_revision_id WHERE s.proposal_id=?`,
    )
    .bind(candidate!.id)
    .first<{ evidence_refs_json: string }>();
  expect(JSON.parse(evidence!.evidence_refs_json)).toContain(OWNERSHIP_DEFAULT_REF);
  const withdrawn = await command("card-settlement.withdraw", {
    proposalId: candidate!.id,
    reason: "synthetic withdrawal",
  });
  if (!withdrawn.ok) throw new Error(JSON.stringify(withdrawn));
  expect(await count("SELECT count(*) AS n FROM current_allocations")).toBe(0);
}, 60000);

test("a recorded contradiction takes the default away: the planned acceptance is refused, and the next candidate's ownership is unknown", async () => {
  await pair(1211, "b", "2026-10");
  await cardSettlementSweep(db);
  const [candidate] = await candidatesOf(1211);
  expect(candidate!.facts.ownershipEvidenceRefs).toContain(OWNERSHIP_DEFAULT_REF);
  const accept = await preparedCommand("card-settlement.accept", {
    proposalId: candidate!.id,
    reason: "planned before the contradiction",
  });
  const receipts = await count("SELECT count(*) AS n FROM operation_receipts");
  // A contradiction recorded on the card's account after the plan.
  const account = candidate!.facts.statement.accountId!;
  await db.batch([
    db
      .prepare(
        `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,created_at)
       VALUES('default-test-contradiction-decision','relation','default-test-contradiction',1,'accept','manual','synthetic-human',NULL,'synthetic contradiction','[]',NULL,?)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
       VALUES('default-test-contradiction','contradicts',?,'card-settlement:synthetic',NULL,NULL,'accepted','default-test-contradiction-decision','[]',?)`,
      )
      .bind("account:" + account, now),
  ]);
  expect(await ownershipCurrent(candidate!.id)).toBe(0);
  expect((await accept()).ok).toBe(false);
  expect(await count("SELECT count(*) AS n FROM operation_receipts")).toBe(receipts);
  expect(await count("SELECT count(*) AS n FROM current_allocations")).toBe(0);

  // The next pass proposes the pair again, now without an owner on the card side.
  await cardSettlementSweep(db);
  const next = (await candidatesOf(1211)).filter((row) => row.id !== candidate!.id);
  expect(next).toHaveLength(1);
  expect(next[0]!.facts.ownership).toBe("unknown");
  expect(next[0]!.facts.statement.ownerRef).toBeNull();
  expect(next[0]!.facts.bankDebit.ownerRef).toBe(OWNERSHIP_DEFAULT_PARTY);
  expect(next[0]!.facts.rejectionConditions).toContain("owner_not_established");
  await expect(
    command("card-settlement.accept", { proposalId: next[0]!.id, reason: "unknown ownership" }),
  ).rejects.toThrow();
  expect(await count("SELECT count(*) AS n FROM current_allocations")).toBe(0);
}, 60000);
