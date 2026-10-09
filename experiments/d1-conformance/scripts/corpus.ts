// Synthetic fixture adapter for ADR 0054's remote gate. Reuses seedCardRows,
// factOf and the shipped card/economic builders; does not open any data file.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  cardPurchaseEventId,
  cardPurchaseRevision,
  classifyCardUsage,
  recognitionKey,
} from "../../../packages/domain/src/card-purchase.ts";
import {
  INITIAL_IDENTITY_EPOCH,
  type EconomicClaimRecord,
} from "../../../packages/domain/src/economic-contract.ts";
import {
  currentRevisionsSql,
  type SqlWrite,
} from "../../../packages/storage-d1/src/core/operations.ts";
import {
  economicFinalizationWrites,
  decisionEntry,
} from "../../../packages/storage-d1/src/atomic/economic-commit.ts";
import { cardPurchaseRecognitionWrites } from "../../../packages/storage-d1/src/atomic/card-purchase-recognition.ts";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { seedCardRows, factOf } from "../../../packages/storage-d1/test/card-purchase-fixture.ts";
import { fullCoreDatabase } from "../../../packages/storage-d1/test/sqlite.ts";
import type { Corpus, BatchCase } from "../src/contract.ts";

const NOW = "2026-10-09T00:00:00.000Z";
const db = fullCoreDatabase();
const baselineCounts = Object.fromEntries(
  (
    db
      .query(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map(({ name }) => [
    name,
    (db.query(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n,
  ]),
);
const seed: SqlWrite[] = [];
const recording = new Proxy(db, {
  get(target, key) {
    if (key === "run")
      return (sql: string, binds: (string | number | null)[]) => {
        seed.push({ sql, binds: [...binds] });
        return target.run(sql, binds);
      };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
seedCardRows(recording);
for (let index = 100; index < 120; index++) {
  const write = {
    sql: `INSERT INTO transaction_observations
      SELECT ?,parse_run_id,source_account,?,status,amount_minor,amount_text,amount_scale,
      currency,description,counterparty,as_of,observed_at,raw_locator,extra_json
      FROM transaction_observations WHERE id=1`,
    binds: [index, `synthetic-row-${index}`],
  };
  db.run(write.sql, write.binds);
  seed.push(write);
}

/** ADR 0054's synthetic entry/revision/leg shape, not an own-transfer planner. */
function adopt(eventId: string, observationId: number, alias: string | null = null): SqlWrite[] {
  const decision = `dr-${eventId}`;
  const entry = decisionEntry(decision);
  const fact = factOf(1, { observationId, externalId: `synthetic-row-${observationId}` });
  const keyText = recognitionKey(fact);
  if (!keyText) throw new Error("synthetic key missing");
  const claim: EconomicClaimRecord = {
    eventId,
    revision: 1,
    book: "card-usage",
    key: keyText,
    aliasClass:
      alias === null
        ? null
        : {
            sourceId: "vpass",
            components: [alias],
            accountId: "acct-card",
            ruleVersion: "synthetic-alias-v1",
          },
    identityEpoch: INITIAL_IDENTITY_EPOCH,
    observationId,
    parseRunId: 1,
  };
  return [
    {
      sql: `INSERT INTO decision_revisions
        (id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,
        reason,evidence_refs_json,previous_revision,superseded_by,created_at)
        SELECT ?,'relation',?,1,'accept','rule','rule:synthetic-writer-v1',NULL,
        'synthetic adoption','[]',NULL,NULL,? WHERE NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`,
      binds: [decision, `event:${eventId}`, NOW, decision],
    },
    {
      sql: `INSERT INTO economic_event_revisions
        (event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,
        decision_revision_id,superseded_by,created_at)
        SELECT ?,1,'transfer','debited',NULL,'{}','cash-movement',?,?,NULL,?
        WHERE ${entry.sql} AND NOT EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND revision=1)`,
      binds: [
        eventId,
        JSON.stringify(["transaction:" + observationId]),
        decision,
        NOW,
        ...entry.binds,
        eventId,
      ],
    },
    {
      sql: `INSERT INTO economic_legs
        (event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
        SELECT ?,1,0,'account:acct-card','JPY','exact','1000',0,NULL,'decrease','cash-movement'
        WHERE ${entry.sql} AND NOT EXISTS(SELECT 1 FROM economic_legs WHERE event_id=? AND revision=1 AND leg_index=0)`,
      binds: [eventId, ...entry.binds, eventId],
    },
    // Like the existing append-only test, SQL-level time/effect rows exercise
    // the database guard independently of the domain temporal validator.
    {
      sql: `INSERT INTO economic_event_times(event_id,revision,role,temporal_json)
        SELECT ?,1,'trade','{}' WHERE ${entry.sql}
        AND NOT EXISTS(SELECT 1 FROM economic_event_times WHERE event_id=? AND revision=1 AND role='trade')`,
      binds: [eventId, ...entry.binds, eventId],
    },
    {
      sql: `INSERT INTO economic_leg_effects(event_id,revision,leg_index,effect,of_leg_index)
        SELECT ?,1,0,'movement',NULL WHERE ${entry.sql}
        AND NOT EXISTS(SELECT 1 FROM economic_leg_effects WHERE event_id=? AND revision=1 AND leg_index=0)`,
      binds: [eventId, ...entry.binds, eventId],
    },
    ...economicFinalizationWrites({
      entry,
      claims: [claim],
      times: [],
      effects: [],
      seals: [
        {
          eventId,
          revision: 1,
          writerRelease: "synthetic-writer-v1",
          legCount: 1,
          claimCount: 1,
          timeCount: 1,
          effectCount: 1,
          contentDigest: "c".repeat(64),
          identityPins: {},
          identityEpoch: INITIAL_IDENTITY_EPOCH,
          now: NOW,
        },
      ],
      commit: {
        decisionRevisionId: decision,
        operationId: null,
        principal: "rule:synthetic-writer-v1",
        payloadDigest: "d".repeat(64),
        kind: "synthetic.adopt",
        members: [{ eventId, revision: 1, supersedes: [] }],
        claims: [{ book: claim.book, key: claim.key }],
        released: [],
        now: NOW,
      },
    }),
  ];
}
const cases: Corpus["cases"] = [];
const add = (
  name: string,
  writes: SqlWrite[],
  expect: BatchCase["expect"],
  codes?: string[],
  rowCount?: number,
) =>
  cases.push({
    name,
    writes,
    expect,
    ...(codes ? { codes } : {}),
    ...(rowCount !== undefined ? { rowCount } : {}),
  });
const epochGap: SqlWrite = {
  sql: "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(4,'identity-epoch-4','synthetic-gap',?)",
  binds: [NOW],
};
const faultWrites = adopt("synthetic-fault", 100);
for (const [index] of faultWrites.entries())
  add(
    `A1-fault-${index}`,
    faultWrites.map((write, at) => (at === index ? epochGap : write)),
    "reject",
    ["identity epochs are append-only"],
  );

add("A2-populate", adopt("synthetic-immutable", 101), "write");
for (const [table, column] of [
  ["economic_claims", "observation_id"],
  ["economic_event_times", "role"],
  ["economic_leg_effects", "effect"],
  ["economic_revision_seals", "leg_count"],
  ["economic_commit_log", "known_at"],
  ["economic_identity_epochs", "reason_code"],
]) {
  add(
    `A2-update-${table}`,
    [{ sql: `UPDATE ${table} SET ${column}=${column}`, binds: [] }],
    "reject",
    ["append-only"],
  );
  add(`A2-delete-${table}`, [{ sql: `DELETE FROM ${table}`, binds: [] }], "reject", [
    "append-only",
  ]);
}
add("A3-holder", adopt("synthetic-holder", 102, "synthetic-shared-alias"), "write");
add("A3-key", adopt("synthetic-held-key", 102), "reject", [
  "economic_claim_held",
  "alias_conflict",
]);
add("A3-alias", adopt("synthetic-held-alias", 103, "synthetic-shared-alias"), "reject", [
  "economic_claim_held",
  "alias_conflict",
]);
add(
  "A4-missing-seal",
  adopt("synthetic-unsealed", 104).filter(
    (write) => !write.sql.startsWith("INSERT INTO economic_revision_seals"),
  ),
  "reject",
  ["economic_commit_member_invalid"],
);
add("A5-epoch-gap", [epochGap], "reject", ["identity epochs are append-only"]);

// A6 uses the production card purchase builder and the existing card fixture.
const fact = factOf(7);
const classified = classifyCardUsage(fact);
const key = recognitionKey(fact);
if (!classified.ok || !key) throw new Error("card fixture not recognisable");
const draft = await cardPurchaseRevision({
  action: "recognize",
  eventId: await cardPurchaseEventId(classified.kind, key),
  revision: 1,
  fact,
});
if (!draft) throw new Error("card fixture draft missing");
const cardWrites = cardPurchaseRecognitionWrites({ draft, expectedRevision: null, now: NOW });
add("A6-card-purchase", cardWrites, "write");
add("A6-replay", cardWrites, "zero");

const newKinds = [
  "economic-event.adopt",
  "economic-event.correct",
  "economic-event.withdraw",
  "economic-event.move",
];
for (const [index, kind] of newKinds.entries()) {
  const plan = (500 + index).toString(16).padStart(64, "0");
  add(
    `A7-kind-${index}`,
    [
      {
        sql: "INSERT INTO change_plans VALUES(?,?,?,'synthetic-context','{}','{}','synthetic-owner-delegated','created','expires','planned')",
        binds: [plan, kind, "{}"],
      },
      {
        sql: "INSERT INTO operation_receipts VALUES(?,'synthetic-owner-delegated',?,?,?,'accepted','{}','created',NULL)",
        binds: [`synthetic-operation-${index}`, kind, plan, plan],
      },
    ],
    "write",
  );
}
for (const kind of ["economic-event.unknown", "economic-event.resolve-identity"]) {
  add(
    `A7-unknown-plan-${kind}`,
    [
      {
        sql: "INSERT INTO change_plans VALUES(?,?,?,'synthetic-context','{}','{}','synthetic-owner-delegated','created','expires','planned')",
        binds: ["f".repeat(64), kind, "{}"],
      },
    ],
    "reject",
    ["CHECK"],
  );
  add(
    `A7-unknown-receipt-${kind}`,
    [
      {
        sql: "INSERT INTO operation_receipts VALUES(?,'synthetic-owner-delegated',?,?,?,'accepted','{}','created',NULL)",
        binds: [
          "synthetic-unknown-operation",
          kind,
          (500).toString(16).padStart(64, "0"),
          "f".repeat(64),
        ],
      },
    ],
    "reject",
    ["CHECK"],
  );
}
add(
  "A7-status-only-allowed",
  [
    {
      sql: "UPDATE change_plans SET status='approved' WHERE plan_id=?",
      binds: [(500).toString(16).padStart(64, "0")],
    },
  ],
  "write",
);
add(
  "A7-status-with-kind-refused",
  [
    {
      sql: "UPDATE change_plans SET status='committed',kind='economic-event.move' WHERE plan_id=?",
      binds: [(500).toString(16).padStart(64, "0")],
    },
  ],
  "reject",
  ["change plan is immutable except its status"],
);
add(
  "A7-receipt-mutation-refused",
  [
    {
      sql: "UPDATE operation_receipts SET operation_kind='economic-event.move' WHERE operation_id='synthetic-operation-0'",
      binds: [],
    },
  ],
  "reject",
  ["operation receipt is immutable except its publication state"],
);
add(
  "A7-receipt-publication-allowed",
  [
    {
      sql: "UPDATE operation_receipts SET status='published',published_at='synthetic-published' WHERE operation_id='synthetic-operation-0'",
      binds: [],
    },
  ],
  "write",
);
add(
  "A8-1000-ids-one-bind",
  [
    {
      sql: currentRevisionsSql("?"),
      binds: [
        JSON.stringify(
          Object.fromEntries(
            Array.from({ length: 1000 }, (_, index) => [
              `economic-event:synthetic-query-${index}`,
              0,
            ]),
          ),
        ),
      ],
    },
  ],
  "read",
  undefined,
  1000,
);
const verifyHolder = (ids: string[]): SqlWrite => ({
  sql: `SELECT
    (SELECT count(*) FROM live_consumption_claims WHERE event_id IN (SELECT value FROM json_each(?1))) AS holders,
    (SELECT count(*) FROM economic_event_revisions WHERE event_id IN (SELECT value FROM json_each(?1))) AS revisions,
    (SELECT count(*) FROM decision_revisions WHERE subject_ref IN (SELECT 'event:'||value FROM json_each(?1))) AS decisions,
    (SELECT count(*) FROM economic_revision_seals WHERE event_id IN (SELECT value FROM json_each(?1))) AS seals,
    (SELECT count(*) FROM economic_commit_log WHERE decision_revision_id IN (SELECT 'dr-'||value FROM json_each(?1))) AS commits,
    (SELECT count(*) FROM economic_claims WHERE event_id IN (SELECT value FROM json_each(?1))) AS claims,
    (SELECT count(*) FROM economic_event_times WHERE event_id IN (SELECT value FROM json_each(?1))) AS times,
    (SELECT count(*) FROM economic_leg_effects WHERE event_id IN (SELECT value FROM json_each(?1))) AS effects,
    (SELECT count(*) FROM economic_legs WHERE event_id IN (SELECT value FROM json_each(?1))) AS legs`,
  binds: [JSON.stringify(ids)],
});
cases.push({
  name: "race-two-holders",
  race: [adopt("synthetic-race-a", 105), adopt("synthetic-race-b", 105)],
  expect: "exclusive",
  codes: ["economic_claim_held", "alias_conflict"],
  verify: verifyHolder(["synthetic-race-a", "synthetic-race-b"]),
});
const same = adopt("synthetic-race-idempotent", 106);
cases.push({
  name: "race-idempotent",
  race: [same, same],
  expect: "idempotent",
  verify: verifyHolder(["synthetic-race-idempotent"]),
});

const acceptance = cases.find((item) => item.name === "A6-card-purchase");
if (!acceptance || "race" in acceptance) throw new Error("card case missing");
acceptance.verify = {
  write: {
    sql: `SELECT
      (SELECT count(*) FROM economic_event_revisions WHERE event_id=?1 AND revision=1 AND superseded_by IS NULL) AS revisions,
      (SELECT count(*) FROM economic_revision_seals WHERE event_id=?1 AND revision=1 AND content_digest=?3) AS seals,
      (SELECT count(*) FROM economic_commit_log WHERE decision_revision_id=?2 AND kind='card-purchase.recognize') AS commits,
      (SELECT count(*) FROM live_consumption_claims WHERE event_id=?1 AND revision=1) AS claims,
      (SELECT count(*) FROM card_purchase_recognitions WHERE event_id=?1 AND revision=1) AS sidecars,
      (SELECT count(*) FROM economic_legs WHERE event_id=?1 AND revision=1) AS legs`,
    binds: [draft.revision.eventId, draft.decisionRevisionId, draft.contentDigest],
  },
  row: { revisions: 1, seals: 1, commits: 1, claims: 1, sidecars: 1, legs: 1 },
};
add(
  "A5-epoch-advance",
  [
    {
      sql: "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(2,'identity-epoch-2','synthetic-rewrite',?)",
      binds: [NOW],
    },
  ],
  "write",
);
add("A5-stale-epoch-whole-rollback", adopt("synthetic-stale-epoch", 108), "reject", [
  "identity_epoch_changed",
]);

const migrations = migrationFiles(CORE_MIGRATIONS_URL);
const corpus: Corpus = {
  version: "synthetic-d1-conformance-v1",
  baseCommit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  migrationDigest: createHash("sha256")
    .update(
      migrations.map((name) => name + "\n" + migrationSql(CORE_MIGRATIONS_URL, name)).join("\n"),
    )
    .digest("hex"),
  lastMigration: migrations.at(-1)!,
  baselineCounts,
  seed,
  cases,
};
const digest = createHash("sha256").update(JSON.stringify(corpus)).digest("hex");
writeFileSync(
  new URL("../src/corpus.generated.ts", import.meta.url),
  'import type { Corpus } from "./contract.ts";\nexport const corpusDigest = ' +
    JSON.stringify(digest) +
    ";\nexport default " +
    JSON.stringify(corpus, null, 2) +
    " satisfies Corpus;\n",
);
db.close();
console.log(
  JSON.stringify({
    cases: cases.length,
    seedStatements: seed.length,
    corpusDigest: digest,
    lastMigration: corpus.lastMigration,
  }),
);
