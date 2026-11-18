// The purchase lane's reviewed-pair guard (`REVIEWED_PAIR_SQL`,
// src/card-purchase-job.ts) against the text first written for it
// (./reviewed-pair-guard-legacy-sql.ts), which read every `proposal:`
// decision in the store. The rewrite reads the pending event's keys, each
// cited row's `pending_to_posted` triples and each triple's decision instead.
//
// What is proved here, on random stores and on a scaled one: both guards
// reach the same verdict for every pair of events wherever each review wrote
// what its writer writes today. The change lifecycle's review
// (`relationMutation` with `pendingPostedWrites`) writes the `proposal:`
// decision and a triple row with its own `manual` decision in one batch; the
// rule (the purchase lane's merge, `acceptProposal`) writes `rule` decisions,
// which neither guard counts; an agent's proposal writes a `proposed` triple
// row, which neither guard counts. The one difference is the documented
// limit: a non-rule rejection written by `decideProposal`, which records
// `proposal:<id>` and no triple, is seen only by the first text (nothing
// calls `decideProposal` with any method but `rule` today). The second limit
// (a row no event's key ever cited) is shared by both texts, so it is no
// difference. Every row is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migratedDatabase } from "../../../packages/application/test/sqlite-store.ts";
import { pick, random } from "../../../packages/read-model/test/relation-history.ts";
import { REVIEWED_PAIR_SQL } from "../src/card-purchase-job.ts";
import {
  LEGACY_REVIEWED_PAIR_SQL,
  LEGACY_REVIEWED_PAIR_SQL_SHA256,
} from "./reviewed-pair-guard-legacy-sql.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

/** What was recorded about one proposal, by the writer that records it today (or the limit). */
const OUTCOMES = [
  "open",
  "rule-accepted",
  "review-accepted",
  "review-rejected",
  "review-withdrawn",
  "command-accepted",
  "command-rejected",
  "agent-proposed",
] as const;
type Outcome = (typeof OUTCOMES)[number];

interface StoreShape {
  events: number;
  observations: number;
  keysPerEvent: number;
  proposals: number;
}

interface Proposal {
  kind: string;
  from: string;
  to: string;
  outcome: Outcome;
  /** A non-rule decision on `proposal:<id>` (what the first text reads). */
  proposalReviewed: boolean;
  /** A non-rule, non-`proposed` row of the triple (what the rewrite reads). */
  tripleReviewed: boolean;
}

interface Store {
  db: Database;
  events: string[];
  cited: Map<string, Set<string>>;
  proposals: Proposal[];
}

/**
 * A migrated store holding only what the two guards read. The recognition
 * keys' own triggers and foreign keys pin them to recognised rows, which these
 * guards never read, so they are dropped here to write the keys directly.
 */
