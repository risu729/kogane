// Small random stores for the statement and settlement reads, on the complete
// CORE schema with foreign keys and every guard trigger on. Each seed draws its
// states at random, and the differential tests run the keyed reads and the
// shipped ones (the migration 0044 views) on the same store:
//
// - statements: several captures of one statement with tied capture times,
//   failed and excluded runs, unpublished parses, other parsers and metrics,
//   the `statementMonth`-only period shape, missing due dates, other snapshot
//   semantics and malformed extras, and two namespaces for one card;
// - identity: none, unsealed, sealed, a newer sealed policy that maps the row to
//   another source account, and a newer unsealed one that must not win; for
//   Vpass, a policy-2 run pinned to the trusted card binding, which wins while
//   the binding is trusted and must not once its run is excluded;
// - mappings: two cards resolved to one account, and remapped revisions;
// - ownership claims: none, `account:`-prefixed, two owners, a claim whose
//   decision was superseded (alone or beside a live one), a rejected claim, a
//   live dated claim that blocks the timeless ones, a dated claim a later
//   timeless one replaces, and a newer claim for the same owner;
// - bank rows: repeated provider ids, missing ids, pending rows, credits,
//   date-only times and other sign sources;
// - SBI Shinsei rows (the second bank adapter, migration 0052): the provider's
//   debit and credit sides, zero debits, foreign currencies, a status and a
//   sign source the parser never sets, timed dates, and re-observed provider
//   ids whose newer capture changes side or currency;
// - settlement candidates keyed by string, missing and numeric facts.
//
// `drawn` records which of these a seed drew, so a test can check that the
// seeds together drew them all. Every value is synthetic.
import type { Database } from "bun:sqlite";
import { fullCoreSchema } from "./card-usage-scale-fixture";

const PRODUCER = "collector-r2-importer";
const CLIENT = "random-client";
const SHA = "a".repeat(64);
const RANDOM_PERIODS = ["2026-06", "2026-07", "2026-08"] as const;
const RANDOM_ACCOUNTS = ["acct-a", "acct-b", "acct-j", "acct-k", "acct-x"] as const;
const PARTIES = ["party:p1", "party:p2"] as const;
const DAY_MS = 86_400_000;

type Source = "vpass" | "myjcb" | "smbc-bank" | "sbi-shinsei-bank";
interface SourceAccount {
  ref: string;
  source: Source;
  /** The observation's `source_account`. */
  raw: string;
  /** The account revision 1 maps it to, or the choices it is drawn from. */
  accounts: readonly string[];
}
const SOURCE_ACCOUNTS: readonly SourceAccount[] = [
  { ref: "sa-vpass-1", source: "vpass", raw: "vpass:card-001", accounts: ["acct-a"] },
  { ref: "sa-vpass-2", source: "vpass", raw: "vpass:card-002", accounts: ["acct-a", "acct-b"] },
  // A new card ordinal of the first card: two source accounts, one account.
  { ref: "sa-vpass-3", source: "vpass", raw: "vpass:card-003", accounts: ["acct-a"] },
  { ref: "sa-myjcb-a", source: "myjcb", raw: "myjcb:conn-a:root", accounts: ["acct-j"] },
  { ref: "sa-myjcb-b", source: "myjcb", raw: "myjcb:conn-b:root", accounts: ["acct-j", "acct-x"] },
  { ref: "sa-bank-1", source: "smbc-bank", raw: "smbc-bank:ordinary-yen", accounts: ["acct-k"] },
  {
    ref: "sa-bank-2",
    source: "smbc-bank",
    raw: "smbc-bank:savings",
    accounts: ["acct-k", "acct-x"],
  },
  {
    ref: "sa-sbi-1",
    source: "sbi-shinsei-bank",
    raw: "sbi-shinsei:SYNTHETIC-001",
    accounts: ["acct-k"],
  },
  {
    ref: "sa-sbi-2",
    source: "sbi-shinsei-bank",
    raw: "sbi-shinsei:SYNTHETIC-002",
    accounts: ["acct-k", "acct-x"],
  },
];

type Bind = string | number | null;

/** A trusted Vpass card binding and the capture unit it binds. */
interface VpassBinding {
  /** The binding fetch run, which a test may exclude. */
  run: number;
  unit: number;
  artifact: number;
  token: string;
  financialUnit: number;
}

export interface RandomSettlementStore {
  db: Database;
  /** Every balance observation written: statement totals and the rows the reads must skip. */
  balances: number[];
  /** Every bank transaction observation written. */
  transactions: number[];
  /** Every (account, source, period) the purchases page could ask for, present or not. */
  triples: [string, string, string][];
  /** The due dates the statements carry, and a date no debit is near. */
  dueDates: string[];
}

