// Synthetic Vpass and MyJCB usage rows on the full CORE schema, for the 0047
// migration and the card purchase write tests. Every name, id and amount is
// invented; no provider row, account or merchant is real.
import { Database } from "bun:sqlite";
import type { CardUsageFact } from "../../domain/src/card-purchase.ts";
import { exactQuantity, integerDecimal } from "../../domain/src/values.ts";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../src/migrations.ts";

export const MIGRATION_0047 = "0047_card_purchase_recognition.sql";
const VPASS_NAMESPACE = "vpass-worker-card-v1";
const MYJCB_NAMESPACE = "myjcb-connection-v1";
const PRODUCER = "card-producer";

/** Apply one CORE migration statement by statement, as wrangler does, inside one transaction. */
export function applyMigration(
  db: Database,
  file: string,
  afterStatement?: (sql: string) => void,
): void {
  db.transaction(() => {
    for (const sql of splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file))) {
      db.run(sql);
      afterStatement?.(sql);
    }
  })();
}

/** CORE from 0001 with foreign keys enforced, optionally stopping before 0047. */
export function cardCoreDatabase(options: { before0047?: boolean } = {}): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL).filter(
    (name) => !options.before0047 || name < MIGRATION_0047,
  ))
    db.exec(migrationSql(CORE_MIGRATIONS_URL, file));
  return db;
}

interface SeededRow {
  observationId: number;
  parseRunId: number;
  sourceId: "vpass" | "myjcb";
  sourceAccount: string;
  externalId: string;
  status: string;
  amount: number;
  paymentType: string;
  usageDate: string;
  statementPeriod: string | null;
  usageAmountText: string | null;
  paymentAmountText: string | null;
}

/**
 * Four Vpass captures of one card (runs 1–3 and a pending run) and one MyJCB
 * capture. Observations 1, 3 and 4 are the same provider row (same key)
 * re-fetched: 3 shows the same content, 4 a corrected amount.
 */
const ROWS: readonly SeededRow[] = [
  vpass(1, 1, "vpass:card-001:202608:web:row-a:0", "posted", -1234),
  vpass(2, 1, "vpass:card-001:202608:customized:row-b:0", "unconfirmed", -1200),
  vpass(3, 2, "vpass:card-001:202608:web:row-a:0", "posted", -1234),
  vpass(4, 3, "vpass:card-001:202608:web:row-a:0", "posted", -1300),
  {
    // The shapes the MyJCB ledger parser emits (tests/fixtures/observation-pipeline/myjcb).
    observationId: 5,
    parseRunId: 4,
    sourceId: "myjcb",
    sourceAccount: "myjcb:connection-a:root",
    externalId: "myjcb-credit-ledger:confirmed:row-c:0",
    status: "confirmed",
    amount: -500,
    paymentType: "一回払い",
    usageDate: "2026-08-20",
    statementPeriod: "2026年9月お支払い分",
    usageAmountText: "500円",
    paymentAmountText: "500円",
  },
];

function vpass(
  observationId: number,
  parseRunId: number,
  externalId: string,
  status: string,
  amount: number,
): SeededRow {
  return {
    observationId,
    parseRunId,
    sourceId: "vpass",
    sourceAccount: "vpass:card-001",
    externalId,
    status,
    amount,
    paymentType: "1回払い",
    usageDate: "2026-08-15",
    statementPeriod: "202609",
    usageAmountText: null,
    paymentAmountText: null,
  };
}

