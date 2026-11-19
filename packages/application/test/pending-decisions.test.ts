// What waits for the owner's decision (src/query/pending-decisions.ts,
// ADR 0126): every line's count, ids and oldest time against its own list's
// service on synthetic stores with the kind present and absent; the grant and
// deployment refusals; the size bound; the plans without table statistics;
// and that the read writes nothing. Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  PENDING_DECISION_KINDS,
  type PendingDecisionKind,
  type PendingDecisionLine,
  type PendingDecisions,
} from "../../domain/src/pending-decisions.ts";
import { IDENTITY_OBSERVATION_COUNT_SQL } from "../../read-model/src/instrument-resolution.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { randomSettlementStore } from "../../read-model/test/card-settlement-random-store.ts";
import type { Grant } from "../src/grants.ts";
import { reviewAccountCandidates } from "../src/query/account-candidates.ts";
import { loadPendingPostedCandidates } from "../src/query/card-purchase-candidates.ts";
import {
  CARD_SETTLEMENT_STATEMENT_PAGE_SQL,
  CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL,
} from "../src/query/card-settlements.ts";
import {
  CURRENT_IDENTITY_OBSERVATION_BOUND,
  reviewInstrumentCandidates,
} from "../src/query/instrument-candidates-review.ts";
import {
  PENDING_CARD_OWNERSHIP_SQL,
  PENDING_CARD_SETTLEMENTS_SQL,
  PENDING_CHANGE_PLANS_SQL,
  PENDING_DECISIONS_COUNT_BOUND,
  PENDING_DECISIONS_ID_BYTES,
  PENDING_DECISIONS_IDS_SHOWN,
  PENDING_DECISIONS_MAX_BYTES,
  PENDING_POSTED_LINKS_SQL,
  PENDING_SURVEY_PROPOSALS_SQL,
  readPendingDecisions,
  shownIds,
  type PendingDecisionsServed,
} from "../src/query/pending-decisions.ts";
import { world as accountWorld } from "./account-candidates-world.ts";
import {
  heldWorld,
  stubDatabase,
  world as instrumentWorld,
} from "./instrument-resolution-world.ts";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import { validPendingDecisions } from "../../observation-shared/src/pending-decisions-contract.ts";
import { migratedDatabase } from "./sqlite-store.ts";

