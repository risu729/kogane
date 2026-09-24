// CORE 0047: the card purchase recognition sidecar, its keys, the one-live-
// holder guard and the scan cursor, on the full CORE schema with foreign keys
// enforced. Rows are synthetic (card-purchase-fixture.ts).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  MIGRATION_0047,
  applyMigration,
  cardCoreDatabase,
  seedCardRows,
} from "./card-purchase-fixture.ts";

const TIME = JSON.stringify({
  kind: "local-date",
  value: "2026-08-15",
  zone: "Asia/Tokyo",
  basis: "provider",
});
const FACT_VALUES = {
  providerStatus: "posted",
  amount: {
    unitRef: "JPY",
    value: {
      status: "exact",
      value: { coefficient: "-1234", scale: 0 },
      normalizationVersion: "decimal-v1",
    },
  },
  usageDate: "2026-08-15",
  paymentType: "single-payment",
  amountCheck: "provider-amount",
  providerSaleCode: null as string | null,
};
const FACTS = JSON.stringify(FACT_VALUES);
/** FACTS with the displayed row's signed amount replaced. */
const factsWith = (coefficient: string, unitRef = "JPY") =>
  JSON.stringify({
    ...FACT_VALUES,
    amount: {
      ...FACT_VALUES.amount,
      unitRef,
      value: { ...FACT_VALUES.amount.value, value: { coefficient, scale: 0 } },
    },
  });
const DIGEST = "d".repeat(64);
const NEW_OBJECTS = [
  "card_purchase_recognition_keys",
  "card_purchase_recognition_keys_guard",
  "card_purchase_recognition_keys_key",
  "card_purchase_recognition_keys_no_delete",
  "card_purchase_recognition_keys_no_replace",
  "card_purchase_recognition_keys_no_update",
  "card_purchase_recognition_keys_observation",
  "card_purchase_recognition_keys_one_live_holder",
  "card_purchase_recognition_legs_sealed",
  "card_purchase_recognitions",
  "card_purchase_recognitions_account",
  "card_purchase_recognitions_facts",
  "card_purchase_recognitions_guard",
  "card_purchase_recognitions_no_delete",
  "card_purchase_recognitions_no_replace",
  "card_purchase_recognitions_no_update",
  "card_purchase_scan_cursor",
  "current_card_purchase_keys",
  "current_card_purchase_recognitions",
  "sqlite_autoindex_card_purchase_recognition_keys_1",
  "sqlite_autoindex_card_purchase_recognitions_1",
];

function revisionRow(
  db: Database,
  eventId: string,
  revision: number,
  kind = "purchase",
  state = "captured",
  basis = "purchase-recognition",
): void {
  const decision = `dr-${eventId}-${revision}`;
  db.run(
    `INSERT INTO decision_revisions VALUES(?,'relation',?,?,'accept','rule','rule:synthetic',NULL,
     'synthetic','[]',NULL,NULL,'created')`,
    [decision, `event:${eventId}`, revision],
  );
  db.run(
    `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,
      evidence_support_json,decision_revision_id,superseded_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,NULL,'created')`,
    [
      eventId,
      revision,
      kind,
      state,
      state === "unknown" ? "provider_status_absent" : null,
      TIME,
      basis,
      JSON.stringify([{ kind: "transaction", id: "transaction:1", revision: "parse_run:1" }]),
      decision,
    ],
  );
}

function legRow(
  db: Database,
  eventId: string,
  revision: number,
  options: {
    index?: number;
    subject?: string;
    coefficient?: string;
    role?: string;
    basis?: string;
  } = {},
): void {
  db.run(
    `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,
      value_reason_code,role,basis) VALUES(?,?,?,?,'JPY','exact',?,0,NULL,?,?)`,
    [
      eventId,
      revision,
      options.index ?? 0,
      options.subject ?? "account:acct-card",
      options.coefficient ?? "1234",
      options.role ?? "decrease",
      options.basis ?? "purchase-recognition",
    ],
  );
}

