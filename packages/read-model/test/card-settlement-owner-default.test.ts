// The owner's default (ADR 0087) in the keyed ownership CTEs
// (src/card-settlement-ownership.ts, `ownerDefault`), on the random stores of
// card-settlement-random-store.ts: every row equals the row without the
// default, except a row whose account is resolved and has no owner, which
// gets the default party exactly when an independent oracle (written here
// against the views, not the CTEs) finds no recorded claim of either role, no
// contradiction and no unresolved mapping or account. The stores are then
// given each of those blockers in turn, and the check repeats. The seeds
// together must draw every case. Every value is synthetic.
//
// The readiness CTEs apply the default too; on the random stores no candidate
// cites it, so card-settlement-readiness.test.ts comparing them (default on)
// with the view row for row also shows that the default changes nothing for
// a candidate that does not cite it.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  OWNERSHIP_DEFAULT_PARTY,
  OWNERSHIP_DEFAULT_REF,
} from "../../domain/src/ownership-default.ts";
import { cardSettlementOwnershipCtes, type OwnershipKind } from "../src/card-settlement-ownership";
import { cardSettlementReadinessCtes } from "../src/card-settlement-readiness";
import { explain } from "./card-usage-plan";
import { fullCoreSchema } from "./card-usage-scale-fixture";
import { randomSettlementStore, type RandomSettlementStore } from "./card-settlement-random-store";
import { statementPlanProblems } from "./card-statement-plan";

const SEEDS = Array.from({ length: 12 }, (_, index) => index + 1);
const drawn = new Set<string>();

interface OwnershipRow {
  kind: OwnershipKind;
  observation_id: number;
  account_id: string | null;
  owner_ref: string | null;
  evidence_refs_json: string;
}

const COLUMNS = "kind,observation_id,account_id,owner_ref,evidence_refs_json";
const keyed = (kind: OwnershipKind, ownerDefault: boolean): string =>
  `WITH observed AS (SELECT value AS observation_id FROM json_each(?1)),
 ${cardSettlementOwnershipCtes(kind, { ownerDefault })}
 SELECT ${COLUMNS} FROM ownership ORDER BY observation_id`;

function all<T>(db: Database, sql: string, ...args: unknown[]): T[] {
  return db.query(sql).all(...(args as SQLQueryBindings[])) as T[];
}

/** The oracle: does anything recorded forbid the default for this row? */
function blocked(db: Database, row: OwnershipRow): string | null {
  const account = row.account_id!;
  const sources = all<{ source_account_id: string }>(
    db,
    `SELECT DISTINCT source_account_id FROM current_identity_observations WHERE kind=? AND observation_id=?`,
    row.kind,
    row.observation_id,
  ).map((entry) => entry.source_account_id);
  const refs = [account, "account:" + account, ...sources.map((id) => "source_account:" + id)];
  const relations = all<{ kind: string; from_ref: string; to_ref: string }>(
    db,
    "SELECT kind,from_ref,to_ref FROM entity_relations",
  );
  if (
    relations.some(
      (relation) =>
        (relation.kind === "liable_party" || relation.kind === "beneficial_owner") &&
        (relation.from_ref === account || relation.from_ref === "account:" + account),
    )
  )
    return "claim recorded";
  if (
    relations.some(
      (relation) =>
        relation.kind === "contradicts" &&
        (refs.includes(relation.from_ref) || refs.includes(relation.to_ref)),
    )
  )
    return "contradiction recorded";
  const unresolved = all<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM current_account_mappings
     WHERE status='unresolved' AND source_account_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(sources),
  )[0]!.n;
  if (unresolved > 0) return "mapping unresolved";
  const account_status = all<{ status: string }>(
    db,
    "SELECT status FROM accounts WHERE id=?",
    account,
  )[0]?.status;
  if (account_status === "unresolved") return "account unresolved";
  return null;
}

