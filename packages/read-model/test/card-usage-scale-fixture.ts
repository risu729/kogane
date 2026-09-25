// A scaled synthetic card store on the complete CORE schema (every migration
// from 0001, in order, foreign keys on, never analyzed: D1 runs no `ANALYZE`,
// so the planner sees no table statistics), for measuring the current card
// usage read the way production runs it.
//
// The shape follows what the collectors store: one Vpass acquisition session
// per capture with one fetch run per card (statement pages, discovery
// artifacts and a manifest) and the trusted importer card binding run of each
// card beside it, one MyJCB run per capture with its unconfirmed ledger and the
// confirmed ledgers of the last periods, and a bank run so the card rows are
// not alone in the tables. Captures are daily for the last `dailyDays` days and
// monthly before that. A card-month keeps its rows from one capture to the next
// (the pending month only grows, page by page), so every capture re-states the
// same keys and only the newest complete capture is current. Every card row
// goes through the deployed Vpass or MyJCB parser; every Vpass parse is
// identified through the card binding policy, every other parse through the
// default policy. `scaledStore` then recognises every recognisable current row
// through the guarded 0047 builder, as the purchase-recognition lane would, and
// adds one more capture in which a few recognised pending rows have gone, so
// stale keys exist too. Names, tokens and amounts are invented; no provider
// row, card or account is real.
//
// With `statements`, the store also holds the statement history the statement
// and settlement reads join (card-statement-history.ts): each posted Vpass
// month's first page carries its bill total, each MyJCB capture reads the
// confirmed statement pages and the past-month summary, the bank capture goes
// through the deployed SMBC parsers (a daily balance, the day's rows and the
// card debits on each due date), a second bank (St.George) records its daily
// balances, the card and bank accounts carry accepted ownership claims, and
// after each capture the settlement reviews the processor sweep would propose
// are written; at the end most are decided.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cardPurchaseEventId,
  cardPurchaseRevision,
  classifyCardUsage,
  recognitionKey,
  type CardUsageFact,
} from "../../../packages/domain/src/card-purchase";
import { exactQuantity, normalizeDecimal } from "../../../packages/domain/src/values";
import {
  myJcbCreditLedger,
  myJcbCreditStatement,
  myJcbPastMonthBalances,
} from "../../../packages/parsers/src/parsers/myjcb";
import {
  smbcDirectBalance,
  smbcDirectTransactions,
} from "../../../packages/parsers/src/parsers/smbc-direct";
import { stGeorgeBalances } from "../../../packages/parsers/src/parsers/st-george";
import { vpassStatementPage } from "../../../packages/parsers/src/parsers/vpass";
import type { ArtifactMeta, Observation, Parser } from "../../../packages/parsers/src/types";
import { cardPurchaseRecognitionWrites } from "../../../packages/storage-d1/src/atomic/card-purchase-recognition";
import {
  CARD_USAGE_PAGE_LIMIT,
  type CurrentCardUsageRow,
  currentCardUsageSql,
} from "../src/card-usage";
import { customizedPayload, ledgerPayload, type UsageRow, webPayload } from "./card-usage-fixture";
import {
  type BankRow,
  myjcbPastMonthsPayload,
  myjcbStatementHtml,
  ownershipRelation,
  paymentDate,
  type SettlementCounts,
  SettlementLedger,
  smbcBalancePayload,
  smbcTransactionsPayload,
  ST_GEORGE_ACCOUNT_KEY,
  stGeorgeSnapshotPayload,
  statementTotal,
  vpassHeader,
} from "./card-statement-history";

const MIGRATIONS = join(import.meta.dir, "../../../packages/storage-d1/migrations/core");
const PRODUCER = "collector-r2-importer";
const CLIENT = "scale-client";
const VPASS_NAMESPACE = "vpass-worker-card-v1";
const MYJCB_NAMESPACE = "myjcb-connection-v1";
const BANK_NAMESPACE = "smbc-direct-v1";
const ST_GEORGE_NAMESPACE = "st-george-v1";
const SHA = "a".repeat(64);
const BYTES = 3;
const DAY_MS = 86_400_000;

export interface ScaleOptions {
  /** The last capture day, `YYYY-MM-DD`. */
  today: string;
  /** Daily captures up to and including `today`. */
  dailyDays: number;
  /** Monthly captures (the first of each month) before the daily window. */
  monthlyMonths: number;
  /** Vpass cards, each with its own ordinal, token and account. */
  cards: number;
  /** Posted (web) statement months each capture re-reads, besides the pending month. */
  postedMonths: number;
  /** Statement pages per card-month, inclusive range. */
  pages: readonly [number, number];
  /** Rows per statement page (and per MyJCB ledger page), inclusive range. */
  rowsPerPage: readonly [number, number];
  /** Bank rows per capture: rows no card read may touch. */
  bankRows: number;
  /** Statement totals, bank captures and settlement reviews (card-statement-history.ts). */
  statements?: boolean;
}

/** The store the measurement asks for: 3 cards, 24 months, 180 daily captures. */
export const FULL_SCALE: ScaleOptions = {
  today: "2026-09-24",
  dailyDays: 180,
  monthlyMonths: 18,
  cards: 3,
  postedMonths: 3,
  pages: [2, 3],
  rowsPerPage: [30, 60],
  bankRows: 60,
};