function syntheticStore(seed: number, shape: StoreShape): Store {
  const next = random(seed);
  const db = migratedDatabase();
  db.exec("PRAGMA foreign_keys=OFF");
  for (const { name } of db
    .query(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='card_purchase_recognition_keys'",
    )
    .all() as { name: string }[])
    db.exec(`DROP TRIGGER ${name}`);
  const key = db.prepare(
    `INSERT INTO card_purchase_recognition_keys(event_id,revision,recognition_key,role,observation_id,parse_run_id)
     VALUES(?1,?2,json_array('synthetic','producer','namespace','account',?3),?4,?5,1)`,
  );
  const decision = db.prepare(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,
      operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES(?1,'relation',?2,?3,?4,?5,'synthetic-operator',NULL,'Synthetic decision.','[]',NULL,NULL,'2026-01-01T00:00:00Z')`,
  );
  const relation = db.prepare(
    `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,
      evidence_refs_json,created_at)
     VALUES(?1,?2,?3,?4,NULL,NULL,?5,?6,'[]','2026-01-01T00:00:00Z')`,
  );
  const proposal = db.prepare(
    `INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,rationale_codes_json,
      rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
     VALUES(?1,?2,'B',?3,'rule','synthetic','[]','[]','[]','proposed',NULL,?4,'2026-01-01T00:00:00Z')`,
  );
  let ids = 0;
  const id = (prefix: string) => `${prefix}_${(ids += 1)}`;
  const observation = () => `transaction:${1 + Math.floor(next() * shape.observations)}`;
  const nonRule = () => pick(next, ["manual", "ai"] as const);
  const proposalDecision = (proposalId: string, kind: string, method: string, revision = 1) =>
    decision.run(id("dr"), `proposal:${proposalId}`, revision, kind, method);
  const triple = (
    kind: string,
    from: string,
    to: string,
    status: string,
    decisionKind: string,
    method: string,
  ) => {
    const relationId = id("rel");
    const decisionId = id("dr");
    decision.run(decisionId, relationId, 1, decisionKind, method);
    relation.run(relationId, kind, from, to, status, decisionId);
  };

  const events = Array.from({ length: shape.events }, (_, index) => `ev_${index}`);
  const cited = new Map<string, Set<string>>();
  const proposals: Proposal[] = [];
  db.transaction(() => {
    for (const event of events) {
      const refs = new Set<string>();
      const count = 1 + Math.floor(next() * shape.keysPerEvent);
      for (let revision = 1; revision <= count; revision += 1) {
        const ref = observation();
        refs.add(ref);
        key.run(
          event,
          revision,
          id("key"),
          pick(next, ["pending", "posted"]),
          Number(ref.slice(12)),
        );
      }
      cited.set(event, refs);
    }
    for (let index = 0; index < shape.proposals; index += 1) {
      const kind = pick(next, ["pending_to_posted", "pending_to_posted", "provider_same"]);
      const from = observation();
      let to = observation();
      while (to === from) to = observation();
      const proposalId = id("rp");
      proposal.run(
        proposalId,
        kind,
        JSON.stringify([
          { kind: "transaction", id: from, revision: "parse_run:1" },
          { kind: "transaction", id: to, revision: "parse_run:1" },
        ]),
        createHash("sha256").update(proposalId).digest("hex"),
      );
      const outcome = pick(next, OUTCOMES);
      let proposalReviewed = false;
      let tripleReviewed = false;
      switch (outcome) {
        case "open":
          break;
        case "rule-accepted":
          // The purchase lane's merge, or `acceptProposal` with `rule`.
          proposalDecision(proposalId, "accept", "rule");
          triple(kind, from, to, "accepted", "accept", "rule");
          break;
        case "review-accepted":
        case "review-rejected": {
          // `relation.accept` / `relation.reject` through the change lifecycle.
          const accept = outcome === "review-accepted";
          proposalDecision(proposalId, accept ? "accept" : "reject", "manual");
          triple(
            kind,
            from,
            to,
            accept ? "accepted" : "rejected",
            accept ? "accept" : "reject",
            "manual",
          );
          proposalReviewed = tripleReviewed = true;
          break;
        }
        case "review-withdrawn": {
          // Accepted by the rule or a reviewer, then withdrawn by a reviewer.
          const method = pick(next, ["rule", "manual"]);
          proposalDecision(proposalId, "accept", method);
          triple(kind, from, to, "accepted", "accept", method);
          proposalDecision(proposalId, "supersede", "manual", 2);
          triple(kind, from, to, "rejected", "reject", "manual");
          proposalReviewed = tripleReviewed = true;
          break;
        }
        case "command-accepted": {
          // `decideProposal` accepting with a non-rule method writes both.
          const method = nonRule();
          proposalDecision(proposalId, "accept", method);
          triple(kind, from, to, "accepted", "accept", method);
          proposalReviewed = tripleReviewed = true;
          break;
        }
        case "command-rejected":
          // `decideProposal` rejecting with a non-rule method: no triple (the limit).
          proposalDecision(proposalId, "reject", nonRule());
          proposalReviewed = true;
          break;
        case "agent-proposed":
          // An agent's proposal of the same triple: a `propose` decision on the row.
          triple(kind, from, to, "proposed", "propose", nonRule());
          break;
      }
      const counted = kind === "pending_to_posted";
      proposals.push({
        kind,
        from,
        to,
        outcome,
        proposalReviewed: counted && proposalReviewed,
        tripleReviewed: counted && tripleReviewed,
      });
    }
    // Agents' proposals of triples no matcher proposed.
    for (let index = 0; index < shape.proposals / 4; index += 1) {
      const from = observation();
      const to = observation();
      if (from !== to) triple("pending_to_posted", from, to, "proposed", "propose", nonRule());
    }
  })();
  return { db, events, cited, proposals };
}

const reviewed = (db: Database, sql: string, pending: string, posted: string): boolean =>
  (db.query(`SELECT EXISTS(${sql}) AS reviewed`).get(pending, posted) as { reviewed: number })
    .reviewed === 1;

interface Tally {
  pairs: number;
  reviewed: number;
  limit: number;
}

/**
 * Both guards for every ordered pair of distinct events in `pairs`: each
 * agrees with its model, and they differ only where every proposal of the pair
 * the first text counts is a `decideProposal` rejection.
 */
function compare(store: Store, pairs: readonly [string, string][], tally: Tally): void {
  for (const [pending, posted] of pairs) {
    const ofPair = store.proposals.filter(
      (entry) =>
        store.cited.get(pending)!.has(entry.from) && store.cited.get(posted)!.has(entry.to),
    );
    const first = reviewed(store.db, LEGACY_REVIEWED_PAIR_SQL, pending, posted);
    const now = reviewed(store.db, REVIEWED_PAIR_SQL, pending, posted);
    expect(first).toBe(ofPair.some((entry) => entry.proposalReviewed));
    expect(now).toBe(ofPair.some((entry) => entry.tripleReviewed));
    tally.pairs += 1;
    if (now) tally.reviewed += 1;
    if (first === now) continue;
    tally.limit += 1;
    expect(now).toBe(false);
    expect(
      ofPair.filter((entry) => entry.proposalReviewed).map((entry) => entry.outcome),
    ).toContain("command-rejected");
    expect(
      ofPair.every((entry) => !entry.proposalReviewed || entry.outcome === "command-rejected"),
    ).toBe(true);
  }
}

const everyPair = (events: readonly string[]): [string, string][] =>
  events.flatMap((pending) =>
    events
      .filter((posted) => posted !== pending)
      .map((posted) => [pending, posted] as [string, string]),
  );

test("the frozen text is the text first written", () => {
  expect(createHash("sha256").update(LEGACY_REVIEWED_PAIR_SQL).digest("hex")).toBe(
    LEGACY_REVIEWED_PAIR_SQL_SHA256,
  );
});

test("on random stores both guards agree wherever a review wrote its triple", () => {
  const tally: Tally = { pairs: 0, reviewed: 0, limit: 0 };
  for (let seed = 1; seed <= 200; seed += 1) {
    const store = syntheticStore(seed, {
      events: 2 + (seed % 5),
      observations: 4 + (seed % 9),
      keysPerEvent: 1 + (seed % 3),
      proposals: seed % 24,
    });
    compare(store, everyPair(store.events), tally);
    store.db.close();
  }
  expect(tally.pairs).toBeGreaterThan(1_000);
  expect(tally.reviewed).toBeGreaterThan(100);
  // The documented limit is exercised, so the agreement above is not vacuous.
  expect(tally.limit).toBeGreaterThan(5);
}, 120_000);

test("on a scaled store both guards agree wherever a review wrote its triple", () => {
  const tally: Tally = { pairs: 0, reviewed: 0, limit: 0 };
  const store = syntheticStore(4_242, {
    events: 400,
    observations: 900,
    keysPerEvent: 3,
    proposals: 3_000,
  });
  const next = random(17);
  const pairs = new Map<string, [string, string]>();
  const add = (pending: string, posted: string) => {
    if (pending !== posted && pairs.size < 1_500)
      pairs.set(`${pending}\u0000${posted}`, [pending, posted]);
  };
  // Random pairs, then pairs the proposals name, so many of them are reviewed.
  for (let index = 0; index < 300; index += 1)
    add(pick(next, store.events), pick(next, store.events));
  const holders = new Map<string, string[]>();
  for (const [event, refs] of store.cited)
    for (const ref of refs) holders.set(ref, [...(holders.get(ref) ?? []), event]);
  for (const entry of store.proposals)
    for (const pending of holders.get(entry.from) ?? [])
      for (const posted of holders.get(entry.to) ?? []) add(pending, posted);
  compare(store, [...pairs.values()], tally);
  store.db.close();
  expect(tally.reviewed).toBeGreaterThan(200);
  expect(tally.limit).toBeGreaterThan(5);
}, 120_000);
