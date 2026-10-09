// CORE 0072 (ADR 0057, G3-a): the own-transfer proposal tables and their
// statement builders, on the full CORE schema through bun:sqlite. Additive,
// append-only, closed codes, proposals under the current identity epoch only,
// and no object that reads a command table or a table ADR 0054's rebuild list
// names. Every value is synthetic.
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { INITIAL_IDENTITY_EPOCH } from "../../domain/src/economic-contract.ts";
import {
  proposeOwnTransfers,
  type OwnTransferProposal,
  type OwnTransferRowInput,
} from "../../domain/src/own-transfer-proposals.ts";
import {
  ownTransferProposalRetirementWrite,
  ownTransferProposalWrite,
} from "../src/atomic/own-transfer-proposals.ts";
import type { SqlWrite } from "../src/core/operations.ts";
import { CORE_MIGRATIONS_URL, migrationFiles, migrationSql } from "../src/migrations.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

const MIGRATION = "0072_own_transfer_proposals.sql";
const NOW = "2030-01-10T00:00:00.000Z";
const TABLES = ["own_transfer_proposals", "own_transfer_proposal_retirements"];

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const row = (id: number, account: string, amount: string): OwnTransferRowInput => ({
  observationId: id,
  parseRunId: 1,
  key: ["smbc-bank", "synthetic-producer", "synthetic-ns", account, `meisai-${id}`],
  parserName: "smbc-direct-transactions",
  extra: { id: `meisai-${id}`, _kogane: { identityOrigin: "provider-id" } },
  amount,
  currency: "JPY",
  postingDate: "2030-01-10",
});

async function proposals(rows: OwnTransferRowInput[]) {
  const run = await proposeOwnTransfers({
    rows,
    ownership: {
      version: "synthetic-ownership-1",
      ownershipOf: (_source, account) => ({ state: "self", accountId: `acct-${account}` }),
    },
    policy: {
      policyVersion: "synthetic-own-transfer-policy-1",
      family: "bank-movement",
      currencyRule: "same-currency",
      window: { minDaysAfterDebit: 0, maxDaysAfterDebit: 2 },
      difference: { rule: "exact" },
    },
    identityEpoch: INITIAL_IDENTITY_EPOCH,
    held: { keys: [], aliasClasses: [] },
  });
  if (!run.ok) throw new Error(run.refusal);
  return run;
}

async function batch(db: Database, writes: SqlWrite[]): Promise<number[]> {
  const d1 = sqliteD1(db);
  const results = await d1.batch(writes.map((write) => d1.prepare(write.sql).bind(...write.binds)));
  return results.map((result) => result.meta.changes);
}

function store(): Database {
  return fullCoreDatabase();
}

async function stored(): Promise<{ db: Database; proposal: OwnTransferProposal; write: SqlWrite }> {
  const db = store();
  const run = await proposals([row(1, "a", "-1000"), row(2, "b", "1000")]);
  const proposal = run.proposals[0]!;
  const write = ownTransferProposalWrite({ proposal, manifest: run.manifest, now: NOW });
  expect(await batch(db, [write])).toEqual([1]);
  return { db, proposal, write };
}

/** Overwrite one bound column of a proposal write (by its position in the column list). */
const withBind = (write: SqlWrite, index: number, value: unknown): SqlWrite => ({
  sql: write.sql,
  binds: write.binds.map((bind, at) => (at === index ? value : bind)),
});
const otherId = (write: SqlWrite, digit: string) => {
  const id = `otp_${digit.repeat(64)}`;
  return withBind(withBind(write, 0, id), 19, id);
};

