// A synthetic store for the reported state on a date (src/dated-state.ts):
// CORE migrations 0017+ over the minimal Layer A stub (card-usage-fixture.ts),
// with typed writers for container captures, statement totals, identities and
// settlement reviews. Rows are written in the shapes the deployed parsers
// store (`_kogane` statement fields, decimal-v1 values, coverage claims); every
// account, code and amount is invented. decimal-v1 values are written by
// the 0024 triggers, as in production.
import type { Database } from "bun:sqlite";
import { migrated } from "./card-usage-fixture";

const PRODUCER = "collector-r2-importer";
const NAMESPACE = "synthetic-namespace-v1";

export interface PositionSpec {
  account: string;
  code: string;
  quantity: string;
  /** Provider market value in minor units of `currency`, recorded as a valuation. */
  value?: number;
  currency?: string;
}
export interface BalanceSpec {
  account: string;
  metric: string;
  instrument: string;
  /** Minor units; `null` records a value the parser could not read. */
  minor: number | null;
}
export interface Capture {
  artifact: number;
  parse: number;
  run: number;
  positions: number[];
  balances: number[];
}

/** The provider's text for `minor` units: yen have no minor unit, the others two. */
function providerText(minor: number, instrument: string): string {
  return instrument === "JPY" ? String(minor) : (minor / 100).toFixed(2);
}

export class DatedStore {
  readonly db: Database = migrated();
  private sequence = 0;
  private readonly mapped = new Set<string>();

