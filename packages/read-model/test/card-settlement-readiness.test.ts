// The keyed readiness CTEs (src/card-settlement-readiness.ts) against the
// migration 0044 view they stand in for (reading the migration 0052 bank debit
// view, both adapters), row for row, on small random stores
// (card-settlement-random-store.ts) whose reviews cite current and older
// statements and debits under their own and other keys, with owners, evidence
// and decisions drawn around the ones the store holds. Each flag both holds and
// fails across the seeds, and each change listed in MUTATIONS, which would make
// the CTEs inexact, fails the comparison on some seed. Every value is synthetic.
//
// ADR 0054 G1b added `claim_available`, which the view does not have. The
// CTEs' other columns are compared with their text before it (frozen in
// card-settlement-readiness-ctes-legacy-sql.ts, digest-pinned) as well as
// with the view, and `claim_available` with its definition over
// `live_consumption_claims` and the registry's alias classes, computed apart.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { aliasClassText } from "../../domain/src/economic-contract";
import { declaredAliasClass } from "../../domain/src/row-identity";
import { cardSettlementReadinessCtes } from "../src/card-settlement-readiness";
import {
  LEGACY_CARD_SETTLEMENT_READINESS_CTES,
  LEGACY_CARD_SETTLEMENT_READINESS_CTES_SHA256,
} from "./card-settlement-readiness-ctes-legacy-sql";
import { explain } from "./card-usage-plan";
import { fullCoreSchema } from "./card-usage-scale-fixture";
import {
  ECONOMIC_CLAIM_STATES,
  READINESS_STATES,
  randomSettlementStore,
  type RandomSettlementStore,
} from "./card-settlement-random-store";
import { statementPlanProblems } from "./card-statement-plan";

/**
 * CI draws seeds 1–16 (12 until the SBI Shinsei rows joined the stores and
 * moved every draw after them); KOGANE_CARD_SETTLEMENT_SEEDS=n draws seeds 1–n.
 */
const SEED_COUNT = Number(process.env["KOGANE_CARD_SETTLEMENT_SEEDS"] ?? 16);
if (!Number.isSafeInteger(SEED_COUNT) || SEED_COUNT < 1)
  throw new Error("KOGANE_CARD_SETTLEMENT_SEEDS must be a positive integer");
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1);
const FLAGS = ["statement_current", "bank_current", "ownership_current", "allocation_available"];
const drawn = new Set<string>();

const COLUMNS = `id,${FLAGS.join(",")}`;
const keyed = (ctes: string, columns = COLUMNS): string =>
  `WITH chosen AS (SELECT value AS id FROM json_each(?1)), ${ctes}
 SELECT ${columns} FROM readiness ORDER BY id`;
const shipped = `SELECT ${COLUMNS} FROM card_settlement_readiness
 WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id`;

/**
 * Changes that make the CTEs inexact, each of which the comparison must catch:
 * a restriction that cuts partitions, a dropped or loosened condition of the
 * view, a reversed order.
 */