describe("CORE 0072 is additive", () => {
  test("every object before 0072 is unchanged, and 0072's objects read no command or rebuilt table", () => {
    const files = migrationFiles(CORE_MIGRATIONS_URL);
    expect(files.at(-1)).toBe(MIGRATION);
    const objects = (db: Database) =>
      db
        .query(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
    const before = new Database(":memory:");
    before.exec("PRAGMA foreign_keys=ON");
    for (const file of files.filter((name) => name < MIGRATION))
      before.exec(migrationSql(CORE_MIGRATIONS_URL, file));
    const prior = objects(before);
    before.exec(migrationSql(CORE_MIGRATIONS_URL, MIGRATION));
    const after = objects(before);
    const added = after.filter(
      (object) => !prior.some((p) => p.type === object.type && p.name === object.name),
    );
    expect(after.filter((object) => !added.includes(object))).toEqual(prior);
    expect(added.every((object) => TABLES.includes(object.tbl_name))).toBe(true);
    expect(added.map((object) => object.name).sort()).toEqual(
      [
        "own_transfer_proposal_retirements",
        "own_transfer_proposal_retirements_no_delete",
        "own_transfer_proposal_retirements_no_replace",
        "own_transfer_proposal_retirements_no_update",
        "own_transfer_proposals",
        "own_transfer_proposals_credit_alias",
        "own_transfer_proposals_debit_alias",
        "own_transfer_proposals_guard",
        "own_transfer_proposals_no_delete",
        "own_transfer_proposals_no_replace",
        "own_transfer_proposals_no_update",
      ].sort(),
    );
    // Every table any 0072 object names is its own or the 0070 epoch list.
    const tables = (after.filter((object) => object.type === "table") as { name: string }[]).map(
      (t) => t.name,
    );
    for (const object of added) {
      const named = tables.filter((table) =>
        new RegExp(`\\b${table}\\b`, "u").test(object.sql ?? ""),
      );
      expect(named.filter((table) => !TABLES.includes(table))).toEqual(
        object.name === "own_transfer_proposals" || object.name === "own_transfer_proposals_guard"
          ? ["economic_identity_epochs"]
          : [],
      );
    }
    before.close();
  });
});

describe("own_transfer_proposals", () => {
  test("a proposal is written once; a replay writes nothing; no amount is stored", async () => {
    const { db, proposal, write } = await stored();
    expect(await batch(db, [write])).toEqual([0]);
    const rows = db.query("SELECT * FROM own_transfer_proposals").all() as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      proposal_id: proposal.proposalId,
      status: "proposed",
      debit_observation_id: 1,
      credit_observation_id: 2,
      policy_version: "synthetic-own-transfer-policy-1",
      engine_release: "own-transfer-proposals-v1",
      identity_epoch: INITIAL_IDENTITY_EPOCH,
    });
    expect(JSON.stringify(rows)).not.toContain("1000");
  });

  test("append-only: no update, no delete, no replacement", async () => {
    const { db, proposal, write } = await stored();
    expect(() => db.run("UPDATE own_transfer_proposals SET status='needs_review'")).toThrow(
      "append-only",
    );
    expect(() => db.run("DELETE FROM own_transfer_proposals")).toThrow("append-only");
    const replace = {
      sql: write.sql
        .replace("INSERT INTO", "INSERT OR REPLACE INTO")
        .replace(/\n WHERE NOT EXISTS[^]*$/u, ""),
      binds: write.binds.slice(0, 19),
    };
    await expect(batch(db, [replace])).rejects.toThrow("replacement is forbidden");
    expect(
      (db.query("SELECT count(*) AS n FROM own_transfer_proposals").get() as { n: number }).n,
    ).toBe(1);
    expect(proposal.status).toBe("proposed");
  });

  test("closed codes, each once, and needs_review exactly with candidate_not_unique", async () => {
    const { db, write } = await stored();
    for (const [digit, status, codes] of [
      ["1", "proposed", ["both_accounts_self", "a_guessed_code"]],
      ["2", "proposed", ["amount_equal", "amount_equal"]],
      ["3", "proposed", ["amount_equal", "candidate_not_unique"]],
      ["4", "needs_review", ["amount_equal"]],
    ] as const)
      await expect(
        batch(db, [withBind(withBind(otherId(write, digit), 2, status), 3, JSON.stringify(codes))]),
      ).rejects.toThrow("own_transfer_proposal_invalid");
    expect(
      await batch(db, [
        withBind(
          withBind(otherId(write, "5"), 2, "needs_review"),
          3,
          '["amount_equal","candidate_not_unique"]',
        ),
      ]),
    ).toEqual([1]);
  });

  test("the current identity epoch only; one account, key or class on both sides is refused", async () => {
    const { db, write } = await stored();
    db.run(
      "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(2,'identity-epoch-2','synthetic-rewrite',?)",
      [NOW],
    );
    await expect(batch(db, [otherId(write, "1")])).rejects.toThrow("own_transfer_proposal_invalid");
    const current = (w: SqlWrite) => withBind(w, 16, "identity-epoch-2");
    expect(await batch(db, [current(otherId(write, "2"))])).toEqual([1]);
    // Columns: 8 debit account, 13 credit account, 6/11 keys, 7/12 classes.
    await expect(
      batch(db, [current(withBind(otherId(write, "3"), 13, write.binds[8]))]),
    ).rejects.toThrow("CHECK");
    await expect(
      batch(db, [current(withBind(otherId(write, "4"), 11, write.binds[6]))]),
    ).rejects.toThrow("CHECK");
    await expect(
      batch(db, [current(withBind(otherId(write, "6"), 12, write.binds[7]))]),
    ).rejects.toThrow("CHECK");
    await expect(
      batch(db, [withBind(otherId(write, "7"), 16, "identity-epoch-9")]),
    ).rejects.toThrow("own_transfer_proposal_invalid");
  });

  test("the builder refuses what is not the contract", async () => {
    const run = await proposals([row(1, "a", "-1000"), row(2, "b", "1000")]);
    const proposal = run.proposals[0]!;
    expect(() =>
      ownTransferProposalWrite({
        proposal: { ...proposal, status: "needs_review" },
        manifest: run.manifest,
        now: NOW,
      }),
    ).toThrow(RangeError);
    expect(() =>
      ownTransferProposalWrite({
        proposal,
        manifest: { ...run.manifest, policyVersion: "other" },
        now: NOW,
      }),
    ).toThrow(RangeError);
    expect(() =>
      ownTransferProposalWrite({
        proposal: {
          ...proposal,
          credit: { ...proposal.credit, accountId: proposal.debit.accountId },
        },
        manifest: run.manifest,
        now: NOW,
      }),
    ).toThrow(RangeError);
  });
});