/** A smaller store of the same shape, for the checks CI runs on every change. */
export const CI_SCALE: ScaleOptions = {
  ...FULL_SCALE,
  dailyDays: 21,
  monthlyMonths: 5,
  cards: 2,
  postedMonths: 2,
  pages: [1, 2],
  rowsPerPage: [8, 14],
  bankRows: 20,
};

/**
 * The store the statement and settlement measurement asks for: three Vpass
 * cards, a MyJCB connection and two banks captured daily for two years, with
 * every statement total, bank debit and settlement review of that history.
 */
export const STATEMENT_SCALE: ScaleOptions = {
  today: "2026-09-24",
  dailyDays: 730,
  monthlyMonths: 0,
  cards: 3,
  postedMonths: 2,
  pages: [1, 2],
  rowsPerPage: [50, 70],
  bankRows: 6,
  statements: true,
};

/** A smaller store of the same shape, for the checks CI runs on every change. */
export const STATEMENT_CI_SCALE: ScaleOptions = {
  ...STATEMENT_SCALE,
  dailyDays: 100,
  cards: 2,
  rowsPerPage: [3, 6],
  bankRows: 3,
};

/** Deterministic: the same options always build the same store. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const between = (next: () => number, [low, high]: readonly [number, number]): number =>
  low + Math.floor(next() * (high - low + 1));

/** `YYYYMM` of the month `offset` months from the month of `YYYY-MM[-DD]`. */
function monthOf(date: string, offset: number): string {
  const shifted = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + offset, 1),
  );
  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

const daysIn = (month: string): number =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4)), 0)).getUTCDate();

