// A synthetic card store for the current card usage read and the Transactions
// page: CORE migrations 0017+ over the minimal Layer A stub the events and
// identity tests use, plus fetch units, Vpass card bindings and identity runs.
// Every Vpass and MyJCB observation is produced by the deployed parser from a
// synthetic payload, so each `extra_json` path the query reads is the one
// those parsers really emit. No provider data, account or card appears here.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { myJcbCreditLedger } from "../../../packages/parsers/src/parsers/myjcb";
import { vpassStatementPage } from "../../../packages/parsers/src/parsers/vpass";
import type { ArtifactMeta, Observation, Parser } from "../../../packages/parsers/src/types";

const MIGRATIONS = join(import.meta.dir, "../../../packages/storage-d1/migrations/core");
const VPASS_TEMPLATES = join(
  import.meta.dir,
  "../../../tests/fixtures/observation-pipeline/vpass-parser-boundaries",
);
const LAYER_A = `CREATE TABLE sources(id TEXT PRIMARY KEY,provider TEXT);
CREATE TABLE ingest_clients(id TEXT PRIMARY KEY,active INTEGER);
CREATE TABLE producers(id TEXT PRIMARY KEY);
CREATE TABLE fetch_runs(id INTEGER PRIMARY KEY,source_id TEXT,acquisition_session_id INTEGER,producer_id TEXT,first_recorded_at_ms INTEGER,source_run_key TEXT DEFAULT 'default');
CREATE TABLE fetch_run_annotations(fetch_run_id INTEGER,annotation_kind TEXT);
CREATE VIEW financial_fetch_runs AS SELECT * FROM fetch_runs WHERE source_id<>'kogane-synthetic' AND NOT EXISTS(SELECT 1 FROM fetch_run_annotations a WHERE a.fetch_run_id=fetch_runs.id AND a.annotation_kind='exclude_from_financial_views');
CREATE TABLE acquisition_sessions(id INTEGER PRIMARY KEY,external_session_id TEXT,producer_id TEXT,external_id_namespace TEXT);
CREATE TABLE fetch_run_seals(fetch_run_id INTEGER,sealed_at_ms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE fetch_run_reports(fetch_run_id INTEGER,report_kind TEXT,normalized_outcome TEXT,started_at_ms INTEGER,completed_at_ms INTEGER);
CREATE TABLE fetch_units(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,unit_key TEXT,unit_kind TEXT DEFAULT 'card');
CREATE TABLE fetch_unit_reports(fetch_unit_id INTEGER,report_kind TEXT,normalized_outcome TEXT,safe_failure_code TEXT);
CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,source_id TEXT,dataset TEXT,artifact_key TEXT,fetch_unit_id INTEGER,declared_media_type TEXT,fetched_at_ms INTEGER,recorded_at_ms INTEGER,sha256 TEXT,artifact_role TEXT,format_id TEXT,format_version TEXT);
CREATE TABLE raw_objects(sha256 TEXT PRIMARY KEY,byte_size INTEGER,blob_key TEXT);
CREATE TABLE fetch_run_ranges(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);
CREATE TABLE artifact_ranges(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);
INSERT INTO sources VALUES('vpass','synthetic'),('myjcb','synthetic'),('smbc-bank','synthetic');
INSERT INTO producers VALUES('collector-r2-importer');`;

/** The importer producer: the Vpass binding view trusts no other. */
export const PRODUCER = "collector-r2-importer";
/** The namespace the trusted Vpass binding requires (migration 0020). */
export const VPASS_NAMESPACE = "vpass-worker-card-v1";
export const MYJCB_NAMESPACE = "synthetic-myjcb-connection-v1";
export const TOKEN_A = `vpass-card-v1-${"a".repeat(64)}`;
export const TOKEN_B = `vpass-card-v1-${"b".repeat(64)}`;

/** One provider usage row as a synthetic payload states it. */
export interface UsageRow {
  /** Provider date: `YY/MM/DD` for Vpass, `YYYY/MM/DD` for MyJCB. */
  date: string;
  merchant: string;
  /** Provider display amount; empty for an amountless Vpass web row. */
  amount: string;
  paymentType: string;
  /** MyJCB only: the other amount of the row (usage when confirmed, payment when not). */
  other?: string;
  /** MyJCB only: the `今回回数` expanded cell. */
  installment?: string;
}