const MUTATIONS: [string, string, string][] = [
  [
    "rank only the candidates' own statements",
    " AND EXISTS(SELECT 1 FROM statement_partitions statement_partition",
    " AND b.id IN (SELECT statement_observation_id FROM ready_candidates) AND EXISTS(SELECT 1 FROM statement_partitions statement_partition",
  ],
  [
    "rank only the candidates' own debits",
    " WHERE a.source_id='smbc-bank' AND t.external_id IS NOT NULL",
    " WHERE t.id IN (SELECT bank_observation_id FROM ready_candidates) AND a.source_id='smbc-bank' AND t.external_id IS NOT NULL",
  ],
  [
    "the oldest debit capture wins",
    "  ORDER BY a.fetched_at DESC,t.id DESC) AS position",
    "  ORDER BY a.fetched_at,t.id DESC) AS position",
  ],
  [
    "rank only the candidates' own SBI Shinsei debits",
    " WHERE a.source_id='sbi-shinsei-bank'",
    " WHERE t.id IN (SELECT bank_observation_id FROM ready_candidates) AND a.source_id='sbi-shinsei-bank'",
  ],
  [
    "an SBI Shinsei row of another parser",
    " AND p.parser_name='sbi-shinsei-top-balances-and-activity'",
    "",
  ],
  ["an SBI Shinsei row in another currency", " AND unit_ref='JPY'", ""],
  [
    "an SBI Shinsei row whose side the provider did not state",
    " AND json_extract(extra_json,'$._kogane.amountSignSource')='debit'",
    "",
  ],
  ["an SBI Shinsei row with a status", "status IS NULL AND unit_ref", "unit_ref"],
  [
    "a newer statement of any account",
    "    AND newer_owner.account_id=json_extract(ready_candidate.facts_json,'$.statement.accountId')\n",
    "\n",
  ],
  [
    "a tie goes to the lower id",
    "AND newer_statement.id>current_statement.id",
    "AND newer_statement.id<current_statement.id",
  ],
  [
    "the statement owner's evidence is not checked",
    "   AND NOT EXISTS(SELECT 1 FROM json_each(statement_owner.evidence_refs_json) e",
    "   AND 1 OR NOT EXISTS(SELECT 1 FROM json_each(statement_owner.evidence_refs_json) e",
  ],
  [
    "the debit owner is not checked",
    "   AND debit_owner.owner_ref=json_extract(ready_candidate.facts_json,'$.bankDebit.ownerRef')",
    "",
  ],
  [
    "a withdrawn review still reserves",
    "used.status='accepted'",
    "used.status IN ('accepted','withdrawn')",
  ],
  [
    "a superseded or withdrawn allocation still counts",
    "NOT EXISTS(SELECT 1 FROM current_allocations a",
    "NOT EXISTS(SELECT 1 FROM allocations a",
  ],
  [
    "a review's own allocation counts against it",
    "\n  AND a.id IS NOT (SELECT settlement_id FROM card_settlement_reviews self WHERE self.id=ready_candidate.id)",
    "",
  ],
];

function all(db: Database, sql: string, args: readonly unknown[]): unknown[] {
  return db.query(sql).all(...(args as SQLQueryBindings[]));
}

const ids = (db: Database): string[] =>
  (db.query("SELECT id FROM card_settlement_candidates ORDER BY id").values() as string[][]).map(
    ([id]) => id!,
  );