/** With the default, every row is the row without it or the default the oracle allows. */
function check(db: Database, kind: OwnershipKind, ids: readonly number[]): OwnershipRow[] {
  const list = JSON.stringify(ids);
  const without = all<OwnershipRow>(db, keyed(kind, false), list);
  const withDefault = all<OwnershipRow>(db, keyed(kind, true), list);
  expect(withDefault.map((row) => [row.kind, row.observation_id, row.account_id])).toEqual(
    without.map((row) => [row.kind, row.observation_id, row.account_id]),
  );
  without.forEach((row, index) => {
    const found = withDefault[index]!;
    if (row.account_id === null || row.owner_ref !== null) {
      if (row.owner_ref !== null) drawn.add(`${kind}: recorded owner kept`);
      expect(found).toEqual(row);
      return;
    }
    const reason = blocked(db, row);
    if (reason !== null) {
      drawn.add(`${kind}: ${reason}`);
      expect(found).toEqual(row);
      return;
    }
    drawn.add(`${kind}: default applied`);
    const recorded = JSON.parse(row.evidence_refs_json) as unknown[];
    expect(recorded.slice(1)).toEqual([null, null]);
    expect(found).toEqual({
      ...row,
      owner_ref: OWNERSHIP_DEFAULT_PARTY,
      evidence_refs_json: JSON.stringify([recorded[0], OWNERSHIP_DEFAULT_REF]),
    });
  });
  return withDefault;
}