function sidecarRow(
  db: Database,
  eventId: string,
  revision: number,
  options: { action?: string; account?: string; source?: string; facts?: string } = {},
): void {
  db.run(
    `INSERT INTO card_purchase_recognitions(event_id,revision,policy_release,action,content_digest,account_id,
      source_id,statement_period,facts_json,created_at)
     VALUES(?,?,'card-purchase-recognition-v1',?,?,?,?,'2026-09',?,'created')`,
    [
      eventId,
      revision,
      options.action ?? "recognize",
      DIGEST,
      options.account ?? "acct-card",
      options.source ?? "vpass",
      options.facts ?? FACTS,
    ],
  );
}

/** The key the 0047 guard re-derives from the observation's own columns. */
function keyOf(db: Database, observationId: number): string {
  const row = db
    .query(
      `SELECT json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS k
       FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id
       JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN fetch_runs fr ON fr.id=a.fetch_run_id
       JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id WHERE t.id=?`,
    )
    .get(observationId) as { k: string };
  return row.k;
}

function keyRow(
  db: Database,
  eventId: string,
  revision: number,
  observationId: number,
  options: { parseRunId?: number; role?: string; key?: string } = {},
): void {
  const parseRunId =
    options.parseRunId ??
    (
      db
        .query("SELECT parse_run_id FROM transaction_observations WHERE id=?")
        .get(observationId) as {
        parse_run_id: number;
      }
    ).parse_run_id;
  db.run(
    `INSERT INTO card_purchase_recognition_keys(event_id,revision,recognition_key,role,observation_id,parse_run_id)
     VALUES(?,?,?,?,?,?)`,
    [
      eventId,
      revision,
      options.key ?? keyOf(db, observationId),
      options.role ?? "posted",
      observationId,
      parseRunId,
    ],
  );
}

/** A complete live recognition of one observation. */
function recognition(db: Database, eventId: string, observationId: number, revision = 1): void {
  revisionRow(db, eventId, revision);
  legRow(db, eventId, revision);
  sidecarRow(db, eventId, revision);
  keyRow(db, eventId, revision, observationId);
}

function fixture(): Database {
  const db = cardCoreDatabase();
  seedCardRows(db);
  return db;
}