describe("keyed card settlement readiness on random stores", () => {
  // The first store pays the one-time CORE schema build (schema-template.ts,
  // every migration in order), which crossed a seed's 5 s default timeout on
  // the loaded CI runner. Pay it here, outside any seed's budget.
  beforeAll(() => {
    fullCoreSchema().close();
  }, 60_000);

  const stores = new Map<number, RandomSettlementStore>();
  const store = (seed: number): RandomSettlementStore => {
    let found = stores.get(seed);
    if (found === undefined) {
      found = randomSettlementStore(seed, drawn);
      stores.set(seed, found);
    }
    return found;
  };

  test.each(SEEDS)("seed %i: every candidate, whole and in parts", (seed) => {
    const { db } = store(seed);
    const every = ids(db);
    const sets = [
      every,
      every.filter((_, index) => index % 2 === seed % 2),
      [...every.slice(0, 3), ...every.slice(0, 3)],
      ...every.slice(0, 6).map((id) => [id]),
      ["cs_missing", ""],
      [],
    ];
    const text = keyed(cardSettlementReadinessCtes());
    // The bank adapter of each candidate's debit, so both adapters are seen
    // current and not current.
    const adapter = new Map(
      db
        .query(
          `SELECT c.id,a.source_id FROM card_settlement_candidates c
           JOIN transaction_observations t ON t.id=c.bank_observation_id
           JOIN parse_runs p ON p.id=t.parse_run_id
           JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id`,
        )
        .values() as [string, string][],
    );
    for (const set of sets) {
      const args = [JSON.stringify(set)];
      const found = all(db, text, args) as Record<string, number | string>[];
      expect(found as unknown[]).toEqual(all(db, shipped, args));
      for (const row of found) {
        for (const flag of FLAGS) drawn.add(`${flag}=${row[flag]}`);
        drawn.add(`${adapter.get(String(row["id"]))} debit: bank_current=${row["bank_current"]}`);
        if (FLAGS.every((flag) => row[flag] === 1)) drawn.add("ready");
      }
    }
  });

  test("the seeds together drew every review state and both values of every flag", () => {
    for (const seed of SEEDS) store(seed);
    const required = [
      ...READINESS_STATES,
      ...FLAGS.flatMap((flag) => [`${flag}=0`, `${flag}=1`]),
      ...["smbc-bank", "sbi-shinsei-bank"].flatMap((source) => [
        `${source} debit: bank_current=0`,
        `${source} debit: bank_current=1`,
      ]),
      "ready",
    ];
    expect(required.filter((state) => !drawn.has(state))).toEqual([]);
  });

  test.each(MUTATIONS)("the comparison catches: %s", (_, from, to) => {
    const ctes = cardSettlementReadinessCtes();
    expect(ctes).toContain(from);
    const mutated = keyed(ctes.replace(from, to));
    const caught = SEEDS.some((seed) => {
      const { db } = store(seed);
      const args = [JSON.stringify(ids(db))];
      return JSON.stringify(all(db, mutated, args)) !== JSON.stringify(all(db, shipped, args));
    });
    expect(caught).toBe(true);
  });

  test("its plan reads only the named candidates' facts and owners, never the whole store", () => {
    const { db } = store(1);
    // The store is what D1 runs: every CORE migration, no ANALYZE.
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const args = [JSON.stringify(ids(db))];
    expect(statementPlanProblems(explain(db, keyed(cardSettlementReadinessCtes()), args))).toEqual(
      [],
    );
    // The view it stands in for fails the same check: its ownership source
    // materializes the candidate identity runs of every published parse.
    expect(statementPlanProblems(explain(db, shipped, args))).not.toEqual([]);
  });
});

/**
 * `claim_available` computed apart from the CTEs: no live holder in
 * `live_consumption_claims` (the CORE 0070 union of economic claims and the
 * legacy settlement holders), in book `cash-movement`, of the candidate's
 * bank_key or of the alias class `declaredAliasClass` gives its debit row and
 * its facts' account, other than the event of the candidate's accepted review.
 */
function claimReference(db: Database, ids: readonly string[]): Record<string, number> {
  const holders = db
    .query(
      "SELECT consumption_key,alias_class,event_id FROM live_consumption_claims WHERE book='cash-movement'",
    )
    .all() as { consumption_key: string; alias_class: string | null; event_id: string }[];
  const found: Record<string, number> = {};
  for (const id of new Set(ids)) {
    const row = db
      .query(
        `SELECT c.bank_key,c.facts_json,a.source_id,p.parser_name,t.source_account,t.extra_json,
          (SELECT r.event_id FROM card_settlement_reviews r WHERE r.id=c.id AND r.status='accepted') AS own
         FROM card_settlement_candidates c JOIN transaction_observations t ON t.id=c.bank_observation_id
         JOIN parse_runs p ON p.id=t.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE c.id=?`,
      )
      .get(id) as {
      bank_key: string;
      facts_json: string;
      source_id: string;
      parser_name: string;
      source_account: string;
      extra_json: string;
      own: string | null;
    } | null;
    if (row === null) continue;
    let extra: unknown = null;
    try {
      extra = JSON.parse(row.extra_json);
    } catch {
      extra = null;
    }
    const facts = JSON.parse(row.facts_json) as { bankDebit?: { accountId?: unknown } };
    const alias = declaredAliasClass({
      sourceId: row.source_id,
      parserName: row.parser_name,
      sourceAccount: row.source_account,
      extra,
      accountId: facts.bankDebit?.accountId,
    });
    const aliasText = alias === null ? null : aliasClassText(alias);
    const held = holders.some(
      (holder) =>
        holder.event_id !== row.own &&
        (holder.consumption_key === row.bank_key ||
          (aliasText !== null && holder.alias_class === aliasText)),
    );
    found[id] = held ? 0 : 1;
  }
  return found;
}