describe("own_transfer_proposal_retirements", () => {
  test("once per existing proposal, closed reasons, append-only", async () => {
    const { db, proposal } = await stored();
    const retire = ownTransferProposalRetirementWrite({
      proposalId: proposal.proposalId,
      reason: "evidence_changed",
      now: NOW,
    });
    expect(await batch(db, [retire])).toEqual([1]);
    expect(await batch(db, [retire])).toEqual([0]);
    expect(() =>
      db.run("UPDATE own_transfer_proposal_retirements SET reason_code='engine_superseded'"),
    ).toThrow("append-only");
    expect(() => db.run("DELETE FROM own_transfer_proposal_retirements")).toThrow("append-only");
    await expect(
      batch(db, [
        ownTransferProposalRetirementWrite({
          proposalId: `otp_${"9".repeat(64)}`,
          reason: "evidence_changed",
          now: NOW,
        }),
      ]),
    ).rejects.toThrow("FOREIGN KEY");
    expect(() =>
      db.run(
        "INSERT INTO own_transfer_proposal_retirements(proposal_id,reason_code,retired_at) VALUES(?, 'guessed', ?)",
        [`otp_${"8".repeat(64)}`, NOW],
      ),
    ).toThrow("CHECK");
    expect(() =>
      ownTransferProposalRetirementWrite({
        proposalId: "not-an-id",
        reason: "evidence_changed",
        now: NOW,
      }),
    ).toThrow(RangeError);
  });
});