function snapshot(db: Database) {
  const tables = (
    db
      .query(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  return {
    schema: db
      .query(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'card_purchase%' AND name NOT LIKE 'current_card_purchase%' AND name NOT LIKE 'sqlite_autoindex_card_purchase%' ORDER BY name",
      )
      .all(),
    rows: Object.fromEntries(
      tables.map((table) => [
        table,
        (db.query(`SELECT * FROM "${table}"`).all() as unknown[])
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    ),
  };
}

test("0047 is additive: pre-existing schema objects and rows unchanged", () => {
  const db = cardCoreDatabase({ before0047: true });
  try {
    seedCardRows(db);
    // Existing Layer C history: a settlement-shaped event with its cash leg.
    revisionRow(db, "ev:settlement-1", 1, "card_settlement", "debited", "cash-movement");
    legRow(db, "ev:settlement-1", 1, {
      subject: "acct-bank",
      coefficient: "10000",
      basis: "cash-movement",
    });
    const before = snapshot(db);
    applyMigration(db, MIGRATION_0047, () => {
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    const after = snapshot(db);
    expect(after.schema).toEqual(before.schema);
    const rows = after.rows as Record<string, string[]>;
    expect(
      Object.fromEntries(Object.keys(before.rows).map((table) => [table, rows[table]])),
    ).toEqual(before.rows);
    expect(Object.keys(rows).filter((table) => !(table in before.rows))).toEqual([
      "card_purchase_recognition_keys",
      "card_purchase_recognitions",
      "card_purchase_scan_cursor",
    ]);
    expect(rows["card_purchase_recognitions"]).toEqual([]);
    expect(rows["card_purchase_recognition_keys"]).toEqual([]);
    expect(rows["card_purchase_scan_cursor"]).toEqual([
      JSON.stringify({ singleton: 1, last_observation_id: 0 }),
    ]);
    expect(
      (
        db
          .query("SELECT name FROM sqlite_schema WHERE name LIKE '%card_purchase%' ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name),
    ).toEqual(NEW_OBJECTS);
    // Every new table is STRICT.
    for (const table of [
      "card_purchase_recognitions",
      "card_purchase_recognition_keys",
      "card_purchase_scan_cursor",
    ])
      expect(db.query("SELECT strict FROM pragma_table_list WHERE name=?").get(table)).toEqual({
        strict: 1,
      });
    expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    // The settlement event is untouched and still accepts no sidecar.
    expect(() => sidecarRow(db, "ev:settlement-1", 1)).toThrow("card_purchase_recognition_invalid");
    // The one new trigger on economic_legs never fires without a sidecar: a
    // settlement written after 0047 keeps its cash leg and its unresolved
    // obligation-change leg (the card-settlement-commands.ts shape).
    revisionRow(db, "ev:settlement-2", 1, "card_settlement", "debited", "cash-movement");
    legRow(db, "ev:settlement-2", 1, {
      subject: "acct-bank",
      coefficient: "10000",
      basis: "cash-movement",
    });
    db.run(
      `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,
        value_reason_code,role,basis) VALUES('ev:settlement-2',1,1,'acct-card','JPY','missing',NULL,NULL,
        'statement_principal_and_fees_unknown','unresolved','obligation-change')`,
    );
    legRow(db, "ev:settlement-1", 1, {
      index: 1,
      subject: "acct-card",
      basis: "obligation-change",
    });
    expect(
      db
        .query("SELECT count(*) AS n FROM economic_legs WHERE event_id LIKE 'ev:settlement-%'")
        .get(),
    ).toEqual({ n: 4 });
  } finally {
    db.close();
  }
}, 30_000);

test("sidecar needs a purchase/refund revision and a matching observation", () => {
  const db = fixture();
  try {
    // No event revision at all.
    expect(() => sidecarRow(db, "purchase_missing", 1)).toThrow();
    // Another kind, another basis, or a state that does not match the action.
    revisionRow(db, "fee_1", 1, "fee", "confirmed");
    legRow(db, "fee_1", 1);
    expect(() => sidecarRow(db, "fee_1", 1)).toThrow("card_purchase_recognition_invalid");
    revisionRow(db, "purchase_cash", 1, "purchase", "captured", "cash-movement");
    legRow(db, "purchase_cash", 1);
    expect(() => sidecarRow(db, "purchase_cash", 1)).toThrow("card_purchase_recognition_invalid");
    revisionRow(db, "purchase_a", 1);
    expect(() => sidecarRow(db, "purchase_a", 1)).toThrow("card_purchase_recognition_invalid");
    legRow(db, "purchase_a", 1);
    expect(() => sidecarRow(db, "purchase_a", 1, { action: "retire" })).toThrow(
      "card_purchase_recognition_invalid",
    );
    // The leg must be on the sidecar's account, and facts carry no provider text.
    expect(() => sidecarRow(db, "purchase_a", 1, { account: "acct-card-2" })).toThrow(
      "card_purchase_recognition_invalid",
    );
    expect(() =>
      sidecarRow(db, "purchase_a", 1, {
        facts: JSON.stringify({ ...JSON.parse(FACTS), merchant: "synthetic merchant" }),
      }),
    ).toThrow("card_purchase_recognition_invalid");
    expect(() => sidecarRow(db, "purchase_a", 1, { account: "acct-unknown" })).toThrow();
    expect(() => sidecarRow(db, "purchase_a", 1, { source: "smbc-bank" })).toThrow();
    sidecarRow(db, "purchase_a", 1);
    // Once the sidecar exists no leg can be added: exactly one leg stays exactly one.
    expect(() => legRow(db, "purchase_a", 1, { index: 1, basis: "cash-movement" })).toThrow(
      "card_purchase_legs_sealed",
    );
    // A second leg, a cash-movement leg or a negative leg is refused before the sidecar.
    revisionRow(db, "purchase_b", 1);
    legRow(db, "purchase_b", 1);
    legRow(db, "purchase_b", 1, { index: 1 });
    expect(() => sidecarRow(db, "purchase_b", 1)).toThrow("card_purchase_recognition_invalid");
    revisionRow(db, "purchase_c", 1);
    legRow(db, "purchase_c", 1, { basis: "cash-movement" });
    expect(() => sidecarRow(db, "purchase_c", 1)).toThrow("card_purchase_recognition_invalid");
    revisionRow(db, "refund_d", 1, "refund");
    legRow(db, "refund_d", 1, { role: "decrease" });
    expect(() => sidecarRow(db, "refund_d", 1)).toThrow("card_purchase_recognition_invalid");
    // A retirement is the unknown state with no leg.
    revisionRow(db, "purchase_e", 1, "purchase", "unknown");
    expect(() => sidecarRow(db, "purchase_e", 1)).toThrow("card_purchase_recognition_invalid");
    sidecarRow(db, "purchase_e", 1, { action: "retire" });

    // Keys: the observation matches its parse run, the key is the row's own
    // json_array, the role matches its status, and the source matches.
    expect(() => keyRow(db, "purchase_a", 1, 1, { parseRunId: 2 })).toThrow(
      "card_purchase_key_invalid",
    );
    expect(() =>
      keyRow(db, "purchase_a", 1, 1, { key: keyOf(db, 1).replace("row-a", "row-z") }),
    ).toThrow("card_purchase_key_invalid");
    expect(() => keyRow(db, "purchase_a", 1, 1, { role: "pending" })).toThrow(
      "card_purchase_key_invalid",
    );
    expect(() => keyRow(db, "purchase_a", 1, 5)).toThrow("card_purchase_key_invalid");
    expect(() => keyRow(db, "purchase_missing", 1, 1)).toThrow();
    keyRow(db, "purchase_a", 1, 1);
    keyRow(db, "purchase_e", 1, 2, { role: "pending" });
    expect(
      db.query("SELECT event_id,role FROM current_card_purchase_keys ORDER BY event_id").all(),
    ).toEqual([
      { event_id: "purchase_a", role: "posted" },
      { event_id: "purchase_e", role: "pending" },
    ]);
  } finally {
    db.close();
  }
}, 30_000);

test("append-only", () => {
  const db = fixture();
  try {
    recognition(db, "purchase_a", 1);
    for (const table of ["card_purchase_recognitions", "card_purchase_recognition_keys"]) {
      expect(() => db.run(`DELETE FROM ${table}`)).toThrow("append-only");
      expect(() => db.run(`UPDATE ${table} SET revision=revision`)).toThrow("append-only");
      expect(() => db.run(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(
        "replacement is forbidden",
      );
    }
    expect(() =>
      db.run("UPDATE card_purchase_recognitions SET facts_json='{}' WHERE event_id='purchase_a'"),
    ).toThrow("append-only");
    // The event revision itself only ever gains its one-shot pointer (0032).
    expect(() =>
      db.run("UPDATE economic_event_revisions SET state='authorized' WHERE event_id='purchase_a'"),
    ).toThrow("event_supersession_invalid");
    expect(db.query("SELECT count(*) AS n FROM card_purchase_recognition_keys").get()).toEqual({
      n: 1,
    });
  } finally {
    db.close();
  }
}, 30_000);

test("a key has at most one live holder; superseding frees it", () => {
  const db = fixture();
  try {
    recognition(db, "purchase_a", 1);
    // Observation 3 is the same provider row re-fetched: the same key.
    expect(keyOf(db, 3)).toBe(keyOf(db, 1));
    revisionRow(db, "purchase_b", 1);
    legRow(db, "purchase_b", 1);
    sidecarRow(db, "purchase_b", 1);
    expect(() => keyRow(db, "purchase_b", 1, 3)).toThrow("card_purchase_key_held");
    expect(() => keyRow(db, "purchase_b", 1, 1)).toThrow("card_purchase_key_held");
    // The holder itself may carry the key into its next revision.
    revisionRow(db, "purchase_a", 2);
    legRow(db, "purchase_a", 2, { coefficient: "1300" });
    // While revision 1 is still live, revision 2 cannot take a sidecar: the
    // event would have two live revisions and count twice.
    expect(() =>
      sidecarRow(db, "purchase_a", 2, { action: "revise", facts: factsWith("-1300") }),
    ).toThrow("card_purchase_recognition_invalid");
    db.run(
      "UPDATE economic_event_revisions SET superseded_by='purchase_a@2' WHERE event_id='purchase_a' AND revision=1",
    );
    sidecarRow(db, "purchase_a", 2, { action: "revise", facts: factsWith("-1300") });
    keyRow(db, "purchase_a", 2, 3);
    expect(() => keyRow(db, "purchase_b", 1, 3)).toThrow("card_purchase_key_held");
    // A superseded revision holds nothing: a reviewed cross-id supersession
    // (the PR4 merge shape) releases the key to the surviving event.
    db.run(
      "UPDATE economic_event_revisions SET superseded_by='purchase_b@1' WHERE event_id='purchase_a' AND revision=2",
    );
    keyRow(db, "purchase_b", 1, 3);
    expect(db.query("SELECT event_id,revision FROM current_card_purchase_keys").all()).toEqual([
      { event_id: "purchase_b", revision: 1 },
    ]);
    // The superseded rows stay readable.
    expect(
      db
        .query(
          "SELECT event_id,revision FROM card_purchase_recognition_keys ORDER BY event_id,revision",
        )
        .all(),
    ).toEqual([
      { event_id: "purchase_a", revision: 1 },
      { event_id: "purchase_a", revision: 2 },
      { event_id: "purchase_b", revision: 1 },
    ]);
    // A key cannot be attached to a superseded revision either.
    expect(() => keyRow(db, "purchase_a", 2, 2, { role: "pending" })).toThrow(
      "card_purchase_key_invalid",
    );
    expect(
      db
        .query(
          "SELECT event_id,revision,action,state FROM current_card_purchase_recognitions ORDER BY event_id",
        )
        .all(),
    ).toEqual([{ event_id: "purchase_b", revision: 1, action: "recognize", state: "captured" }]);
  } finally {
    db.close();
  }
}, 30_000);

test("a second live revision of the holder cannot hold the key either", () => {
  const db = fixture();
  try {
    recognition(db, "purchase_a", 1);
    // Defence in depth behind the sidecar guard: even with that guard gone, a
    // second live revision of the same event is refused the key it would
    // double count.
    db.run("DROP TRIGGER card_purchase_recognitions_guard");
    revisionRow(db, "purchase_a", 2);
    legRow(db, "purchase_a", 2);
    sidecarRow(db, "purchase_a", 2, { action: "revise" });
    expect(() => keyRow(db, "purchase_a", 2, 3)).toThrow("card_purchase_key_held");
    expect(() => keyRow(db, "purchase_a", 2, 1)).toThrow("card_purchase_key_held");
  } finally {
    db.close();
  }
}, 30_000);

test("facts_json admits codes, amounts and dates only", () => {
  const db = fixture();
  try {
    revisionRow(db, "purchase_a", 1);
    legRow(db, "purchase_a", 1);
    const refused = (facts: string, source?: string) =>
      expect(() =>
        sidecarRow(db, "purchase_a", 1, { facts, ...(source ? { source } : {}) }),
      ).toThrow("card_purchase_recognition_invalid");
    const edit = (patch: Record<string, unknown>) => JSON.stringify({ ...FACT_VALUES, ...patch });
    const amount = (value: Record<string, unknown>, outer: Record<string, unknown> = {}) =>
      edit({
        amount: {
          ...FACT_VALUES.amount,
          ...outer,
          value: { ...FACT_VALUES.amount.value, ...value },
        },
      });
    // Provider or merchant text under an allowed key, in any position.
    refused(edit({ paymentType: "1回払い" }));
    refused(edit({ providerStatus: "synthetic merchant" }));
    refused(edit({ amountCheck: "synthetic merchant" }));
    refused(edit({ usageDate: "synthetic merchant" }));
    refused(edit({ providerSaleCode: "synthetic merchant" }));
    refused(amount({}, { unitRef: "synthetic merchant" }));
    refused(amount({ normalizationVersion: "decimal v1 synthetic merchant" }));
    refused(amount({}, { merchant: "synthetic merchant" }));
    refused(amount({ value: { coefficient: "-1234", scale: 0, merchant: "synthetic merchant" } }));
    // Every key exactly once: missing, extra and duplicated keys.
    const { providerSaleCode: _dropped, ...missing } = FACT_VALUES;
    refused(JSON.stringify(missing));
    refused(edit({ merchant: "synthetic merchant" }));
    refused(
      FACTS.replace(
        '"paymentType":"single-payment"',
        '"paymentType":"single-payment","paymentType":"1回払い"',
      ),
    );
    // Closed code sets, per source.
    refused(edit({ providerStatus: "confirmed" }));
    refused(edit({ providerStatus: "posted", amountCheck: "usage-equals-payment" }));
    refused(edit({ providerStatus: "posted" }), "myjcb");
    refused(edit({ providerSaleCode: "7" }));
    refused(edit({ providerSaleCode: 5 }));
    refused(edit({ providerSaleCode: "6" }));
    // A calendar date, and an exact non-zero decimal.
    refused(edit({ usageDate: "2026-02-30" }));
    refused(edit({ usageDate: "2026/08/15" }));
    refused(amount({ status: "missing" }));
    for (const value of [
      { coefficient: "0", scale: 0 },
      { coefficient: "-12a4", scale: 0 },
      { coefficient: "-1.5", scale: 0 },
      { coefficient: "--1234", scale: 0 },
      { coefficient: -1234, scale: 0 },
      { coefficient: "-1234", scale: -1 },
      { coefficient: "-1234", scale: "0" },
    ])
      refused(amount({ value }));
    // The stored amount is the leg: same unit, magnitude and scale, sign by kind.
    refused(factsWith("-1300"));
    refused(factsWith("1234"));
    refused(factsWith("-1234", "USD"));
    // The state is the row's: a captured revision cannot rest on an unconfirmed row.
    refused(edit({ providerStatus: "unconfirmed" }));
    expect(db.query("SELECT count(*) AS n FROM card_purchase_recognitions").get()).toEqual({
      n: 0,
    });
    sidecarRow(db, "purchase_a", 1);
    // A pending refund (Vpass customized return, sale code 6) is the mirror image.
    revisionRow(db, "refund_b", 1, "refund", "authorized");
    legRow(db, "refund_b", 1, { coefficient: "400", role: "increase" });
    sidecarRow(db, "refund_b", 1, {
      facts: JSON.stringify({
        ...JSON.parse(factsWith("400")),
        providerStatus: "unconfirmed",
        providerSaleCode: "6",
      }),
    });
    expect(
      db.query("SELECT event_id FROM current_card_purchase_recognitions ORDER BY event_id").all(),
    ).toEqual([{ event_id: "purchase_a" }, { event_id: "refund_b" }]);
  } finally {
    db.close();
  }
}, 30_000);

test("cursor singleton", () => {
  const db = fixture();
  try {
    expect(db.query("SELECT * FROM card_purchase_scan_cursor").all()).toEqual([
      { singleton: 1, last_observation_id: 0 },
    ]);
    expect(() => db.run("INSERT INTO card_purchase_scan_cursor VALUES(2,0)")).toThrow();
    expect(() => db.run("INSERT INTO card_purchase_scan_cursor VALUES(1,5)")).toThrow();
    expect(() => db.run("UPDATE card_purchase_scan_cursor SET last_observation_id=-1")).toThrow();
    // Operational progress: it moves without moving the CORE revision.
    const revision = () =>
      db.query("SELECT source_revision FROM core_source_revision WHERE id=1").get();
    const before = revision();
    db.run("UPDATE card_purchase_scan_cursor SET last_observation_id=42 WHERE singleton=1");
    expect(revision()).toEqual(before);
    expect(db.query("SELECT * FROM card_purchase_scan_cursor").all()).toEqual([
      { singleton: 1, last_observation_id: 42 },
    ]);
  } finally {
    db.close();
  }
}, 30_000);