/** The capture days: monthly (the 1st) before the daily window, then daily up to `today`. */
function captureDays(options: ScaleOptions): string[] {
  const end = Date.parse(`${options.today}T00:00:00Z`);
  const daily = Array.from({ length: options.dailyDays }, (_, index) =>
    new Date(end - (options.dailyDays - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
  const first = daily[0]!;
  const monthly = Array.from({ length: options.monthlyMonths }, (_, index) => {
    const month = monthOf(first, index - options.monthlyMonths);
    return `${month.slice(0, 4)}-${month.slice(4)}-01`;
  });
  return [...monthly, ...daily];
}

/** Mostly single payments; the rest are shapes recognition leaves alone. */
const PAYMENT_TYPES = [
  "1回払い",
  "1回払い",
  "1回払い",
  "1回払い",
  "1回払い",
  "1回払い",
  "2回払い",
  "2回払い",
  "リボ",
  "分割",
];

type MonthRow = UsageRow & { day: number };

/**
 * The provider rows of one card-month (statement month `statement`, usage in
 * the month before), in pages of a fixed size, generated once so every
 * capture re-states the same rows on the same pages.
 */
function monthPages(
  options: ScaleOptions,
  source: string,
  statement: string,
  vpassDate: boolean,
): MonthRow[][] {
  let seed = 7;
  for (const character of `${source}:${statement}`)
    seed = (Math.imul(seed, 31) + character.charCodeAt(0)) >>> 0;
  const next = random(seed);
  const size = options.rowsPerPage[1];
  // A MyJCB ledger is one artifact per period: one page of rows.
  const counts = Array.from({ length: vpassDate ? between(next, options.pages) : 1 }, () =>
    between(next, options.rowsPerPage),
  );
  const count = counts.reduce((total, rows) => total + rows, 0);
  const usage = monthOf(`${statement.slice(0, 4)}-${statement.slice(4)}`, -1);
  const days = daysIn(usage);
  const rows = Array.from({ length: count }, (_, index): MonthRow => {
    const day = 1 + Math.floor((index * days) / count);
    const paymentType = PAYMENT_TYPES[Math.floor(next() * PAYMENT_TYPES.length)]!;
    const yen = 100 + Math.floor(next() * 30_000);
    const refund = next() < 0.03;
    const dd = String(day).padStart(2, "0");
    return {
      day,
      date: vpassDate
        ? `${usage.slice(2, 4)}/${usage.slice(4)}/${dd}`
        : `${usage.slice(0, 4)}/${usage.slice(4)}/${dd}`,
      merchant: `架空店舗-${source}-${statement}-${index}`,
      amount: `${refund ? "-" : ""}${yen.toLocaleString("en-US")}`,
      paymentType,
      ...(paymentType === "分割"
        ? { other: (yen * 3).toLocaleString("en-US"), installment: "1" }
        : {}),
    };
  });
  const pages: MonthRow[][] = [];
  for (let start = 0; start < rows.length; start += size)
    pages.push(rows.slice(start, start + size));
  return pages;
}

/**
 * The pages as the provider shows them on `day`: rows used after it are not
 * there yet, and the `cancelled` oldest rows have disappeared (a withdrawn
 * authorisation), leaving their page slots empty.
 */
function visibleOn(pages: readonly MonthRow[][], day: number, cancelled: number): MonthRow[][] {
  const shown = new Set(
    pages
      .flat()
      .filter((row) => row.day <= day)
      .slice(cancelled),
  );
  const result = pages
    .map((page) => page.filter((row) => shown.has(row)))
    .filter((page) => page.length > 0);
  return result.length === 0 ? [[]] : result;
}

const hex = (value: number): string => value.toString(16).padStart(64, "0");
const token = (card: number): string =>
  `vpass-card-v1-${String.fromCharCode(97 + card).repeat(64)}`;
const ordinal = (card: number): string => `card-${String(card + 1).padStart(3, "0")}`;
const periodLabel = (statement: string): string =>
  `${statement.slice(0, 4)}年${Number(statement.slice(4))}月お支払い分`;

type Bind = string | number | null;

interface Artifact {
  key: string;
  dataset: string | null;
  /** The artifact belongs to the run's one fetch unit. */
  inUnit: boolean;
  role: "provider_response" | "collector_manifest" | "collector_derived";
  format?: readonly [string, string];
  state?: string;
  period?: string;
  /** The declared media type; JSON unless given. */
  mime?: string;
}

type Stored = "transaction" | "balance";

interface Built {
  artifact: number;
  parse: number;
  observations: { kind: Stored; id: number; observation: Observation }[];
}

/** The complete CORE schema, every migration in order, foreign keys on, never analyzed. */
export function fullCoreSchema(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return db;
}

/** What a build wrote, for the measurement report. */
interface ScaleCounts {
  captureDays: number;
  fetchRuns: number;
  fetchArtifacts: number;
  parseRuns: number;
  transactionObservations: number;
  vpassRows: number;
  myjcbRows: number;
  identityObservations: number;
  balanceObservations: number;
  publishedParseRuns: number;
  /** `credit_statement_payment_amount` rows of the two statement parsers. */
  statementTotals: number;
  settlement: SettlementCounts | null;
}

const BANK_PARSER: Parser = {
  name: "synthetic-bank-history",
  version: "1",
  accepts: () => true,
  parse: () => ({ observations: [], warnings: [] }),
};

class ScaleStore {
  readonly db = fullCoreSchema();
  private id = 0;
  private days = 0;
  private readonly statements = new Map<string, ReturnType<Database["prepare"]>>();
  /** The statement history's reviews, with `options.statements`. */
  readonly ledger: SettlementLedger | null;
  /** Every card and bank account's ownership evidence (`card_settlement_fact_ownership`). */
  private readonly evidence = new Map<string, string[]>();
  private settlement: SettlementCounts | null = null;

  constructor(readonly options: ScaleOptions) {
    this.exec(
      "INSERT INTO ingest_clients(id,display_name,active) VALUES(?,'Scale client',1)",
      CLIENT,
    );
    this.exec(
      "INSERT INTO ingest_client_producers(ingest_client_id,producer_id) VALUES(?,?)",
      CLIENT,
      PRODUCER,
    );
    for (const source of ["vpass", "myjcb", "smbc-bank"])
      this.exec(
        "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES(?,?,?)",
        CLIENT,
        PRODUCER,
        source,
      );
    this.exec(
      "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?,?,'objects/scale',0)",
      SHA,
      BYTES,
    );
    for (let card = 0; card < options.cards; card += 1)
      this.account(
        `sa-${ordinal(card)}`,
        "vpass",
        ["vpass:card", token(card)],
        `acct-card-${card}`,
        "identified",
      );
    this.account("sa-jcb", "myjcb", ["myjcb:conn-a:root"], "acct-jcb", "aggregate");
    this.account("sa-bank", "smbc-bank", ["smbc-bank:ordinary-yen"], "acct-bank", "identified");
    this.ledger = options.statements === true ? new SettlementLedger(this.db) : null;
    if (this.ledger === null) return;
    this.exec(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES(?,?,'st-george')",
      CLIENT,
      PRODUCER,
    );
    this.account(
      "sa-st-george",
      "st-george",
      [`st-george:${ST_GEORGE_ACCOUNT_KEY}`],
      "acct-st-george",
      "identified",
    );
    const owned: [string, string, "liable_party" | "beneficial_owner"][] = [
      ...Array.from({ length: options.cards }, (_, card): [string, string, "liable_party"] => [
        `sa-${ordinal(card)}`,
        `acct-card-${card}`,
        "liable_party",
      ]),
      ["sa-jcb", "acct-jcb", "liable_party"],
      ["sa-bank", "acct-bank", "beneficial_owner"],
    ];
    for (const [ref, account, kind] of owned) {
      const relation = ownershipRelation(this.db, kind, account);
      this.evidence.set(account, [
        `account_mapping:${ref}-r1`,
        `relation:${relation}`,
        `decision:dr-${relation}`,
      ]);
    }
  }

  private exec(sql: string, ...binds: Bind[]): number {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return Number(statement.run(...(binds as never[])).lastInsertRowid);
  }

  private next(): number {
    this.id += 1;
    return this.id;
  }

  private account(
    ref: string,
    source: string,
    reference: readonly string[],
    account: string,
    status: string,
  ): void {
    this.exec(
      "INSERT INTO source_accounts VALUES(?,?,?,?)",
      ref,
      source,
      PRODUCER,
      JSON.stringify(reference),
    );
    this.exec("INSERT INTO accounts VALUES(?,'Synthetic','card-statement',?)", account, status);
    this.exec(
      "INSERT INTO account_mappings VALUES(?,?,1,?,'rule','synthetic',1,'2098-01-01','Synthetic',?)",
      `${ref}-r1`,
      ref,
      account,
      status,
    );
  }

  private session(namespace: string, at: number): number {
    const id = this.next();
    this.exec(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?,?,?,?,?,?)`,
      id,
      PRODUCER,
      CLIENT,
      namespace,
      `scale-session-${id}`,
      at,
    );
    return id;
  }

  /**
   * One sealed, successful fetch run: its unit, artifacts, inventory, terminal
   * reports and seal, in the order the ingest Worker writes them. Returns the
   * artifact ids in `artifacts` order.
   */
  private sealedRun(input: {
    session: number;
    source: string;
    runKey: string;
    at: number;
    unitKey?: string;
    artifacts: readonly Artifact[];
  }): { run: number; unit: number | null; artifacts: number[] } {
    const run = this.next();
    this.exec(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,?,?,?,?)`,
      run,
      input.session,
      PRODUCER,
      input.source,
      CLIENT,
      input.runKey,
      input.at,
    );
    let unit: number | null = null;
    if (input.unitKey !== undefined) {
      unit = this.next();
      this.exec(
        `INSERT INTO fetch_units(id,fetch_run_id,unit_kind,unit_key,terminal_report_required,recorded_by_client_id,recorded_at_ms)
         VALUES(?,?,'card',?,1,?,?)`,
        unit,
        run,
        input.unitKey,
        CLIENT,
        input.at,
      );
    }
    const ids: number[] = [];
    for (const artifact of input.artifacts) {
      const id = this.next();
      const derived = artifact.role === "collector_derived";
      const manifest = artifact.role === "collector_manifest";
      this.exec(
        `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,fetch_unit_id,artifact_key,artifact_role,
          payload_fidelity,container_kind,lineage_disposition,dataset,format_id,format_version,declared_media_type,media_type_basis,
          fetched_at_ms,fetched_at_basis,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
         VALUES(?,?,?,?,?,?,?,?,?,'single',?,?,?,?,?,'response_header',?,'response',?,?,'v1',?,?)`,
        id,
        run,
        input.source,
        PRODUCER,
        CLIENT,
        artifact.inUnit ? unit : null,
        artifact.key,
        artifact.role,
        derived ? "transformed" : manifest ? "generated" : "exact",
        derived ? "source_not_retained_for_security" : "not_applicable",
        artifact.dataset,
        artifact.format?.[0] ?? null,
        artifact.format?.[1] ?? null,
        artifact.mime ?? "application/json",
        input.at,
        SHA,
        BYTES,
        hex(id),
        input.at,
      );
      if (derived)
        for (const [index, kind] of ["extracted", "redacted"].entries())
          this.exec(
            `INSERT INTO artifact_transform_steps(fetch_artifact_id,step_index,step_kind,transformer_id,transformer_version,recorded_by_client_id,recorded_at_ms)
             VALUES(?,?,?,'synthetic','1',?,?)`,
            id,
            index,
            kind,
            CLIENT,
            input.at,
          );
      if (artifact.state !== undefined || artifact.period !== undefined)
        this.exec(
          "INSERT INTO observation_artifact_metadata(fetch_artifact_id,statement_state,period) VALUES(?,?,?)",
          id,
          artifact.state ?? null,
          artifact.period ?? null,
        );
      ids.push(id);
    }
    if (unit !== null)
      this.exec(
        `INSERT INTO fetch_unit_reports(fetch_unit_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,recorded_at_ms)
         VALUES(?,'terminal','terminal',?,'success',?)`,
        unit,
        CLIENT,
        input.at,
      );
    const inventory = this.next();
    this.exec(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
       VALUES(?,?,?,?,'operator',?,?)`,
      inventory,
      run,
      hex(inventory),
      ids.length,
      input.at,
      CLIENT,
    );
    input.artifacts.forEach((artifact, index) =>
      this.exec(
        "INSERT INTO run_inventory_items(inventory_id,fetch_run_id,artifact_key,sha256,descriptor_sha256) VALUES(?,?,?,?,?)",
        inventory,
        run,
        artifact.key,
        SHA,
        hex(ids[index]!),
      ),
    );
    this.exec(
      `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,
        started_at_ms,started_at_basis,completed_at_ms,completed_at_basis,recorded_at_ms)
       VALUES(?,'terminal','terminal',?,'success',?,'manifest',?,'manifest',?)`,
      run,
      CLIENT,
      input.at,
      input.at,
      input.at,
    );
    this.exec(
      "INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?,?,?,?)",
      inventory,
      run,
      input.at,
      CLIENT,
    );
    return { run, unit, artifacts: ids };
  }

  /** A pending parse, its observations, then `ok` and published, as the pipeline writer does. */
  private parse(artifact: number, parser: Parser, observations: readonly Observation[]): Built {
    const parse = this.next();
    this.exec(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'2026-09-01','pending','[]')",
      parse,
      artifact,
      parser.name,
      parser.version,
    );
    const ids: Built["observations"] = [];
    for (const row of observations) {
      if (row.kind === "transaction")
        ids.push({
          kind: row.kind,
          observation: row,
          id: this.exec(
            `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          ),
        });
      else if (row.kind === "balance")
        ids.push({
          kind: row.kind,
          observation: row,
          id: this.exec(
            `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
            parse,
            row.sourceAccount,
            row.metric,
            row.amountMinor ?? null,
            row.amountText ?? null,
            row.amountScale ?? null,
            row.instrument,
            row.asOf ?? null,
            row.observedAt ?? null,
            row.rawLocator,
            JSON.stringify(row.extra),
          ),
        });
      else throw new Error(`unexpected ${row.kind} observation`);
    }
    this.exec("UPDATE parse_runs SET status='ok' WHERE id=?", parse);
    this.exec(
      "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,?,NULL,?,'normal','pipeline','parse_ok','2026-09-01')",
      artifact,
      parser.name,
      parse,
    );
    this.exec(
      "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,?,?,?,'2026-09-01','normal')",
      artifact,
      parser.name,
      parse,
      parser.version,
    );
    return { artifact, parse, observations: ids };
  }

  /** A sealed identity run over every observation of one parse. */
  private identify(
    built: Built,
    ref: string,
    binding?: { unit: number; artifact: number; token: string },
  ): void {
    const run = `ir-${built.parse}`;
    this.exec(
      "INSERT INTO identity_runs VALUES(?,?,?,'2098-01-01')",
      run,
      built.parse,
      binding === undefined ? 1 : 2,
    );
    this.exec(
      "INSERT INTO identity_run_policies VALUES(?,?,?,?,?,'[]')",
      run,
      built.parse,
      binding === undefined ? "identity-default" : "vpass-card-binding",
      binding === undefined ? "identity-default-v1" : "vpass-card-binding-v2",
      "c".repeat(64),
    );
    if (binding !== undefined)
      this.exec(
        "INSERT INTO identity_vpass_bindings VALUES(?,?,?,?)",
        run,
        binding.unit,
        binding.artifact,
        binding.token,
      );
    for (const { kind, id } of built.observations)
      this.exec(
        "INSERT INTO identity_observations VALUES(?,?,?,?,?,?,'[]')",
        // Observation ids repeat across the observation tables.
        kind === "transaction" ? `io-${id}` : `io-${kind}-${id}`,
        run,
        kind,
        id,
        ref,
        `${ref}-r1`,
      );
    this.exec(
      "INSERT INTO identity_run_seals VALUES(?,?,'2098-01-01')",
      run,
      built.observations.length,
    );
  }

  private meta(
    artifact: number,
    source: string,
    dataset: string,
    key: string,
    at: number,
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
      fetchedAt: new Date(at).toISOString(),
      sha256: SHA,
      ...extra,
    };
  }

  /**
   * One Vpass capture of one card in the day's session: the pending
   * (customized) month holding the usage up to the capture day, the posted
   * (web) months before it, each over its pages, the discovery artifacts, and
   * the trusted binding run. `cancelled` drops that many of the pending
   * month's oldest rows (`visibleOn`).
   */
  private vpassCapture(
    session: number,
    day: string,
    card: number,
    at: number,
    cancelled: number,
  ): void {
    const binding = this.sealedRun({
      session,
      source: "vpass",
      runKey: `${ordinal(card)}-vpass-card-binding-v1`,
      at,
      unitKey: token(card),
      artifacts: [
        {
          key: "card-identity-binding.json",
          dataset: "card-identity-binding",
          inUnit: true,
          role: "collector_derived",
          format: ["vpass-card-identity-binding-json", "1"],
        },
      ],
    });
    const source = `vpass-${card}`;
    const pending = monthOf(day, 1);
    const months = [
      {
        month: pending,
        family: "customized" as const,
        pages: visibleOn(
          monthPages(this.options, source, pending, true),
          Number(day.slice(8)),
          cancelled,
        ),
      },
      ...Array.from({ length: this.options.postedMonths }, (_, back) => {
        const month = monthOf(day, -back);
        return {
          month,
          family: "web" as const,
          pages: monthPages(this.options, source, month, true),
        };
      }),
    ];
    const pageKey = (family: "web" | "customized", index: number): string =>
      `${family === "customized" && index > 0 ? "answer" : "top"}-${String(index).padStart(3, "0")}`;
    const pages = months.flatMap(({ month, family, pages: rows }) =>
      rows.map((page, index) => ({
        month,
        family,
        page,
        first: index === 0,
        key: `months/${month}/${pageKey(family, index)}.json`,
      })),
    );
    const run = this.sealedRun({
      session,
      source: "vpass",
      runKey: `${ordinal(card)}-vpass-r2-v2`,
      at,
      unitKey: ordinal(card),
      artifacts: [
        { key: "card-list.json", dataset: "card-list", inUnit: true, role: "provider_response" },
        {
          key: "select-card.json",
          dataset: "select-card",
          inUnit: true,
          role: "provider_response",
        },
        {
          key: "web-meisai-top.json",
          dataset: "statement-discovery",
          inUnit: true,
          role: "provider_response",
        },
        { key: "manifest.json", dataset: null, inUnit: true, role: "collector_manifest" },
        ...pages.map(({ key }): Artifact => ({
          key,
          dataset: "statement-page",
          inUnit: true,
          role: "provider_response",
        })),
      ],
    });
    pages.forEach(({ month, family, page, first, key }, index) => {
      const artifact = run.artifacts[4 + index]!;
      // With a statement history, a posted month's first page carries its bill.
      const header =
        this.ledger !== null && family === "web" && first ? vpassHeader(source, month) : undefined;
      const bytes = family === "web" ? webPayload(page, header) : customizedPayload(month, page);
      const result = vpassStatementPage.parse(
        bytes,
        this.meta(artifact, "vpass", "statement-page", key, at, { fetchUnitKey: ordinal(card) }),
      );
      const built = this.parse(artifact, vpassStatementPage, result.observations);
      this.identify(built, `sa-${ordinal(card)}`, {
        unit: run.unit!,
        artifact: binding.artifacts[0]!,
        token: token(card),
      });
      this.statementTotals(built, "vpass", VPASS_NAMESPACE, `acct-card-${card}`);
    });
  }

  /**
   * Hands the bill totals of one statement parse to the ledger, as
   * `card_statement_facts` and its ownership return them.
   */
  private statementTotals(
    built: Built,
    source: "vpass" | "myjcb",
    namespace: string,
    account: string,
  ): void {
    if (this.ledger === null) return;
    for (const { id, observation } of built.observations) {
      if (observation.kind !== "balance") continue;
      const facts = observation.extra["_kogane"] as { period: string; paymentDate: string };
      this.ledger.statement({
        id,
        parseRunId: built.parse,
        source,
        sourceAccount: observation.sourceAccount,
        accountId: account,
        statementKey: JSON.stringify([
          source,
          PRODUCER,
          namespace,
          observation.sourceAccount,
          facts.period,
        ]),
        period: facts.period,
        paymentDate: facts.paymentDate,
        total: observation.amountMinor!,
        evidence: this.evidence.get(account)!,
      });
    }
  }

  /**
   * One MyJCB capture: the unconfirmed ledger and the confirmed ledgers of the
   * last periods; with a statement history also the confirmed statement page
   * of each of those periods and the past-month summary.
   */
  private myjcbCapture(day: string, at: number): void {
    const session = this.session(MYJCB_NAMESPACE, at);
    const pending = monthOf(day, 1);
    const ledgers = [
      {
        detail: 0,
        state: "unconfirmed" as const,
        month: pending,
        period: periodLabel(pending),
        rows: visibleOn(
          monthPages(this.options, "myjcb", pending, false),
          Number(day.slice(8)),
          0,
        ).flat(),
      },
      ...Array.from({ length: this.options.postedMonths }, (_, back) => {
        const statement = monthOf(day, -back);
        return {
          detail: back + 1,
          state: "confirmed" as const,
          month: statement,
          period: periodLabel(statement),
          rows: monthPages(this.options, "myjcb", statement, false).flat(),
        };
      }),
    ];
    const keyOf = (detail: number): string =>
      `conn-a/credit-ledger-${String(detail).padStart(2, "0")}.json`;
    const bills = this.ledger === null ? [] : ledgers.filter(({ state }) => state === "confirmed");
    const billKey = (detail: number): string =>
      `conn-a/credit-detail-${String(detail).padStart(2, "0")}.html`;
    const PAST_KEY = "conn-a/credit-past-months.json";
    const run = this.sealedRun({
      session,
      source: "myjcb",
      runKey: "default",
      at,
      artifacts: [
        ...ledgers.map((ledger): Artifact => ({
          key: keyOf(ledger.detail),
          dataset: "credit-ledger",
          inUnit: false,
          role: "provider_response",
          state: ledger.state,
          period: ledger.period,
        })),
        ...bills.map((ledger): Artifact => ({
          key: billKey(ledger.detail),
          dataset: "credit-detail",
          inUnit: false,
          role: "provider_response",
          state: ledger.state,
          period: ledger.period,
          mime: "text/html",
        })),
        ...(this.ledger === null
          ? []
          : [
              {
                key: PAST_KEY,
                dataset: "credit-past-months",
                inUnit: false,
                role: "provider_response",
              } satisfies Artifact,
            ]),
      ],
    });
    ledgers.forEach((ledger, index) => {
      const artifact = run.artifacts[index]!;
      const result = myJcbCreditLedger.parse(
        ledgerPayload(ledger.detail, ledger.period, ledger.state, ledger.rows),
        this.meta(artifact, "myjcb", "credit-ledger", keyOf(ledger.detail), at, {
          statementState: ledger.state,
          period: ledger.period,
        }),
      );
      this.identify(this.parse(artifact, myJcbCreditLedger, result.observations), "sa-jcb");
    });
    if (this.ledger === null) return;
    bills.forEach((ledger, index) => {
      const artifact = run.artifacts[ledgers.length + index]!;
      const result = myJcbCreditStatement.parse(
        myjcbStatementHtml(ledger.month),
        this.meta(artifact, "myjcb", "credit-detail", billKey(ledger.detail), at, {
          statementState: ledger.state,
          period: ledger.period,
          mime: "text/html",
        }),
      );
      const built = this.parse(artifact, myJcbCreditStatement, result.observations);
      this.identify(built, "sa-jcb");
      this.statementTotals(built, "myjcb", MYJCB_NAMESPACE, "acct-jcb");
    });
    const past = run.artifacts.at(-1)!;
    const result = myJcbPastMonthBalances.parse(
      myjcbPastMonthsPayload(Array.from({ length: 12 }, (_, back) => monthOf(day, -back))),
      this.meta(past, "myjcb", "credit-past-months", PAST_KEY, at, {
        statementState: null,
        period: null,
      }),
    );
    this.identify(this.parse(past, myJcbPastMonthBalances, result.observations), "sa-jcb");
  }

  /** The bill totals due on `day`, which the bank debits that day. */
  private dueOn(day: string): { source: string; month: string; total: number }[] {
    const month = monthOf(day, 0);
    const due: { source: string; month: string; total: number }[] = [];
    if (day === paymentDate("vpass", month))
      for (let card = 0; card < this.options.cards; card += 1)
        due.push({ source: `vpass-${card}`, month, total: statementTotal(`vpass-${card}`, month) });
    if (day === paymentDate("myjcb", month))
      due.push({ source: "myjcb", month, total: statementTotal("myjcb", month) });
    return due;
  }

  /**
   * One SMBC capture through the deployed parsers: the day's closing balance,
   * the day's rows and the debit of every bill due that day; then a St.George
   * balance capture.
   */
  private statementBankCapture(day: string, at: number): void {
    const range = day.replaceAll("-", "");
    const rowsKey = `transactions/${range}-${range}.normalized.json`;
    const run = this.sealedRun({
      session: this.session(BANK_NAMESPACE, at),
      source: "smbc-bank",
      runKey: "default",
      at,
      artifacts: [
        {
          key: "balance.normalized.json",
          dataset: "balance-normalized",
          inUnit: false,
          role: "provider_response",
        },
        {
          key: rowsKey,
          dataset: "transactions-normalized",
          inUnit: false,
          role: "provider_response",
        },
      ],
    });
    const next = random(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
    const rows: BankRow[] = [
      ...this.dueOn(day).map(({ source, month, total }): BankRow => ({
        id: `smbc-card-${source}-${month}`,
        amount: total,
        direction: "debit",
        description: "カード引落",
      })),
      // Ordinary rows stay under 10,000 yen, below every bill.
      ...Array.from({ length: this.options.bankRows }, (_, index): BankRow => ({
        id: `smbc-${day}-${index}`,
        amount: 100 + Math.floor(next() * 9_800),
        direction: index % 3 === 0 ? "credit" : "debit",
        description: "synthetic",
      })),
    ];
    const closing = 1_000_000 + Math.floor(next() * 500_000);
    const balance = smbcDirectBalance.parse(
      smbcBalancePayload(new Date(at).toISOString(), closing),
      this.meta(
        run.artifacts[0]!,
        "smbc-bank",
        "balance-normalized",
        "balance.normalized.json",
        at,
        {},
      ),
    );
    this.identify(
      this.parse(run.artifacts[0]!, smbcDirectBalance, balance.observations),
      "sa-bank",
    );
    const history = smbcDirectTransactions.parse(
      smbcTransactionsPayload(day, rows, closing),
      this.meta(run.artifacts[1]!, "smbc-bank", "transactions-normalized", rowsKey, at, {}),
    );
    const built = this.parse(run.artifacts[1]!, smbcDirectTransactions, history.observations);
    this.identify(built, "sa-bank");
    for (const { id, observation } of built.observations)
      if (observation.kind === "transaction" && observation.amountMinor! < 0)
        this.ledger!.debit({
          id,
          parseRunId: built.parse,
          bankKey: JSON.stringify([
            "smbc-bank",
            PRODUCER,
            BANK_NAMESPACE,
            observation.sourceAccount,
            observation.externalId,
          ]),
          sourceAccount: observation.sourceAccount,
          accountId: "acct-bank",
          date: day,
          amount: -observation.amountMinor!,
          evidence: this.evidence.get("acct-bank")!,
        });

    const bankAt = at + 5 * 60_000;
    const snapshot = this.sealedRun({
      session: this.session(ST_GEORGE_NAMESPACE, bankAt),
      source: "st-george",
      runKey: "default",
      at: bankAt,
      artifacts: [
        {
          key: "account-snapshot.json",
          dataset: "account-snapshot",
          inUnit: false,
          role: "provider_response",
        },
      ],
    });
    const balances = stGeorgeBalances.parse(
      stGeorgeSnapshotPayload(new Date(bankAt).toISOString(), day),
      this.meta(
        snapshot.artifacts[0]!,
        "st-george",
        "account-snapshot",
        "account-snapshot.json",
        bankAt,
        {},
      ),
    );
    this.identify(
      this.parse(snapshot.artifacts[0]!, stGeorgeBalances, balances.observations),
      "sa-st-george",
    );
  }

  /** One bank capture: rows of a source no card read may touch. */
  private bankCapture(day: string, at: number): void {
    if (this.ledger !== null) {
      this.statementBankCapture(day, at);
      return;
    }
    const run = this.sealedRun({
      session: this.session(BANK_NAMESPACE, at),
      source: "smbc-bank",
      runKey: "default",
      at,
      artifacts: [
        {
          key: "history.json",
          dataset: "synthetic-history",
          inUnit: false,
          role: "provider_response",
        },
      ],
    });
    const rows: Observation[] = Array.from({ length: this.options.bankRows }, (_, index) => ({
      kind: "transaction",
      sourceAccount: "smbc-bank:ordinary-yen",
      externalId: `synthetic-bank-${day}-${index}`,
      status: "posted",
      amountMinor: -(index + 1) * 100,
      amountText: String(-(index + 1) * 100),
      amountScale: 0,
      currency: "JPY",
      description: "synthetic",
      asOf: day,
      rawLocator: `json:$.rows[${index}]`,
      extra: {},
    }));
    this.identify(this.parse(run.artifacts[0]!, BANK_PARSER, rows), "sa-bank");
  }

  /**
   * Every capture of `days`, each day in one transaction. `cancelled` pending
   * Vpass rows per card disappear from these captures. With a statement
   * history, the sweep's proposals follow each day's captures.
   */
  async capture(days: readonly string[], options: { cancelled?: number } = {}): Promise<void> {
    for (const day of days) {
      const at = Date.parse(`${day}T03:00:00Z`);
      this.db.transaction(() => {
        const session = this.session(VPASS_NAMESPACE, at);
        for (let card = 0; card < this.options.cards; card += 1)
          this.vpassCapture(session, day, card, at + card * 60_000, options.cancelled ?? 0);
        this.myjcbCapture(day, at + 30 * 60_000);
        this.bankCapture(day, at + 40 * 60_000);
      })();
      this.days += 1;
      await this.ledger?.propose(new Date(at + 60 * 60_000).toISOString());
    }
  }

  /** The operator's settlement reviews, once every capture is in. */
  decide(): void {
    if (this.ledger !== null) this.settlement = this.ledger.decide();
  }

  counts(): ScaleCounts {
    const n = (sql: string): number => (this.db.query(sql).get() as { n: number }).n;
    return {
      captureDays: this.days,
      fetchRuns: n("SELECT count(*) AS n FROM fetch_runs"),
      fetchArtifacts: n("SELECT count(*) AS n FROM fetch_artifacts"),
      parseRuns: n("SELECT count(*) AS n FROM parse_runs"),
      transactionObservations: n("SELECT count(*) AS n FROM transaction_observations"),
      vpassRows: n(
        "SELECT count(*) AS n FROM transaction_observations WHERE source_account LIKE 'vpass:%'",
      ),
      myjcbRows: n(
        "SELECT count(*) AS n FROM transaction_observations WHERE source_account LIKE 'myjcb:%'",
      ),
      identityObservations: n("SELECT count(*) AS n FROM identity_observations"),
      balanceObservations: n("SELECT count(*) AS n FROM balance_observations"),
      publishedParseRuns: n("SELECT count(*) AS n FROM published_parse_runs"),
      statementTotals: n(
        `SELECT count(*) AS n FROM balance_observations b JOIN parse_runs p ON p.id=b.parse_run_id
         WHERE b.metric='credit_statement_payment_amount'
          AND p.parser_name IN ('vpass-statement-page','myjcb-credit-statement-total')`,
      ),
      settlement: this.settlement,
    };
  }
}

type UsagePage = (page: { afterId: number; limit: number }) => { sql: string; args: unknown[] };

/** Every current usage row, page by page, as the recognition lane reads them. */
export function allCurrentUsage(
  db: Database,
  page: UsagePage = currentCardUsageSql,
): CurrentCardUsageRow[] {
  const rows: CurrentCardUsageRow[] = [];
  for (let afterId = 0; ;) {
    const query = page({ afterId, limit: CARD_USAGE_PAGE_LIMIT });
    const batch = db
      .query(query.sql)
      .all(...(query.args as SQLQueryBindings[])) as CurrentCardUsageRow[];
    rows.push(...batch);
    if (batch.length < CARD_USAGE_PAGE_LIMIT) return rows;
    afterId = batch.at(-1)!.observation_id;
  }
}

/**
 * The fact the recognition lane classifies (services/processor `cardUsageFactOf`),
 * or null for a row without an exact decimal-v1 amount.
 */
export function factOf(row: CurrentCardUsageRow): CardUsageFact | null {
  if (row.value_status !== "exact" || row.coefficient === null || row.scale === null) return null;
  return {
    observationId: row.observation_id,
    parseRunId: row.parse_run_id,
    sourceId: row.source_id,
    producerId: row.producer_id,
    externalIdNamespace: row.external_id_namespace,
    sourceAccount: row.source_account,
    externalId: row.external_id,
    accountId: row.account_status === "unresolved" ? null : row.account_id,
    identityPolicyFamily: row.policy_family,
    providerStatus: row.provider_status,
    amount: exactQuantity(
      row.unit_ref ?? "unknown-unit",
      normalizeDecimal(BigInt(row.coefficient), row.scale),
      "decimal-v1",
    ),
    usageDate: row.as_of,
    paymentType: row.payment_type,
    statementPeriod: row.statement_period,
    capturedAt: row.snapshot_fetched_at,
    providerSaleCode: row.provider_sale_code,
    usageAmountText: row.usage_amount_text,
    paymentAmountText: row.payment_amount_text,
    newestRepresentation: true,
  };
}

/**
 * Recognises every recognisable current row no live event holds yet, one
 * guarded 0047 batch per event in its own transaction, as the lane writes
 * them; returns how many were written.
 */
async function recogniseCurrent(db: Database, now: string): Promise<number> {
  let written = 0;
  const held = db.prepare("SELECT 1 FROM current_card_purchase_keys WHERE recognition_key=?");
  for (const row of allCurrentUsage(db)) {
    if (row.recognition_key === null || held.get(row.recognition_key) !== null) continue;
    const fact = factOf(row);
    if (fact === null) continue;
    const classified = classifyCardUsage(fact);
    const key = recognitionKey(fact);
    if (!classified.ok || key === null) continue;
    const draft = await cardPurchaseRevision({
      action: "recognize",
      eventId: await cardPurchaseEventId(classified.kind, key),
      revision: 1,
      fact,
    });
    if (draft === null) throw new Error("scale fixture: recognition draft rejected");
    const writes = cardPurchaseRecognitionWrites({ draft, expectedRevision: null, now });
    const changes = db.transaction(() =>
      writes.map((write) => db.run(write.sql, write.binds as SQLQueryBindings[]).changes),
    )();
    if (changes[0]! > 0) written += 1;
  }
  return written;
}

/** A built store and what it holds. */
export interface ScaledStore {
  store: ScaleStore;
  /** Events the builder recognised before the last capture. */
  recognised: number;
  counts: ScaleCounts;
}

/**
 * Every capture but the last, every recognisable current row recognised, then
 * the last capture, in which the two oldest pending Vpass rows of each card
 * have disappeared, so their live events are stale; with a statement history,
 * the settlement reviews are decided last.
 */
export async function scaledStore(options: ScaleOptions): Promise<ScaledStore> {
  const store = new ScaleStore(options);
  const days = captureDays(options);
  await store.capture(days.slice(0, -1));
  const recognised = await recogniseCurrent(store.db, `${options.today}T00:00:00.000Z`);
  await store.capture(days.slice(-1), { cancelled: 2 });
  store.decide();
  return { store, recognised, counts: store.counts() };
}
