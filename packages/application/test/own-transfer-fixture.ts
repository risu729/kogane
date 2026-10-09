// A synthetic store for the own-transfer planners (ADR 0057, G3-a): SMBC-shaped
// rows on three own accounts under two producers, one SBI-Shinsei-shaped row
// whose parser records no identity origin, and a synthetic economic writer
// standing in for the own-transfer writer G3-b will build (no such writer
// ships). Every value is synthetic: invented accounts, ids, round amounts and
// dates; nothing is read from production.
import type { Database } from "bun:sqlite";
import {
  parseConsumptionKey,
  type AliasClass,
  type BookClaim,
  type ConsumptionKey,
} from "../../domain/src/economic-contract.ts";
import { declaredAliasClass } from "../../domain/src/row-identity.ts";
import {
  OWN_TRANSFER_WRITER_RELEASE,
  type AccountOwnership,
  type AccountOwnershipSource,
  type OwnTransferPolicy,
  type OwnTransferRowInput,
} from "../../domain/src/own-transfer-proposals.ts";
import {
  decisionEntry,
  economicFinalizationWrites,
} from "../../storage-d1/src/atomic/economic-commit.ts";
import type { SqlWrite } from "../../storage-d1/src/core/operations.ts";

const PRINCIPAL = "synthetic-reviewer";
export const POLICY: OwnTransferPolicy = {
  policyVersion: "synthetic-own-transfer-policy-1",
  family: "bank-movement",
  currencyRule: "same-currency",
  window: { minDaysAfterDebit: 0, maxDaysAfterDebit: 2 },
  difference: { rule: "exact" },
};

/** Source account → own account. */
const ACCOUNTS: Record<string, string> = {
  "smbc-bank:synthetic-a": "acct-synthetic-a",
  "smbc-bank:synthetic-b": "acct-synthetic-b",
  "smbc-bank:synthetic-c": "acct-synthetic-c",
  "sbi-shinsei:synthetic": "acct-synthetic-shinsei",
};
export const ownership: AccountOwnershipSource = {
  version: "synthetic-ownership-1",
  ownershipOf: (_sourceId, sourceAccount): AccountOwnership => {
    const accountId = ACCOUNTS[sourceAccount];
    return accountId === undefined ? { state: "unresolved" } : { state: "self", accountId };
  },
};
export const accountOf = (sourceAccount: string): string => ACCOUNTS[sourceAccount]!;

/** Observation id → [parse run, source account, external id, signed amount]. */
export const ROWS: Record<number, [number, string, string, string]> = {
  101: [1, "smbc-bank:synthetic-a", "meisai-0101", "-1000"],
  102: [1, "smbc-bank:synthetic-b", "meisai-0102", "1000"],
  103: [1, "smbc-bank:synthetic-a", "meisai-0103", "-2000"],
  104: [1, "smbc-bank:synthetic-c", "meisai-0104", "2000"],
  105: [1, "smbc-bank:synthetic-c", "meisai-0105", "1000"],
  // Observation 101's provider row collected under a second producer and namespace.
  111: [3, "smbc-bank:synthetic-a", "meisai-0101", "-1000"],
  // An SBI-Shinsei-shaped credit: `txnReferenceNo`, no recorded origin.
  201: [2, "sbi-shinsei:synthetic", "ref-0201", "1000"],
};

