import { beforeAll, afterAll, test, expect } from "bun:test";
import { type Miniflare } from "miniflare";
import { startPipeline, seedArtifact, publishParse } from "./harness.ts";
import { smbcDirectTransactions } from "../../../packages/parsers/src/parsers/smbc-direct.ts";
import { cardSettlementSweep } from "../src/card-settlement-job.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";
import {
  createPlan,
  approve,
  commit,
  d1CommandStore,
  type ChangeKind,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";

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
      operationId: "test-op-" + ++sequence,
      principal: actor,
      planId: planned.plan.planId,
      approvalId: approval.approval.approvalId,
      planners: changeMutationPlanners(db),
      now,
    });
}
async function command(kind: ChangeKind, payload: unknown) {
  return (await preparedCommand(kind, payload))();
}
async function ownership(parse: number, kind: "liable_party" | "beneficial_owner") {
  const mapping = await db
    .prepare(
      "SELECT m.account_id FROM current_account_mappings m JOIN current_identity_observations o ON o.source_account_id=m.source_account_id WHERE o.parse_run_id=? LIMIT 1",
    )
    .bind(parse)
    .first<{ account_id: string }>();
  if (!mapping) throw new Error("no mapping");
  const result = await command("relation.accept", {
    relationKind: kind,
    fromRef: "account:" + mapping.account_id,
    toRef: "party:synthetic-owner",
    validFrom: null,
    validTo: null,
    evidenceRefs: ["synthetic-proof"],
    reason: "Synthetic explicit ownership evidence",
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(result.ok).toBe(true);
}
async function seed() {
  for (const [id, source] of [
    [701, "myjcb"],
    [702, "smbc-bank"],
  ] as const) {
    await seedArtifact(env, id, source, "synthetic", "synthetic-" + id, {});
    await db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1','2026-09-12','ok','[]')",
      )
      .bind(
        id,
        id,
        source === "myjcb" ? "myjcb-credit-statement-total" : "smbc-direct-transactions",
      )
      .run();
  }
  await db
    .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
 VALUES(701,'myjcb:synthetic:root','credit_statement_payment_amount',3000,'3000',0,'JPY','2026-09-01','synthetic-total',?)`)
    .bind(
      JSON.stringify({
        _kogane: {
          period: "2026-09",
          paymentDate: "2026-09-10",
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
  const parsed = await smbcDirectTransactions.parse(
    new TextEncoder().encode(
      JSON.stringify({
        range: { start: "2026-09-01", end: "2026-09-30" },
        depositsTotal: 0,
        withdrawalsTotal: 3000,
        transactions: [
          {
            id: "synthetic-provider-debit",
            date: "2026-09-10T00:00:00+09:00",
            amount: 3000,
            balanceAfter: 7000,
            description: "synthetic",
            direction: "debit",
          },
        ],
      }),
    ),
    {
      id: 702,
      sourceId: "smbc-bank",
      runStatus: "success",
      runFailureCount: 0,
      dataset: "transactions-normalized",
      artifactKey: "transactions/20260901-20260930.normalized.json",
      url: null,
      mime: "application/json",
      fetchedAt: "2026-09-12T00:00:00.000Z",
      sha256: "0".repeat(64),
    },
  );
  for (const row of parsed.observations) {
    if (row.kind !== "transaction") continue;
    await db
      .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json)
  VALUES(702,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        row.sourceAccount,
        row.externalId ?? null,
        row.status ?? null,
        row.amountMinor ?? null,
        row.amountText ?? null,
        row.amountScale ?? null,
        row.currency ?? null,
        row.counterparty ?? null,
        row.asOf ?? null,
        row.rawLocator,
        JSON.stringify(row.extra),
      )
      .run();
  }
  for (const [id, source] of [
    [701, "myjcb"],
    [702, "smbc-bank"],
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
}
test("real SMBC parser shape yields a review but unknown ownership cannot be accepted", async () => {
  await seed();
  expect(await cardSettlementSweep(db)).toMatchObject({ proposed: 1, written: 1 });
  const row = await db
    .prepare("SELECT id,facts_json FROM card_settlement_reviews")
    .first<{ id: string; facts_json: string }>();
  expect(JSON.parse(row!.facts_json).bankDebit.occurred.value).toBe("2026-09-10");
  await expect(
    command("card-settlement.accept", { proposalId: row!.id, reason: "test" }),
  ).rejects.toThrow();
  expect(
    (await db.prepare("SELECT count(*) AS n FROM economic_event_revisions").first<{ n: number }>())!
      .n,
  ).toBe(0);
}, 60000);
test("explicit approval allocates existing cash once; withdrawal preserves facts and historical decisions", async () => {
  await ownership(701, "liable_party");
  await ownership(702, "beneficial_owner");
  expect(await cardSettlementSweep(db)).toMatchObject({ written: 1 });
  const row = await db
    .prepare(
      "SELECT id FROM card_settlement_candidates WHERE json_extract(facts_json,'$.ownership')='established-same'",
    )
    .first<{ id: string }>();
  const accepted = await command("card-settlement.accept", {
    proposalId: row!.id,
    reason: "verified total and bank debit",
  });
  if (!accepted.ok) throw new Error(JSON.stringify(accepted));
  expect(accepted.ok).toBe(true);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM current_allocations").first<{ n: number }>())!.n,
  ).toBe(1);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM obligation_revisions").first<{ n: number }>())!.n,
  ).toBe(0);
  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM economic_legs WHERE basis='purchase-recognition'")
      .first<{ n: number }>())!.n,
  ).toBe(0);
  const withdrawn = await command("card-settlement.withdraw", {
    proposalId: row!.id,
    reason: "correspondence judgement corrected",
  });
  if (!withdrawn.ok) throw new Error(JSON.stringify(withdrawn));
  expect(withdrawn.ok).toBe(true);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM current_allocations").first<{ n: number }>())!.n,
  ).toBe(0);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM allocations").first<{ n: number }>())!.n,
  ).toBe(1);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM economic_event_revisions").first<{ n: number }>())!
      .n,
  ).toBe(2);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM transaction_observations").first<{ n: number }>())!
      .n,
  ).toBe(1);
}, 60000);

async function cloneCandidate(label: string): Promise<string> {
  const id = "synthetic-candidate-" + label;
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await db
    .prepare(`INSERT INTO card_settlement_candidates
 (id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
 SELECT ?,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,?,created_at
 FROM card_settlement_candidates WHERE json_extract(facts_json,'$.ownership')='established-same' ORDER BY id LIMIT 1`)
    .bind(id, digest)
    .run();
  return id;
}
test("rejection appends a judgement without allocating or rewriting the immutable candidate", async () => {
  const proposalId = await cloneCandidate("rejected");
  expect(
    (await command("card-settlement.reject", { proposalId, reason: "not this payment" })).ok,
  ).toBe(true);
  expect(
    (await db
      .prepare("SELECT status FROM card_settlement_reviews WHERE id=?")
      .bind(proposalId)
      .first<{ status: string }>())!.status,
  ).toBe("rejected");
  expect(
    (await db.prepare("SELECT count(*) AS n FROM current_allocations").first<{ n: number }>())!.n,
  ).toBe(0);
  await expect(
    db
      .prepare("UPDATE card_settlement_candidates SET facts_json='{}' WHERE id=?")
      .bind(proposalId)
      .run(),
  ).rejects.toThrow();
});
test("two approved alternatives cannot consume the same provider debit twice; correction needs withdrawal", async () => {
  const a = await cloneCandidate("alternative-a"),
    b = await cloneCandidate("alternative-b");
  const first = await preparedCommand("card-settlement.accept", {
    proposalId: a,
    reason: "first reviewed alternative",
  });
  const competing = await preparedCommand("card-settlement.accept", {
    proposalId: b,
    reason: "competing alternative",
  });
  expect((await first()).ok).toBe(true);
  const receiptCount = (await db
    .prepare("SELECT count(*) AS n FROM operation_receipts")
    .first<{ n: number }>())!.n;
  expect((await competing()).ok).toBe(false);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM operation_receipts").first<{ n: number }>())!.n,
  ).toBe(receiptCount);
  expect(
    (await db
      .prepare("SELECT allocation_available FROM card_settlement_readiness WHERE id=?")
      .bind(b)
      .first<{ allocation_available: number }>())!.allocation_available,
  ).toBe(0);
  expect(
    (
      await command("card-settlement.withdraw", {
        proposalId: a,
        reason: "correct prior matching judgement",
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await command("card-settlement.accept", {
        proposalId: b,
        reason: "now approve corrected match",
      })
    ).ok,
  ).toBe(true);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM current_allocations").first<{ n: number }>())!.n,
  ).toBe(1);
}, 60000);

test("published debit revision invalidates approval; a generic allocation against the old representation blocks reuse", async () => {
  expect(
    (
      await command("card-settlement.withdraw", {
        proposalId: "synthetic-candidate-alternative-b",
        reason: "prepare correction review",
      })
    ).ok,
  ).toBe(true);
  const staleId = await cloneCandidate("stale-source");
  const staleCommit = await preparedCommand("card-settlement.accept", {
    proposalId: staleId,
    reason: "review before changed source",
  });
  const receipts = (await db
    .prepare("SELECT count(*) AS n FROM operation_receipts")
    .first<{ n: number }>())!.n;
  await seedArtifact(
    env,
    703,
    "smbc-bank",
    "transactions-normalized",
    "refreshed-provider-debit",
    {},
  );
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(703,703,'smbc-direct-transactions','1','2026-09-13','ok','[]')",
    )
    .run();
  await db
    .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json)
 SELECT 703,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json FROM transaction_observations WHERE parse_run_id=702`)
    .run();
  await publishParse(db, 703);
  await identifyParse(
    db,
    {
      id: 703,
      artifact_id: 703,
      source_id: "smbc-bank",
      producer_id: "collector-r2-importer",
      fetch_run_id: 703,
    },
    resolver,
  );
  const staleResult = await staleCommit();
  expect(staleResult.ok).toBe(false);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM operation_receipts").first<{ n: number }>())!.n,
  ).toBe(receipts);
  expect(
    (await db
      .prepare("SELECT bank_current FROM card_settlement_readiness WHERE id=?")
      .bind(staleId)
      .first<{ bank_current: number }>())!.bank_current,
  ).toBe(0);
  await db
    .prepare(`INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,reason,evidence_refs_json,created_at)
 VALUES('generic-decision','relation','allocation:generic-allocation',1,'accept','manual','synthetic-human','Existing separate allocation','[]','2098')`)
    .run();
  await db
    .prepare(`INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,created_at)
 SELECT 'generic-allocation','transaction:'||id,'event:other-effect','transfer','JPY','1',0,'generic-decision','2098'
 FROM transaction_observations WHERE parse_run_id=702`)
    .run();
  expect((await cardSettlementSweep(db)).written).toBe(1);
  const fresh = await db
    .prepare(
      `SELECT c.id,r.ownership_current,r.allocation_available FROM card_settlement_candidates c JOIN card_settlement_readiness r ON r.id=c.id WHERE c.bank_parse_run_id=703`,
    )
    .first<{ id: string; ownership_current: number; allocation_available: number }>();
  expect(fresh).toMatchObject({ ownership_current: 1, allocation_available: 0 });
  expect(
    (await db.prepare("SELECT count(*) AS n FROM transaction_observations").first<{ n: number }>())!
      .n,
  ).toBe(2);
}, 60000);