/** What made a candidate's claim unavailable, for the coverage check. */
function claimCauses(db: Database, id: string): string[] {
  const causes: string[] = [];
  const own = `(SELECT r.event_id FROM card_settlement_reviews r WHERE r.id=c.id AND r.status='accepted')`;
  if (
    db
      .query(
        `SELECT 1 FROM card_settlement_candidates c JOIN economic_claims x ON x.book='cash-movement' AND x.consumption_key=c.bank_key
         JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision AND r.superseded_by IS NULL
         WHERE c.id=? AND x.event_id IS NOT ${own}`,
      )
      .get(id)
  )
    causes.push("claim_available=0: economic claim of the key");
  if (
    db
      .query(
        `SELECT 1 FROM card_settlement_candidates c JOIN card_settlement_candidates k ON k.bank_key=c.bank_key
         JOIN card_settlement_decisions d ON d.proposal_id=k.id AND d.status='accepted'
         JOIN economic_event_revisions r ON r.event_id=d.event_id AND r.revision=d.revision AND r.superseded_by IS NULL
         WHERE c.id=? AND d.event_id IS NOT ${own}`,
      )
      .get(id)
  )
    causes.push("claim_available=0: legacy settlement holder");
  return causes;
}

describe("claim_available on random stores (ADR 0054, G1b)", () => {
  const stores = new Map<number, RandomSettlementStore>();
  const store = (seed: number): RandomSettlementStore => {
    let found = stores.get(seed);
    if (found === undefined) {
      found = randomSettlementStore(seed, drawn);
      stores.set(seed, found);
    }
    return found;
  };
  const claimDrawn = new Set<string>();
  const WITH_CLAIM = `${COLUMNS},claim_available`;

  test("the frozen text is the text before claim_available, byte for byte", () => {
    expect(createHash("sha256").update(LEGACY_CARD_SETTLEMENT_READINESS_CTES).digest("hex")).toBe(
      LEGACY_CARD_SETTLEMENT_READINESS_CTES_SHA256,
    );
    expect(LEGACY_CARD_SETTLEMENT_READINESS_CTES).not.toContain("claim_available");
    // The current text is the frozen text with one column added at its end.
    const current = cardSettlementReadinessCtes();
    const head = LEGACY_CARD_SETTLEMENT_READINESS_CTES.slice(
      0,
      LEGACY_CARD_SETTLEMENT_READINESS_CTES.lastIndexOf(" AS allocation_available"),
    );
    expect(current.startsWith(`${head} AS allocation_available,\n`)).toBe(true);
    expect(current.endsWith(" AS claim_available\nFROM ready_candidates ready_candidate)")).toBe(
      true,
    );
  });

  test.each(SEEDS)(
    "seed %i: the old columns equal the frozen text's, and claim_available its definition",
    (seed) => {
      const { db } = store(seed);
      const every = ids(db);
      const sets = [
        every,
        every.filter((_, index) => index % 2 === seed % 2),
        [...every.slice(0, 3), ...every.slice(0, 3)],
        ...every.slice(0, 6).map((id) => [id]),
        ["cs_missing", ""],
        [],
      ];
      const text = keyed(cardSettlementReadinessCtes(), WITH_CLAIM);
      const legacy = keyed(LEGACY_CARD_SETTLEMENT_READINESS_CTES);
      for (const set of sets) {
        const args = [JSON.stringify(set)];
        const found = all(db, text, args) as Record<string, number | string>[];
        // The four flags the frozen text had, row for row.
        const old: unknown[] = found.map((row) =>
          Object.fromEntries(Object.entries(row).filter(([name]) => name !== "claim_available")),
        );
        expect(old).toEqual(all(db, legacy, args));
        const reference = claimReference(db, set);
        expect(Object.fromEntries(found.map((row) => [row["id"], row["claim_available"]]))).toEqual(
          reference,
        );
        for (const row of found) {
          claimDrawn.add(`claim_available=${row["claim_available"]}`);
          if (row["claim_available"] === 0)
            for (const cause of claimCauses(db, String(row["id"]))) claimDrawn.add(cause);
        }
      }
      // The alias term alone: a candidate whose key nobody else holds and whose class someone does.
      for (const id of every) {
        const keyOnly = claimCauses(db, id).length === 0;
        const row = all(db, text, [JSON.stringify([id])])[0] as Record<string, number> | undefined;
        if (keyOnly && row?.["claim_available"] === 0)
          claimDrawn.add("claim_available=0: alias class only");
      }
    },
  );

  test("the seeds together drew every holder state and every cause", () => {
    for (const seed of SEEDS) store(seed);
    const required = [
      ...ECONOMIC_CLAIM_STATES,
      "claim_available=0",
      "claim_available=1",
      "claim_available=0: economic claim of the key",
      "claim_available=0: legacy settlement holder",
      "claim_available=0: alias class only",
    ];
    expect(required.filter((state) => !drawn.has(state) && !claimDrawn.has(state))).toEqual([]);
  });

  const CLAIM_MUTATIONS: [string, string, string][] = [
    [
      "a released economic claim still holds",
      " AND held.consumption_key=ready_candidate.bank_key AND held_revision.superseded_by IS NULL",
      " AND held.consumption_key=ready_candidate.bank_key",
    ],
    [
      "a withdrawn settlement still holds",
      " WHERE holder_candidate.bank_key=ready_candidate.bank_key AND holder_revision.superseded_by IS NULL",
      " WHERE holder_candidate.bank_key=ready_candidate.bank_key",
    ],
    [
      "the candidate's own event holds against it",
      "  AND held.event_id IS NOT (SELECT self.event_id",
      "  AND held.event_id IS NOT NULL AND 1 IS NOT (SELECT self.event_id",
    ],
    [
      "legacy holders are ignored",
      " AND NOT EXISTS(SELECT 1 FROM card_settlement_candidates holder_candidate",
      " AND 1 OR NOT EXISTS(SELECT 1 FROM card_settlement_candidates holder_candidate",
    ],
    [
      "alias classes are ignored",
      " AND NOT EXISTS(SELECT 1 FROM transaction_observations debit",
      " AND 1 OR NOT EXISTS(SELECT 1 FROM transaction_observations debit",
    ],
    [
      "the alias class ignores the account",
      ",json_extract(ready_candidate.facts_json,'$.bankDebit.accountId'),'",
      ",'acct-k','",
    ],
  ];

  test.each(CLAIM_MUTATIONS)("the comparison catches: %s", (_, from, to) => {
    const ctes = cardSettlementReadinessCtes();
    expect(ctes).toContain(from);
    // Every occurrence: the alias class has one branch per declared function.
    const mutated = keyed(ctes.replaceAll(from, to), WITH_CLAIM);
    const caught = SEEDS.some((seed) => {
      const { db } = store(seed);
      const every = ids(db);
      const found = all(db, mutated, [JSON.stringify(every)]) as Record<string, number | string>[];
      return (
        JSON.stringify(
          Object.fromEntries(found.map((row) => [row["id"], row["claim_available"]])),
        ) !== JSON.stringify(claimReference(db, every))
      );
    });
    expect(caught).toBe(true);
  });

  test("its plan reads holders by key, alias class and candidate only, without table statistics", () => {
    const { db } = store(1);
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const args = [JSON.stringify(ids(db))];
    const steps = explain(db, keyed(cardSettlementReadinessCtes(), WITH_CLAIM), args);
    expect(statementPlanProblems(steps)).toEqual([]);
    const details = steps.map((step) => step.detail);
    for (const index of [
      "economic_claims_key",
      "economic_claims_alias",
      "card_settlement_candidates_bank",
    ])
      expect(
        details.some(
          (detail) =>
            detail.includes(`USING INDEX ${index}`) ||
            detail.includes(`USING COVERING INDEX ${index}`),
        ),
      ).toBe(true);
  });
});
