// The common consumption guard (CORE 0070, ADR 0054) and its statement
// builders (src/atomic/economic-commit.ts) on the full CORE schema, through
// the bun:sqlite D1Like whose batch rolls back on any SQL error as D1 does.
// Every row is synthetic: invented ids, round amounts, invented dates.
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  CARD_PURCHASE_ACTOR,
  cardPurchaseEventId,
  cardPurchaseRevision,
  classifyCardUsage,
  recognitionKey,
  type CardPurchaseDraft,
  type CardUsageFact,
} from "../../domain/src/card-purchase.ts";
import {
  ECONOMIC_GUARD_CODES,
  INITIAL_IDENTITY_EPOCH,
  aliasClassText,
  parseConsumptionKey,
  type AliasClass,
  type Book,
  type BookClaim,
  type ConsumptionKey,
  type RevisionRef,
} from "../../domain/src/economic-contract.ts";
import { cardPurchaseRecognitionWrites } from "../src/atomic/card-purchase-recognition.ts";
import {
  decisionEntry,
  economicClaimWrite,
  economicFinalizationWrites,
  receiptEntry,
  type CommitInput,
} from "../src/atomic/economic-commit.ts";
import type { SqlWrite } from "../src/core/operations.ts";
import { CORE_MIGRATIONS_URL, migrationFiles, migrationSql } from "../src/migrations.ts";
import { applyMigration, factOf, seedCardRows } from "./card-purchase-fixture.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

const MIGRATION = "0070_economic_commit_guard.sql";
const NOW = "2026-10-08T00:00:00.000Z";
const LATER = "2026-10-08T01:00:00.000Z";
const PRINCIPAL = "rule:synthetic-writer-v1";
const EPOCH_1 = INITIAL_IDENTITY_EPOCH;
const BANK_ACCOUNT = "smbc-bank:ordinary-yen";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

// ---------------------------------------------------------------------------
// Synthetic store

/**
 * One SMBC-shaped debit collected under two producers (A: runs 10, B: run 11)
 * and two more debits under A; a statement total for the settlement
 * candidates. Observation 111 is observation 101's row under producer B.
 */
function seedBank(db: Database): void {
  const run = (sql: string, ...binds: (string | number | null)[]) => db.run(sql, binds);
  for (const [producer, session, namespace] of [
    ["bank-producer-a", 10, "bank-ns-a"],
    ["bank-producer-b", 11, "bank-ns-b"],
  ] as const) {
    run(
      `INSERT INTO producers(id,kind,display_name) VALUES(?,'collector','Bank producer')`,
      producer,
    );
    run("INSERT INTO producer_sources(producer_id,source_id) VALUES(?,'smbc-bank')", producer);
    run(
      "INSERT INTO ingest_client_producers(ingest_client_id,producer_id) VALUES('card-client',?)",
      producer,
    );
    run(
      `INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('card-client',?,'smbc-bank')`,
      producer,
    );
    run(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?,?,'card-client',?,?,1000)`,
      session,
      producer,
      namespace,
      `session-${session}`,
    );
    run(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,'smbc-bank','card-client',?,1000)`,
      session,
      session,
      producer,
      `run-${session}`,
    );
    run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
        payload_fidelity,container_kind,lineage_disposition,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
       VALUES(?,?,'smbc-bank',?,'card-client',?,'provider_response','exact','single','not_applicable',?,3,'v1',?,1000)`,
      session,
      session,
      producer,
      `bank/details-${session}.json`,
      "a".repeat(64),
      String(session).repeat(32),
    );
    run(
      `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status)
       VALUES(?,?,'smbc-direct','1.0.0','2026-10-01T00:00:00Z','ok')`,
      session,
      session,
    );
  }
  const rows: [number, number, string][] = [
    [101, 10, "meisai-0001"],
    [102, 10, "meisai-0002"],
    [103, 10, "meisai-0003"],
    [104, 10, "meisai-0004"],
    [111, 11, "meisai-0001"],
  ];
  for (const [id, parseRun, externalId] of rows)
    run(
      `INSERT INTO transaction_observations(id,parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,
        currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,?,?,?,'posted',-1000,'-1000',0,'JPY','synthetic debit',NULL,'2026-10-01T00:00:00+09:00','2026-10-01T00:00:00Z','json:$.rows[0]','{}')`,
      id,
      parseRun,
      BANK_ACCOUNT,
      externalId,
    );
  run(
    `INSERT INTO balance_observations(id,parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json)
     VALUES(201,1,'vpass:card-001','credit_statement_payment_amount',1000,'1000',0,'JPY','2026-10-01','2026-10-01T00:00:00Z','json:$.total','{}')`,
  );
  run(
    "INSERT INTO accounts(id,label,role,status) VALUES('acct-bank','Synthetic bank','asset','identified')",
  );
}

function database(): Database {
  const db = fullCoreDatabase();
  seedCardRows(db);
  seedBank(db);
  return db;
}

/** The row's own key, as SQLite renders it from the stored columns. */
function keyOf(db: Database, observationId: number): ConsumptionKey {
  const row = db
    .query(
      `SELECT json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS k
       FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id
       JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN fetch_runs fr ON fr.id=a.fetch_run_id
       JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id WHERE t.id=?`,
    )
    .get(observationId) as { k: string };
  const key = parseConsumptionKey(row.k);
  if (!key) throw new Error("fixture key is not canonical");
  return key;
}
const keyText = (db: Database, observationId: number) => JSON.stringify(keyOf(db, observationId));
const parseRunOf = (db: Database, observationId: number) =>
  (
    db
      .query("SELECT parse_run_id AS p FROM transaction_observations WHERE id=?")
      .get(observationId) as { p: number }
  ).p;

/** The SMBC debit's alias class: provider id, resolved account, rule version. */
const aliasOf = (meisai: string): AliasClass => ({
  sourceId: "smbc-bank",
  components: [meisai],
  accountId: "acct-bank",
  ruleVersion: "smbc-meisai-v1",
});

async function run(db: Database, writes: SqlWrite[]): Promise<number[]> {
  const d1 = sqliteD1(db);
  const results = await d1.batch(writes.map((write) => d1.prepare(write.sql).bind(...write.binds)));
  return results.map((result) => result.meta.changes);
}

/** Every row of every table, so a moved pointer shows as well as a new row. */
function snapshot(db: Database): Record<string, unknown[]> {
  const tables = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  // Some Layer A tables are WITHOUT ROWID: order every table by its rows' text.
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .query(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

// ---------------------------------------------------------------------------
// A synthetic economic writer: entry decision → revision → leg → supersede →
// the builders' claims, seal and commit row.

interface ClaimSpec {
  book: Book;
  observationId: number;
  alias?: AliasClass | null;
  identityEpoch?: string;
}

interface AdoptSpec {
  eventId: string;
  revision: number;
  /** The head the plan read: 0 when the event never existed. */
  expectedHead?: number;
  supersedes?: RevisionRef[];
  /** What the supersede statements actually target (a mis-planned batch). */
  supersedeTargets?: RevisionRef[];
  claims?: ClaimSpec[];
  released?: BookClaim[];
  withdraw?: boolean;
  /** Overrides of what the commit row declares. */
  commitClaims?: BookClaim[];
  sealEpoch?: string;
  kind?: string;
  now?: string;
  decisionId?: string;
}

function adoptWrites(db: Database, spec: AdoptSpec): SqlWrite[] {
  const { eventId, revision } = spec;
  const decisionId = spec.decisionId ?? `dr-${eventId}-${revision}`;
  const expectedHead = spec.expectedHead ?? revision - 1;
  const supersedes = spec.supersedes ?? (revision > 1 ? [{ eventId, revision: revision - 1 }] : []);
  const now = spec.now ?? NOW;
  const claims = (spec.claims ?? []).map((claim) => ({
    eventId,
    revision,
    book: claim.book,
    key: keyOf(db, claim.observationId),
    aliasClass: claim.alias === undefined ? null : claim.alias,
    identityEpoch: claim.identityEpoch ?? EPOCH_1,
    observationId: claim.observationId,
    parseRunId: parseRunOf(db, claim.observationId),
  }));
  const entry = decisionEntry(decisionId);
  const writes: SqlWrite[] = [
    {
      sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
 SELECT ?,'relation',?,?,?,'rule',?,NULL,'synthetic adoption','[]',?,NULL,? WHERE NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)
 AND NOT EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND revision>?)
 AND (?=0 OR EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND revision=? AND superseded_by IS NULL))`,
      binds: [
        decisionId,
        `event:${eventId}`,
        revision,
        revision === 1 ? "accept" : "supersede",
        PRINCIPAL,
        expectedHead || null,
        now,
        decisionId,
        eventId,
        expectedHead,
        expectedHead,
        eventId,
        expectedHead,
      ],
    },
    {
      sql: `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
 SELECT ?,?,'transfer',?,?,'{}','cash-movement','["transaction:101"]',?,NULL,? WHERE ${entry.sql}
 AND NOT EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND revision=?)`,
      binds: [
        eventId,
        revision,
        spec.withdraw ? "unknown" : "debited",
        spec.withdraw ? "conflicting_evidence" : null,
        decisionId,
        now,
        ...entry.binds,
        eventId,
        revision,
      ],
    },
  ];
  if (!spec.withdraw)
    writes.push({
      sql: `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
 SELECT ?,?,0,'account:acct-bank','JPY','exact','1000',0,NULL,'decrease','cash-movement' WHERE ${entry.sql}
 AND NOT EXISTS(SELECT 1 FROM economic_legs WHERE event_id=? AND revision=? AND leg_index=0)`,
      binds: [eventId, revision, ...entry.binds, eventId, revision],
    });
  for (const target of spec.supersedeTargets ?? supersedes)
    writes.push({
      sql: `UPDATE economic_event_revisions SET superseded_by=? WHERE event_id=? AND revision=? AND superseded_by IS NULL AND ${entry.sql}`,
      binds: [`${eventId}@${revision}`, target.eventId, target.revision, ...entry.binds],
    });
  const commit: CommitInput = {
    decisionRevisionId: decisionId,
    operationId: null,
    principal: PRINCIPAL,
    payloadDigest: "d".repeat(64),
    kind: spec.kind ?? "synthetic.adopt",
    members: [{ eventId, revision, supersedes }],
    claims: spec.commitClaims ?? claims.map(({ book, key }) => ({ book, key })),
    released: spec.released ?? [],
    now,
  };
  writes.push(
    ...economicFinalizationWrites({
      entry,
      claims: spec.commitClaims ? [] : claims,
      times: [],
      effects: [],
      seals: [
        {
          eventId,
          revision,
          writerRelease: "synthetic-writer-v1",
          legCount: spec.withdraw ? 0 : 1,
          claimCount: claims.length,
          timeCount: 0,
          effectCount: 0,
          contentDigest: "c".repeat(64),
          identityPins: { "account_mapping:synthetic-bank": 1 },
          identityEpoch: spec.sealEpoch ?? EPOCH_1,
          now,
        },
      ],
      commit,
    }),
  );
  // An override's claim rows are still written, so the batch has claims to
  // compare (the builder refuses claims the commit does not declare).
  if (spec.commitClaims) writes.splice(writes.length - 2, 0, ...claimRows(claims));
  return writes;
}