function random(seed: number): () => number {
  let state = (seed * 2_654_435_761) >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const shift = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

class Builder {
  readonly db = fullCoreSchema();
  private sequence = 0;
  readonly balances: number[] = [];
  readonly transactions: number[] = [];
  readonly dueDates = new Set<string>();

  constructor(
    private readonly next: () => number,
    readonly drawn: Set<string>,
  ) {}

  run(sql: string, ...binds: Bind[]): number {
    return Number(this.db.query(sql).run(...binds).lastInsertRowid);
  }

  id(): number {
    this.sequence += 1;
    return this.sequence;
  }

  chance(probability: number, state?: string): boolean {
    const hit = this.next() < probability;
    if (hit && state !== undefined) this.drawn.add(state);
    return hit;
  }

  pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.next() * values.length)]!;
  }

  registry(): void {
    this.run(
      "INSERT INTO ingest_clients(id,display_name,active) VALUES(?,'Random client',1)",
      CLIENT,
    );
    this.run(
      "INSERT INTO ingest_client_producers(ingest_client_id,producer_id) VALUES(?,?)",
      CLIENT,
      PRODUCER,
    );
    for (const source of ["vpass", "myjcb", "smbc-bank", "sbi-shinsei-bank"])
      this.run(
        "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES(?,?,?)",
        CLIENT,
        PRODUCER,
        source,
      );
    this.run(
      "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?,3,'objects/random',0)",
      SHA,
    );
    for (const account of RANDOM_ACCOUNTS)
      this.run("INSERT INTO accounts VALUES(?,'Synthetic','card-statement','identified')", account);
    for (const source of SOURCE_ACCOUNTS) {
      this.run(
        "INSERT INTO source_accounts VALUES(?,?,?,?)",
        source.ref,
        source.source,
        PRODUCER,
        JSON.stringify([source.raw]),
      );
      const first = this.pick(source.accounts);
      if (first !== source.accounts[0]) this.drawn.add("two source accounts, one account");
      this.mapping(source.ref, 1, first);
      if (this.chance(0.25, "remapped source account"))
        this.mapping(source.ref, 2, this.pick(RANDOM_ACCOUNTS));
    }
  }

  private mapping(ref: string, revision: number, account: string): void {
    this.run(
      "INSERT INTO account_mappings VALUES(?,?,?,?,'rule','synthetic',1,'2026-01-01','Synthetic','identified')",
      `${ref}-r${revision}`,
      ref,
      revision,
      account,
    );
  }

  private decision(subject: string, revision: number, kind: string): string {
    const id = `dr-${this.id()}`;
    this.run(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation',?,?,?,'manual','synthetic-operator',NULL,'synthetic','[]',NULL,NULL,'2026-01-01')`,
      id,
      subject,
      revision,
      kind,
    );
    return id;
  }

  /** One ownership claim; returns its decision so a test may supersede it. */
  private relation(input: {
    kind: "liable_party" | "beneficial_owner";
    from: string;
    to: string;
    status?: "accepted" | "rejected";
    dated?: boolean;
  }): { id: string; decision: string } {
    const id = `rel-${this.id()}`;
    const status = input.status ?? "accepted";
    const decision = this.decision(id, 1, status === "accepted" ? "accept" : "reject");
    this.run(
      `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
       VALUES(?,?,?,?,?,NULL,?,?,'[]','2026-01-01')`,
      id,
      input.kind,
      input.from,
      input.to,
      input.dated === true ? "2026-01-01" : null,
      status,
      decision,
    );
    return { id, decision };
  }

  /** Every account's ownership claims, one scenario each. */
  ownership(): void {
    const claims: [string, "liable_party" | "beneficial_owner"][] = [
      ["acct-a", "liable_party"],
      ["acct-b", "liable_party"],
      ["acct-j", "liable_party"],
      ["acct-x", "liable_party"],
      ["acct-k", "beneficial_owner"],
      ["acct-x", "beneficial_owner"],
    ];
    for (const [account, kind] of claims) {
      const from = this.chance(0.3, "account:-prefixed claim") ? `account:${account}` : account;
      const scenario = this.pick([
        "none",
        "timeless",
        "timeless",
        "two owners",
        "superseded decision",
        "superseded beside live",
        "rejected claim",
        "live dated claim",
        "dated then timeless",
        "newer claim, same owner",
      ] as const);
      this.drawn.add(`claim: ${scenario}`);
      const claim = (to: string, options: { status?: "rejected"; dated?: boolean } = {}) =>
        this.relation({ kind, from, to, ...options });
      const supersede = (relation: { id: string; decision: string }) => {
        const next = this.decision(relation.id, 2, "supersede");
        this.db
          .query("UPDATE decision_revisions SET superseded_by=? WHERE id=?")
          .run(next, relation.decision);
      };
      switch (scenario) {
        case "none":
          break;
        case "timeless":
          claim(PARTIES[0]);
          break;
        case "two owners":
          claim(PARTIES[0]);
          claim(PARTIES[1]);
          break;
        case "superseded decision":
          supersede(claim(PARTIES[0]));
          break;
        case "superseded beside live":
          supersede(claim(PARTIES[0]));
          claim(PARTIES[1]);
          break;
        case "rejected claim":
          claim(PARTIES[0], { status: "rejected" });
          break;
        case "live dated claim":
          claim(PARTIES[0]);
          claim(PARTIES[1], { dated: true });
          break;
        case "dated then timeless":
          claim(PARTIES[1], { dated: true });
          claim(PARTIES[1]);
          break;
        case "newer claim, same owner":
          claim(PARTIES[0]);
          claim(PARTIES[0]);
          break;
      }
    }
  }

  /**
   * One sealed fetch run with one artifact and a parse of it; returns the
   * parse, whose id is also the run's. The run may have failed, the parse may
   * stay unpublished.
   */
  private capture(input: {
    source: Source;
    namespace: string;
    key: string;
    dataset: string;
    parser: string;
    fetchedAtMs: number;
    /** The card unit the artifact belongs to (a Vpass card ordinal). */
    unitKey?: string | undefined;
    insert: (parse: number) => { kind: "balance" | "transaction"; id: number }[];
  }): { parse: number; observations: { kind: "balance" | "transaction"; id: number }[] } {
    const id = this.id();
    this.run(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?,?,?,?,?,?)`,
      id,
      PRODUCER,
      CLIENT,
      input.namespace,
      `random-session-${id}`,
      input.fetchedAtMs,
    );
    this.run(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,?,?,?,?)`,
      id,
      id,
      PRODUCER,
      input.source,
      CLIENT,
      `run-${id}`,
      input.fetchedAtMs,
    );
    const descriptor = id.toString(16).padStart(64, "0");
    const unit =
      input.unitKey === undefined ? null : this.unit(id, input.unitKey, input.fetchedAtMs);
    this.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,fetch_unit_id,artifact_key,artifact_role,
        payload_fidelity,container_kind,lineage_disposition,dataset,declared_media_type,media_type_basis,fetched_at_ms,fetched_at_basis,
        sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
       VALUES(?,?,?,?,?,?,?,'provider_response','exact','single','not_applicable',?,'application/json','response_header',?,'response',?,3,'v1',?,?)`,
      id,
      id,
      input.source,
      PRODUCER,
      CLIENT,
      unit,
      input.key,
      input.dataset,
      input.fetchedAtMs,
      SHA,
      descriptor,
      input.fetchedAtMs,
    );
    this.run(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
       VALUES(?,?,?,1,'operator',?,?)`,
      id,
      id,
      descriptor,
      input.fetchedAtMs,
      CLIENT,
    );
    this.run(
      "INSERT INTO run_inventory_items(inventory_id,fetch_run_id,artifact_key,sha256,descriptor_sha256) VALUES(?,?,?,?,?)",
      id,
      id,
      input.key,
      SHA,
      descriptor,
    );
    this.run(
      `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,recorded_at_ms)
       VALUES(?,'terminal','terminal',?,?,?)`,
      id,
      CLIENT,
      this.chance(0.12, "failed run") ? "failed" : "success",
      input.fetchedAtMs,
    );
    this.run(
      "INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?,?,?,?)",
      id,
      id,
      input.fetchedAtMs,
      CLIENT,
    );
    const parser = this.chance(0.08, "other parser") ? "synthetic-other-parser" : input.parser;
    this.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1.0.0','2026-09-01','pending','[]')",
      id,
      id,
      parser,
    );
    const observations = input.insert(id);
    this.run("UPDATE parse_runs SET status='ok' WHERE id=?", id);
    if (!this.chance(0.1, "unpublished parse")) {
      this.run(
        "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,?,NULL,?,'normal','pipeline','parse_ok','2026-09-01')",
        id,
        parser,
        id,
      );
      this.run(
        "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,?,?,'1.0.0','2026-09-01','normal')",
        id,
        parser,
        id,
      );
    }
    return { parse: id, observations };
  }

  /** One card unit of a fetch run, with its successful terminal report. */
  private unit(run: number, key: string, at: number): number {
    const unit = this.id();
    this.run(
      `INSERT INTO fetch_units(id,fetch_run_id,unit_kind,unit_key,terminal_report_required,recorded_by_client_id,recorded_at_ms)
       VALUES(?,?,'card',?,1,?,?)`,
      unit,
      run,
      key,
      CLIENT,
      at,
    );
    this.run(
      `INSERT INTO fetch_unit_reports(fetch_unit_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,recorded_at_ms)
       VALUES(?,'terminal','terminal',?,'success',?)`,
      unit,
      CLIENT,
      at,
    );
    return unit;
  }

  /**
   * The trusted importer card binding run of one Vpass card capture, in the
   * capture's session (migration 0020 `trusted_vpass_card_bindings`): one card
   * unit keyed by the card token and its binding sidecar.
   */
  private vpassBinding(
    session: number,
    card: string,
    at: number,
  ): Omit<VpassBinding, "financialUnit"> {
    const run = this.id();
    const token = `vpass-card-v1-${run.toString(16).padStart(64, "0")}`;
    this.run(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,'vpass',?,?,?)`,
      run,
      session,
      PRODUCER,
      CLIENT,
      `${card}-vpass-card-binding-v1`,
      at,
    );
    const unit = this.unit(run, token, at);
    const artifact = this.id();
    const descriptor = artifact.toString(16).padStart(64, "0");
    this.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,fetch_unit_id,artifact_key,artifact_role,
        payload_fidelity,container_kind,lineage_disposition,dataset,format_id,format_version,declared_media_type,media_type_basis,
        fetched_at_ms,fetched_at_basis,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
       VALUES(?,?,'vpass',?,?,?,'card-identity-binding.json','collector_derived','transformed','single','source_not_retained_for_security',
        'card-identity-binding','vpass-card-identity-binding-json','1','application/json','response_header',?,'response',?,3,'v1',?,?)`,
      artifact,
      run,
      PRODUCER,
      CLIENT,
      unit,
      at,
      SHA,
      descriptor,
      at,
    );
    for (const [index, kind] of ["extracted", "redacted"].entries())
      this.run(
        `INSERT INTO artifact_transform_steps(fetch_artifact_id,step_index,step_kind,transformer_id,transformer_version,recorded_by_client_id,recorded_at_ms)
         VALUES(?,?,?,'synthetic','1',?,?)`,
        artifact,
        index,
        kind,
        CLIENT,
        at,
      );
    this.run(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
       VALUES(?,?,?,1,'operator',?,?)`,
      run,
      run,
      descriptor,
      at,
      CLIENT,
    );
    this.run(
      "INSERT INTO run_inventory_items(inventory_id,fetch_run_id,artifact_key,sha256,descriptor_sha256) VALUES(?,?,'card-identity-binding.json',?,?)",
      run,
      run,
      SHA,
      descriptor,
    );
    this.run(
      `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,recorded_at_ms)
       VALUES(?,'terminal','terminal',?,'success',?)`,
      run,
      CLIENT,
      at,
    );
    this.run(
      "INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?,?,?,?)",
      run,
      run,
      at,
      CLIENT,
    );
    return { run, unit, artifact, token };
  }

  /**
   * A later exclusion of the run from financial views (after its identity was
   * sealed: a seal needs a visible artifact).
   */
  private maybeExclude(run: number): void {
    if (this.chance(0.08, "excluded run"))
      this.run(
        "INSERT INTO fetch_run_annotations(fetch_run_id,annotation_kind,reason_code,recorded_at_ms) VALUES(?,'exclude_from_financial_views','synthetic',0)",
        run,
      );
  }

  /** An identity run of one parse: every observation mapped to `ref`, sealed unless told otherwise. */
  private identityRun(
    parse: number,
    policy: number,
    ref: string,
    observations: readonly { kind: "balance" | "transaction"; id: number }[],
    sealed: boolean,
    pin?: VpassBinding,
  ): void {
    const run = `ir-${parse}-${policy}`;
    this.run("INSERT INTO identity_runs VALUES(?,?,?,'2026-09-01')", run, parse, policy);
    if (pin !== undefined)
      this.run(
        "INSERT INTO identity_vpass_bindings VALUES(?,?,?,?)",
        run,
        pin.financialUnit,
        pin.artifact,
        pin.token,
      );
    for (const { kind, id } of observations)
      this.run(
        "INSERT INTO identity_observations VALUES(?,?,?,?,?,?,'[]')",
        `io-${run}-${kind}-${id}`,
        run,
        kind,
        id,
        ref,
        `${ref}-r1`,
      );
    if (sealed)
      this.run("INSERT INTO identity_run_seals VALUES(?,?,'2026-09-01')", run, observations.length);
  }

  /**
   * The identity of one parse: none, unsealed or sealed at policy 1, and
   * sometimes a policy-2 run mapping it elsewhere. For a source other than
   * Vpass that run is sealed (it wins) or not (it must not); for Vpass it is
   * pinned to the capture's trusted card binding and sealed, and the binding
   * run may later be excluded, which makes the run ineligible (migration 0020
   * `eligible_identity_runs`) so that policy 1 wins again.
   */
  identity(
    source: SourceAccount,
    parse: number,
    observations: readonly { kind: "balance" | "transaction"; id: number }[],
    binding?: VpassBinding,
  ): void {
    if (this.chance(0.08, "no identity")) return;
    const peers = SOURCE_ACCOUNTS.filter((entry) => entry.source === source.source);
    const ref = this.chance(0.15, "identity names another source account")
      ? this.pick(peers).ref
      : source.ref;
    this.identityRun(parse, 1, ref, observations, !this.chance(0.1, "unsealed identity"));
    if (source.source === "vpass") {
      // The pin needs the binding to be trusted now: a failed capture has none.
      const trusted =
        binding !== undefined &&
        this.db
          .query("SELECT 1 FROM trusted_vpass_card_bindings WHERE financial_artifact_id=?")
          .get(parse) !== null;
      if (!trusted || !this.chance(0.4)) return;
      this.identityRun(parse, 2, this.pick(peers).ref, observations, true, binding);
      if (this.chance(0.5, "binding no longer trusted"))
        this.run(
          "INSERT INTO fetch_run_annotations(fetch_run_id,annotation_kind,reason_code,recorded_at_ms) VALUES(?,'exclude_from_financial_views','synthetic',0)",
          binding.run,
        );
      else this.drawn.add("pinned binding policy");
      return;
    }
    if (!this.chance(0.3)) return;
    const sealed = this.chance(0.6);
    this.drawn.add(sealed ? "newer sealed policy" : "newer unsealed policy");
    this.identityRun(parse, 2, this.pick(peers).ref, observations, sealed);
  }

  statement(source: SourceAccount, period: string, fetchedAtMs: number): void {
    const vpass = source.source === "vpass";
    const namespace = this.chance(0.1, "second namespace")
      ? `${source.source}-alternate-v1`
      : vpass
        ? "vpass-worker-card-v1"
        : "myjcb-connection-v1";
    const month = period.replace("-", "");
    const due = shift(`${period}-${vpass ? "26" : "10"}`, Math.floor(this.next() * 3) - 1);
    const facts: Record<string, string> = {
      statementMonth: month,
      snapshotSemantics: "provider-reported-monthly-payment-amount",
    };
    if (!(vpass && this.chance(0.2, "statementMonth only"))) facts["period"] = period;
    if (!this.chance(0.12, "no payment date")) {
      facts["paymentDate"] = due;
      this.dueDates.add(due);
    }
    if (this.chance(0.05, "other snapshot semantics")) facts["snapshotSemantics"] = "other";
    const extra = this.chance(0.03, "malformed extra") ? "{" : JSON.stringify({ _kogane: facts });
    const metric = this.chance(0.05, "other metric")
      ? "credit_statement_balance"
      : "credit_statement_payment_amount";
    const total = 1_000 + Math.floor(this.next() * 20) * 1_000;
    // A Vpass capture belongs to its card's unit, as the importer's does.
    const card = vpass ? source.raw.slice("vpass:".length) : undefined;
    const { parse, observations } = this.capture({
      source: source.source,
      namespace,
      unitKey: card,
      key: vpass ? `months/${month}/top-000.json` : `conn-a/credit-detail-01.html`,
      dataset: vpass ? "statement-page" : "credit-detail",
      parser: vpass ? "vpass-statement-page" : "myjcb-credit-statement-total",
      fetchedAtMs,
      insert: (parseRun) => {
        const id = this.run(
          `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
           VALUES(?,?,?,?,?,0,'JPY',?,'json:$.statement',?)`,
          parseRun,
          source.raw,
          metric,
          total,
          String(total),
          `${period}-01`,
          extra,
        );
        this.balances.push(id);
        return [{ kind: "balance", id }];
      },
    });
    const binding =
      card === undefined
        ? undefined
        : { ...this.vpassBinding(parse, card, fetchedAtMs), financialUnit: this.unitOf(parse) };
    this.identity(source, parse, observations, binding);
    this.maybeExclude(parse);
    if (facts["paymentDate"] !== undefined && this.chance(0.7))
      if (this.chance(0.4, "SBI Shinsei capture")) this.sbiShinseiDebits(due, total, fetchedAtMs);
      else this.debits(due, total, fetchedAtMs);
  }

  /** The card unit of a capture's artifact. */
  private unitOf(artifact: number): number {
    return (
      this.db
        .query("SELECT fetch_unit_id AS unit FROM fetch_artifacts WHERE id=?")
        .get(artifact) as {
        unit: number;
      }
    ).unit;
  }

  /** One bank capture of one to three rows around a due date. */
  private debits(due: string, total: number, fetchedAtMs: number): void {
    const source = this.pick(SOURCE_ACCOUNTS.filter((entry) => entry.source === "smbc-bank"));
    const count = 1 + Math.floor(this.next() * 3);
    const { parse, observations } = this.capture({
      source: "smbc-bank",
      namespace: "smbc-direct-v1",
      key: `transactions/${due.replaceAll("-", "")}.normalized.json`,
      dataset: "transactions-normalized",
      parser: "smbc-direct-transactions",
      fetchedAtMs: fetchedAtMs + 3_600_000,
      insert: (parseRun) =>
        Array.from({ length: count }, () => {
          const date = shift(due, Math.floor(this.next() * 11) - 5);
          const credit = this.chance(0.1, "credit row");
          const amount = this.chance(0.7) ? total : 1_000 + Math.floor(this.next() * 20) * 1_000;
          const externalId = this.chance(0.08, "row without provider id")
            ? this.pick([null, ""])
            : // A small id space, so later captures restate earlier rows.
              `debit-${due.slice(0, 7)}-${Math.floor(this.next() * 3)}`;
          const id = this.run(
            `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,
              currency,description,as_of,raw_locator,extra_json)
             VALUES(?,?,?,?,?,?,0,'JPY','synthetic',?,'json:$.transactions[0]',?)`,
            parseRun,
            source.raw,
            externalId,
            this.chance(0.1, "pending bank row") ? "pending" : "posted",
            credit ? amount : -amount,
            String(credit ? amount : -amount),
            this.chance(0.1, "date-only bank time") ? date : `${date}T00:00:00+09:00`,
            JSON.stringify({
              _kogane: {
                direction: credit ? "inflow" : "outflow",
                amountSignSource: this.chance(0.05, "other sign source") ? "text" : "direction",
              },
            }),
          );
          this.transactions.push(id);
          return { kind: "transaction" as const, id };
        }),
    });
    this.identity(source, parse, observations);
    this.maybeExclude(parse);
  }

  /**
   * One SBI Shinsei activity capture of one to three rows around a due date,
   * as `sbi-shinsei-top-balances-and-activity` stores them: the provider's
   * side in `_kogane.amountSignSource`, a debit signed negative unless zero,
   * the posting date as `YYYY-MM-DD` and no status; and the drawn departures
   * from that shape the adapter must refuse.
   */
  private sbiShinseiDebits(due: string, total: number, fetchedAtMs: number): void {
    const source = this.pick(
      SOURCE_ACCOUNTS.filter((entry) => entry.source === "sbi-shinsei-bank"),
    );
    const count = 1 + Math.floor(this.next() * 3);
    const { parse, observations } = this.capture({
      source: "sbi-shinsei-bank",
      namespace: "sbi-shinsei-v1",
      key: "top-accounts-balance-and-activity.json",
      dataset: "top-accounts-balance-and-activity",
      parser: "sbi-shinsei-top-balances-and-activity",
      fetchedAtMs: fetchedAtMs + 1_800_000,
      insert: (parseRun) =>
        Array.from({ length: count }, () => {
          const date = shift(due, Math.floor(this.next() * 11) - 5);
          const side = this.chance(0.15, "SBI Shinsei credit row") ? "credit" : "debit";
          const zero = this.chance(0.08, "SBI Shinsei zero debit");
          const foreign = this.chance(0.1, "SBI Shinsei foreign currency");
          const magnitude = zero
            ? 0
            : this.chance(0.7)
              ? total
              : 1_000 + Math.floor(this.next() * 20) * 1_000;
          const sign = side === "debit" && !zero ? "-" : "";
          const text = `${sign}${foreign ? (magnitude / 100).toFixed(2) : String(magnitude)}`;
          const externalId = this.chance(0.05, "SBI Shinsei row without provider id")
            ? this.pick([null, ""])
            : // A small id space, so later captures restate earlier rows.
              `sbi-${due.slice(0, 7)}-${Math.floor(this.next() * 3)}`;
          const id = this.run(
            `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,
              currency,description,as_of,raw_locator,extra_json)
             VALUES(?,?,?,?,?,?,?,?,'synthetic',?,'json:$.responseParam.activity.responseParam.activityDetails[0]',?)`,
            parseRun,
            source.raw,
            externalId,
            this.chance(0.06, "SBI Shinsei row with a status") ? "posted" : null,
            sign === "-" ? -magnitude : magnitude,
            text,
            foreign ? 2 : 0,
            foreign ? "USD" : "JPY",
            this.chance(0.06, "SBI Shinsei timed date") ? `${date}T00:00:00+09:00` : date,
            JSON.stringify({
              _kogane: {
                sourceView: "top_activity",
                // A negative row whose side is not the provider's own column.
                amountSignSource: this.chance(0.06, "SBI Shinsei other sign source")
                  ? "text"
                  : side,
              },
            }),
          );
          this.transactions.push(id);
          return { kind: "transaction" as const, id };
        }),
    });
    this.identity(source, parse, observations);
    this.maybeExclude(parse);
  }

  /** Settlement candidates over written statements and debits, keyed as the reads look them up. */
  candidates(): void {
    const statements = this.db
      .query("SELECT id,parse_run_id FROM balance_observations ORDER BY id")
      .all() as { id: number; parse_run_id: number }[];
    const banks = this.db
      .query("SELECT id,parse_run_id FROM transaction_observations ORDER BY id")
      .all() as { id: number; parse_run_id: number }[];
    if (statements.length === 0 || banks.length === 0) return;
    const count = 3 + Math.floor(this.next() * 8);
    for (let index = 0; index < count; index += 1) {
      const statement = this.pick(statements);
      const bank = this.pick(banks);
      const shape = this.pick([
        "keyed",
        "keyed",
        "keyed",
        "numeric account",
        "no account",
      ] as const);
      this.drawn.add(`candidate: ${shape}`);
      const key = {
        sourceId: this.pick(["vpass", "myjcb"]),
        accountId:
          shape === "numeric account"
            ? 7
            : shape === "no account"
              ? undefined
              : this.pick(RANDOM_ACCOUNTS),
        period: this.pick(RANDOM_PERIODS),
      };
      const n = this.id();
      const id = `cs_random_${n}`;
      this.run(
        `INSERT INTO card_settlement_candidates(id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,
          bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
         VALUES(?,?,?,?,?,?,?,'card-statement-settlement-v1',?,?,?)`,
        id,
        `statement-${n}`,
        `bank-${n}`,
        statement.id,
        statement.parse_run_id,
        bank.id,
        bank.parse_run_id,
        JSON.stringify({ statement: key }),
        n.toString(16).padStart(64, "0"),
        `2026-09-${String(1 + Math.floor(this.next() * 28)).padStart(2, "0")}T00:00:00Z`,
      );
      if (this.chance(0.3, "rejected candidate")) {
        const decision = `dr-review-${n}`;
        this.run(
          `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
           VALUES(?,'relation',?,1,'reject','manual','synthetic-operator',NULL,'synthetic','[]',NULL,NULL,'2026-09-01')`,
          decision,
          `card-settlement:${id}`,
        );
        this.run(
          `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
           VALUES(?,1,'rejected',?,NULL,NULL,NULL,'2026-09-01')`,
          id,
          decision,
        );
      }
    }
  }
}

/** A statement or bank row a review may cite, with its key and owner if it has them. */
interface Cited {
  id: number;
  parse_run_id: number;
  key: string;
  source_id: string;
  period: string | null;
  account_id: string | null;
  owner_ref: string | null;
  evidence_refs_json: string | null;
}

/**
 * The reviews `card_settlement_readiness` (migration 0044) judges, built on the
 * rows of the store as the sweep builds them, then drawn away from it: every
 * flag of the view both holds and fails. Candidates cite a current statement
 * or an older capture, a current debit or another bank row, under their real
 * keys or other ones, with the facts the owners give or other accounts,
 * parties and evidence. Some are rejected, accepted with a settlement
 * allocation of their debit, or accepted and withdrawn; other allocations cite
 * bank rows directly, and some of those are superseded.
 */
class Reviews {
  private accepted = 0;

  constructor(private readonly builder: Builder) {}

  private statements(): Cited[] {
    const { db } = this.builder;
    const current = db
      .query(
        `SELECT s.id,s.parse_run_id,s.statement_key AS key,s.source_id,s.period,o.account_id,o.owner_ref,o.evidence_refs_json
         FROM card_statement_facts s LEFT JOIN card_settlement_fact_ownership o ON o.kind='balance' AND o.observation_id=s.id ORDER BY s.id`,
      )
      .all() as Cited[];
    const older = db
      .query(
        `SELECT b.id,b.parse_run_id,json_array(fa.source_id,fr.producer_id,ses.external_id_namespace,b.source_account,'2026-07') AS key,
          fa.source_id,'2026-07' AS period,NULL AS account_id,NULL AS owner_ref,NULL AS evidence_refs_json
         FROM balance_observations b JOIN parse_runs p ON p.id=b.parse_run_id JOIN fetch_artifacts fa ON fa.id=p.fetch_artifact_id
         JOIN fetch_runs fr ON fr.id=fa.fetch_run_id JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
         WHERE b.id NOT IN (SELECT id FROM card_statement_facts) ORDER BY b.id`,
      )
      .all() as Cited[];
    return [...current, ...current, ...older];
  }

  private debits(): Cited[] {
    const { db } = this.builder;
    const current = db
      .query(
        `SELECT b.id,b.parse_run_id,b.bank_key AS key,b.source_id,NULL AS period,o.account_id,o.owner_ref,o.evidence_refs_json
         FROM card_bank_debit_facts b LEFT JOIN card_settlement_fact_ownership o ON o.kind='transaction' AND o.observation_id=b.id ORDER BY b.id`,
      )
      .all() as Cited[];
    // Every bank row under the key of its provider id, current or not.
    const rows = db
      .query(
        `SELECT t.id,t.parse_run_id,json_array(fa.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS key,
          fa.source_id,NULL AS period,o.account_id,o.owner_ref,o.evidence_refs_json
         FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id JOIN fetch_artifacts fa ON fa.id=p.fetch_artifact_id
         JOIN fetch_runs fr ON fr.id=fa.fetch_run_id JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
         LEFT JOIN card_settlement_fact_ownership o ON o.kind='transaction' AND o.observation_id=t.id ORDER BY t.id`,
      )
      .all() as Cited[];
    return [...current, ...current, ...rows];
  }

  private decision(subject: string, revision: number, kind: string): string {
    const id = `dr-${this.builder.id()}`;
    this.builder.run(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation',?,?,?,'manual','synthetic-operator',NULL,'synthetic','[]',NULL,NULL,'2026-09-01')`,
      id,
      subject,
      revision,
      kind,
    );
    return id;
  }

  /** One allocation citing a bank row; returns its id. */
  allocation(bank: number, role: string, target: string): string {
    const id = `alloc-${this.builder.id()}`;
    const decision = this.decision(`allocation:${id}`, 1, "accept");
    this.builder.run(
      `INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,superseded_by,created_at)
       VALUES(?,?,?,?,'JPY','1000',0,?,NULL,'2026-09-01')`,
      id,
      `transaction:${bank}`,
      target,
      role,
      decision,
    );
    return id;
  }

  private settle(id: string, bank: number, withdraw: boolean): void {
    const b = this.builder;
    const n = (this.accepted += 1);
    const event = `event-review-${n}`;
    const allocation = this.allocation(bank, "settlement", `event:${event}`);
    b.run(
      `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
       VALUES(?,1,'accepted',?,?,NULL,?,'2026-09-01')`,
      id,
      this.decision(`card-settlement:${id}`, 1, "accept"),
      event,
      allocation,
    );
    if (!withdraw) return;
    b.run(
      `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
       VALUES(?,2,'withdrawn',?,?,NULL,?,'2026-09-02')`,
      id,
      this.decision(`card-settlement:${id}`, 2, "supersede"),
      event,
      allocation,
    );
    b.run(
      "INSERT INTO card_settlement_allocation_withdrawals(settlement_id,decision_revision_id,created_at) VALUES(?,?,'2026-09-02')",
      allocation,
      this.decision(`allocation:${allocation}`, 2, "supersede"),
    );
  }

  write(): void {
    const b = this.builder;
    const statements = this.statements();
    const debits = this.debits();
    if (statements.length === 0 || debits.length === 0) return;
    const owned = statements.filter((statement) => statement.owner_ref !== null);
    const count = 8 + Math.floor(statements.length / 2);
    for (let index = 0; index < count; index += 1) {
      // Mostly a statement with an owner, whose review can be ready.
      const statement =
        owned.length > 0 && b.chance(0.5, "review: owned statement")
          ? b.pick(owned)
          : b.pick(statements);
      // Mostly a debit of the statement's owner, as the sweep pairs them.
      const same = debits.filter(
        (debit) => debit.owner_ref !== null && debit.owner_ref === statement.owner_ref,
      );
      const debit =
        same.length > 0 && b.chance(0.6, "review: same owner") ? b.pick(same) : b.pick(debits);
      const n = b.id();
      const id = `cs_review_${n}`;
      const statementKey = b.chance(0.8) ? statement.key : `statement-review-${n}`;
      const bankKey = b.chance(0.8, "review: debit key")
        ? debit.key
        : b.chance(0.5, "review: another debit's key")
          ? b.pick(debits).key
          : `bank-review-${n}`;
      const evidence = [
        ...new Set([
          ...(JSON.parse(statement.evidence_refs_json ?? "[]") as string[]),
          ...(JSON.parse(debit.evidence_refs_json ?? "[]") as string[]),
        ]),
      ];
      // The facts the owners give, or with exactly one of them drawn otherwise.
      const facts = {
        statement: {
          sourceId: statement.source_id,
          accountId: statement.account_id as string | number | null,
          ownerRef: statement.owner_ref,
          period: statement.period,
        },
        bankDebit: { accountId: debit.account_id, ownerRef: debit.owner_ref },
        ownershipEvidenceRefs: evidence,
      };
      if (b.chance(0.6)) {
        const changed = b.pick([
          "statement source",
          "statement account",
          "statement owner",
          "statement period",
          "debit account",
          "debit owner",
          "evidence missing a ref",
          "evidence with another ref",
        ] as const);
        b.drawn.add(`review: ${changed}`);
        switch (changed) {
          case "statement source":
            facts.statement.sourceId = statement.source_id === "vpass" ? "myjcb" : "vpass";
            break;
          case "statement account":
            facts.statement.accountId = b.pick([...RANDOM_ACCOUNTS, null, 7]);
            break;
          case "statement owner":
            facts.statement.ownerRef = b.pick([...PARTIES, null]);
            break;
          case "statement period":
            facts.statement.period = b.pick(RANDOM_PERIODS);
            break;
          case "debit account":
            facts.bankDebit.accountId = b.pick([...RANDOM_ACCOUNTS, null]);
            break;
          case "debit owner":
            facts.bankDebit.ownerRef = b.pick([...PARTIES, null]);
            break;
          case "evidence missing a ref":
            facts.ownershipEvidenceRefs = evidence.slice(1);
            break;
          case "evidence with another ref":
            facts.ownershipEvidenceRefs = [...evidence, "relation:synthetic-extra"];
            break;
        }
      }
      b.run(
        `INSERT INTO card_settlement_candidates(id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,
          bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
         VALUES(?,?,?,?,?,?,?,'card-statement-settlement-v1',?,?,?)`,
        id,
        statementKey,
        bankKey,
        statement.id,
        statement.parse_run_id,
        debit.id,
        debit.parse_run_id,
        JSON.stringify(facts),
        n.toString(16).padStart(64, "0"),
        `2026-09-${String(1 + Math.floor(b.pick([0, 5, 5, 10, 20]))).padStart(2, "0")}T00:00:00Z`,
      );
      // Mostly still proposed: an acceptance reserves its statement and debit for every other review.
      const decision = b.pick([
        "proposed",
        "proposed",
        "proposed",
        "proposed",
        "rejected",
        "accepted",
        "withdrawn",
      ] as const);
      b.drawn.add(`review: ${decision}`);
      if (decision === "rejected")
        b.run(
          `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
           VALUES(?,1,'rejected',?,NULL,NULL,NULL,'2026-09-01')`,
          id,
          this.decision(`card-settlement:${id}`, 1, "reject"),
        );
      else if (decision !== "proposed") this.settle(id, debit.id, decision === "withdrawn");
    }
    // Allocations that are not a review's: a transfer of a bank row, some superseded.
    for (let index = 0; index < 2; index += 1) {
      const debit = b.pick(debits);
      const first = this.allocation(debit.id, "transfer", `event:transfer-${b.id()}`);
      if (b.chance(0.4, "review: superseded allocation")) {
        const next = this.allocation(b.pick(debits).id, "transfer", `event:transfer-${b.id()}`);
        b.run("UPDATE allocations SET superseded_by=? WHERE id=?", next, first);
      } else b.drawn.add("review: other allocation");
    }
  }
}

