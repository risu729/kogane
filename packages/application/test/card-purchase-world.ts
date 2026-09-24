// A synthetic card world for the purchase explanation query, on every CORE
// migration with foreign keys enforced: the Vpass/MyJCB usage rows of the
// storage-d1 purchase fixture, recognised through the guarded write builder
// the processor uses, plus sealed and published statement totals with a
// resolved account, SMBC debit rows and card settlement reviews written the
// way the settlement command writes them. Every id, account and amount is
// invented; nothing here is a provider row.
import type { Database } from "bun:sqlite";
import {
  cardPurchaseEventId,
  cardPurchaseRetirement,
  cardPurchaseRevision,
  classifyCardUsage,
  recognitionKey,
  type CardPurchaseDraft,
  type CardPurchaseFacts,
  type CardPurchaseKey,
  type CardPurchaseSourceId,
  type CardUsageFact,
} from "../../domain/src/card-purchase.ts";
import type { CardSettlementStatus } from "../../domain/src/card-settlement.ts";
import type { EconomicEventRevision } from "../../domain/src/events.ts";
import { exactQuantity, integerDecimal } from "../../domain/src/values.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { cardPurchaseRecognitionWrites } from "../../storage-d1/src/atomic/card-purchase-recognition.ts";
import type { SqlWrite } from "../../storage-d1/src/core/operations.ts";
import { factOf, seedCardRows } from "../../storage-d1/test/card-purchase-fixture.ts";
import { settlementFacts } from "./card-settlement-fixture.ts";
import { migratedDatabase } from "./sqlite-store.ts";

const NOW = "2026-09-24T00:00:00.000Z";
const PRODUCER = "card-producer";
const CLIENT = "card-client";
const SHA = "a".repeat(64);
const SESSION: Record<CardPurchaseSourceId | "smbc-bank", number> = {
  vpass: 1,
  myjcb: 2,
  "smbc-bank": 3,
};
type Bind = string | number | null;

export interface StatementInput {
  source: CardPurchaseSourceId;
  sourceAccount: string;
  /** The resolved account of the statement's own identity run; null leaves it unresolved. */
  accountId: string | null;
  /** `YYYY-MM`. */
  period: string;
  total: number;
  paymentDate: string | null;
  recordedAtMs?: number;
}
export interface Fact {
  observationId: number;
  parseRunId: number;
}

/** The builder's statements in one transaction, as a D1 batch runs them. */
function apply(db: Database, writes: readonly SqlWrite[]): void {
  db.transaction(() => {
    for (const entry of writes) db.query(entry.sql).run(...(entry.binds as Bind[]));
  })();
}

function write(
  db: Database,
  draft: CardPurchaseDraft | null,
  expectedRevision: number | null,
): void {
  if (draft === null) throw new Error("draft rejected");
  apply(db, cardPurchaseRecognitionWrites({ draft, expectedRevision, now: NOW }));
}

/**
 * A first recognition of one row through the guarded batch, on any CORE
 * database that holds the row; returns the event id.
 */
export async function recognise(db: Database, fact: CardUsageFact): Promise<string> {
  const classified = classifyCardUsage(fact);
  const key = recognitionKey(fact);
  if (!classified.ok || key === null) throw new Error("fixture row is not recognisable");
  const eventId = await cardPurchaseEventId(classified.kind, key);
  write(db, await cardPurchaseRevision({ action: "recognize", eventId, revision: 1, fact }), null);
  return eventId;
}

/** Full CORE, the purchase fixture's rows, and the writers the tests compose. */
export class PurchaseWorld {
  readonly db: Database = migratedDatabase();
  private sequence = 100;
  private readonly mappings = new Map<string, number>();

  readonly sql: SqlExecutor = {
    all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> =>
      this.db.query(query).all(...(args as Bind[])) as T[],
    first: async <T>(query: string, args: readonly unknown[]): Promise<T | null> =>
      (this.db.query(query).get(...(args as Bind[])) as T | null) ?? null,
  };