/** Plain claim inserts, guarded as the builder guards them. */
function claimRows(claims: ReturnType<typeof claimRecords>): SqlWrite[] {
  return claims.map((claim) => ({
    sql: `INSERT INTO economic_claims(event_id,revision,book,consumption_key,alias_class,identity_epoch,observation_id,parse_run_id)
 VALUES(?,?,?,?,?,?,?,?)`,
    binds: [
      claim.eventId,
      claim.revision,
      claim.book,
      JSON.stringify(claim.key),
      claim.aliasClass === null ? null : aliasClassText(claim.aliasClass),
      claim.identityEpoch,
      claim.observationId,
      claim.parseRunId,
    ],
  }));
}
function claimRecords(db: Database, eventId: string, revision: number, specs: ClaimSpec[]) {
  return specs.map((claim) => ({
    eventId,
    revision,
    book: claim.book,
    key: keyOf(db, claim.observationId),
    aliasClass: claim.alias === undefined ? null : claim.alias,
    identityEpoch: claim.identityEpoch ?? EPOCH_1,
    observationId: claim.observationId,
    parseRunId: parseRunOf(db, claim.observationId),
  }));
}

/** A settlement candidate for one bank debit (a proposal, not a decision). */
function proposeSettlement(db: Database, id: string, bankObservationId: number): void {
  db.run(
    `INSERT INTO card_settlement_candidates(id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,
      bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
     VALUES(?,?,?,201,1,?,?,'synthetic-settlement-v1','{}',?,?)`,
    [
      id,
      `statement-${id}`,
      keyText(db, bankObservationId),
      bankObservationId,
      parseRunOf(db, bankObservationId),
      Bun.hash(id).toString(16).padStart(16, "0").repeat(4),
      NOW,
    ],
  );
}

/**
 * The card settlement writer's accept, statement for statement in its shape
 * (services/processor/src/card-settlement-commands.ts), with the guard true.
 * `alias` adds what G1b will add: the economic_claims row for the bank debit.
 */