export function seedOwnTransferStore(db: Database): void {
  const run = (sql: string, ...binds: (string | number | null)[]) => db.run(sql, binds);
  run("INSERT INTO ingest_clients(id,display_name,active) VALUES('synthetic-client','Client',1)");
  run(
    "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?,3,'objects/synthetic',1000)",
    "a".repeat(64),
  );
  // [run id, producer, namespace, source, parser]
  const runs: [number, string, string, string, string][] = [
    [1, "producer-a", "ns-a", "smbc-bank", "smbc-direct-transactions"],
    [2, "producer-a", "ns-a", "sbi-shinsei-bank", "sbi-shinsei-top-balances-and-activity"],
    [3, "producer-b", "ns-b", "smbc-bank", "smbc-direct-transactions"],
  ];
  for (const producer of ["producer-a", "producer-b"]) {
    run(`INSERT INTO producers(id,kind,display_name) VALUES(?,'collector','Producer')`, producer);
    run(
      "INSERT INTO producer_sources(producer_id,source_id) VALUES(?,'smbc-bank'),(?,'sbi-shinsei-bank')",
      producer,
      producer,
    );
    run(
      "INSERT INTO ingest_client_producers(ingest_client_id,producer_id) VALUES('synthetic-client',?)",
      producer,
    );
    run(
      `INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id)
       VALUES('synthetic-client',?,'smbc-bank'),('synthetic-client',?,'sbi-shinsei-bank')`,
      producer,
      producer,
    );
  }
  for (const [id, producer, namespace, source, parser] of runs) {
    run(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?,?,'synthetic-client',?,?,1000)`,
      id,
      producer,
      namespace,
      `session-${id}`,
    );
    run(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,?,'synthetic-client',?,1000)`,
      id,
      id,
      producer,
      source,
      `run-${id}`,
    );
    run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
        payload_fidelity,container_kind,lineage_disposition,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
       VALUES(?,?,?,?,'synthetic-client',?,'provider_response','exact','single','not_applicable',?,3,'v1',?,1000)`,
      id,
      id,
      source,
      producer,
      `synthetic/details-${id}.json`,
      "a".repeat(64),
      String(id).repeat(64).slice(0, 64),
    );
    run(
      `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status)
       VALUES(?,?,?,'1.0.0','2030-01-01T00:00:00Z','ok')`,
      id,
      id,
      parser,
    );
  }
  for (const [id, [parseRun, account, externalId, amount]] of Object.entries(ROWS)) {
    const extra =
      parseRun === 2
        ? { txnReferenceNo: externalId }
        : { id: externalId, _kogane: { identityOrigin: "provider-id" } };
    run(
      `INSERT INTO transaction_observations(id,parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,
        currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,?,?,?,'posted',?,?,0,'JPY','synthetic movement',NULL,'2030-01-10','2030-01-10T00:00:00Z','json:$.rows[0]',?)`,
      Number(id),
      parseRun,
      account,
      externalId,
      Number(amount),
      amount,
      JSON.stringify(extra),
    );
  }
  for (const accountId of Object.values(ACCOUNTS))
    run(
      "INSERT INTO accounts(id,label,role,status) VALUES(?,'Synthetic account','asset','identified')",
      accountId,
    );
}

/** The row's own 5-tuple, as SQLite renders it from the stored columns. */
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

/** Stored rows as the engine's input. */
export function engineRows(db: Database, ids: readonly number[]): OwnTransferRowInput[] {
  return ids.map((id) => {
    const row = db
      .query(
        `SELECT t.parse_run_id,p.parser_name,t.extra_json,t.amount_text,t.currency,t.as_of
         FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id WHERE t.id=?`,
      )
      .get(id) as {
      parse_run_id: number;
      parser_name: string;
      extra_json: string;
      amount_text: string;
      currency: string;
      as_of: string;
    };
    return {
      observationId: id,
      parseRunId: row.parse_run_id,
      key: keyOf(db, id),
      parserName: row.parser_name,
      extra: JSON.parse(row.extra_json),
      amount: row.amount_text,
      currency: row.currency,
      postingDate: row.as_of,
    };
  });
}

/** The alias class the registry function computes for a stored SMBC row. */
function aliasOf(db: Database, observationId: number): AliasClass {
  const [parseRun, account, externalId] = ROWS[observationId]!;
  const alias = declaredAliasClass({
    sourceId: parseRun === 2 ? "sbi-shinsei-bank" : "smbc-bank",
    parserName:
      parseRun === 2 ? "sbi-shinsei-top-balances-and-activity" : "smbc-direct-transactions",
    sourceAccount: account,
    extra: parseRun === 2 ? { txnReferenceNo: externalId } : { id: externalId },
    accountId: accountOf(account),
  });
  if (!alias) throw new Error(`no alias class for ${observationId} in ${db.filename}`);
  return alias;
}

export const claimOf = (db: Database, observationId: number): BookClaim => ({
  book: "cash-movement",
  key: keyOf(db, observationId),
});

// ---------------------------------------------------------------------------
// The synthetic writer: entry decision(s) → revision(s) → legs → supersede
// pointer(s) → the guard's claims, seals and commit row (CORE 0070).

export interface MemberSpec {
  eventId: string;
  revision: number;
  /** Observation ids of the debit and credit legs; empty for a withdrawal. */
  legs: readonly number[];
  /** Observation ids claimed. Defaults to the legs. */
  claims?: readonly number[];
  /** Record no alias class (a legacy-shaped holder). */
  withoutAlias?: boolean;
  writerRelease?: string;
}

let clock = 0;
const tick = () => new Date(Date.UTC(2030, 0, 10, 0, 0, clock++)).toISOString();

export function memberWrites(
  db: Database,
  members: readonly MemberSpec[],
  released: readonly number[] = [],
): SqlWrite[] {
  const now = tick();
  const decisionOf = (m: MemberSpec) => `dr-${m.eventId}-${m.revision}`;
  const entry = decisionEntry(decisionOf(members[0]!));
  const writes: SqlWrite[] = [];
  for (const member of members) {
    const { eventId, revision } = member;
    writes.push({
      sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
 SELECT ?,'relation',?,?,?,'manual',?,NULL,'synthetic review','[]',?,NULL,? WHERE NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`,
      binds: [
        decisionOf(member),
        `event:${eventId}`,
        revision,
        revision === 1 ? "accept" : "supersede",
        PRINCIPAL,
        revision > 1 ? revision - 1 : null,
        now,
        decisionOf(member),
      ],
    });
  }
  for (const member of members) {
    const { eventId, revision } = member;
    const withdrawn = member.legs.length === 0;
    writes.push({
      sql: `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
 SELECT ?,?,'transfer',?,?,'{}','cash-movement','["synthetic:evidence"]',?,NULL,? WHERE ${entry.sql}
 AND NOT EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND revision=?)`,
      binds: [
        eventId,
        revision,
        withdrawn ? "unknown" : "credited",
        withdrawn ? "conflicting_evidence" : null,
        decisionOf(member),
        now,
        ...entry.binds,
        eventId,
        revision,
      ],
    });
    member.legs.forEach((observationId, legIndex) => {
      const [, account, , amount] = ROWS[observationId]!;
      writes.push({
        sql: `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
 SELECT ?,?,?,?,'JPY','exact',?,0,NULL,?,'cash-movement' WHERE ${entry.sql}
 AND NOT EXISTS(SELECT 1 FROM economic_legs WHERE event_id=? AND revision=? AND leg_index=?)`,
        binds: [
          eventId,
          revision,
          legIndex,
          `account:${accountOf(account)}`,
          amount.replace("-", ""),
          amount.startsWith("-") ? "decrease" : "increase",
          ...entry.binds,
          eventId,
          revision,
          legIndex,
        ],
      });
    });
  }
  const supersedes = (m: MemberSpec) =>
    m.revision > 1 ? [{ eventId: m.eventId, revision: m.revision - 1 }] : [];
  for (const member of members)
    for (const prior of supersedes(member))
      writes.push({
        sql: `UPDATE economic_event_revisions SET superseded_by=? WHERE event_id=? AND revision=? AND superseded_by IS NULL AND ${entry.sql}`,
        binds: [
          `${member.eventId}@${member.revision}`,
          prior.eventId,
          prior.revision,
          ...entry.binds,
        ],
      });
  const claims = members.flatMap((member) =>
    (member.claims ?? member.legs).map((observationId) => ({
      eventId: member.eventId,
      revision: member.revision,
      book: "cash-movement" as const,
      key: keyOf(db, observationId),
      aliasClass: member.withoutAlias ? null : aliasOf(db, observationId),
      identityEpoch: currentEpoch(db),
      observationId,
      parseRunId: ROWS[observationId]![0],
    })),
  );
  writes.push(
    ...economicFinalizationWrites({
      entry,
      claims,
      times: [],
      effects: [],
      seals: members.map((member) => ({
        eventId: member.eventId,
        revision: member.revision,
        writerRelease: member.writerRelease ?? OWN_TRANSFER_WRITER_RELEASE,
        legCount: member.legs.length,
        claimCount: (member.claims ?? member.legs).length,
        timeCount: 0,
        effectCount: 0,
        contentDigest: "c".repeat(64),
        identityPins: {},
        identityEpoch: currentEpoch(db),
        now,
      })),
      commit: {
        decisionRevisionId: decisionOf(members[0]!),
        operationId: null,
        principal: PRINCIPAL,
        payloadDigest: "d".repeat(64),
        kind: "synthetic.own-transfer",
        members: members.map((member) => ({
          eventId: member.eventId,
          revision: member.revision,
          supersedes: supersedes(member),
        })),
        claims: claims.map(({ book, key }) => ({ book, key })),
        released: released.map((observationId) => claimOf(db, observationId)),
        now,
      },
    }),
  );
  return writes;
}

function currentEpoch(db: Database): string {
  return (
    db
      .query(
        "SELECT identity_epoch AS e FROM economic_identity_epochs ORDER BY ordinal DESC LIMIT 1",
      )
      .get() as { e: string }
  ).e;
}

/** Declare the next identity epoch, as a declared identity rewrite would. */
export function declareNextEpoch(db: Database): void {
  db.run(
    "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(2,'identity-epoch-2','synthetic-rewrite','2030-01-11T00:00:00.000Z')",
  );
}