  private id(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private run(source: string, outcome: "success" | "failure"): number {
    const id = this.id();
    this.db.run(
      "INSERT INTO acquisition_sessions(id,external_session_id,producer_id,external_id_namespace) VALUES(?,?,?,?)",
      [id, `synthetic-session-${id}`, PRODUCER, NAMESPACE],
    );
    this.db.run(
      "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(?,?,?,?,0)",
      [id, source, id, PRODUCER],
    );
    this.db.run("INSERT INTO fetch_run_reports VALUES(?,'terminal',?,0,0)", [id, outcome]);
    this.db.run("INSERT INTO fetch_run_seals(fetch_run_id) VALUES(?)", [id]);
    return id;
  }

  private publish(artifact: number, parser: string, version: string): number {
    const parse = this.id();
    this.db.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'2026-09-01','ok','[]')",
      [parse, artifact, parser, version],
    );
    this.db.run(
      "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,?,?,?,'2026-09-01','normal')",
      [artifact, parser, parse, version],
    );
    return parse;
  }

  /**
   * One capture of a container dataset: a sealed fetch run with one artifact
   * at `fetchedAt`, parsed and published with the given rows. `claim` writes a
   * coverage-v1 claim for the dataset's scope (complete, or partial).
   */
  capture(input: {
    source: string;
    dataset: string;
    parser: string;
    version?: string;
    fetchedAt: string;
    positions?: readonly PositionSpec[];
    balances?: readonly BalanceSpec[];
    outcome?: "success" | "failure";
    claim?: "complete" | "partial";
    artifactKey?: string;
    unitKey?: string;
  }): Capture {
    const run = this.run(input.source, input.outcome ?? "success");
    let unit: number | null = null;
    if (input.unitKey !== undefined) {
      unit = this.id();
      this.db.run(
        "INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,'account')",
        [unit, run, input.unitKey],
      );
      this.db.run("INSERT INTO fetch_unit_reports VALUES(?,'terminal','success',NULL)", [unit]);
    }
    const artifact = this.id();
    const at = Date.parse(input.fetchedAt);
    this.db.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role)
       VALUES(?,?,?,?,?,?,'application/json',?,?,?,'provider_response')`,
      [
        artifact,
        run,
        input.source,
        input.dataset,
        input.artifactKey ?? `${input.dataset}.json`,
        unit,
        at,
        at,
        artifact.toString(16).padStart(64, "0"),
      ],
    );
    const parse = this.publish(artifact, input.parser, input.version ?? "1.0.0");
    const positions: number[] = [];
    for (const [index, position] of (input.positions ?? []).entries()) {
      const id = Number(
        this.db.run(
          `INSERT INTO position_observations(parse_run_id,source_account,security_code,security_name,market,quantity_text,quantity_scale,currency,as_of,observed_at,raw_locator,extra_json)
           VALUES(?,?,?,?,NULL,?,0,?,NULL,NULL,?,'{}')`,
          [
            parse,
            position.account,
            position.code,
            `Synthetic ${position.code}`,
            position.quantity,
            position.currency ?? "JPY",
            `$.positions[${index}]`,
          ],
        ).lastInsertRowid,
      );
      positions.push(id);
      if (position.value !== undefined) {
        this.db.run(
          `INSERT INTO valuation_observations(parse_run_id,source_account,subject,metric,amount_minor,amount_text,amount_scale,currency,as_of,observed_at,raw_locator,extra_json)
             VALUES(?,?,?,'evaluation_amount',?,?,0,?,NULL,NULL,?,'{}')`,
          [
            parse,
            position.account,
            position.code,
            position.value,
            providerText(position.value, position.currency ?? "JPY"),
            position.currency ?? "JPY",
            // The foreign parser's valuation row sits under its position
            // (the locator guard POSITION_VALUATIONS_SQL applies).
            input.parser === "sbi-foreign-cash-positions"
              ? `$.positions[${index}].evaluationProfitLoss`
              : `$.positions[${index}].value`,
          ],
        );
      }
    }
    const balances: number[] = [];
    for (const [index, balance] of (input.balances ?? []).entries()) {
      const id = Number(
        this.db.run(
          `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json)
           VALUES(?,?,?,?,?,0,?,NULL,NULL,?,'{}')`,
          [
            parse,
            balance.account,
            balance.metric,
            balance.minor,
            balance.minor === null ? "unreadable" : providerText(balance.minor, balance.instrument),
            balance.instrument,
            `$.balances[${index}]`,
          ],
        ).lastInsertRowid,
      );
      balances.push(id);
    }
    if (input.claim !== undefined) {
      const count = positions.length + balances.length;
      const complete = input.claim === "complete";
      this.db.run(
        `INSERT INTO parse_coverage_claims(parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,observed_count,expected_count,evidence_refs_json,policy_version,failure_cause,absence_meaning,parent_run_status,parent_run_failure_count)
         VALUES(?,'container',?,'complete-container',?,?,?,NULL,'[]','coverage-v1',?,?,'success',0)`,
        [
          parse,
          `${input.source}/${input.dataset}${input.unitKey === undefined ? "" : `/unit=${input.unitKey}`}`,
          complete ? "complete" : "partial",
          complete ? 1 : 0,
          count,
          complete ? null : "page_missing",
          count > 0 ? "not-applicable" : "complete-empty",
        ],
      );
    }
    return { artifact, parse, run, positions, balances };
  }

  /**
   * A provider statement total as the Vpass statement parser stores it: the
   * `credit_statement_payment_amount` of `period` (`YYYY-MM`) due on
   * `paymentDate` (or with none), captured at `fetchedAt`.
   */
  statement(input: {
    card: string;
    period: string;
    paymentDate: string | null;
    minor: number;
    fetchedAt: string;
  }): Capture {
    const month = input.period.replace("-", "");
    const captured = this.capture({
      source: "vpass",
      dataset: "statement-page",
      parser: "vpass-statement-page",
      fetchedAt: input.fetchedAt,
      artifactKey: `cards/${input.card}/months/${month}/top-000.json`,
    });
    const id = Number(
      this.db.run(
        `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json)
         VALUES(?,?,'credit_statement_payment_amount',?,?,0,'JPY',NULL,NULL,'$.total',?)`,
        [
          captured.parse,
          input.card,
          input.minor,
          String(input.minor),
          JSON.stringify({
            _kogane: {
              statementMonth: month,
              snapshotSemantics: "provider-reported-monthly-payment-amount",
              ...(input.paymentDate === null ? {} : { paymentDate: input.paymentDate }),
            },
          }),
        ],
      ).lastInsertRowid,
    );
    return { ...captured, balances: [id] };
  }

  /** A mapping of `ref` to `account`, once per source account. */
  private mapAccount(ref: string, source: string, account: string, status: string): string {
    if (!this.mapped.has(ref)) {
      this.db.run("INSERT INTO source_accounts VALUES(?,?,?,?)", [
        ref,
        source,
        PRODUCER,
        JSON.stringify([ref]),
      ]);
      if (this.db.query("SELECT 1 FROM accounts WHERE id=?").get(account) === null)
        this.db.run("INSERT INTO accounts VALUES(?,'Synthetic','synthetic',?)", [account, status]);
      this.db.run(
        "INSERT INTO account_mappings VALUES(?,?,1,?,'rule','synthetic',1,'2098-01-01','Synthetic',?)",
        [`${ref}-r1`, ref, account, status],
      );
      this.mapped.add(ref);
    }
    return `${ref}-r1`;
  }

  /**
   * A sealed identity run over every observation of a capture, each mapped to
   * `account` with `status`; the n-th position or balance (positions first)
   * uses instrument `instruments[n]` when one is given.
   */
  identify(
    capture: Capture,
    source: string,
    account: string,
    status: "identified" | "provider-local" | "aggregate" | "unresolved",
    instruments: readonly (string | undefined)[] = [],
  ): void {
    const ref = `sa-${account}-${source}`;
    const mapping = this.mapAccount(ref, source, account, status);
    const run = `ir-${capture.parse}`;
    this.db.run("INSERT INTO identity_runs VALUES(?,?,1,'2098-01-01')", [run, capture.parse]);
    this.db.run(
      "INSERT INTO identity_run_policies VALUES(?,?,'identity-default','identity-default-v1',?,'[]')",
      [run, capture.parse, "c".repeat(64)],
    );
    const observations: [string, number][] = [
      ...capture.positions.map((id): [string, number] => ["position", id]),
      ...capture.balances.map((id): [string, number] => ["balance", id]),
    ];
    const valuations = this.db
      .query("SELECT id FROM valuation_observations WHERE parse_run_id=?")
      .all(capture.parse) as { id: number }[];
    for (const [index, [kind, id]] of observations.entries()) {
      const instrument = instruments[index];
      const identity = `io-${run}-${kind}-${id}`;
      this.db.run("INSERT INTO identity_observations VALUES(?,?,?,?,?,?,'[]')", [
        identity,
        run,
        kind,
        id,
        ref,
        mapping,
      ]);
      if (instrument !== undefined) {
        const identifier = `ii-${instrument}`;
        if (this.db.query("SELECT 1 FROM instruments WHERE id=?").get(instrument) === null) {
          this.db.run("INSERT INTO instruments VALUES(?,'security','Synthetic','identified')", [
            instrument,
          ]);
          this.db.run("INSERT INTO instrument_identifiers VALUES(?,'synthetic','test',?,'{}')", [
            identifier,
            instrument,
          ]);
          this.db.run(
            "INSERT INTO instrument_mappings VALUES(?,?,1,?,'rule','synthetic',1,'2098-01-01','Synthetic','identified')",
            [`im-${instrument}`, identifier, instrument],
          );
        }
        this.db.run("INSERT INTO identity_instrument_uses VALUES(?,?,?,?)", [
          identity,
          kind === "position" ? "security" : "unit",
          identifier,
          `im-${instrument}`,
        ]);
      }
    }
    for (const { id } of valuations)
      this.db.run("INSERT INTO identity_observations VALUES(?,?,'valuation',?,?,?,'[]')", [
        `io-${run}-valuation-${id}`,
        run,
        id,
        ref,
        mapping,
      ]);
    this.db.run("INSERT INTO identity_run_seals VALUES(?,?,'2098-01-01')", [
      run,
      observations.length + valuations.length,
    ]);
  }

  /**
   * A settlement review of `statement` (its first balance) against a synthetic
   * bank debit on `debitDate`, proposed and optionally decided. The statement
   * must be identified to `account`: reviews are keyed by resolved account.
   */
  settle(
    statement: Capture,
    input: {
      account: string;
      period: string;
      debitDate: string;
      decision?: "accepted" | "rejected";
    },
  ): string {
    const bank = this.capture({
      source: "smbc-bank",
      dataset: "synthetic-history",
      parser: "synthetic-bank-history",
      fetchedAt: `${input.debitDate}T03:00:00Z`,
    });
    const debit = Number(
      this.db.run(
        `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
         VALUES(?,'synthetic-bank',?,'posted',-1,'-1',0,'JPY',NULL,NULL,?,NULL,'$.rows[0]','{}')`,
        [bank.parse, `debit-${bank.parse}`, `${input.debitDate}T00:00:00+09:00`],
      ).lastInsertRowid,
    );
    const id = `cs_${statement.parse}_${debit}`;
    const statementId = statement.balances[0]!;
    const facts = {
      statement: {
        ref: {
          kind: "balance",
          id: `balance:${statementId}`,
          revision: `parse_run:${statement.parse}`,
        },
        sourceId: "vpass",
        sourceAccount: "synthetic-card",
        accountId: input.account,
        ownerRef: "party:synthetic-self",
        amount: {
          unitRef: "JPY",
          value: {
            status: "exact",
            value: { coefficient: "1", scale: 0 },
            normalizationVersion: "exact-arith-v1",
          },
        },
        paymentDate: {
          kind: "local-date",
          value: input.debitDate,
          zone: "Asia/Tokyo",
          basis: "provider",
        },
        period: input.period,
      },
      bankDebit: {
        ref: {
          kind: "transaction",
          id: `transaction:${debit}`,
          revision: `parse_run:${bank.parse}`,
        },
        sourceId: "smbc-bank",
        sourceAccount: "synthetic-bank",
        accountId: "acct-bank",
        ownerRef: "party:synthetic-self",
        amount: {
          unitRef: "JPY",
          value: {
            status: "exact",
            value: { coefficient: "1", scale: 0 },
            normalizationVersion: "exact-arith-v1",
          },
        },
        occurred: {
          kind: "local-date",
          value: input.debitDate,
          zone: "Asia/Tokyo",
          basis: "provider",
        },
      },
      rationaleCodes: [
        "authoritative_statement_total",
        "observed_bank_debit",
        "amount_equal",
        "date_within_window",
      ],
      rejectionConditions: ["statement_changed", "bank_debit_changed", "allocation_already_used"],
      ownership: "established-same",
      ownershipEvidenceRefs: ["decision:synthetic-owner"],
      feeBreakdown: "unknown",
    };
    this.db.run(
      `INSERT INTO card_settlement_candidates(id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
       VALUES(?,?,?,?,?,?,?,'card-statement-settlement-v1',?,?,'2026-09-01T00:00:00Z')`,
      [
        id,
        `["vpass","${statement.parse}"]`,
        `["smbc-bank","${debit}"]`,
        statementId,
        statement.parse,
        debit,
        bank.parse,
        JSON.stringify(facts),
        String(this.id()).padStart(64, "0"),
      ],
    );
    if (input.decision !== undefined) {
      const decision = `dr-${id}`;
      this.db.run(
        `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
         VALUES(?,'relation',?,1,?,'manual','synthetic-operator',NULL,'synthetic review','[]',NULL,NULL,'2026-09-02T00:00:00Z')`,
        [decision, `card-settlement:${id}`, input.decision === "accepted" ? "accept" : "reject"],
      );
      this.db.run(
        `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
         VALUES(?,1,?,?,?,NULL,?,'2026-09-02T00:00:00Z')`,
        input.decision === "accepted"
          ? [id, "accepted", decision, `event-${id}`, `allocation-${id}`]
          : [id, "rejected", decision, null, null],
      );
    }
    return id;
  }
}