/** Layer A registry, runs, artifacts and parse runs, Layer B rows and Layer C accounts. */
export function seedCardRows(db: Database): void {
  const run = (sql: string, ...binds: (string | number | null)[]) => db.run(sql, binds);
  run(
    `INSERT INTO producers(id,kind,display_name) VALUES(?,'collector','Card producer')`,
    PRODUCER,
  );
  run(
    "INSERT INTO producer_sources(producer_id,source_id) VALUES(?,'vpass'),(?,'myjcb')",
    PRODUCER,
    PRODUCER,
  );
  run("INSERT INTO ingest_clients(id,display_name,active) VALUES('card-client','Card client',1)");
  run(
    "INSERT INTO ingest_client_producers(ingest_client_id,producer_id) VALUES('card-client',?)",
    PRODUCER,
  );
  run(
    `INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id)
     VALUES('card-client',?,'vpass'),('card-client',?,'myjcb')`,
    PRODUCER,
    PRODUCER,
  );
  const sessions: [number, string][] = [
    [1, VPASS_NAMESPACE],
    [2, MYJCB_NAMESPACE],
  ];
  for (const [id, namespace] of sessions)
    run(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?,?,'card-client',?,?,1000)`,
      id,
      PRODUCER,
      namespace,
      `session-${id}`,
    );
  run(
    "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?,3,'objects/card',1000)",
    "a".repeat(64),
  );
  const runs: [number, number, "vpass" | "myjcb", string][] = [
    [1, 1, "vpass", "months/202608/web-1.json"],
    [2, 1, "vpass", "months/202608/web-2.json"],
    [3, 1, "vpass", "months/202608/web-3.json"],
    [4, 2, "myjcb", "connection-a/credit-ledger-00.json"],
  ];
  for (const [id, session, source, key] of runs) {
    run(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,?,'card-client',?,1000)`,
      id,
      session,
      PRODUCER,
      source,
      `run-${id}`,
    );
    run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
        payload_fidelity,container_kind,lineage_disposition,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
       VALUES(?,?,?,?,'card-client',?,'provider_response','exact','single','not_applicable',?,3,'v1',?,1000)`,
      id,
      id,
      source,
      PRODUCER,
      key,
      "a".repeat(64),
      String(id).repeat(64).slice(0, 64),
    );
    run(
      `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status)
       VALUES(?,?,?,'1.0.0','2026-09-07T00:00:00Z','ok')`,
      id,
      id,
      source === "vpass" ? "vpass-statement-page" : "myjcb-credit-ledger",
    );
  }
  for (const row of ROWS)
    run(
      `INSERT INTO transaction_observations(id,parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,
        currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,?,?,?,?,?,?,0,'JPY',?,'synthetic merchant',?,'2026-09-07T00:00:00Z','json:$.rows[0]','{}')`,
      row.observationId,
      row.parseRunId,
      row.sourceAccount,
      row.externalId,
      row.status,
      row.amount,
      String(row.amount),
      row.paymentType,
      row.usageDate,
    );
  for (const account of ["acct-card", "acct-card-2", "acct-jcb"])
    run(
      "INSERT INTO accounts(id,label,role,status) VALUES(?,'Synthetic card','liability','identified')",
      account,
    );
}

/** The fact the read model would return for one seeded row. */
export function factOf(
  observationId: number,
  overrides: Partial<CardUsageFact> = {},
): CardUsageFact {
  const row = ROWS.find((entry) => entry.observationId === observationId);
  if (!row) throw new Error(`no seeded row ${observationId}`);
  return {
    observationId: row.observationId,
    parseRunId: row.parseRunId,
    sourceId: row.sourceId,
    producerId: PRODUCER,
    externalIdNamespace: row.sourceId === "vpass" ? VPASS_NAMESPACE : MYJCB_NAMESPACE,
    sourceAccount: row.sourceAccount,
    externalId: row.externalId,
    accountId: row.sourceId === "vpass" ? "acct-card" : "acct-jcb",
    identityPolicyFamily: row.sourceId === "vpass" ? "vpass-card-binding" : "identity-default",
    providerStatus: row.status,
    amount: exactQuantity("JPY", integerDecimal(row.amount), "decimal-v1"),
    usageDate: row.usageDate,
    paymentType: row.paymentType,
    statementPeriod: row.statementPeriod,
    providerSaleCode: null,
    usageAmountText: row.usageAmountText,
    paymentAmountText: row.paymentAmountText,
    newestRepresentation: true,
    ...overrides,
  };
}

/** Every table a recognition writes, plus the allocations it must never write. */
const WRITTEN_TABLES = [
  "decision_revisions",
  "economic_event_revisions",
  "economic_legs",
  "card_purchase_recognitions",
  "card_purchase_recognition_keys",
  "allocations",
] as const;

/** Row counts of every table a recognition writes. */
export function counts(db: Database): Record<string, number> {
  return Object.fromEntries(
    WRITTEN_TABLES.map((table) => [
      table,
      (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  );
}

/**
 * Every row of every table a recognition writes (so a moved `superseded_by`
 * shows, not only a new row), plus the CORE source revision.
 */
export function snapshot(db: Database): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      WRITTEN_TABLES.map((table) => [
        table,
        db.query(`SELECT * FROM ${table} ORDER BY 1,2,3`).all(),
      ]),
    ),
    core_source_revision: db.query("SELECT * FROM core_source_revision").all(),
  };
}