  constructor() {
    seedCardRows(this.db);
    this.run("INSERT INTO producer_sources(producer_id,source_id) VALUES(?,'smbc-bank')", PRODUCER);
    this.run(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES(?,?,'smbc-bank')",
      CLIENT,
      PRODUCER,
    );
    this.run(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(3,?,?,'smbc-bank-v1','session-3',1000)`,
      PRODUCER,
      CLIENT,
    );
  }

  run(query: string, ...binds: Bind[]): void {
    this.db.query(query).run(...binds);
  }

  private next(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /**
   * One more Vpass usage row on the fixture's first run (source account
   * `vpass:card-001` unless given), as the fact the read model would return.
   */
  usage(input: {
    externalId: string;
    status?: "posted" | "unconfirmed";
    amount?: number;
    usageDate?: string;
    statementPeriod?: string | null;
    sourceAccount?: string;
    accountId?: string;
    counterparty?: string;
  }): CardUsageFact {
    const id = this.next();
    const status = input.status ?? "posted";
    const amount = input.amount ?? -1000;
    const usageDate = input.usageDate ?? "2026-08-20";
    const sourceAccount = input.sourceAccount ?? "vpass:card-001";
    this.run(
      `INSERT INTO transaction_observations(id,parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,
        currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,1,?,?,?,?,?,0,'JPY','1回払い',?,?,'2026-09-07T00:00:00Z',?,'{}')`,
      id,
      sourceAccount,
      input.externalId,
      status,
      amount,
      String(amount),
      input.counterparty ?? "synthetic merchant",
      usageDate,
      `json:$.rows[${id}]`,
    );
    return factOf(1, {
      observationId: id,
      externalId: input.externalId,
      providerStatus: status,
      amount: exactQuantity("JPY", integerDecimal(amount), "decimal-v1"),
      usageDate,
      statementPeriod: input.statementPeriod === undefined ? "202609" : input.statementPeriod,
      sourceAccount,
      accountId: input.accountId ?? "acct-card",
    });
  }

  /** A first recognition through the guarded batch; returns the event id. */
  recognise(fact: CardUsageFact): Promise<string> {
    return recognise(this.db, fact);
  }

  /** The same key with new content: the next revision of the live event. */
  async revise(eventId: string, fact: CardUsageFact): Promise<void> {
    const live = this.live(eventId);
    const draft = await cardPurchaseRevision({
      action: "revise",
      eventId,
      revision: live.revision + 1,
      fact,
    });
    this.write(draft, live.revision);
  }

  /** The provider stopped displaying the row: an `unknown` revision with no leg. */
  async retire(eventId: string): Promise<void> {
    const live = this.live(eventId);
    const keys = this.db
      .query(
        "SELECT recognition_key AS key,role,observation_id AS observationId,parse_run_id AS parseRunId FROM card_purchase_recognition_keys WHERE event_id=? AND revision=?",
      )
      .all(eventId, live.revision) as CardPurchaseKey[];
    const sidecar = this.db
      .query(
        "SELECT account_id,source_id,statement_period,facts_json FROM card_purchase_recognitions WHERE event_id=? AND revision=?",
      )
      .get(eventId, live.revision) as {
      account_id: string;
      source_id: CardPurchaseSourceId;
      statement_period: string | null;
      facts_json: string;
    };
    const draft = await cardPurchaseRetirement({
      live,
      keys,
      sidecar: {
        accountId: sidecar.account_id,
        sourceId: sidecar.source_id,
        statementPeriod: sidecar.statement_period,
        facts: JSON.parse(sidecar.facts_json) as CardPurchaseFacts,
      },
    });
    this.write(draft, live.revision);
  }

  private write(draft: CardPurchaseDraft | null, expectedRevision: number | null): void {
    write(this.db, draft, expectedRevision);
  }

  /** The stored live revision in the domain shape. */
  live(eventId: string): EconomicEventRevision {
    const row = this.db
      .query("SELECT * FROM current_economic_events WHERE event_id=?")
      .get(eventId) as Record<string, string | number | null>;
    const legs = this.db
      .query("SELECT * FROM economic_legs WHERE event_id=? AND revision=? ORDER BY leg_index")
      .all(eventId, row["revision"] as number) as Record<string, string | number>[];
    return {
      eventId,
      revision: row["revision"] as number,
      kind: row["kind"] as EconomicEventRevision["kind"],
      state: row["state"] as EconomicEventRevision["state"],
      unknownReason: row["unknown_reason"] as EconomicEventRevision["unknownReason"],
      effectiveTime: JSON.parse(row["effective_time_json"] as string),
      basis: "purchase-recognition",
      evidenceSupport: JSON.parse(row["evidence_support_json"] as string),
      decisionRevisionRef: row["decision_revision_id"] as string,
      supersededBy: null,
      legs: legs.map((leg) => ({
        eventId,
        revision: leg["revision"] as number,
        legIndex: leg["leg_index"] as number,
        subjectRef: leg["subject_ref"] as string,
        quantity: exactQuantity(
          leg["unit_ref"] as string,
          { coefficient: leg["coefficient"] as string, scale: leg["scale"] as number },
          "decimal-v1",
        ),
        role: leg["role"] as "decrease" | "increase",
        basis: "purchase-recognition",
      })),
    };
  }

  /**
   * One sealed, successful fetch run with one artifact, parsed `ok` by
   * `parser` and (unless `publish` is false) published.
   */
  private sealedParse(
    source: CardPurchaseSourceId | "smbc-bank",
    parser: string,
    recordedAtMs: number,
    publish = true,
  ): number {
    const id = this.next();
    const key = `synthetic/${source}/${id}.json`;
    const descriptor = id.toString(16).padStart(64, "0");
    this.run(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,?,?,?,?)`,
      id,
      SESSION[source],
      PRODUCER,
      source,
      CLIENT,
      `run-${id}`,
      recordedAtMs,
    );
    this.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
        payload_fidelity,container_kind,lineage_disposition,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
       VALUES(?,?,?,?,?,?,'provider_response','exact','single','not_applicable',?,3,'v1',?,?)`,
      id,
      id,
      source,
      PRODUCER,
      CLIENT,
      key,
      SHA,
      descriptor,
      recordedAtMs,
    );
    this.run(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
       VALUES(?,?,?,1,'operator',?,?)`,
      id,
      id,
      descriptor,
      recordedAtMs,
      CLIENT,
    );
    this.run(
      "INSERT INTO run_inventory_items(inventory_id,fetch_run_id,artifact_key,sha256,descriptor_sha256) VALUES(?,?,?,?,?)",
      id,
      id,
      key,
      SHA,
      descriptor,
    );
    this.run(
      `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,recorded_at_ms)
       VALUES(?,'terminal','terminal',?,'success',?)`,
      id,
      CLIENT,
      recordedAtMs,
    );
    this.run(
      "INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?,?,?,?)",
      id,
      id,
      recordedAtMs,
      CLIENT,
    );
    this.run(
      `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
       VALUES(?,?,?,'1.0.0','2026-09-07T00:00:00Z','ok','[]')`,
      id,
      id,
      parser,
    );
    if (publish) {
      this.run(
        `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
         VALUES(?,?,NULL,?,'normal','pipeline','parse_ok','2026-09-07T00:00:00Z')`,
        id,
        parser,
        id,
      );
      this.run(
        `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
         VALUES(?,?,?,'1.0.0','2026-09-07T00:00:00Z','normal')`,
        id,
        parser,
        id,
      );
    }
    return id;
  }

  /**
   * A provider statement total (`credit_statement_payment_amount`) in its own
   * published run, and, when `accountId` is given, a sealed identity run that
   * maps its source account to that account.
   */
  statement(input: StatementInput): Fact {
    const parser =
      input.source === "vpass" ? "vpass-statement-page" : "myjcb-credit-statement-total";
    const parse = this.sealedParse(input.source, parser, input.recordedAtMs ?? 2000);
    const period =
      input.source === "vpass"
        ? { statementMonth: input.period.replace("-", "") }
        : { period: input.period };
    const observationId = this.next();
    this.run(
      `INSERT INTO balance_observations(id,parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
       VALUES(?,?,?,'credit_statement_payment_amount',?,?,0,'JPY',?,'json:$.statement',?)`,
      observationId,
      parse,
      input.sourceAccount,
      input.total,
      String(input.total),
      `${input.period}-01`,
      JSON.stringify({
        _kogane: {
          ...period,
          ...(input.paymentDate === null ? {} : { paymentDate: input.paymentDate }),
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    );
    if (input.accountId !== null)
      this.identify(parse, observationId, input.source, input.sourceAccount, input.accountId);
    return { observationId, parseRunId: parse };
  }

  private identify(
    parse: number,
    observationId: number,
    source: CardPurchaseSourceId,
    sourceAccount: string,
    accountId: string,
  ): void {
    const sourceAccountId = `sa-${sourceAccount}`;
    const revision = (this.mappings.get(sourceAccountId) ?? 0) + 1;
    if (revision === 1)
      this.run(
        "INSERT INTO source_accounts(id,source_id,producer_id,reference_json) VALUES(?,?,?,?)",
        sourceAccountId,
        source,
        PRODUCER,
        JSON.stringify([sourceAccount]),
      );
    this.mappings.set(sourceAccountId, revision);
    const mapping = `${sourceAccountId}-r${revision}`;
    this.run(
      `INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
       VALUES(?,?,?,?,'rule','synthetic',1,?,'synthetic','identified')`,
      mapping,
      sourceAccountId,
      revision,
      accountId,
      NOW,
    );
    const run = `ir-${parse}`;
    this.run(
      "INSERT INTO identity_runs(id,parse_run_id,policy_version,created_at) VALUES(?,?,1,?)",
      run,
      parse,
      NOW,
    );
    this.run(
      `INSERT INTO identity_observations(id,identity_run_id,kind,observation_id,source_account_id,account_mapping_id,issues_json)
       VALUES(?,?,'balance',?,?,?,'[]')`,
      `io-${parse}`,
      run,
      observationId,
      sourceAccountId,
      mapping,
    );
    this.run(
      "INSERT INTO identity_run_seals(identity_run_id,observation_count,completed_at) VALUES(?,1,?)",
      run,
      NOW,
    );
  }

  /** An SMBC debit row, which a settlement review cites as its bank debit. */
  bankDebit(amount: number): Fact {
    const parse = this.sealedParse("smbc-bank", "smbc-direct-transactions", 3000);
    const observationId = this.next();
    this.run(
      `INSERT INTO transaction_observations(id,parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,
        currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,?,'smbc-bank:ordinary','bank-debit-1','posted',?,?,0,'JPY','card payment',NULL,'2026-10-10',NULL,'json:$.debit','{}')`,
      observationId,
      parse,
      -amount,
      String(-amount),
    );
    return { observationId, parseRunId: parse };
  }

  /**
   * A settlement review of one statement against one bank debit, with the
   * decision rows `card-settlement.accept`/`reject` writes
   * (services/processor/src/card-settlement-commands.ts): an accepted review
   * has a `card_settlement` event with a cash leg on the bank account and an
   * unresolved obligation-change leg, and a `settlement` allocation from the
   * bank row to that event. No purchase-recognition leg is written.
   */
  settle(input: {
    statement: Fact;
    bank: Fact;
    source: CardPurchaseSourceId;
    accountId: string;
    period: string;
    total: number;
    status: Exclude<CardSettlementStatus, "withdrawn">;
    createdAt?: string;
  }): { proposalId: string; eventId: string | null; allocationId: string | null } {
    const n = this.next();
    const proposalId = `cs_synthetic_${n}`;
    const facts = settlementFacts();
    const amount = exactQuantity("JPY", integerDecimal(input.total));
    facts.statement = {
      ...facts.statement,
      ref: {
        kind: "balance",
        id: `balance:${input.statement.observationId}`,
        revision: `parse_run:${input.statement.parseRunId}`,
      },
      sourceId: input.source,
      sourceAccount: "synthetic-card",
      accountId: input.accountId,
      amount,
      paymentDate: {
        kind: "local-date",
        value: "2026-10-10",
        zone: "Asia/Tokyo",
        basis: "provider",
      },
      period: input.period,
    };
    facts.bankDebit = {
      ...facts.bankDebit,
      ref: {
        kind: "transaction",
        id: `transaction:${input.bank.observationId}`,
        revision: `parse_run:${input.bank.parseRunId}`,
      },
      sourceId: "smbc-bank",
      accountId: "acct-bank",
      amount,
      occurred: { kind: "local-date", value: "2026-10-10", zone: "Asia/Tokyo", basis: "provider" },
    };
    const createdAt = input.createdAt ?? NOW;
    this.run(
      `INSERT INTO card_settlement_candidates(id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,
        bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
       VALUES(?,?,?,?,?,?,?,'card-statement-settlement-v1',?,?,?)`,
      proposalId,
      `statement-${n}`,
      `bank-${n}`,
      input.statement.observationId,
      input.statement.parseRunId,
      input.bank.observationId,
      input.bank.parseRunId,
      JSON.stringify(facts),
      n.toString(16).padStart(64, "0"),
      createdAt,
    );
    if (input.status === "proposed") return { proposalId, eventId: null, allocationId: null };
    const decision = (id: string, subject: string, kind: string) =>
      this.run(
        `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
         VALUES(?,'relation',?,1,?,'manual','synthetic-operator',NULL,'synthetic review','[]',NULL,NULL,?)`,
        id,
        subject,
        kind,
        createdAt,
      );
    const decisionId = `dr_settlement_${n}`;
    decision(
      decisionId,
      `card-settlement:${proposalId}`,
      input.status === "accepted" ? "accept" : "reject",
    );
    if (input.status === "rejected") {
      this.run(
        `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
         VALUES(?,1,'rejected',?,NULL,NULL,NULL,?)`,
        proposalId,
        decisionId,
        createdAt,
      );
      return { proposalId, eventId: null, allocationId: null };
    }
    const eventId = `event_settlement_${n}`;
    const allocationId = `allocation_settlement_${n}`;
    decision(`dr_event_${n}`, `event:${eventId}`, "accept");
    decision(`dr_allocation_${n}`, `allocation:${allocationId}`, "accept");
    this.run(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
       VALUES(?,1,'card_settlement','debited',NULL,?,'cash-movement',?,?,NULL,?)`,
      eventId,
      JSON.stringify(facts.bankDebit.occurred),
      JSON.stringify([facts.statement.ref.id, facts.bankDebit.ref.id]),
      `dr_event_${n}`,
      createdAt,
    );
    this.run(
      `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
       VALUES(?,1,0,'acct-bank','JPY','exact',?,0,NULL,'decrease','cash-movement')`,
      eventId,
      String(input.total),
    );
    this.run(
      `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
       VALUES(?,1,1,?,'JPY','missing',NULL,NULL,'statement_principal_and_fees_unknown','unresolved','obligation-change')`,
      eventId,
      input.accountId,
    );
    this.run(
      `INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,superseded_by,created_at)
       VALUES(?,?,?,'settlement','JPY',?,0,?,NULL,?)`,
      allocationId,
      facts.bankDebit.ref.id,
      `event:${eventId}`,
      String(input.total),
      `dr_allocation_${n}`,
      createdAt,
    );
    this.run(
      `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
       VALUES(?,1,'accepted',?,?,NULL,?,?)`,
      proposalId,
      decisionId,
      eventId,
      allocationId,
      createdAt,
    );
    return { proposalId, eventId, allocationId };
  }

  /**
   * `card-settlement.withdraw` of an accepted review, as the command writes it:
   * revision 2 of the review, its settlement event (`unknown`, no leg) and its
   * allocation decision, and the allocation withdrawal. Nothing is deleted.
   */
  withdraw(settled: {
    proposalId: string;
    eventId: string | null;
    allocationId: string | null;
  }): void {
    const { proposalId, eventId, allocationId } = settled;
    if (eventId === null || allocationId === null) throw new Error("only an accepted review");
    const n = this.next();
    const createdAt = "2026-09-25T00:00:00Z";
    const decision = (id: string, subject: string) =>
      this.run(
        `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
         VALUES(?,'relation',?,2,'supersede','manual','synthetic-operator',NULL,'synthetic withdrawal','[]',1,NULL,?)`,
        id,
        subject,
        createdAt,
      );
    decision(`dr_withdraw_${n}`, `card-settlement:${proposalId}`);
    decision(`dr_withdraw_event_${n}`, `event:${eventId}`);
    decision(`dr_withdraw_allocation_${n}`, `allocation:${allocationId}`);
    const occurred = (
      this.db
        .query(
          "SELECT effective_time_json FROM economic_event_revisions WHERE event_id=? AND revision=1",
        )
        .get(eventId) as { effective_time_json: string }
    ).effective_time_json;
    this.run(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
       VALUES(?,2,'card_settlement','unknown','conflicting_evidence',?,'cash-movement','["withdrawn"]',?,NULL,?)`,
      eventId,
      occurred,
      `dr_withdraw_event_${n}`,
      createdAt,
    );
    this.run(
      "UPDATE economic_event_revisions SET superseded_by=? WHERE event_id=? AND revision=1",
      `${eventId}@2`,
      eventId,
    );
    this.run(
      "INSERT INTO card_settlement_allocation_withdrawals(settlement_id,decision_revision_id,created_at) VALUES(?,?,?)",
      allocationId,
      `dr_withdraw_allocation_${n}`,
      createdAt,
    );
    this.run(
      `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
       VALUES(?,2,'withdrawn',?,?,NULL,?,?)`,
      proposalId,
      `dr_withdraw_${n}`,
      eventId,
      allocationId,
      createdAt,
    );
  }

  close(): void {
    this.db.close();
  }
}