test("one resolved card month cannot be allocated twice after raw ordinal changes", async () => {
  const stableCard: IdentityResolver = (input) => ({
    ...resolver(input),
    account: {
      key: ["synthetic-stable-card-token"],
      label: "synthetic card",
      role: "credit",
      status: "provider-local",
      reason: "synthetic verified stable card identity",
    },
  });
  for (const [id, source, parser] of [
    [801, "vpass", "vpass-statement-page"],
    [802, "vpass", "vpass-statement-page"],
    [803, "smbc-bank", "smbc-direct-transactions"],
  ] as const) {
    await seedArtifact(env, id, source, "synthetic", "ordinal-refresh-" + id, {});
    await db
      .prepare(`INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES(?,?,?,'1','2026-10-12','ok','[]')`)
      .bind(id, id, parser)
      .run();
  }
  for (const [id, ordinal] of [
    [801, "card-001"],
    [802, "card-002"],
  ] as const) {
    await db
      .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
      VALUES(?,?,'credit_statement_payment_amount',5000,'5000',0,'JPY','2026-10-01','synthetic-ordinal-total',?)`)
      .bind(
        id,
        "vpass:" + ordinal,
        JSON.stringify({
          _kogane: {
            period: "2026-10",
            paymentDate: "2026-10-10",
            snapshotSemantics: "provider-reported-monthly-payment-amount",
          },
        }),
      )
      .run();
  }
  for (const externalId of ["ordinal-first-debit", "ordinal-second-debit"]) {
    await db
      .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,as_of,raw_locator,extra_json)
      VALUES(803,'smbc-bank:synthetic-ordinal-test',?,'posted',-5000,'-5000',0,'JPY','2026-10-10T00:00:00+09:00','synthetic-ordinal-debit',?)`)
      .bind(
        externalId,
        JSON.stringify({ _kogane: { direction: "outflow", amountSignSource: "direction" } }),
      )
      .run();
  }
  for (const [id, source] of [
    [801, "vpass"],
    [803, "smbc-bank"],
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
      source === "vpass" ? stableCard : resolver,
    );
  }
  await ownership(801, "liable_party");
  await ownership(803, "beneficial_owner");
  await cardSettlementSweep(db);
  const candidate = async (parse: number, externalId: string) => {
    const row = await db
      .prepare(`SELECT c.id,c.statement_key,c.bank_key FROM card_settlement_candidates c
      JOIN transaction_observations t ON t.id=c.bank_observation_id
      WHERE c.statement_parse_run_id=? AND t.external_id=?
      AND json_extract(c.facts_json,'$.ownership')='established-same'`)
      .bind(parse, externalId)
      .first<{ id: string; statement_key: string; bank_key: string }>();
    if (!row) throw new Error("synthetic ordinal candidate missing");
    return row;
  };
  const first = await candidate(801, "ordinal-first-debit");
  const acceptFirst = await preparedCommand("card-settlement.accept", {
    proposalId: first.id,
    reason: "first ordinal reviewed",
  });
  expect((await acceptFirst()).ok).toBe(true);
  await publishParse(db, 802);
  await identifyParse(
    db,
    {
      id: 802,
      artifact_id: 802,
      source_id: "vpass",
      producer_id: "collector-r2-importer",
      fetch_run_id: 802,
    },
    stableCard,
  );
  const resolved = await db
    .prepare(`SELECT DISTINCT m.account_id FROM current_account_mappings m
    JOIN current_identity_observations o ON o.source_account_id=m.source_account_id
    WHERE o.parse_run_id IN(801,802)`)
    .all<{ account_id: string }>();
  expect(resolved.results).toHaveLength(1);
  await cardSettlementSweep(db);
  const refreshed = await candidate(802, "ordinal-second-debit");
  expect(first.statement_key).not.toBe(refreshed.statement_key);
  expect(first.bank_key).not.toBe(refreshed.bank_key);
  const receipts = (await db
    .prepare("SELECT count(*) AS n FROM operation_receipts")
    .first<{ n: number }>())!.n;
  expect(
    (await db
      .prepare("SELECT allocation_available FROM card_settlement_readiness WHERE id=?")
      .bind(refreshed.id)
      .first<{ allocation_available: number }>())!.allocation_available,
  ).toBe(0);
  await expect(
    command("card-settlement.accept", {
      proposalId: refreshed.id,
      reason: "refreshed ordinal reviewed",
    }),
  ).rejects.toThrow("stale_context");
  expect(
    (await db.prepare("SELECT count(*) AS n FROM operation_receipts").first<{ n: number }>())!.n,
  ).toBe(receipts);
  expect(
    (
      await command("card-settlement.withdraw", {
        proposalId: first.id,
        reason: "correct the same resolved card month",
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await command("card-settlement.accept", {
        proposalId: refreshed.id,
        reason: "corrected ordinal reviewed after withdrawal",
      })
    ).ok,
  ).toBe(true);
}, 60000);

test("a newer resolved card ordinal invalidates an earlier approval without consuming it", async () => {
  const stableCard: IdentityResolver = (input) => ({
    ...resolver(input),
    account: {
      key: ["synthetic-freshness-card"],
      label: "synthetic",
      role: "credit",
      status: "provider-local",
      reason: "verified synthetic identity",
    },
  });
  for (const [id, source, parser] of [
    [901, "vpass", "vpass-statement-page"],
    [902, "vpass", "vpass-statement-page"],
    [903, "smbc-bank", "smbc-direct-transactions"],
  ] as const) {
    await seedArtifact(env, id, source, "synthetic", "freshness-" + id, {});
    await db
      .prepare(`INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES(?,?,?,'1','2026-11-12','ok','[]')`)
      .bind(id, id, parser)
      .run();
  }
  for (const [id, ordinal] of [
    [901, "card-003"],
    [902, "card-004"],
  ] as const) {
    await db
      .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
      VALUES(?,?,'credit_statement_payment_amount',6000,'6000',0,'JPY','2026-11-01','synthetic-freshness',?)`)
      .bind(
        id,
        "vpass:" + ordinal,
        JSON.stringify({
          _kogane: {
            period: "2026-11",
            paymentDate: "2026-11-10",
            snapshotSemantics: "provider-reported-monthly-payment-amount",
          },
        }),
      )
      .run();
  }
  await db
    .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,as_of,raw_locator,extra_json)
    VALUES(903,'smbc-bank:synthetic-freshness','synthetic-freshness-debit','posted',-6000,'-6000',0,'JPY','2026-11-10T00:00:00+09:00','synthetic-freshness',?)`)
    .bind(JSON.stringify({ _kogane: { direction: "outflow", amountSignSource: "direction" } }))
    .run();
  for (const [id, source] of [
    [901, "vpass"],
    [903, "smbc-bank"],
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
      source === "vpass" ? stableCard : resolver,
    );
  }
  await ownership(901, "liable_party");
  await ownership(903, "beneficial_owner");
  await cardSettlementSweep(db);
  const old = (await db
    .prepare("SELECT id FROM card_settlement_candidates WHERE statement_parse_run_id=901")
    .first<{ id: string }>())!;
  const acceptOld = await preparedCommand("card-settlement.accept", {
    proposalId: old.id,
    reason: "reviewed before refresh",
  });
  const receipts = (await db
    .prepare("SELECT count(*) AS n FROM operation_receipts")
    .first<{ n: number }>())!.n;
  const approvals = await db
    .prepare("SELECT approval_id,uses_remaining FROM approvals ORDER BY approval_id")
    .all();
  await publishParse(db, 902);
  await identifyParse(
    db,
    {
      id: 902,
      artifact_id: 902,
      source_id: "vpass",
      producer_id: "collector-r2-importer",
      fetch_run_id: 902,
    },
    stableCard,
  );
  expect(
    (await db
      .prepare("SELECT statement_current FROM card_settlement_readiness WHERE id=?")
      .bind(old.id)
      .first<{ statement_current: number }>())!.statement_current,
  ).toBe(0);
  expect((await acceptOld()).ok).toBe(false);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM operation_receipts").first<{ n: number }>())!.n,
  ).toBe(receipts);
  expect(
    (
      await db
        .prepare("SELECT approval_id,uses_remaining FROM approvals ORDER BY approval_id")
        .all()
    ).results,
  ).toEqual(approvals.results);
  await cardSettlementSweep(db);
  const fresh = (await db
    .prepare("SELECT id FROM card_settlement_candidates WHERE statement_parse_run_id=902")
    .first<{ id: string }>())!;
  expect(
    (await db
      .prepare("SELECT statement_current FROM card_settlement_readiness WHERE id=?")
      .bind(fresh.id)
      .first<{ statement_current: number }>())!.statement_current,
  ).toBe(1);
  expect(
    (
      await command("card-settlement.accept", {
        proposalId: fresh.id,
        reason: "reviewed the current ordinal",
      })
    ).ok,
  ).toBe(true);
}, 60000);