let next = 0;
/** One recorded relation with its decision, as the decision log writes them. */
function relate(
  db: Database,
  kind: string,
  from: string,
  to: string,
  status: "accepted" | "rejected" = "accepted",
  validFrom: string | null = null,
): void {
  next += 1;
  const id = `default-test-rel-${next}`;
  const decision = `default-test-dr-${next}`;
  db.query(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES(?,'relation',?,1,?,'manual','synthetic-operator',NULL,'synthetic','[]',NULL,NULL,'2026-01-01')`,
  ).run(decision, id, status === "accepted" ? "accept" : "reject");
  db.query(
    `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
     VALUES(?,?,?,?,?,NULL,?,?,'[]','2026-01-01')`,
  ).run(id, kind, from, to, validFrom, status, decision);
}

/** The source accounts whose identities name `observation` of `kind`. */
function sourcesOf(db: Database, kind: OwnershipKind, observation: number): string[] {
  return all<{ source_account_id: string }>(
    db,
    "SELECT DISTINCT source_account_id FROM current_identity_observations WHERE kind=? AND observation_id=?",
    kind,
    observation,
  ).map((entry) => entry.source_account_id);
}

/** A new mapping revision of `source` to `account`. */
function remap(db: Database, source: string, account: string, status: string): void {
  const revision =
    all<{ n: number }>(
      db,
      "SELECT max(revision) AS n FROM account_mappings WHERE source_account_id=?",
      source,
    )[0]!.n + 1;
  db.query(
    `INSERT INTO account_mappings VALUES(?,?,?,?,'rule','synthetic',1,'2026-01-01','Synthetic',?)`,
  ).run(`${source}-default-r${revision}`, source, revision, account, status);
}

/** A fresh account of `status` with no relation at all. */
function freshAccount(db: Database, status = "identified"): string {
  next += 1;
  const account = `acct-fresh-${next}`;
  db.query("INSERT INTO accounts VALUES(?,'Synthetic','card-statement',?)").run(account, status);
  return account;
}

/** Each blocker, recorded against one row that defaults. */
const BLOCKERS: [string, (db: Database, row: OwnershipRow) => void][] = [
  [
    "a rejected claim of the other role",
    (db, row) =>
      relate(
        db,
        row.kind === "balance" ? "beneficial_owner" : "liable_party",
        row.account_id!,
        "party:p1",
        "rejected",
      ),
  ],
  [
    "a dated claim from the prefixed account",
    (db, row) =>
      relate(
        db,
        row.kind === "balance" ? "liable_party" : "beneficial_owner",
        "account:" + row.account_id!,
        "party:p1",
        "accepted",
        "2026-01-01",
      ),
  ],
  [
    "a contradiction naming the source account, at its far end",
    (db, row) =>
      relate(
        db,
        "contradicts",
        "card-settlement:synthetic",
        "source_account:" + sourcesOf(db, row.kind, row.observation_id)[0]!,
      ),
  ],
  [
    "a contradiction from the prefixed account",
    (db, row) => relate(db, "contradicts", "account:" + row.account_id!, "card-settlement:other"),
  ],
  [
    "an unresolved remapping to the same account",
    (db, row) =>
      remap(db, sourcesOf(db, row.kind, row.observation_id)[0]!, row.account_id!, "unresolved"),
  ],
  [
    "an identified remapping to an unresolved account",
    (db, row) => {
      const account = freshAccount(db, "unresolved");
      for (const source of sourcesOf(db, row.kind, row.observation_id))
        remap(db, source, account, "identified");
    },
  ],
  [
    "a timeless accepted claim",
    (db, row) =>
      relate(
        db,
        row.kind === "balance" ? "liable_party" : "beneficial_owner",
        row.account_id!,
        "party:p2",
      ),
  ],
];

describe("the owner's default on random stores (ADR 0087)", () => {
  beforeAll(() => {
    fullCoreSchema().close();
  }, 60_000);

  const checkAll = ({ db, balances, transactions }: RandomSettlementStore): OwnershipRow[] => [
    ...check(db, "balance", balances),
    ...check(db, "transaction", transactions),
  ];
  /**
   * A fresh store of `seed` in which the first owned statement's and the
   * first owned debit's source accounts are remapped to new accounts nobody
   * has a claim on, so both kinds have rows the default applies to.
   */
  const unclaimedStore = (seed: number): RandomSettlementStore => {
    const store = randomSettlementStore(seed, new Set());
    for (const [kind, ids] of [
      ["balance", store.balances],
      ["transaction", store.transactions],
    ] as const) {
      const owned = all<OwnershipRow>(store.db, keyed(kind, false), JSON.stringify(ids)).find(
        (row) => row.account_id !== null,
      );
      if (owned === undefined) continue;
      const account = freshAccount(store.db);
      for (const source of sourcesOf(store.db, kind, owned.observation_id))
        remap(store.db, source, account, "identified");
    }
    return store;
  };

  test.each(SEEDS)("seed %i: every row as drawn", (seed) => {
    checkAll(randomSettlementStore(seed, new Set()));
  });

  // One store per seed and blocker, each its own test.
  const pairs = SEEDS.flatMap((seed) => BLOCKERS.map((_, index) => [seed, index] as const));
  test.each(pairs)("seed %i, blocker %i: the blocker takes the default away", (seed, index) => {
    const [name, block] = BLOCKERS[index]!;
    const store = unclaimedStore(seed);
    const before = checkAll(store);
    for (const kind of ["balance", "transaction"] as const) {
      const target = before.find(
        (row) => row.kind === kind && row.owner_ref === OWNERSHIP_DEFAULT_PARTY,
      );
      if (target === undefined) continue;
      block(store.db, target);
      drawn.add(`${kind} blocked: ${name}`);
      const after = checkAll(store).find(
        (row) => row.kind === target.kind && row.observation_id === target.observation_id,
      );
      expect(after?.owner_ref ?? null).not.toBe(OWNERSHIP_DEFAULT_PARTY);
    }
    store.db.close();
  });

  test("its plan reads only the named observations' owners, never the whole store", () => {
    const { db, balances, transactions } = unclaimedStore(1);
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    for (const [kind, ids] of [
      ["balance", balances],
      ["transaction", transactions],
    ] as const)
      expect(statementPlanProblems(explain(db, keyed(kind, true), [JSON.stringify(ids)]))).toEqual(
        [],
      );
  });

  test("the readiness CTEs apply it on both sides, and only when asked to", () => {
    const on = cardSettlementReadinessCtes();
    const off = cardSettlementReadinessCtes({ ownerDefault: false });
    expect(on).toContain(OWNERSHIP_DEFAULT_REF);
    expect(on.split(OWNERSHIP_DEFAULT_REF).length - 1).toBe(2);
    expect(off).not.toContain(OWNERSHIP_DEFAULT_REF);
    expect(cardSettlementReadinessCtes({ ownerDefault: true })).toBe(on);
  });

  test("the seeds together drew every case", () => {
    const required = (["balance", "transaction"] as const).flatMap((kind) => [
      `${kind}: default applied`,
      `${kind}: recorded owner kept`,
      `${kind}: claim recorded`,
      `${kind}: contradiction recorded`,
      `${kind}: mapping unresolved`,
      `${kind}: account unresolved`,
      ...BLOCKERS.map(([name]) => `${kind} blocked: ${name}`),
    ]);
    expect(required.filter((state) => !drawn.has(state))).toEqual([]);
  });
});