function acceptSettlementWrites(
  db: Database,
  id: string,
  bankObservationId: number,
  alias?: AliasClass,
): SqlWrite[] {
  const op = `op-${id}`;
  const eventId = `settlement-event-${id}`;
  const decision = (decisionId: string, subject: string): SqlWrite => ({
    sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,created_at)
 VALUES(?,'relation',?,1,'accept','manual','owner',?,'synthetic review','[]',NULL,?)`,
    binds: [decisionId, subject, op, NOW],
  });
  const writes: SqlWrite[] = [
    {
      sql: `INSERT INTO decision_operations(operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at)
 VALUES(?,'owner','server','card-settlement.accept',?,'{}',?)`,
      binds: [op, "e".repeat(64), NOW],
    },
    decision(`dr-${id}`, `card-settlement:${id}`),
    decision(`dr-event-${id}`, `event:${eventId}`),
    decision(`dr-allocation-${id}`, `allocation:allocation-${id}`),
    {
      sql: `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,created_at)
 VALUES(?,1,'card_settlement','debited',NULL,'{}','cash-movement',?,?,?)`,
      binds: [eventId, `["transaction:${bankObservationId}"]`, `dr-event-${id}`, NOW],
    },
    {
      sql: `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,role,basis)
 VALUES(?,1,0,'acct-bank','JPY','exact','1000',0,'decrease','cash-movement')`,
      binds: [eventId],
    },
    {
      sql: `INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,created_at)
 VALUES(?,?,?,'settlement','JPY','1000',0,?,?)`,
      binds: [
        `allocation-${id}`,
        `transaction:${bankObservationId}`,
        `event:${eventId}`,
        `dr-allocation-${id}`,
        NOW,
      ],
    },
  ];
  if (alias)
    writes.push(
      ...claimRows(
        claimRecords(db, eventId, 1, [
          { book: "cash-movement", observationId: bankObservationId, alias },
        ]),
      ),
    );
  writes.push({
    sql: `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
 VALUES(?,1,'accepted',?,?,NULL,?,?)`,
    binds: [id, `dr-${id}`, eventId, `allocation-${id}`, NOW],
  });
  return writes;
}

async function draftOf(fact: CardUsageFact): Promise<CardPurchaseDraft> {
  const classified = classifyCardUsage(fact);
  const key = recognitionKey(fact);
  if (!classified.ok || !key) throw new Error("fixture row is not recognisable");
  const draft = await cardPurchaseRevision({
    action: "recognize",
    eventId: await cardPurchaseEventId(classified.kind, key),
    revision: 1,
    fact,
  });
  if (!draft) throw new Error("draft rejected");
  return draft;
}

/** The card purchase lane's recognition, as it writes today. */
const purchaseWrites = (draft: CardPurchaseDraft) =>
  cardPurchaseRecognitionWrites({ draft, expectedRevision: null, now: NOW });

/** The same batch with the seal and commit row G1b appends (keys are the claims). */
function purchaseWithCommitWrites(draft: CardPurchaseDraft): SqlWrite[] {
  const entry = decisionEntry(draft.decisionRevisionId);
  const ref = { eventId: draft.revision.eventId, revision: draft.revision.revision };
  return [
    ...purchaseWrites(draft),
    ...economicFinalizationWrites({
      entry,
      claims: [],
      times: [],
      effects: [],
      seals: [
        {
          ...ref,
          writerRelease: "card-purchase-recognition-v1",
          legCount: draft.revision.legs.length,
          claimCount: draft.keys.length,
          timeCount: 0,
          effectCount: 0,
          contentDigest: draft.contentDigest,
          identityPins: {},
          identityEpoch: EPOCH_1,
          now: NOW,
        },
      ],
      commit: {
        decisionRevisionId: draft.decisionRevisionId,
        operationId: null,
        principal: CARD_PURCHASE_ACTOR,
        payloadDigest: draft.contentDigest,
        kind: "card-purchase.recognize",
        members: [{ ...ref, supersedes: [] }],
        claims: draft.keys.map((key) => ({
          book: "card-usage" as const,
          key: parseConsumptionKey(key.key)!,
        })),
        released: [],
        now: NOW,
      },
    }),
  ];
}

const liveHolders = (db: Database) =>
  db
    .query(
      "SELECT book,consumption_key,alias_class,event_id,revision FROM live_consumption_claims ORDER BY 1,2,4,5",
    )
    .all();

// ---------------------------------------------------------------------------

describe("migration 0070", () => {
  /** CORE through every migration before 0070, as production stands today. */
  function beforeGuard(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const file of migrationFiles(CORE_MIGRATIONS_URL).filter((name) => name < MIGRATION))
      db.exec(migrationSql(CORE_MIGRATIONS_URL, file));
    return db;
  }

  test("is additive: legacy holders and a synthetic inconsistency are untouched and listed", async () => {
    const db = beforeGuard();
    seedCardRows(db);
    seedBank(db);
    // A recognised card purchase (the lane's own batch) ...
    const draft = await draftOf(factOf(1));
    await run(db, purchaseWrites(draft));
    // ... an accepted settlement, and a second one on the same debit: an
    // inconsistency the old readiness would refuse but nothing stores against.
    proposeSettlement(db, "proposal-1", 101);
    proposeSettlement(db, "proposal-2", 101);
    await run(db, acceptSettlementWrites(db, "proposal-1", 101));
    await run(db, acceptSettlementWrites(db, "proposal-2", 101));
    // An event with two live revisions, written by hand.
    db.run(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,created_at)
       VALUES('dr-twin-2','relation','event:settlement-event-proposal-1',2,'supersede','manual','owner',NULL,'synthetic','[]',1,?)`,
      [NOW],
    );
    db.run(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,created_at)
       VALUES('settlement-event-proposal-1',2,'card_settlement','debited',NULL,'{}','cash-movement','["transaction:101"]','dr-twin-2',?)`,
      [NOW],
    );
    const before = snapshot(db);
    applyMigration(db, MIGRATION, () => {
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    });
    const after = snapshot(db);
    const created = [
      "economic_claims",
      "economic_commit_log",
      "economic_event_times",
      "economic_identity_epochs",
      "economic_leg_effects",
      "economic_revision_seals",
    ];
    expect(
      Object.keys(after)
        .filter((table) => !(table in before))
        .sort(),
    ).toEqual(created);
    for (const table of Object.keys(before)) expect(after[table]).toEqual(before[table]!);
    expect(db.query("SELECT * FROM economic_identity_epochs").all()).toEqual([
      { ordinal: 1, identity_epoch: EPOCH_1, reason_code: "contract-start", declared_at: NOW },
    ]);
    for (const table of created.filter((name) => name !== "economic_identity_epochs"))
      expect(after[table]).toEqual([]);

    // The union view lists every legacy holder in its book.
    const purchaseKey = draft.keys[0]!.key;
    const bankKey = keyText(db, 101);
    expect(liveHolders(db)).toEqual([
      {
        book: "card-usage",
        consumption_key: purchaseKey,
        alias_class: null,
        event_id: draft.revision.eventId,
        revision: 1,
      },
      ...["proposal-1", "proposal-2"].map((id) => ({
        book: "cash-movement",
        consumption_key: bankKey,
        alias_class: null,
        event_id: `settlement-event-${id}`,
        revision: 1,
      })),
    ]);
    // The inconsistencies are listed, never washed.
    expect(db.query("SELECT * FROM consumption_claim_conflicts").all()).toEqual([
      { dimension: "key", book: "cash-movement", claim_ref: bankKey, holder_count: 2 },
    ]);
    expect(db.query("SELECT * FROM economic_event_live_conflicts").all()).toEqual([
      { event_id: "settlement-event-proposal-1", live_revisions: 2 },
    ]);
    // Everything written before the log started is unlogged knowledge.
    expect(
      db
        .query(
          "SELECT event_id,revision,live,after_log_start FROM unlogged_economic_revisions ORDER BY 1,2",
        )
        .all(),
    ).toEqual([
      { event_id: draft.revision.eventId, revision: 1, live: 1, after_log_start: 0 },
      { event_id: "settlement-event-proposal-1", revision: 1, live: 1, after_log_start: 0 },
      { event_id: "settlement-event-proposal-1", revision: 2, live: 1, after_log_start: 0 },
      { event_id: "settlement-event-proposal-2", revision: 1, live: 1, after_log_start: 0 },
    ]);
    db.close();
  });

  test("the current writers keep working unchanged after it", async () => {
    const db = database();
    const draft = await draftOf(factOf(1));
    expect((await run(db, purchaseWrites(draft))).every((changes) => changes > 0)).toBe(true);
    proposeSettlement(db, "proposal-1", 101);
    await run(db, acceptSettlementWrites(db, "proposal-1", 101));
    expect(liveHolders(db)).toHaveLength(2);
    db.close();
  });

  test("the trigger lookups go through indexes, without table statistics", () => {
    const db = database();
    const lookups = [
      // Step 4: every revision that points at a member, across event ids.
      `SELECT 1 FROM json_each(?1) m JOIN economic_event_revisions r
        ON r.superseded_by=json_extract(m.value,'$.eventId')||'@'||json_extract(m.value,'$.revision')`,
      `SELECT 1 FROM economic_claims x JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision
        WHERE x.book=?1 AND x.consumption_key=?2 AND r.superseded_by IS NULL`,
      `SELECT 1 FROM economic_claims x JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision
        WHERE x.book=?1 AND x.alias_class=?2 AND r.superseded_by IS NULL`,
      `SELECT 1 FROM card_purchase_recognition_keys k JOIN economic_event_revisions r ON r.event_id=k.event_id AND r.revision=k.revision
        WHERE k.recognition_key=?1 AND r.superseded_by IS NULL`,
      `SELECT 1 FROM card_settlement_candidates k JOIN card_settlement_decisions d ON d.proposal_id=k.id AND d.status='accepted'
        JOIN economic_event_revisions r ON r.event_id=d.event_id AND r.revision=d.revision
        WHERE k.bank_key=?1 AND r.superseded_by IS NULL`,
      `SELECT count(*) FROM card_settlement_decisions d JOIN card_settlement_candidates k ON k.id=d.proposal_id
        WHERE d.event_id=?1 AND d.revision=?2 AND d.status='accepted'`,
    ];
    for (const sql of lookups) {
      const plan = (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(
        (row) => row.detail,
      );
      // Only the JSON table-valued function is scanned; every table is searched.
      expect(
        plan.filter((detail) => detail.startsWith("SCAN") && !detail.includes("VIRTUAL TABLE")),
      ).toEqual([]);
    }
    db.close();
  });

  test("every closed code the migration raises is the contract's, and back", () => {
    const sql = migrationSql(CORE_MIGRATIONS_URL, MIGRATION);
    const raised = new Set(
      [...sql.matchAll(/RAISE\(ABORT,'([a-z_]+)'\)/gu)].map((match) => match[1]),
    );
    expect([...raised].sort()).toEqual([...ECONOMIC_GUARD_CODES].sort());
  });
});

describe("the finalization", () => {
  test("an adoption writes claims, a seal and commit 1; a replay writes nothing", async () => {
    const db = database();
    const writes = adoptWrites(db, {
      eventId: "transfer-x",
      revision: 1,
      claims: [{ book: "cash-movement", observationId: 101, alias: aliasOf("meisai-0001") }],
    });
    expect((await run(db, writes)).every((changes) => changes > 0)).toBe(true);
    expect(
      db
        .query(
          "SELECT core_epoch,commit_seq,members_json,claims_json,released_json,known_at FROM economic_commit_log",
        )
        .all(),
    ).toEqual([
      {
        core_epoch: "core-epoch-1",
        commit_seq: 1,
        members_json: '[{"eventId":"transfer-x","revision":1,"supersedes":[]}]',
        claims_json: JSON.stringify([["cash-movement", keyText(db, 101)]]),
        released_json: "[]",
        known_at: NOW,
      },
    ]);
    expect(db.query("SELECT commit_seq,identity_epoch FROM economic_revision_seals").all()).toEqual(
      [{ commit_seq: 1, identity_epoch: EPOCH_1 }],
    );
    expect(db.query("SELECT count(*) AS n FROM unlogged_economic_revisions").get()).toEqual({
      n: 0,
    });
    const before = snapshot(db);
    // The same batch again: every statement finds its own row.
    expect(await run(db, writes)).toEqual(writes.map(() => 0));
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("W2: a supersede that matched 0 rows is refused, and nothing is written", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 101 }],
      }),
    );
    const before = snapshot(db);
    // The correction's pointer statement names a revision that is not there.
    const writes = adoptWrites(db, {
      eventId: "transfer-x",
      revision: 2,
      claims: [{ book: "cash-movement", observationId: 101 }],
      supersedeTargets: [{ eventId: "transfer-x", revision: 7 }],
    });
    // Without the commit row this batch would succeed and leave two live
    // revisions of one event: every statement is a valid conditional write.
    const silent = adoptWrites(db, {
      eventId: "transfer-x",
      revision: 2,
      claims: [],
      released: [{ book: "cash-movement", key: keyOf(db, 101) }],
      supersedeTargets: [{ eventId: "transfer-x", revision: 7 }],
    });
    await expect(run(db, silent)).rejects.toThrow("economic_commit_prior_not_superseded");
    expect(snapshot(db)).toEqual(before);
    // Re-claiming the old revision's key fails even earlier: it is still held.
    await expect(run(db, writes)).rejects.toThrow("economic_claim_held");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("a stale batch whose entry matched nothing writes 0 rows everywhere", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 101 }],
      }),
    );
    const stale = adoptWrites(db, {
      eventId: "transfer-x",
      revision: 2,
      claims: [{ book: "cash-movement", observationId: 101 }],
    });
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 2,
        decisionId: "dr-other",
        claims: [{ book: "cash-movement", observationId: 101 }],
      }),
    );
    const before = snapshot(db);
    expect(await run(db, stale)).toEqual(stale.map(() => 0));
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("a correction supersedes, re-claims and releases exactly what it drops", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [
          { book: "cash-movement", observationId: 101 },
          { book: "cash-movement", observationId: 102 },
        ],
      }),
    );
    const keep = { book: "cash-movement" as const, key: keyOf(db, 101) };
    const drop = { book: "cash-movement" as const, key: keyOf(db, 102) };
    // Not listing the dropped key as released is refused.
    await expect(
      run(
        db,
        adoptWrites(db, {
          eventId: "transfer-x",
          revision: 2,
          claims: [{ book: "cash-movement", observationId: 101 }],
        }),
      ),
    ).rejects.toThrow("economic_commit_released_mismatch");
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 2,
        claims: [{ book: "cash-movement", observationId: 101 }],
        released: [drop],
        now: LATER,
      }),
    );
    expect(liveHolders(db)).toEqual([
      {
        book: "cash-movement",
        consumption_key: JSON.stringify(keep.key),
        alias_class: null,
        event_id: "transfer-x",
        revision: 2,
      },
    ]);
    // The released key is free for another event.
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-y",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 102 }],
        now: LATER,
      }),
    );
    expect(db.query("SELECT commit_seq FROM economic_commit_log ORDER BY 1").all()).toEqual([
      { commit_seq: 1 },
      { commit_seq: 2 },
      { commit_seq: 3 },
    ]);
    db.close();
  });

  test("P1: a correction that leaves its superseded prior undeclared is refused", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [
          { book: "cash-movement", observationId: 101 },
          { book: "cash-movement", observationId: 102 },
        ],
      }),
    );
    const before = snapshot(db);
    // The pointer on @1 moves, but the commit declares no prior and releases
    // nothing, so 102 would be released without anyone saying so.
    const writes = adoptWrites(db, {
      eventId: "transfer-x",
      revision: 2,
      claims: [{ book: "cash-movement", observationId: 101 }],
      supersedes: [],
      supersedeTargets: [{ eventId: "transfer-x", revision: 1 }],
      now: LATER,
    });
    await expect(run(db, writes)).rejects.toThrow("economic_commit_supersession_undeclared");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("P2: a withdrawal that leaves its prior undeclared cannot wash a double holder", async () => {
    const db = database();
    proposeSettlement(db, "proposal-1", 101);
    proposeSettlement(db, "proposal-2", 101);
    await run(db, acceptSettlementWrites(db, "proposal-1", 101));
    await run(db, acceptSettlementWrites(db, "proposal-2", 101));
    const conflicts = db.query("SELECT * FROM consumption_claim_conflicts").all();
    expect(conflicts).toHaveLength(1);
    const before = snapshot(db);
    const withdraw = adoptWrites(db, {
      eventId: "settlement-event-proposal-1",
      revision: 2,
      withdraw: true,
      supersedes: [],
      supersedeTargets: [{ eventId: "settlement-event-proposal-1", revision: 1 }],
      released: [],
    });
    await expect(run(db, withdraw)).rejects.toThrow("economic_commit_supersession_undeclared");
    expect(snapshot(db)).toEqual(before);
    expect(db.query("SELECT * FROM consumption_claim_conflicts").all()).toEqual(conflicts);
    db.close();
  });

  test("W10: the same number of claims with another key is refused", async () => {
    const db = database();
    const before = snapshot(db);
    const writes = adoptWrites(db, {
      eventId: "transfer-x",
      revision: 1,
      claims: [{ book: "cash-movement", observationId: 101 }],
      commitClaims: [{ book: "cash-movement", key: keyOf(db, 102) }],
    });
    await expect(run(db, writes)).rejects.toThrow("economic_commit_claims_mismatch");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("the sequence is dense and known_at never goes backwards", async () => {
    const db = database();
    await run(db, adoptWrites(db, { eventId: "transfer-x", revision: 1, now: LATER }));
    // A worker clock behind the log: the builder records the previous known_at.
    await run(db, adoptWrites(db, { eventId: "transfer-y", revision: 1, now: NOW }));
    expect(
      db.query("SELECT commit_seq,known_at FROM economic_commit_log ORDER BY 1").all(),
    ).toEqual([
      { commit_seq: 1, known_at: LATER },
      { commit_seq: 2, known_at: LATER },
    ]);
    const before = snapshot(db);
    const handWritten = (seq: number, knownAt: string): SqlWrite[] => {
      const writes = adoptWrites(db, { eventId: "transfer-z", revision: 1 });
      // Keep the seal (it names the next sequence); hand-write the commit row.
      writes[writes.length - 1] = {
        sql: `INSERT INTO economic_commit_log(core_epoch,commit_seq,decision_revision_id,operation_id,principal,payload_digest,kind,members_json,claims_json,released_json,known_at)
 VALUES('core-epoch-1',?,'dr-transfer-z-1',NULL,?,?,'synthetic.adopt','[{"eventId":"transfer-z","revision":1,"supersedes":[]}]','[]','[]',?)`,
        binds: [seq, PRINCIPAL, "d".repeat(64), knownAt],
      };
      return writes;
    };
    await expect(run(db, handWritten(4, LATER))).rejects.toThrow(
      "economic_commit_sequence_invalid",
    );
    await expect(run(db, handWritten(3, NOW))).rejects.toThrow(
      "economic_commit_known_at_regressed",
    );
    expect(snapshot(db)).toEqual(before);
    await run(db, handWritten(3, LATER));
    expect(db.query("SELECT count(*) AS n FROM economic_commit_log").get()).toEqual({ n: 3 });
    db.close();
  });

  test("known_at is one canonical UTC format, so text order is time order", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, { eventId: "transfer-x", revision: 1, now: "2026-10-08T10:00:00.000Z" }),
    );
    // "...T10:00:00Z" sorts after "...T10:00:00.500Z" as text: mixed formats
    // would misorder the log. The builder refuses another format outright ...
    for (const now of [
      "2026-10-08T10:00:00Z",
      "2026-10-08T19:00:00.000+09:00",
      "2026-02-30T00:00:00.000Z",
    ])
      expect(() => adoptWrites(db, { eventId: "transfer-y", revision: 1, now })).toThrow(
        "economic commit is not the contract",
      );
    // ... and the table refuses a hand-written one.
    const writes = adoptWrites(db, { eventId: "transfer-y", revision: 1, now: LATER });
    writes[writes.length - 1] = {
      sql: `INSERT INTO economic_commit_log(core_epoch,commit_seq,decision_revision_id,operation_id,principal,payload_digest,kind,members_json,claims_json,released_json,known_at)
 VALUES('core-epoch-1',2,'dr-transfer-y-1',NULL,?,?,'synthetic.adopt','[{"eventId":"transfer-y","revision":1,"supersedes":[]}]','[]','[]','2026-10-08T11:00:00Z')`,
      binds: [PRINCIPAL, "d".repeat(64)],
    };
    const before = snapshot(db);
    await expect(run(db, writes)).rejects.toThrow("CHECK constraint failed");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("a seal must state the stored children exactly", async () => {
    const db = database();
    const writes = adoptWrites(db, { eventId: "transfer-x", revision: 1 });
    const seal = writes.at(-2)!;
    // leg_count is the fourth value; claim it is 2.
    const binds = [...seal.binds];
    binds[3] = 2;
    writes[writes.length - 2] = { sql: seal.sql, binds };
    await expect(run(db, writes)).rejects.toThrow("economic_seal_invalid");
    db.close();
  });
});

describe("the entry", () => {
  test("a reviewed entry is the receipt for this payload and plan, nothing else", async () => {
    const db = database();
    const planId = "f".repeat(64);
    db.run(
      `INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
       VALUES(?,'card-settlement.accept','{}','context','{}','{}','owner',?,?,'committed')`,
      [planId, NOW, LATER],
    );
    db.run(
      `INSERT INTO operation_receipts(operation_id,principal,operation_kind,payload_digest,plan_id,status,result_json,created_at)
       VALUES('op-1','owner','card-settlement.accept',?,?,'accepted','{}',?)`,
      ["e".repeat(64), planId, NOW],
    );
    // The revision the claim belongs to (decision, revision, leg only).
    await run(db, adoptWrites(db, { eventId: "transfer-x", revision: 1 }).slice(0, 3));
    const [claim] = claimRecords(db, "transfer-x", 1, [
      { book: "cash-movement", observationId: 101 },
    ]);
    const entry = (payloadDigest: string, principal = "owner") =>
      receiptEntry({ operationId: "op-1", principal, payloadDigest, planId });
    // Another payload, or another principal, under the same operation id writes nothing.
    expect(await run(db, [economicClaimWrite(entry("0".repeat(64)), claim!)])).toEqual([0]);
    expect(await run(db, [economicClaimWrite(entry("e".repeat(64), "other"), claim!)])).toEqual([
      0,
    ]);
    expect(await run(db, [economicClaimWrite(entry("e".repeat(64)), claim!)])).toEqual([1]);
    // And once written, the same statement finds its own row.
    expect(await run(db, [economicClaimWrite(entry("e".repeat(64)), claim!)])).toEqual([0]);
    db.close();
  });

  test("a finalization whose members and seals disagree is a programming error", () => {
    const db = database();
    expect(() =>
      economicFinalizationWrites({
        entry: decisionEntry("dr-x"),
        claims: claimRecords(db, "transfer-y", 1, [{ book: "cash-movement", observationId: 101 }]),
        times: [],
        effects: [],
        seals: [],
        commit: {
          decisionRevisionId: "dr-x",
          operationId: null,
          principal: PRINCIPAL,
          payloadDigest: "d".repeat(64),
          kind: "synthetic.adopt",
          members: [{ eventId: "transfer-x", revision: 1, supersedes: [] }],
          claims: [],
          released: [],
          now: NOW,
        },
      }),
    ).toThrow("economic finalization does not match its commit");
    db.close();
  });
});

describe("G1b decision: a rule entry means the entry exists", () => {
  test("P9: replaying a pre-guard lane draft with the G1b tail logs that revision now", async () => {
    // decisionEntry is "this decision exists", not "this batch wrote it". A
    // draft recognised before G1b, replayed with the seal and commit row
    // appended, writes no decision but does write the seal and commit row.
    // ADR 0054 records the decision: from G1b on the lane's decision digest
    // includes the writer release, so a guard-era batch has its own entry;
    // where an old draft id is replayed anyway, its revision is logged with
    // an honest later known_at, never backdated.
    const db = database();
    const draft = await draftOf(factOf(1));
    await run(db, purchaseWrites(draft));
    const changes = await run(db, purchaseWithCommitWrites(draft));
    expect(changes.slice(0, -2).every((n) => n === 0)).toBe(true);
    expect(changes.slice(-2)).toEqual([1, 1]);
    expect(db.query("SELECT commit_seq,kind,known_at FROM economic_commit_log").all()).toEqual([
      { commit_seq: 1, kind: "card-purchase.recognize", known_at: NOW },
    ]);
    db.close();
  });
});

describe("W3: a sealed revision takes no more children", () => {
  test("no leg, claim, time or effect is added after the seal", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 101 }],
      }),
    );
    const before = snapshot(db);
    const attempts: [string, unknown[]][] = [
      [
        `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
         VALUES('transfer-x',1,1,'account:acct-bank','JPY','exact','10',0,NULL,'fee','cash-movement')`,
        [],
      ],
      [
        `INSERT INTO economic_claims(event_id,revision,book,consumption_key,alias_class,identity_epoch,observation_id,parse_run_id)
         VALUES('transfer-x',1,'cash-movement',?,NULL,?,102,10)`,
        [keyText(db, 102), EPOCH_1],
      ],
      [
        `INSERT INTO economic_event_times(event_id,revision,role,temporal_json)
         VALUES('transfer-x',1,'settlement','{"kind":"unknown","reasonCode":"synthetic"}')`,
        [],
      ],
      [
        `INSERT INTO economic_leg_effects(event_id,revision,leg_index,effect,of_leg_index) VALUES('transfer-x',1,0,'movement',NULL)`,
        [],
      ],
    ];
    for (const [sql, binds] of attempts)
      await expect(run(db, [{ sql, binds }])).rejects.toThrow("economic_revision_sealed");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("no card purchase key is added to a sealed purchase revision", async () => {
    const db = database();
    const draft = await draftOf(factOf(1));
    expect((await run(db, purchaseWithCommitWrites(draft))).every((changes) => changes > 0)).toBe(
      true,
    );
    const before = snapshot(db);
    // Observation 7 is a Vpass pending row the 0047 key guard itself admits.
    await expect(
      run(db, [
        {
          sql: `INSERT INTO card_purchase_recognition_keys(event_id,revision,recognition_key,role,observation_id,parse_run_id)
                VALUES(?,1,?,'pending',7,1)`,
          binds: [draft.revision.eventId, keyText(db, 7)],
        },
      ]),
    ).rejects.toThrow("economic_revision_sealed");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("a leg effect states 101 = 100 + 1 in one unit, never across units", async () => {
    const db = database();
    const writes = adoptWrites(db, { eventId: "transfer-x", revision: 1 });
    const legs: SqlWrite[] = [
      [1, "JPY", "100", "increase"],
      [2, "JPY", "1", "fee"],
      [3, "USD", "1", "fee"],
    ].map(([index, unit, coefficient, role]) => ({
      sql: `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
            VALUES('transfer-x',1,?,'account:acct-bank',?,'exact',?,0,NULL,?,'cash-movement')`,
      binds: [index, unit, coefficient, role],
    }));
    const effect = (leg: number, kind: string, of: number | null): SqlWrite => ({
      sql: "INSERT INTO economic_leg_effects(event_id,revision,leg_index,effect,of_leg_index) VALUES('transfer-x',1,?,?,?)",
      binds: [leg, kind, of],
    });
    // Run the revision and its legs, without the seal and commit.
    await run(db, [...writes.slice(0, 3), ...legs]);
    await run(db, [
      effect(0, "movement", null),
      effect(1, "movement", null),
      effect(2, "breakdown", 0),
    ]);
    await expect(run(db, [effect(3, "breakdown", 0)])).rejects.toThrow(
      "economic_leg_effect_invalid",
    );
    await expect(run(db, [effect(3, "breakdown", 2)])).rejects.toThrow(
      "economic_leg_effect_invalid",
    );
    await expect(
      run(db, [
        {
          sql: `INSERT INTO economic_event_times(event_id,revision,role,temporal_json) VALUES('transfer-nowhere',1,'trade','{}')`,
          binds: [],
        },
      ]),
    ).rejects.toThrow();
    db.close();
  });
});

describe("times and effects", () => {
  test("P6: a time or effect row needs a live revision", async () => {
    const db = database();
    proposeSettlement(db, "proposal-1", 101);
    await run(db, acceptSettlementWrites(db, "proposal-1", 101));
    // Withdraw it: revision 1 is superseded (and was never sealed).
    await run(
      db,
      adoptWrites(db, {
        eventId: "settlement-event-proposal-1",
        revision: 2,
        withdraw: true,
        released: [{ book: "cash-movement", key: keyOf(db, 101) }],
      }),
    );
    const before = snapshot(db);
    expect(() =>
      db.run(
        "INSERT INTO economic_event_times(event_id,revision,role,temporal_json) VALUES('settlement-event-proposal-1',1,'settlement','{}')",
      ),
    ).toThrow("economic_event_time_invalid");
    expect(() =>
      db.run(
        "INSERT INTO economic_leg_effects(event_id,revision,leg_index,effect,of_leg_index) VALUES('settlement-event-proposal-1',1,0,'movement',NULL)",
      ),
    ).toThrow("economic_leg_effect_invalid");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });
});

describe("one live holder across writers", () => {
  test("a settlement accepted on a debit, then an economic claim on it, is refused", async () => {
    const db = database();
    proposeSettlement(db, "proposal-1", 101);
    await run(db, acceptSettlementWrites(db, "proposal-1", 101));
    const before = snapshot(db);
    await expect(
      run(
        db,
        adoptWrites(db, {
          eventId: "transfer-x",
          revision: 1,
          claims: [{ book: "cash-movement", observationId: 101 }],
        }),
      ),
    ).rejects.toThrow("economic_claim_held");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("an economic claim on a debit, then a settlement accepting it, is refused", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 101 }],
      }),
    );
    proposeSettlement(db, "proposal-1", 101);
    const before = snapshot(db);
    await expect(run(db, acceptSettlementWrites(db, "proposal-1", 101))).rejects.toThrow(
      "economic_claim_held",
    );
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("a card purchase key held as an economic claim refuses the lane's recognition", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "usage-holder",
        revision: 1,
        claims: [{ book: "card-usage", observationId: 1 }],
      }),
    );
    const before = snapshot(db);
    await expect(run(db, purchaseWrites(await draftOf(factOf(1))))).rejects.toThrow(
      "economic_claim_held",
    );
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("T2c: the same 5-tuple claimed again (one execution seen twice) is refused", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 101 }],
      }),
    );
    const before = snapshot(db);
    await expect(
      run(
        db,
        adoptWrites(db, {
          eventId: "transfer-y",
          revision: 1,
          claims: [{ book: "cash-movement", observationId: 101 }],
        }),
      ),
    ).rejects.toThrow("economic_claim_held");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("a released key that keeps another live holder is never released silently", async () => {
    const db = database();
    // Two legacy settlements on one debit: an inconsistency from before 0070.
    proposeSettlement(db, "proposal-1", 101);
    proposeSettlement(db, "proposal-2", 101);
    await run(db, acceptSettlementWrites(db, "proposal-1", 101));
    await run(db, acceptSettlementWrites(db, "proposal-2", 101));
    const before = snapshot(db);
    const withdraw = adoptWrites(db, {
      eventId: "settlement-event-proposal-1",
      revision: 2,
      withdraw: true,
      released: [{ book: "cash-movement", key: keyOf(db, 101) }],
    });
    await expect(run(db, withdraw)).rejects.toThrow("economic_claim_conflict_unresolved");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });
});

describe("alias classes (the same fact under another key)", () => {
  const ALIAS = aliasOf("meisai-0001");

  test("T1: a settlement under producer A, then a claim under producer B, is an alias conflict", async () => {
    const db = database();
    expect(keyText(db, 101)).not.toBe(keyText(db, 111));
    proposeSettlement(db, "proposal-1", 101);
    await run(db, acceptSettlementWrites(db, "proposal-1", 101, ALIAS));
    const before = snapshot(db);
    await expect(
      run(
        db,
        adoptWrites(db, {
          eventId: "transfer-x",
          revision: 1,
          claims: [{ book: "cash-movement", observationId: 111, alias: ALIAS }],
        }),
      ),
    ).rejects.toThrow("alias_conflict");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("T1 reversed: a claim under producer B, then a settlement under producer A, is refused", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 111, alias: ALIAS }],
      }),
    );
    proposeSettlement(db, "proposal-1", 101);
    const before = snapshot(db);
    await expect(run(db, acceptSettlementWrites(db, "proposal-1", 101, ALIAS))).rejects.toThrow(
      "alias_conflict",
    );
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  test("limit: a settlement that records no alias class (today's writer) is not seen by alias", async () => {
    const db = database();
    proposeSettlement(db, "proposal-1", 101);
    await run(db, acceptSettlementWrites(db, "proposal-1", 101));
    // Until G1b, the producer-B row of the same debit is a different key.
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 111, alias: ALIAS }],
      }),
    );
    expect(
      db.query("SELECT dimension,holder_count FROM consumption_claim_conflicts").all(),
    ).toEqual([]);
    expect(liveHolders(db)).toHaveLength(2);
    db.close();
  });

  test("T4: a rekeyed row (new key, same alias class) is refused while the old key is held", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 101, alias: ALIAS }],
      }),
    );
    const holders = liveHolders(db);
    const before = snapshot(db);
    // Observation 104 stands for the same debit after a parser release renamed its id.
    await expect(
      run(
        db,
        adoptWrites(db, {
          eventId: "transfer-y",
          revision: 1,
          claims: [{ book: "cash-movement", observationId: 104, alias: ALIAS }],
        }),
      ),
    ).rejects.toThrow("alias_conflict");
    expect(snapshot(db)).toEqual(before);
    expect(liveHolders(db)).toEqual(holders);
    db.close();
  });

  test("an alias class must name the key's own source", async () => {
    const db = database();
    // The builder refuses it before SQL does; the trigger refuses a hand-written row.
    expect(() =>
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [
          {
            book: "cash-movement",
            observationId: 101,
            alias: { ...ALIAS, sourceId: "other-bank" },
          },
        ],
      }),
    ).toThrow("economic claim is not the contract");
    const rows = claimRows(
      claimRecords(db, "transfer-x", 1, [
        { book: "cash-movement", observationId: 101, alias: { ...ALIAS, sourceId: "other-bank" } },
      ]),
    );
    await expect(
      run(db, [...adoptWrites(db, { eventId: "transfer-x", revision: 1 }).slice(0, 3), ...rows]),
    ).rejects.toThrow("economic_claim_invalid");
    db.close();
  });
});

describe("identity epochs", () => {
  test("T9: after a declared rewrite, a commit sealed under the old epoch is refused; the claim stays held", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 101 }],
      }),
    );
    db.run(
      "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(2,'identity-epoch-2','synthetic-rewrite',?)",
      [LATER],
    );
    const holders = liveHolders(db);
    const before = snapshot(db);
    const correction = (kind?: string) =>
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 2,
        claims: [{ book: "cash-movement", observationId: 101 }],
        sealEpoch: EPOCH_1,
        ...(kind ? { kind } : {}),
        now: LATER,
      });
    await expect(run(db, correction())).rejects.toThrow("identity_epoch_changed");
    expect(snapshot(db)).toEqual(before);
    expect(liveHolders(db)).toEqual(holders);
    // The resolution kind is bound to a reviewed receipt of that kind: a rule
    // writer naming it is refused like any other commit.
    await expect(run(db, correction("economic-event.resolve-identity"))).rejects.toThrow(
      "identity_epoch_changed",
    );
    expect(snapshot(db)).toEqual(before);
    // And no receipt of that kind can exist until G2 adds it to the vocabulary.
    expect(() =>
      db.run(
        `INSERT INTO operation_receipts(operation_id,principal,operation_kind,payload_digest,plan_id,status,result_json,created_at)
         VALUES('op-1','owner','economic-event.resolve-identity',?,?,'accepted','{}',?)`,
        ["e".repeat(64), "f".repeat(64), NOW],
      ),
    ).toThrow("CHECK constraint failed");
    db.close();
  });

  test("P3: INSERT OR REPLACE cannot replace a declared epoch", () => {
    const db = database();
    const before = db.query("SELECT * FROM economic_identity_epochs").all();
    expect(() =>
      db.run(
        "INSERT OR REPLACE INTO economic_identity_epochs VALUES(2,'identity-epoch-1','synthetic-replace',?)",
        [LATER],
      ),
    ).toThrow("identity epochs are append-only");
    expect(db.query("SELECT * FROM economic_identity_epochs").all()).toEqual(before);
    db.close();
  });

  test("P11: the guard does not route old-epoch holders to review; that is the planner's job", async () => {
    // ADR 0054: a rule writer under retire-before-recognise keeps auto-revising
    // after a declared rewrite, and a reviewed correction is itself the
    // explicit review, so 0070 cannot tell which supersession of an old-epoch
    // holder needs review. The planner (G3) and the selector (#550) decide;
    // the trigger only requires the new seal to be under the current epoch.
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 101 }],
      }),
    );
    db.run(
      "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(2,'identity-epoch-2','synthetic-rewrite',?)",
      [LATER],
    );
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 2,
        now: LATER,
        sealEpoch: "identity-epoch-2",
        claims: [{ book: "cash-movement", observationId: 104, identityEpoch: "identity-epoch-2" }],
        released: [{ book: "cash-movement", key: keyOf(db, 101) }],
      }),
    );
    expect(
      db.query("SELECT s.identity_epoch FROM economic_revision_seals s ORDER BY s.revision").all(),
    ).toEqual([{ identity_epoch: EPOCH_1 }, { identity_epoch: "identity-epoch-2" }]);
    expect(liveHolders(db)).toEqual([
      {
        book: "cash-movement",
        consumption_key: keyText(db, 104),
        alias_class: null,
        event_id: "transfer-x",
        revision: 2,
      },
    ]);
    db.close();
  });

  test("a claim names a declared epoch, and the seal's epoch is its claims' epoch", async () => {
    const db = database();
    await expect(
      run(
        db,
        adoptWrites(db, {
          eventId: "transfer-x",
          revision: 1,
          claims: [
            { book: "cash-movement", observationId: 101, identityEpoch: "identity-epoch-9" },
          ],
        }),
      ),
    ).rejects.toThrow();
    db.run(
      "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(2,'identity-epoch-2','synthetic-rewrite',?)",
      [LATER],
    );
    await expect(
      run(
        db,
        adoptWrites(db, {
          eventId: "transfer-x",
          revision: 1,
          claims: [{ book: "cash-movement", observationId: 101, identityEpoch: EPOCH_1 }],
          sealEpoch: "identity-epoch-2",
        }),
      ),
    ).rejects.toThrow("economic_seal_invalid");
    expect(() =>
      db.run(
        "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(4,'identity-epoch-4','gap',?)",
        [LATER],
      ),
    ).toThrow("identity epochs are append-only");
    db.close();
  });
});

describe("append-only", () => {
  test("no row of a 0070 table is updated or deleted", async () => {
    const db = database();
    await run(
      db,
      adoptWrites(db, {
        eventId: "transfer-x",
        revision: 1,
        claims: [{ book: "cash-movement", observationId: 101 }],
      }),
    );
    // An unsealed revision with a time and an effect (decision, revision, leg only).
    await run(db, adoptWrites(db, { eventId: "transfer-y", revision: 1 }).slice(0, 3));
    db.run(
      `INSERT INTO economic_event_times(event_id,revision,role,temporal_json) VALUES('transfer-y',1,'trade','{}')`,
    );
    db.run(
      `INSERT INTO economic_leg_effects(event_id,revision,leg_index,effect,of_leg_index) VALUES('transfer-y',1,0,'movement',NULL)`,
    );
    const tables: [string, string][] = [
      ["economic_claims", "observation_id"],
      ["economic_event_times", "role"],
      ["economic_leg_effects", "effect"],
      ["economic_revision_seals", "leg_count"],
      ["economic_commit_log", "known_at"],
      ["economic_identity_epochs", "reason_code"],
    ];
    const before = snapshot(db);
    for (const [table, column] of tables) {
      expect(
        (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      ).toBeGreaterThan(0);
      expect(() => db.run(`UPDATE ${table} SET ${column}=${column}`)).toThrow("append-only");
      expect(() => db.run(`DELETE FROM ${table}`)).toThrow("append-only");
    }
    // Replacing a row is refused too.
    expect(() =>
      db.run(
        `INSERT INTO economic_event_times(event_id,revision,role,temporal_json) VALUES('transfer-y',1,'trade','{}')`,
      ),
    ).toThrow("economic event time replacement is forbidden");
    expect(snapshot(db)).toEqual(before);
    db.close();
  });
});