/** One random store; `drawn` collects the states the seed drew. */
export function randomSettlementStore(seed: number, drawn: Set<string>): RandomSettlementStore {
  const builder = new Builder(random(seed), drawn);
  builder.registry();
  builder.ownership();
  const base = Date.parse("2026-06-01T03:00:00Z");
  for (const period of RANDOM_PERIODS)
    for (const source of SOURCE_ACCOUNTS.filter(
      (entry) => entry.source === "vpass" || entry.source === "myjcb",
    )) {
      if (!builder.chance(0.75)) continue;
      const captures = builder.pick([1, 1, 2, 2, 3]);
      if (captures > 1) drawn.add("recaptured statement");
      const times = new Set<number>();
      for (let capture = 0; capture < captures; capture += 1) {
        // Few distinct times, so two captures of one statement can tie.
        const at = base + builder.pick([0, 1, 1, 2]) * 3_600_000;
        if (times.has(at)) drawn.add("tied capture time");
        times.add(at);
        builder.statement(source, period, at);
      }
    }
  builder.candidates();
  new Reviews(builder).write();
  const triples: [string, string, string][] = [];
  for (const account of RANDOM_ACCOUNTS)
    for (const source of ["vpass", "myjcb"])
      for (const period of [...RANDOM_PERIODS, "2026-01"]) triples.push([account, source, period]);
  return {
    db: builder.db,
    balances: builder.balances,
    transactions: builder.transactions,
    triples,
    dueDates: [...builder.dueDates, "2025-01-15"].sort(),
  };
}