/** The authority every MCP client and the operator's page hold (ADR 0084). */
const FULL: Grant = {
  principal: "synthetic-owner",
  scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
  capabilities: ["summary.read", "records.read", "evidence.read", "schedules.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};
const SERVED: PendingDecisionsServed = {
  cardSettlements: true,
  cardPurchases: true,
  schedules: true,
  commands: true,
};
const NOW = "2099-03-01T00:00:00.000Z";

function executor(db: Database): SqlExecutor {
  return {
    all: async <T>(text: string, args: readonly unknown[]) =>
      db.query(text).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(text: string, args: readonly unknown[]) =>
      (db.query(text).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

async function pending(
  sql: SqlExecutor,
  options: { grant?: Grant; served?: Partial<PendingDecisionsServed>; now?: string } = {},
): Promise<PendingDecisions> {
  const outcome = await readPendingDecisions({
    grant: options.grant ?? FULL,
    sql,
    served: { ...SERVED, ...options.served },
    now: options.now ?? NOW,
  });
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}`);
  // Every answer is one the browser's wire contract admits.
  expect(validPendingDecisions({ apiVersion: 2, ...outcome.answer })).toBe(true);
  return outcome.answer;
}

const line = (answer: PendingDecisions, kind: PendingDecisionKind): PendingDecisionLine =>
  answer.kinds.find((entry) => entry.kind === kind)!;

/** Every committed change since the connection opened: a read adds none. */
const changes = (db: Database): number =>
  (db.query("SELECT total_changes() AS n").get() as { n: number }).n;

beforeAll(() => {
  stubDatabase().close();
  migratedDatabase().close();
}, 60_000);

describe("an empty store", () => {
  test("every line is counted at zero, with no id and no time, and nothing is written", async () => {
    const db = migratedDatabase();
    const before = changes(db);
    const answer = await pending(executor(db));
    expect(changes(db)).toBe(before);
    expect(answer.kinds.map((entry) => entry.kind)).toEqual([...PENDING_DECISION_KINDS]);
    for (const entry of answer.kinds)
      expect(entry).toMatchObject({
        state: "counted",
        reason: null,
        count: 0,
        complete: true,
        ids: [],
        oldestAt: null,
      });
    expect(answer.schemaVersion).toBe("kogane-pending-decisions-v1");
    expect(answer.decisions).toBe("elsewhere");
    expect(answer.asOf).toBe(NOW);
  });
});

/** A candidate as the カード照合 list's own SQL reads it. */
interface Listed {
  proposalId: string;
  status: string;
  createdAt: string;
  statementAccount: string | null;
  bankAccount: string | null;
}

/**
 * Every candidate of the カード照合 list, read through the list's own SQL:
 * its statement pages, then each statement's pages of candidates. (The
 * random stores draw malformed facts too, which the service refuses whole, so
 * the rows are read rather than the service's DTO.)
 */
function listedCandidates(db: Database): Map<string, Listed[]> {
  const found = new Map<string, Listed[]>();
  for (let offset = 0; ; offset += 10) {
    const statements = db.query(CARD_SETTLEMENT_STATEMENT_PAGE_SQL).all(11, offset) as {
      statement_key: string;
    }[];
    for (const { statement_key: key } of statements.slice(0, 10))
      for (let at = 0; ; at += 50) {
        const rows = db.query(CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL).all(key, 51, at) as {
          id: string;
          status: string;
          created_at: string;
          facts_json: string;
        }[];
        for (const row of rows.slice(0, 50)) {
          const facts = JSON.parse(row.facts_json) as {
            statement?: { accountId?: unknown };
            bankDebit?: { accountId?: unknown };
          };
          const account = (value: unknown) => (typeof value === "string" ? value : null);
          found.set(key, [
            ...(found.get(key) ?? []),
            {
              proposalId: row.id,
              status: row.status,
              createdAt: row.created_at,
              statementAccount: account(facts.statement?.accountId),
              bankAccount: account(facts.bankDebit?.accountId),
            },
          ]);
        }
        if (rows.length <= 50) break;
      }
    if (statements.length <= 10) return found;
  }
}

const newestFirst = (left: Listed, right: Listed): number =>
  left.createdAt === right.createdAt
    ? left.proposalId < right.proposalId
      ? 1
      : -1
    : left.createdAt < right.createdAt
      ? 1
      : -1;

interface RelationRow {
  position: number;
  kind: string;
  from_ref: string;
  to_ref: string;
  status: string;
  live: number;
}

/** Whether `account` holds a current accepted claim in `role`, read in TypeScript. */
function owned(rows: readonly RelationRow[], role: string, account: string): boolean {
  const aliases = [account, `account:${account}`];
  const mine = rows.filter((row) => row.kind === role && aliases.includes(row.from_ref));
  return mine.some(
    (row) =>
      row.status === "accepted" &&
      row.live === 1 &&
      !mine.some(
        (later) =>
          later.to_ref === row.to_ref &&
          later.position > row.position &&
          later.status !== "proposed",
      ),
  );
}

describe("card settlement statements and ownership, on random stores", () => {
  const drawn = new Set<string>();
  for (const seed of [1, 2, 3, 4])
    test(`seed ${String(seed)}: the lines count what the カード照合 list shows`, async () => {
      const { db } = randomSettlementStore(seed, new Set(), { laterProposals: seed % 2 === 0 });
      const sql = executor(db);
      const before = changes(db);
      const answer = await pending(sql);
      expect(changes(db)).toBe(before);

      const byStatement = listedCandidates(db);
      const waiting = [...byStatement.entries()].filter(
        ([, reviews]) =>
          reviews.some((review) => review.status === "proposed") &&
          !reviews.some((review) => review.status === "accepted"),
      );
      if (waiting.length > 0) drawn.add("statement waiting");
      if (waiting.length < byStatement.size) drawn.add("statement decided");
      const proposed = waiting.flatMap(([, reviews]) =>
        reviews.filter((review) => review.status === "proposed"),
      );
      const leads = waiting
        .map(
          ([, reviews]) =>
            reviews.filter((review) => review.status === "proposed").sort(newestFirst)[0]!,
        )
        .sort(newestFirst);
      const statements = line(answer, "card-settlement.statement");
      expect(statements).toMatchObject({
        state: "counted",
        count: waiting.length,
        complete: true,
        timeBasis: "created",
      });
      expect(statements.ids).toEqual(shownIds(leads.map((review) => review.proposalId)));
      expect(statements.oldestAt).toBe(
        proposed.length === 0 ? null : proposed.map((review) => review.createdAt).sort()[0]!,
      );

      // Ownership: each (role, account) an undecided candidate of a waiting
      // statement resolved, without a current accepted claim.
      const relations = db
        .query(
          `SELECT r.rowid AS position,r.kind,r.from_ref,r.to_ref,r.status,
            (SELECT CASE WHEN d.superseded_by IS NULL THEN 1 ELSE 0 END FROM decision_revisions d WHERE d.id=r.decision_revision_id) AS live
           FROM entity_relations r WHERE r.kind IN ('liable_party','beneficial_owner')`,
        )
        .all() as RelationRow[];
      const sides = new Map<string, Listed[]>();
      for (const review of proposed)
        for (const [role, account] of [
          ["liable_party", review.statementAccount],
          ["beneficial_owner", review.bankAccount],
        ] as const) {
          if (account === null) continue;
          if (owned(relations, role, account)) {
            drawn.add("account owned");
            continue;
          }
          const key = `${role}\u0000${account}`;
          sides.set(key, [...(sides.get(key) ?? []), review]);
        }
      if (sides.size > 0) drawn.add("account without owner");
      const ownership = line(answer, "card-ownership.account");
      expect(ownership).toMatchObject({ state: "counted", count: sides.size, complete: true });
      const ownershipLeads = new Map<string, Listed>();
      for (const reviews of sides.values()) {
        const lead = [...reviews].sort(newestFirst)[0]!;
        ownershipLeads.set(lead.proposalId, lead);
      }
      expect(ownership.ids).toEqual(
        shownIds([...ownershipLeads.values()].sort(newestFirst).map((review) => review.proposalId)),
      );
      expect(ownership.oldestAt).toBe(
        sides.size === 0
          ? null
          : [...sides.values()]
              .flat()
              .map((review) => review.createdAt)
              .sort()[0]!,
      );
    }, 30_000);
  test("the seeds draw every case", () => {
    expect([...drawn].sort()).toEqual([
      "account owned",
      "account without owner",
      "statement decided",
      "statement waiting",
    ]);
  });
});

describe("account and instrument candidates", () => {
  test("the account lines are the review's open and held totals and first ids", async () => {
    const s = accountWorld();
    const before = s.snapshot();
    const answer = await pending(s.sql);
    expect(s.snapshot()).toBe(before);
    for (const view of ["open", "held"] as const) {
      const outcome = await reviewAccountCandidates({
        grant: FULL,
        sql: s.sql,
        request: { view, offset: 0, sourceAccountId: null },
      });
      if (!outcome.ok) throw new Error(outcome.error.code);
      const entry = line(answer, `account-candidate.${view}`);
      expect(entry.count).toBe(outcome.review.total);
      expect(entry.count).toBeGreaterThan(0);
      expect(entry.ids).toEqual(
        shownIds(
          outcome.review.items.map((item) => ("candidateId" in item ? item.candidateId : "")),
        ),
      );
      expect(entry).toMatchObject({ oldestAt: null, timeBasis: "not_recorded", complete: true });
    }
  });

  test("the instrument lines are the review's open and held totals and first ids", async () => {
    for (const w of [await instrumentWorld(), (await heldWorld()).w]) {
      const before = w.snapshot();
      const answer = await pending(w.sql);
      expect(w.snapshot()).toBe(before);
      for (const view of ["open", "held"] as const) {
        const outcome = await reviewInstrumentCandidates({
          grant: FULL,
          sql: w.sql,
          request: { view, offset: 0, identifierId: null },
        });
        if (!outcome.ok) throw new Error(outcome.error.code);
        const entry = line(answer, `instrument-candidate.${view}`);
        expect(entry.count).toBe(outcome.review.total);
        expect(entry.ids).toEqual(
          shownIds(
            outcome.review.items.map((item) => ("candidateId" in item ? item.candidateId : "")),
          ),
        );
      }
    }
    const held = await pending((await heldWorld()).w.sql);
    expect(line(held, "instrument-candidate.held").count).toBeGreaterThan(0);
  });

  test("a store past the instrument read's bound leaves its lines unavailable, not the others", async () => {
    const w = await instrumentWorld();
    const sql: SqlExecutor = {
      all: w.sql.all,
      first: async <T>(text: string, args: readonly unknown[]) =>
        text === IDENTITY_OBSERVATION_COUNT_SQL
          ? ({ n: CURRENT_IDENTITY_OBSERVATION_BOUND + 1 } as T)
          : w.sql.first<T>(text, args),
    };
    const answer = await pending(sql);
    for (const kind of ["instrument-candidate.open", "instrument-candidate.held"] as const)
      expect(line(answer, kind)).toMatchObject({
        state: "unavailable",
        reason: "budget_exceeded",
        count: null,
        complete: false,
        ids: [],
      });
    expect(line(answer, "account-candidate.open").state).toBe("counted");
  });
});

/** The proposal row the purchase lane writes, between two canonical rows. */
function proposal(db: Database, id: string, at: string, kind = "pending_to_posted", stage = "B") {
  db.run(
    `INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,rationale_codes_json,
      rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
     VALUES(?,?,?,?,'rule','synthetic-v1','[]','[]','[]','proposed',NULL,?,?)`,
    [
      id,
      kind,
      stage,
      JSON.stringify([
        { kind: "transaction", id: `transaction:${String(id.length)}1`, revision: "parse_run:1" },
        { kind: "transaction", id: `transaction:${String(id.length)}2`, revision: "parse_run:2" },
      ]),
      createHash("sha256").update(id).digest("hex"),
      at,
    ],
  );
}

/** A `proposal:` decision resolving `id`, as the review commit writes one. */
function resolve(db: Database, id: string) {
  db.run(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,reason,evidence_refs_json,created_at)
     VALUES(?,'relation',?,1,'reject','manual','synthetic-owner','synthetic','[]','2099-02-02')`,
    [`decision-${id}`, `proposal:${id}`],
  );
  db.run(
    "UPDATE reconciliation_proposals SET status='rejected',decision_revision_id=? WHERE id=?",
    [`decision-${id}`, id],
  );
}

function survey(db: Database, id: number, source: string, at: string, decided = false) {
  db.run(
    `INSERT INTO maintenance_survey_fetches(id,target_id,source,url,fetched_at,outcome,sha256,object_key,extractor_version,windows)
     VALUES(?,'synthetic-target',?,'https://synthetic.invalid/notice',?,'extracted',?,?,'synthetic-v1',1)`,
    [
      id,
      source,
      at,
      String(id).padStart(64, "0"),
      `maintenance-survey/objects/00/${String(id).padStart(64, "0")}`,
    ],
  );
  db.run(
    `INSERT INTO maintenance_survey_proposals(id,fetch_id,target_id,source,kind,rule_id,base_revision,timezone,pattern_json,enabled,scope,status,reasons_json,proposal_key,created_at)
     VALUES(?,?,'synthetic-target',?,'new',NULL,0,'Asia/Tokyo','{}',1,'collection','proposed','[]',?,?)`,
    [id, id, source, String(id).padStart(64, "a"), at],
  );
  if (decided)
    db.run(
      "INSERT INTO maintenance_survey_decisions(proposal_id,decision,actor,decided_at) VALUES(?,'rejected','synthetic-owner',?)",
      [id, at],
    );
}

function plan(db: Database, id: string, createdAt: string, expiresAt: string, status: string) {
  db.run(
    `INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
     VALUES(?,'relation.accept','{}','synthetic','{}','{}','synthetic-owner',?,?,?)`,
    [id.repeat(64).slice(0, 64), createdAt, expiresAt, status],
  );
}

describe("pending-to-posted links, survey proposals and open plans", () => {
  test("each line counts its undecided rows, oldest first, and the lists agree", async () => {
    const db = migratedDatabase();
    proposal(db, "rp_c", "2099-02-03T00:00:00Z");
    proposal(db, "rp_a", "2099-02-01T00:00:00Z");
    proposal(db, "rp_b", "2099-02-02T00:00:00Z");
    resolve(db, "rp_b");
    // Not reviewable through the purchase page: another kind, another stage.
    proposal(db, "rp_x", "2099-01-01T00:00:00Z", "supports");
    proposal(db, "rp_y", "2099-01-01T00:00:00Z", "pending_to_posted", "A");
    survey(db, 1, "vpass", "2099-02-01T00:00:00Z", true);
    survey(db, 2, "vpass", "2099-02-02T00:00:00Z");
    survey(db, 3, "myjcb", "2099-02-03T00:00:00Z");
    // Unexpired planned and approved plans wait; committed, stale and expired ones do not.
    plan(db, "a", "2099-02-28T23:50:00.000Z", "2099-03-01T00:05:00.000Z", "planned");
    plan(db, "b", "2099-02-28T23:55:00.000Z", "2099-03-01T00:10:00.000Z", "approved");
    plan(db, "c", "2099-02-28T23:56:00.000Z", "2099-03-01T00:11:00.000Z", "committed");
    plan(db, "d", "2099-02-28T23:40:00.000Z", "2099-02-28T23:55:00.000Z", "planned");
    plan(db, "e", "2099-02-27T00:00:00.000Z", "2099-02-27T00:15:00.000Z", "approved");
    plan(db, "f", "2099-02-28T23:57:00.000Z", "2099-03-01T00:12:00.000Z", "stale");
    const sql = executor(db);
    const before = changes(db);
    const answer = await pending(sql);
    expect(changes(db)).toBe(before);

    const links = line(answer, "pending-posted.link");
    expect(links).toMatchObject({
      count: 2,
      complete: true,
      ids: ["rp_c", "rp_a"],
      oldestAt: "2099-02-01T00:00:00Z",
    });
    // The purchase page's candidate reader agrees on which are still proposed.
    const open = [];
    for (const id of ["rp_a", "rp_b", "rp_c"]) {
      const [loaded] = await loadPendingPostedCandidates(sql, { proposalId: id });
      if (loaded?.view.proposalStatus === "proposed") open.push(id);
    }
    expect(links.count).toBe(open.length);

    expect(line(answer, "maintenance-survey.proposal")).toMatchObject({
      count: 2,
      ids: ["2", "3"],
      oldestAt: "2099-02-02T00:00:00Z",
    });
    const narrowed = await pending(sql, {
      grant: { ...FULL, scopes: { ...FULL.scopes, scheduleSources: ["myjcb"] } },
    });
    expect(line(narrowed, "maintenance-survey.proposal")).toMatchObject({ count: 1, ids: ["3"] });

    expect(line(answer, "change-plan.open")).toMatchObject({
      count: 2,
      ids: ["a".repeat(64), "b".repeat(64)],
      oldestAt: "2099-02-28T23:50:00.000Z",
    });
    // Five minutes later the first plan has expired.
    const later = await pending(sql, { now: "2099-03-01T00:06:00.000Z" });
    expect(line(later, "change-plan.open")).toMatchObject({ count: 1, ids: ["b".repeat(64)] });
  });

  test("past the count bound a line says so instead of counting on", async () => {
    const db = migratedDatabase();
    for (let n = 0; n <= PENDING_DECISIONS_COUNT_BOUND; n += 1)
      proposal(db, `rp_${String(n).padStart(5, "0")}`, `2099-02-01T00:00:00Z`);
    const entry = line(await pending(executor(db)), "pending-posted.link");
    expect(entry).toMatchObject({
      count: PENDING_DECISIONS_COUNT_BOUND,
      complete: false,
      ids: ["rp_00000", "rp_00001", "rp_00002", "rp_00003", "rp_00004"],
    });
  });
});

describe("grant and deployment", () => {
  const untouched: SqlExecutor = {
    all: async () => {
      throw new Error("read");
    },
    first: async () => {
      throw new Error("read");
    },
  };
  test("records.read over the whole store, refused before anything is read", async () => {
    for (const [grant, code, refs] of [
      [{ ...FULL, capabilities: ["summary.read"] }, "unauthorized", ["capability:records.read"]],
      [
        { ...FULL, scopes: { sources: ["vpass"], accounts: "*" } },
        "evidence_restricted",
        ["scope:source"],
      ],
      [
        { ...FULL, scopes: { sources: "*", accounts: ["a"] } },
        "evidence_restricted",
        ["scope:account"],
      ],
    ] as const) {
      const outcome = await readPendingDecisions({
        grant: grant as Grant,
        sql: untouched,
        served: SERVED,
        now: NOW,
      });
      expect(outcome).toMatchObject({ ok: false, error: { code, refs } });
    }
  });

  test("a line the deployment or the grant cannot serve says why and reads nothing for it", async () => {
    const db = migratedDatabase();
    const answer = await pending(executor(db), {
      grant: { ...FULL, capabilities: ["records.read"] },
      served: { cardSettlements: false, cardPurchases: false, schedules: true, commands: false },
    });
    const reasons = Object.fromEntries(
      answer.kinds.map((entry) => [
        entry.kind,
        entry.state === "counted" ? "counted" : entry.reason,
      ]),
    );
    expect(reasons).toEqual({
      "card-settlement.statement": "not_served",
      "card-ownership.account": "not_served",
      "account-candidate.open": "counted",
      "account-candidate.held": "counted",
      "instrument-candidate.open": "counted",
      "instrument-candidate.held": "counted",
      "pending-posted.link": "not_served",
      "maintenance-survey.proposal": "unauthorized",
      "change-plan.open": "not_served",
    });
    const off = await pending(executor(db), { served: { schedules: false } });
    expect(line(off, "maintenance-survey.proposal").reason).toBe("not_served");
  });
});

describe("size", () => {
  test("ids stop at five and at the byte budget", () => {
    expect(shownIds(["a", "b", "c", "d", "e", "f"])).toEqual(["a", "b", "c", "d", "e"]);
    const long = "x".repeat(300);
    expect(shownIds([long, long, long])).toEqual([long, long]);
    expect(shownIds(["x".repeat(PENDING_DECISIONS_ID_BYTES + 1)])).toEqual([]);
  });

  test("an answer with every line full of the longest ids stays under the bound", async () => {
    // Every line with five ids at the longest any of its id shapes may be.
    const longest: Record<PendingDecisionKind, number> = {
      "card-settlement.statement": 128,
      "card-ownership.account": 128,
      "account-candidate.open": 600,
      "account-candidate.held": 600,
      "instrument-candidate.open": 300,
      "instrument-candidate.held": 300,
      "pending-posted.link": 512,
      "maintenance-survey.proposal": 16,
      "change-plan.open": 64,
    };
    const answer = await pending(executor(migratedDatabase()));
    const full: PendingDecisions = {
      ...answer,
      kinds: answer.kinds.map((entry) => ({
        ...entry,
        count: 1_000_000,
        complete: false,
        oldestAt: "2099-12-31T23:59:59.999Z",
        ids: shownIds(
          Array.from({ length: PENDING_DECISIONS_IDS_SHOWN }, () =>
            "あ".repeat(Math.ceil(longest[entry.kind] / 3)).padEnd(longest[entry.kind], "x"),
          ),
        ),
      })),
    };
    const bytes = new TextEncoder().encode(JSON.stringify({ apiVersion: 2, ...full })).length;
    expect(bytes).toBeLessThan(PENDING_DECISIONS_MAX_BYTES);
  });
});

describe("plans without table statistics", () => {
  /**
   * The only whole-relation scans each plan may make: the candidates once
   * (`c`, as the カード照合 statement page does), the survey proposals (`p`,
   * as the survey read does), and the plans' own CTEs.
   */
  const ALLOWED = new Set([
    "c",
    "p",
    "undecided",
    "s",
    "w",
    "u",
    "a",
    "sides",
    "ranked",
    "leads",
    "waiting",
    "waiting_statements",
    "(subquery-7)",
    "(subquery-12)",
    "(subquery-20)",
    "json_each",
  ]);
  test("every table is reached by key or by one index range, and no table statistics exist", () => {
    const db = migratedDatabase();
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    for (const [name, text, binds, required] of [
      ["statements", PENDING_CARD_SETTLEMENTS_SQL, [5], ["card_settlement_candidates_statement"]],
      ["ownership", PENDING_CARD_OWNERSHIP_SQL, [5], ["entity_relations_from"]],
      ["links", PENDING_POSTED_LINKS_SQL, [1001, 5], ["reconciliation_proposals_status"]],
      ["survey", PENDING_SURVEY_PROPOSALS_SQL, [1001, 5, null], []],
      ["plans", PENDING_CHANGE_PLANS_SQL, [1001, 5, "2099", "2099"], ["change_plans_status"]],
    ] as const) {
      const steps = explain(db, text, binds).map((step) => step.detail);
      const scans = steps
        .filter((detail) => detail.startsWith("SCAN "))
        .map((detail) => detail.slice(5).split(" ")[0]!)
        .filter((target) => !ALLOWED.has(target));
      expect({ name, scans }).toEqual({ name, scans: [] });
      for (const index of required)
        expect({ name, index, used: steps.some((detail) => detail.includes(index)) }).toEqual({
          name,
          index,
          used: true,
        });
    }
  });
});