export interface Parsed {
  artifact: number;
  parse: number;
  observations: number[];
}

type Publication = "published" | "unpublished" | "none";

interface AccountSpec {
  /** `source_accounts.id`, the identity reference. */
  ref: string;
  reference: readonly string[];
  account: string;
  status?: "identified" | "provider-local" | "aggregate" | "unresolved";
}

function migrated(): Database {
  const db = new Database(":memory:");
  db.exec(LAYER_A);
  for (const name of readdirSync(MIGRATIONS)
    // 0043 only removes historical bootstrap rows from the full Layer A
    // schema; this deliberately minimal stub has neither those rows nor the
    // registry and append-only guards that the cleanup touches.
    .filter(
      (entry) =>
        entry.endsWith(".sql") &&
        entry >= "0017" &&
        entry !== "0043_remove_synthetic_bootstrap.sql",
    )
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return db;
}

function template(name: "web" | "customized"): Record<string, unknown> {
  return JSON.parse(readFileSync(join(VPASS_TEMPLATES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

function bean(payload: Record<string, unknown>, name: string): Record<string, unknown> {
  const content = (payload["body"] as Record<string, unknown>)["content"] as Record<
    string,
    unknown
  >;
  return content[name] as Record<string, unknown>;
}

/** A Vpass `WebMeisaiTopDisplayServiceBean` page (posted rows, `4K/005`). */
export function webPayload(rows: readonly UsageRow[]): Uint8Array {
  const payload = template("web");
  bean(payload, "WebMeisaiTopDisplayServiceBean")["meisaiList"] = rows.map((row) => ({
    columnsSize: 11,
    columnsSizeS: "11",
    data: ["4K", "005", "", row.date, row.merchant, row.amount, row.paymentType, "", "", "", ""],
    maxIndex: "10",
    rowType: "4K",
    shiharaiPatternFlag: 0,
  }));
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** A Vpass `CustomizedMeisaiAnsDisplayServiceBean` page (unconfirmed rows). */
export function customizedPayload(month: string, rows: readonly UsageRow[]): Uint8Array {
  const payload = template("customized");
  const target = bean(payload, "CustomizedMeisaiAnsDisplayServiceBean");
  target["seikyuYM"] = month;
  target["responseCnt"] = String(rows.length);
  target["total"] = rows.length;
  target["meisaiList"] = rows.map((row) => ({
    bunkatsuPay: "",
    bunkatsuYaku: row.paymentType,
    genchiKin: "",
    kanzanDate: "",
    kanzanRate: "",
    kmName: row.merchant,
    riyouDate: row.date,
    riyouKin: row.amount,
    shiharaiDate: "",
    shiharaiTotal: "",
    tesuWariKin: row.amount.replace(/^-/u, ""),
    tukaRyaku: "",
    uketsukeKbn: "",
    uriageKbn: row.amount.startsWith("-") ? "6" : "5",
    zokugara: "",
  }));
  return new TextEncoder().encode(JSON.stringify(payload));
}

const CONFIRMED_HEADERS = ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"];
const UNCONFIRMED_HEADERS = ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"];

/** A MyJCB canonical `credit-ledger` JSON as the collector writes it. */
export function ledgerPayload(
  detailMonth: number,
  period: string,
  state: "confirmed" | "unconfirmed",
  rows: readonly UsageRow[],
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      detailMonth,
      period,
      state,
      headers: state === "confirmed" ? CONFIRMED_HEADERS : UNCONFIRMED_HEADERS,
      rows: rows.map((row) => ({
        summaryCells: [row.date, row.merchant, row.paymentType, row.amount],
        expanded:
          state === "confirmed"
            ? {
                ご利用金額: row.other ?? row.amount,
                今回回数: row.installment ?? "",
                摘要: "",
                備考: "",
                訂正サイン: "",
              }
            : { 今回のお支払い金額: row.other ?? row.amount, 今回回数: row.installment ?? "" },
      })),
    }),
  );
}

/** Synthetic CORE store with typed writers for fetch runs, parses and identity. */
export class CardStore {
  readonly db = migrated();
  private sequence = 0;
  private readonly units = new Map<string, number>();
  private readonly accounts = new Set<string>();

  private id(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /**
   * A sealed fetch run of the importer in its own acquisition session (a Vpass
   * binding run must share its financial run's session, migration 0021).
   */
  run(source: "vpass" | "myjcb" | "smbc-bank", outcome: "success" | "failure" = "success"): number {
    const id = this.id();
    const namespace = source === "vpass" ? VPASS_NAMESPACE : MYJCB_NAMESPACE;
    this.db.run(
      "INSERT INTO acquisition_sessions(id,external_session_id,producer_id,external_id_namespace) VALUES(?,?,?,?)",
      [id, `synthetic-session-${id}`, PRODUCER, namespace],
    );
    this.db.run(
      "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(?,?,?,?,0)",
      [id, source, id, PRODUCER],
    );
    this.db.run("INSERT INTO fetch_run_reports VALUES(?,'terminal',?,0,0)", [id, outcome]);
    this.db.run("INSERT INTO fetch_run_seals(fetch_run_id) VALUES(?)", [id]);
    return id;
  }

  private unit(run: number, key: string): number {
    const name = `${run}/${key}`;
    const existing = this.units.get(name);
    if (existing !== undefined) return existing;
    const id = this.id();
    this.db.run(
      "INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,'card')",
      [id, run, key],
    );
    this.units.set(name, id);
    return id;
  }

  /** The trusted importer sidecar binding one card ordinal of a run to a token. */
  bind(run: number, card: string, token: string): number {
    const binding = this.id();
    this.db.run(
      "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms,source_run_key) VALUES(?,'vpass',?,?,0,?)",
      [binding, run, PRODUCER, `${card}-vpass-card-binding-v1`],
    );
    this.db.run("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',0,0)", [binding]);
    this.db.run("INSERT INTO fetch_run_seals(fetch_run_id) VALUES(?)", [binding]);
    const unit = this.unit(binding, token);
    this.db.run("INSERT INTO fetch_unit_reports VALUES(?,'terminal','success',NULL)", [unit]);
    const artifact = this.id();
    this.db.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,artifact_role,format_id,format_version)
       VALUES(?,?,'vpass','card-identity-binding','card-identity-binding.json',?,'collector_derived','vpass-card-identity-binding-json','1')`,
      [artifact, binding, unit],
    );
    return artifact;
  }

  private artifact(input: {
    run: number;
    source: string;
    dataset: string;
    key: string;
    fetchedAt: string;
    unit?: number;
    state?: string;
    period?: string;
  }): number {
    const id = this.id();
    this.db.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role)
       VALUES(?,?,?,?,?,?,'application/json',?,?,?,'provider_response')`,
      [
        id,
        input.run,
        input.source,
        input.dataset,
        input.key,
        input.unit ?? null,
        Date.parse(input.fetchedAt),
        Date.parse(input.fetchedAt),
        id.toString(16).padStart(64, "0"),
      ],
    );
    if (input.state !== undefined || input.period !== undefined)
      this.db.run(
        "INSERT INTO observation_artifact_metadata(fetch_artifact_id,statement_state,period) VALUES(?,?,?)",
        [id, input.state ?? null, input.period ?? null],
      );
    return id;
  }

  /** A pending parse run, its observations, then `ok` and (optionally) publication. */
  private parse(
    artifact: number,
    parser: Parser,
    observations: readonly Observation[],
    publication: Publication,
  ): Parsed {
    const parse = this.id();
    this.db.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'2026-09-01','pending','[]')",
      [parse, artifact, parser.name, parser.version],
    );
    const ids: number[] = [];
    for (const row of observations) {
      if (row.kind !== "transaction") throw new Error(`unexpected ${row.kind} observation`);
      const result = this.db.run(
        `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          parse,
          row.sourceAccount,
          row.externalId ?? null,
          row.status ?? null,
          row.amountMinor ?? null,
          row.amountText ?? null,
          row.amountScale ?? null,
          row.currency ?? null,
          row.description ?? null,
          row.counterparty ?? null,
          row.asOf ?? null,
          row.observedAt ?? null,
          row.rawLocator,
          JSON.stringify(row.extra),
        ],
      );
      ids.push(Number(result.lastInsertRowid));
    }
    this.db.run("UPDATE parse_runs SET status='ok' WHERE id=?", [parse]);
    if (publication === "published") {
      this.db.run(
        "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,?,NULL,?,'normal','pipeline','parse_ok','2026-09-01')",
        [artifact, parser.name, parse],
      );
      this.db.run(
        "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,?,?,?,'2026-09-01','normal')",
        [artifact, parser.name, parse, parser.version],
      );
    }
    return { artifact, parse, observations: ids };
  }

  private meta(
    artifact: number,
    source: string,
    dataset: string,
    key: string,
    fetchedAt: string,
    extra: Partial<ArtifactMeta>,
  ): ArtifactMeta {
    return {
      id: artifact,
      sourceId: source,
      runStatus: "success",
      runFailureCount: 0,
      dataset,
      artifactKey: key,
      url: null,
      mime: "application/json",
      fetchedAt: new Date(Date.parse(fetchedAt)).toISOString(),
      sha256: "0".repeat(64),
      ...extra,
    };
  }

  /**
   * One Vpass statement page of a card-month. `page` is `top-000`,
   * `answer-001`, ...; `publication: "none"` records the artifact only.
   */
  vpassPage(input: {
    run: number;
    card: string;
    month: string;
    page?: string;
    family: "web" | "customized";
    rows: readonly UsageRow[];
    fetchedAt: string;
    publication?: Publication;
  }): Parsed {
    const unit = this.unit(input.run, input.card);
    const key = `cards/${input.card}/months/${input.month}/${input.page ?? "top-000"}.json`;
    const artifact = this.artifact({
      run: input.run,
      source: "vpass",
      dataset: "statement-page",
      key,
      fetchedAt: input.fetchedAt,
      unit,
    });
    const publication = input.publication ?? "published";
    if (publication === "none") return { artifact, parse: 0, observations: [] };
    const bytes =
      input.family === "web" ? webPayload(input.rows) : customizedPayload(input.month, input.rows);
    const result = vpassStatementPage.parse(
      bytes,
      this.meta(artifact, "vpass", "statement-page", key, input.fetchedAt, {
        fetchUnitKey: input.card,
      }),
    );
    return this.parse(artifact, vpassStatementPage, result.observations, publication);
  }

  /** One MyJCB `credit-ledger` artifact of a connection. */
  myjcbLedger(input: {
    run: number;
    connection: string;
    detailMonth: number;
    state: "confirmed" | "unconfirmed";
    period: string;
    rows: readonly UsageRow[];
    fetchedAt: string;
    publication?: Publication;
  }): Parsed {
    const key = `${input.connection}/credit-ledger-${String(input.detailMonth).padStart(2, "0")}.json`;
    const artifact = this.artifact({
      run: input.run,
      source: "myjcb",
      dataset: "credit-ledger",
      key,
      fetchedAt: input.fetchedAt,
      state: input.state,
      period: input.period,
    });
    const publication = input.publication ?? "published";
    if (publication === "none") return { artifact, parse: 0, observations: [] };
    const result = myJcbCreditLedger.parse(
      ledgerPayload(input.detailMonth, input.period, input.state, input.rows),
      this.meta(artifact, "myjcb", "credit-ledger", key, input.fetchedAt, {
        statementState: input.state,
        period: input.period,
      }),
    );
    return this.parse(artifact, myJcbCreditLedger, result.observations, publication);
  }

  /** A bank row with no card snapshot rule, to prove it is not card usage. */
  bankRow(run: number, fetchedAt: string): Parsed {
    const artifact = this.artifact({
      run,
      source: "smbc-bank",
      dataset: "synthetic-history",
      key: "history.json",
      fetchedAt,
    });
    return this.parse(
      artifact,
      {
        name: "synthetic-bank-history",
        version: "1",
        accepts: () => true,
        parse: () => ({ observations: [], warnings: [] }),
      },
      [
        {
          kind: "transaction",
          sourceAccount: "smbc-bank:ordinary-yen",
          externalId: "synthetic-bank-1",
          status: "posted",
          amountMinor: -500,
          amountText: "-500",
          amountScale: 0,
          currency: "JPY",
          description: "synthetic",
          asOf: "2026-05-20",
          rawLocator: "json:$.rows[0]",
          extra: {},
        },
      ],
      "published",
    );
  }

  /** Appends a mapping revision (a first mapping creates the reference and account). */
  mapAccount(spec: AccountSpec, method: "rule" | "manual" = "rule"): void {
    const source = spec.reference[0]!.split(":")[0]!;
    if (!this.accounts.has(spec.ref)) {
      this.db.run("INSERT INTO source_accounts VALUES(?,?,?,?)", [
        spec.ref,
        source,
        PRODUCER,
        JSON.stringify(spec.reference),
      ]);
      this.accounts.add(spec.ref);
    }
    this.db.run(
      "INSERT INTO accounts SELECT ?,'synthetic','card-statement',? WHERE NOT EXISTS(SELECT 1 FROM accounts WHERE id=?)",
      [spec.account, spec.status ?? "provider-local", spec.account],
    );
    const revision =
      (
        this.db
          .query(
            "SELECT coalesce(max(revision),0) AS n FROM account_mappings WHERE source_account_id=?",
          )
          .get(spec.ref) as { n: number }
      ).n + 1;
    this.db.run(
      "INSERT INTO account_mappings VALUES(?,?,?,?,?,'synthetic',1,'2098-01-01','synthetic',?)",
      [
        `${spec.ref}-r${revision}`,
        spec.ref,
        revision,
        spec.account,
        method,
        spec.status ?? "provider-local",
      ],
    );
  }

  /**
   * An identity run over every observation of one parse, sealed unless
   * `sealed` is false. Policy 2 is the `vpass-card-binding` family and needs
   * the pinned trusted binding.
   */
  identify(
    parsed: Parsed,
    spec: AccountSpec,
    policy: { version: 1 } | { version: 2; bindingArtifact: number; token: string },
    sealed = true,
  ): void {
    if (!this.accounts.has(spec.ref)) this.mapAccount(spec);
    const run = `ir-${parsed.parse}-v${policy.version}`;
    const mapping = (
      this.db
        .query("SELECT id FROM current_account_mappings WHERE source_account_id=?")
        .get(spec.ref) as { id: string }
    ).id;
    this.db.run("INSERT INTO identity_runs VALUES(?,?,?,'2098-01-01')", [
      run,
      parsed.parse,
      policy.version,
    ]);
    this.db.run("INSERT INTO identity_run_policies VALUES(?,?,?,?,?,'[]')", [
      run,
      parsed.parse,
      policy.version === 2 ? "vpass-card-binding" : "identity-default",
      policy.version === 2 ? "vpass-card-binding-v2" : "identity-default-v1",
      "c".repeat(64),
    ]);
    if (policy.version === 2) {
      const unit = (
        this.db
          .query("SELECT fetch_unit_id AS id FROM fetch_artifacts WHERE id=?")
          .get(parsed.artifact) as { id: number }
      ).id;
      this.db.run("INSERT INTO identity_vpass_bindings VALUES(?,?,?,?)", [
        run,
        unit,
        policy.bindingArtifact,
        policy.token,
      ]);
    }
    for (const observation of parsed.observations)
      this.db.run("INSERT INTO identity_observations VALUES(?,?,'transaction',?,?,?,'[]')", [
        `io-${run}-${observation}`,
        run,
        observation,
        spec.ref,
        mapping,
      ]);
    if (sealed)
      this.db.run("INSERT INTO identity_run_seals VALUES(?,?,'2098-01-01')", [
        run,
        parsed.observations.length,
      ]);
  }

  /**
   * Annotates the binding run behind `bindingArtifact` as excluded from
   * financial views, so the trusted binding (0020) and every identity run
   * pinned to it stop being eligible, as later evidence exclusions do.
   */
  excludeBinding(bindingArtifact: number): void {
    this.db.run(
      "INSERT INTO fetch_run_annotations SELECT fetch_run_id,'exclude_from_financial_views' FROM fetch_artifacts WHERE id=?",
      [bindingArtifact],
    );
  }

  /** Appends a raw observation to an existing parse, for shapes no parser emits. */
  appendRow(parsed: Parsed, row: { externalId: string | null; extraJson: string }): number {
    const result = this.db.run(
      `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
       SELECT parse_run_id,source_account,?,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,'json:$.synthetic',?
       FROM transaction_observations WHERE id=?`,
      [row.externalId, row.extraJson, parsed.observations[0]!],
    );
    return Number(result.lastInsertRowid);
  }
}

/** A Vpass card bound to a durable token: reference `["vpass:card", token]` (0020). */
export function vpassCard(token: string, account: string): AccountSpec {
  return { ref: `sa-${token.slice(-6)}`, reference: ["vpass:card", token], account };
}

/** A MyJCB connection root (aggregate status, as the identity rules map it). */
export function myjcbRoot(connection: string, account: string): AccountSpec {
  return {
    ref: `sa-jcb-${connection}`,
    reference: [`myjcb:${connection}:root`],
    account,
    status: "aggregate",
  };
}

export interface BaseWorld {
  store: CardStore;
  /** Vpass card-001 (token A), 2026-05: a customized capture replaced by the web capture. */
  replacedCustomized: Parsed;
  web202605: Parsed;
  customized202606: [Parsed, Parsed];
  /** A newer 2026-06 capture with one page unpublished: incomplete, never current. */
  incomplete202606: [Parsed, Parsed];
  unpublished202607: Parsed;
  /** MyJCB connection `conn-a`. */
  olderConfirmed202605: Parsed;
  olderUnconfirmed: Parsed;
  confirmed202604: Parsed;
  confirmed202605: Parsed;
  unconfirmed: Parsed;
  unpublishedConfirmed202605: Parsed;
  bank: Parsed;
}

const CONFIRMED_ROWS: readonly UsageRow[] = [
  {
    date: "2026/04/20",
    merchant: "架空店舗G",
    amount: "1,000",
    paymentType: "1回払い",
    other: "1,000",
  },
  {
    date: "2026/04/21",
    merchant: "架空店舗H",
    amount: "4,000",
    paymentType: "分割",
    other: "12,000",
    installment: "1",
  },
];

/**
 * The shared scenario: a Vpass card whose 2026-05 month flipped from the
 * customized (pending) family to the web (posted) family, a complete 2026-06
 * customized snapshot that neither an incomplete newer capture nor an
 * unpublished one shadows, and a MyJCB connection with a re-fetched confirmed
 * period, a replaced unconfirmed capture and an unpublished newer capture.
 * Every published card parse is identified; the bank row is not card usage.
 */
export function baseWorld(): BaseWorld {
  const store = new CardStore();
  const card = vpassCard(TOKEN_A, "acct-card-a");
  const vpass = (fetchedAt: string) => {
    const run = store.run("vpass");
    return { run, binding: store.bind(run, "card-001", TOKEN_A), fetchedAt };
  };
  const bound = (parsed: Parsed, binding: number): Parsed => {
    store.identify(parsed, card, { version: 2, bindingArtifact: binding, token: TOKEN_A });
    return parsed;
  };

  const may = vpass("2026-05-10T00:00:00.000Z");
  const replacedCustomized = bound(
    store.vpassPage({
      run: may.run,
      card: "card-001",
      month: "202605",
      family: "customized",
      fetchedAt: may.fetchedAt,
      rows: [
        { date: "26/05/03", merchant: "架空店舗A", amount: "2,000", paymentType: "1回払い" },
        { date: "26/05/04", merchant: "架空返金A", amount: "-1,500", paymentType: "1回払い" },
      ],
    }),
    may.binding,
  );

  const june = vpass("2026-06-10T00:00:00.000Z");
  const web202605 = bound(
    store.vpassPage({
      run: june.run,
      card: "card-001",
      month: "202605",
      family: "web",
      fetchedAt: june.fetchedAt,
      rows: [
        { date: "26/05/03", merchant: "架空店舗A", amount: "2,000", paymentType: "1回払い" },
        { date: "26/05/05", merchant: "架空店舗B", amount: "5,000", paymentType: "2回払い" },
        { date: "26/05/06", merchant: "架空店舗C", amount: "", paymentType: "1回払い" },
      ],
    }),
    june.binding,
  );
  const customized202606: [Parsed, Parsed] = [
    bound(
      store.vpassPage({
        run: june.run,
        card: "card-001",
        month: "202606",
        family: "customized",
        fetchedAt: june.fetchedAt,
        rows: [
          { date: "26/06/01", merchant: "架空店舗D", amount: "1,234", paymentType: "1回払い" },
        ],
      }),
      june.binding,
    ),
    bound(
      store.vpassPage({
        run: june.run,
        card: "card-001",
        month: "202606",
        page: "answer-001",
        family: "customized",
        fetchedAt: june.fetchedAt,
        rows: [
          { date: "26/06/02", merchant: "架空店舗E", amount: "3,300", paymentType: "1回払い" },
        ],
      }),
      june.binding,
    ),
  ];

  const late = vpass("2026-06-20T00:00:00.000Z");
  const incomplete202606: [Parsed, Parsed] = [
    bound(
      store.vpassPage({
        run: late.run,
        card: "card-001",
        month: "202606",
        family: "customized",
        fetchedAt: late.fetchedAt,
        rows: [
          { date: "26/06/01", merchant: "架空店舗D", amount: "1,234", paymentType: "1回払い" },
          { date: "26/06/03", merchant: "架空店舗F", amount: "700", paymentType: "1回払い" },
        ],
      }),
      late.binding,
    ),
    store.vpassPage({
      run: late.run,
      card: "card-001",
      month: "202606",
      page: "answer-001",
      family: "customized",
      fetchedAt: late.fetchedAt,
      publication: "unpublished",
      rows: [{ date: "26/06/02", merchant: "架空店舗E", amount: "3,300", paymentType: "1回払い" }],
    }),
  ];

  const july = vpass("2026-07-10T00:00:00.000Z");
  const unpublished202607 = store.vpassPage({
    run: july.run,
    card: "card-001",
    month: "202607",
    family: "web",
    fetchedAt: july.fetchedAt,
    publication: "unpublished",
    rows: [{ date: "26/07/01", merchant: "架空店舗K", amount: "900", paymentType: "1回払い" }],
  });

  const root = myjcbRoot("conn-a", "acct-jcb");
  const jcb = (parsed: Parsed): Parsed => {
    store.identify(parsed, root, { version: 1 });
    return parsed;
  };
  const first = store.run("myjcb");
  const olderConfirmed202605 = jcb(
    store.myjcbLedger({
      run: first,
      connection: "conn-a",
      detailMonth: 1,
      state: "confirmed",
      period: "202605",
      fetchedAt: "2026-05-12T00:00:00.000Z",
      rows: CONFIRMED_ROWS,
    }),
  );
  const confirmed202604 = jcb(
    store.myjcbLedger({
      run: first,
      connection: "conn-a",
      detailMonth: 2,
      state: "confirmed",
      period: "2026年4月お支払い分",
      fetchedAt: "2026-05-12T00:00:00.000Z",
      rows: [
        { date: "2026/03/15", merchant: "架空店舗L", amount: "2,500", paymentType: "1回払い" },
      ],
    }),
  );
  const olderUnconfirmed = jcb(
    store.myjcbLedger({
      run: first,
      connection: "conn-a",
      detailMonth: 0,
      state: "unconfirmed",
      period: "202606",
      fetchedAt: "2026-05-12T00:00:00.000Z",
      rows: [{ date: "2026/05/10", merchant: "架空店舗I", amount: "800", paymentType: "1回払い" }],
    }),
  );
  const second = store.run("myjcb");
  const confirmed202605 = jcb(
    store.myjcbLedger({
      run: second,
      connection: "conn-a",
      detailMonth: 1,
      state: "confirmed",
      period: "202605",
      fetchedAt: "2026-06-12T00:00:00.000Z",
      rows: CONFIRMED_ROWS,
    }),
  );
  const unconfirmed = jcb(
    store.myjcbLedger({
      run: second,
      connection: "conn-a",
      detailMonth: 0,
      state: "unconfirmed",
      period: "202607",
      fetchedAt: "2026-06-12T00:00:00.000Z",
      rows: [
        { date: "2026/05/10", merchant: "架空店舗I", amount: "800", paymentType: "1回払い" },
        {
          date: "2026/06/02",
          merchant: "架空店舗J",
          amount: "300",
          paymentType: "1回払い",
          other: "300",
        },
      ],
    }),
  );
  const unpublishedConfirmed202605 = store.myjcbLedger({
    run: store.run("myjcb"),
    connection: "conn-a",
    detailMonth: 1,
    state: "confirmed",
    period: "202605",
    fetchedAt: "2026-06-20T00:00:00.000Z",
    publication: "unpublished",
    rows: CONFIRMED_ROWS,
  });

  const bank = store.bankRow(store.run("smbc-bank"), "2026-05-20T00:00:00.000Z");
  return {
    store,
    replacedCustomized,
    web202605,
    customized202606,
    incomplete202606,
    unpublished202607,
    olderConfirmed202605,
    olderUnconfirmed,
    confirmed202604,
    confirmed202605,
    unconfirmed,
    unpublishedConfirmed202605,
    bank,
  };
}