/** The states the coverage checks require the seeds together to draw. */
export const RANDOM_STATES = [
  "two source accounts, one account",
  "remapped source account",
  "account:-prefixed claim",
  "claim: none",
  "claim: timeless",
  "claim: two owners",
  "claim: superseded decision",
  "claim: superseded beside live",
  "claim: rejected claim",
  "claim: live dated claim",
  "claim: dated then timeless",
  "claim: newer claim, same owner",
  "failed run",
  "excluded run",
  "other parser",
  "unpublished parse",
  "no identity",
  "identity names another source account",
  "unsealed identity",
  "newer sealed policy",
  "newer unsealed policy",
  "pinned binding policy",
  "binding no longer trusted",
  "second namespace",
  "statementMonth only",
  "no payment date",
  "other snapshot semantics",
  "malformed extra",
  "other metric",
  "recaptured statement",
  "tied capture time",
  "credit row",
  "row without provider id",
  "pending bank row",
  "date-only bank time",
  "other sign source",
  "SBI Shinsei capture",
  "SBI Shinsei credit row",
  "SBI Shinsei zero debit",
  "SBI Shinsei foreign currency",
  "SBI Shinsei row without provider id",
  "SBI Shinsei row with a status",
  "SBI Shinsei timed date",
  "SBI Shinsei other sign source",
  "candidate: keyed",
  "candidate: numeric account",
  "candidate: no account",
  "rejected candidate",
] as const;

/** The review states the readiness checks require the seeds together to draw. */
export const READINESS_STATES = [
  "review: debit key",
  "review: another debit's key",
  "review: owned statement",
  "review: same owner",
  "review: statement source",
  "review: statement account",
  "review: statement owner",
  "review: statement period",
  "review: debit account",
  "review: debit owner",
  "review: evidence missing a ref",
  "review: evidence with another ref",
  "review: proposed",
  "review: rejected",
  "review: accepted",
  "review: withdrawn",
  "review: superseded allocation",
  "review: other allocation",
] as const;
