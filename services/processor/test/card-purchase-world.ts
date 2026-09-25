// The Miniflare card world the card purchase lane tests share: Vpass and MyJCB
// usage rows produced by the deployed parsers, published and identified the
// way the pipeline does it, on the real CORE schema. Every card, amount,
// merchant and token here is synthetic.
import { readFileSync } from "node:fs";
import type { Miniflare } from "miniflare";
import { cardPurchaseSummary } from "../../../packages/domain/src/card-purchase.ts";
import type { EconomicEventRevision } from "../../../packages/domain/src/events.ts";
import { exactQuantity, normalizeDecimal } from "../../../packages/domain/src/values.ts";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import {
  myJcbCreditLedger,
  myJcbCreditStatement,
} from "../../../packages/parsers/src/parsers/myjcb.ts";
import { vpassStatementPage } from "../../../packages/parsers/src/parsers/vpass.ts";
import type { ArtifactMeta, Observation, Parser } from "../../../packages/parsers/src/types.ts";
import {
  currentCardUsageSql,
  type CurrentCardUsageRow,
} from "../../../packages/read-model/src/card-usage.ts";
import {
  cardPurchaseSweep,
  type CardPurchaseSweepOptions,
  type CardPurchaseSweepResult,
} from "../src/card-purchase-job.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";
import { publishParse, seedUnitRun, startPipeline } from "./harness.ts";

export const PRODUCER = "collector-r2-importer";
/** The namespace the trusted Vpass binding requires (migration 0020). */
export const VPASS_NAMESPACE = "vpass-worker-card-v1";
export const MYJCB_NAMESPACE = "synthetic-myjcb-connection-v1";
export const TOKEN_A = `vpass-card-v1-${"a".repeat(64)}`;
export const TOKEN_B = `vpass-card-v1-${"b".repeat(64)}`;
export const NOW = "2026-09-24T00:00:00.000Z";
const FIXTURES = new URL("../../../tests/fixtures/observation-pipeline/", import.meta.url);

/** The card-settlement test's resolver: a provider-local account per source account, no binding. */
export const providerLocal: IdentityResolver = (input) => ({
  account: {
    key: [input.sourceAccount],
    label: "synthetic",
    role: "deposit",
    status: "provider-local",
    reason: "test",
  },
  instruments: [],
  issues: [],
});

// ---------------------------------------------------------------------------
// Synthetic provider payloads, parsed by the deployed parsers
// ---------------------------------------------------------------------------

export interface UsageRow {
  /** `YY/MM/DD` for Vpass, `YYYY/MM/DD` for MyJCB. */
  date: string;
  merchant: string;
  amount: string;
  /**
   * The payment type where production rows carry it, verbatim except for the
   * width of Vpass web digits. Vpass web: the one-digit `data[6]` code, which
   * the web builder writes full width (`1` → `１`). Vpass customized:
   * `bunkatsuYaku`, a different field that is `0` on every production row
   * (its meaning is unverified, so recognition accepts no value of it).
   * MyJCB: the wording the combined `ご利用先など／支払区分` cell shows after
   * the merchant (`1回払`).
   */
  paymentType: string;
  /** MyJCB: the other amount of the row (usage when confirmed, payment when not). */
  other?: string;
  installment?: string;
}

function template(name: "web" | "customized"): Record<string, any> {
  return JSON.parse(
    readFileSync(new URL(`vpass-parser-boundaries/${name}.json`, FIXTURES), "utf8"),
  ) as Record<string, any>;
}

/** ASCII digits as the Vpass web family writes its payment-type code: full width (`1` → `１`). */
const fullWidthDigits = (text: string): string =>
  text.replace(/[0-9]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0));

/**
 * The two-character on-screen label production MyJCB rows show in the summary
 * cell the ledger parser takes for the payment type (synthetic text).
 */
const MYJCB_LABEL = "架空";

/** A MyJCB combined `ご利用先など／支払区分` cell: the merchant, then the payment type. */
const myjcbCombinedCell = (row: Pick<UsageRow, "merchant" | "paymentType">): string =>
  row.paymentType === "" ? row.merchant : `${row.merchant} ${row.paymentType}`;

function vpassPayload(family: "web" | "customized", month: string, rows: readonly UsageRow[]) {
  if (family === "web") {
    const payload = template("web");
    payload["body"]["content"]["WebMeisaiTopDisplayServiceBean"]["meisaiList"] = rows.map(
      (row) => ({
        columnsSize: 11,
        columnsSizeS: "11",
        data: [
          "4K",
          "005",
          "",
          row.date,
          row.merchant,
          row.amount,
          fullWidthDigits(row.paymentType),
          "",
          "",
          "",
          "",
        ],
        maxIndex: "10",
        rowType: "4K",
        shiharaiPatternFlag: 0,
      }),
    );
    return payload;
  }
  const payload = template("customized");
  const bean = payload["body"]["content"]["CustomizedMeisaiAnsDisplayServiceBean"];
  bean["seikyuYM"] = month;
  bean["responseCnt"] = String(rows.length);
  bean["total"] = rows.length;
  bean["meisaiList"] = rows.map((row) => ({
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
  return payload;
}

/**
 * A MyJCB canonical `credit-ledger` JSON in the production row shape: the
 * merchant and the payment type share the combined `summaryCells[1]`, and the
 * cell the parser takes for the payment type holds a two-character label.
 */
function ledgerPayload(
  detailMonth: number,
  period: string,
  state: "confirmed" | "unconfirmed",
  rows: readonly UsageRow[],
) {
  return {
    schemaVersion: 1,
    detailMonth,
    period,
    state,
    headers:
      state === "confirmed"
        ? ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"]
        : ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"],
    rows: rows.map((row) => ({
      summaryCells: [row.date, myjcbCombinedCell(row), MYJCB_LABEL, row.amount],
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
  };
}

export function meta(
  id: number,
  sourceId: string,
  dataset: string,
  artifactKey: string,
  fetchedAt: string,
  extra: Partial<ArtifactMeta>,
): ArtifactMeta {
  return {
    id,
    sourceId,
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    artifactKey,
    url: null,
    mime: "application/json",
    fetchedAt,
    sha256: "0".repeat(64),
    ...extra,
  };
}

export interface Capture {
  run: number;
  artifact: number;
  parse: number;
  observations: number[];
  /** Re-parses the same bytes of the same artifact under another parser version (a replay). */
  replay: (options?: { publish?: boolean }) => Promise<Capture>;
}

export interface CaptureOptions {
  fetchedAt: string;
  rows: readonly UsageRow[];
  /** Default true. */
  publish?: boolean;
  /** Default `resolveIdentity`, the deployed resolver; null leaves the parse unidentified. */
  identify?: IdentityResolver | null;
  /** Rewrites each parsed row before it is stored (e.g. an external id with unusual characters). */
  rewrite?: (row: Observation) => Observation;
}

/** One Miniflare CORE with typed writers for card captures, publication and identity. */
export class World {
  readonly db: D1Database;
  private sequence = 1000;
  constructor(readonly env: Env) {
    this.db = env.DB;
  }

  private id(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /** A Vpass card-month capture of one card ordinal; bound to `token` unless it is null. */
  async vpass(
    input: CaptureOptions & {
      family: "web" | "customized";
      card?: string;
      month?: string;
      token?: string | null;
    },
  ): Promise<Capture> {
    const card = input.card ?? "card-001";
    const month = input.month ?? "202605";
    const run = this.id();
    const unit = this.id();
    const artifact = this.id();
    const key = `cards/${card}/months/${month}/top-000.json`;
    const payload = vpassPayload(input.family, month, input.rows);
    await seedUnitRun(this.env, {
      id: run,
      source: "vpass",
      dataset: "statement-page",
      runOutcome: "success",
      fetchedAtMs: Date.parse(input.fetchedAt),
      units: [
        { id: unit, key: card, outcome: "success", artifacts: [{ id: artifact, key, payload }] },
      ],
    });
    await this.db.batch([
      this.db
        .prepare("UPDATE acquisition_sessions SET producer_id=?,external_id_namespace=? WHERE id=?")
        .bind(PRODUCER, VPASS_NAMESPACE, run),
      this.db.prepare("UPDATE fetch_units SET unit_kind='card' WHERE id=?").bind(unit),
    ]);
    const token = input.token === undefined ? TOKEN_A : input.token;
    if (token !== null) await this.bind(run, card, token);
    return this.parse(
      run,
      artifact,
      "vpass",
      vpassStatementPage,
      new TextEncoder().encode(JSON.stringify(payload)),
      meta(artifact, "vpass", "statement-page", key, input.fetchedAt, { fetchUnitKey: card }),
      input,
    );
  }

  /** The trusted importer sidecar that binds one card ordinal of a run to a durable token. */
  private async bind(run: number, card: string, token: string): Promise<void> {
    const binding = this.id();
    const unit = this.id();
    const artifact = this.id();
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO fetch_runs(id,source_id,producer_id,acquisition_session_id,source_run_key,first_recorded_at_ms) VALUES(?,'vpass',?,?,?,0)",
        )
        .bind(binding, PRODUCER, run, `${card}-vpass-card-binding-v1`),
      this.db
        .prepare("INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,'card')")
        .bind(unit, binding, token),
      this.db
        .prepare("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',0,0)")
        .bind(binding),
      this.db
        .prepare("INSERT INTO fetch_unit_reports VALUES(?,'terminal','success',NULL)")
        .bind(unit),
      this.db
        .prepare(
          "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,artifact_role,format_id,format_version) VALUES(?,?,'vpass','card-identity-binding','card-identity-binding.json',?,'collector_derived','vpass-card-identity-binding-json','1')",
        )
        .bind(artifact, binding, unit),
      this.db
        .prepare("INSERT INTO fetch_run_seals(fetch_run_id,sealed_at_ms) VALUES(?,0)")
        .bind(binding),
    ]);
  }

  /** One MyJCB `credit-ledger` capture of a connection. */
  async myjcb(
    input: CaptureOptions & {
      state: "confirmed" | "unconfirmed";
      period: string;
      connection?: string;
      detailMonth?: number;
      /** The acquisition session's external id namespace; default `MYJCB_NAMESPACE`. */
      namespace?: string;
    },
  ): Promise<Capture> {
    const connection = input.connection ?? "conn-a";
    const detailMonth = input.detailMonth ?? (input.state === "unconfirmed" ? 0 : 1);
    const run = this.id();
    const unit = this.id();
    const artifact = this.id();
    const key = `${connection}/credit-ledger-${String(detailMonth).padStart(2, "0")}.json`;
    const payload = ledgerPayload(detailMonth, input.period, input.state, input.rows);
    await seedUnitRun(this.env, {
      id: run,
      source: "myjcb",
      dataset: "credit-ledger",
      runOutcome: "success",
      fetchedAtMs: Date.parse(input.fetchedAt),
      units: [
        {
          id: unit,
          key: connection,
          outcome: "success",
          artifacts: [{ id: artifact, key, payload }],
        },
      ],
    });
    await this.db.batch([
      this.db
        .prepare("UPDATE acquisition_sessions SET producer_id=?,external_id_namespace=? WHERE id=?")
        .bind(PRODUCER, input.namespace ?? MYJCB_NAMESPACE, run),
      this.db
        .prepare(
          "INSERT INTO observation_artifact_metadata(fetch_artifact_id,statement_state,period) VALUES(?,?,?)",
        )
        .bind(artifact, input.state, input.period),
    ]);
    return this.parse(
      run,
      artifact,
      "myjcb",
      myJcbCreditLedger,
      new TextEncoder().encode(JSON.stringify(payload)),
      meta(artifact, "myjcb", "credit-ledger", key, input.fetchedAt, {
        statementState: input.state,
        period: input.period,
      }),
      input,
    );
  }

  /**
   * One confirmed MyJCB `credit-detail` page of a connection, parsed by the
   * deployed statement parser into its `credit_statement_payment_amount`, then
   * published and identified. `period` is the manifest label (it may be the
   * collector's relative `detailMonth-N`); the page's own heading and payment
   * date name the month.
   */
  async myjcbStatement(input: {
    fetchedAt: string;
    detailMonth: number;
    period: string;
    /** The heading's payment month and the dated total, e.g. `2026年10月` and `2026年10月13日(火)`. */
    heading: string;
    paymentDay: string;
    total: string;
    connection?: string;
  }): Promise<Capture> {
    const connection = input.connection ?? "conn-a";
    const run = this.id();
    const unit = this.id();
    const artifact = this.id();
    const key = `${connection}/credit-detail-${String(input.detailMonth).padStart(2, "0")}.html`;
    const html = `<!doctype html><html><body><h1>MyJCB</h1><h1>カードご利用代金明細(確定分)</h1><h2>${input.heading}お支払い分のカードご利用明細</h2><div class="detail-list-01"></div><dl><dt>${input.paymentDay}お支払い金額合計</dt><dd>${input.total}円</dd></dl></body></html>`;
    await seedUnitRun(this.env, {
      id: run,
      source: "myjcb",
      dataset: "credit-detail",
      runOutcome: "success",
      fetchedAtMs: Date.parse(input.fetchedAt),
      units: [
        {
          id: unit,
          key: connection,
          outcome: "success",
          artifacts: [{ id: artifact, key, payload: html }],
        },
      ],
    });
    await this.db.batch([
      this.db
        .prepare("UPDATE acquisition_sessions SET producer_id=?,external_id_namespace=? WHERE id=?")
        .bind(PRODUCER, MYJCB_NAMESPACE, run),
      this.db
        .prepare(
          "INSERT INTO observation_artifact_metadata(fetch_artifact_id,statement_state,period) VALUES(?,'confirmed',?)",
        )
        .bind(artifact, input.period),
    ]);
    const parse = this.id();
    await this.db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'2026-09-01','pending','[]')",
      )
      .bind(parse, artifact, myJcbCreditStatement.name, myJcbCreditStatement.version)
      .run();
    const observations: number[] = [];
    const parsed = myJcbCreditStatement.parse(
      new TextEncoder().encode(html),
      meta(artifact, "myjcb", "credit-detail", key, input.fetchedAt, {
        mime: "text/html; charset=utf-8",
        statementState: "confirmed",
        period: input.period,
      }),
    );
    for (const row of parsed.observations as Observation[]) {
      if (row.kind !== "balance") continue;
      const inserted = await this.db
        .prepare(
          `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        )
        .bind(
          parse,
          row.sourceAccount,
          row.metric,
          row.amountMinor ?? null,
          row.amountText ?? null,
          row.amountScale ?? null,
          row.instrument ?? null,
          row.asOf ?? null,
          row.observedAt ?? null,
          row.rawLocator,
          JSON.stringify(row.extra),
        )
        .first<{ id: number }>();
      observations.push(inserted!.id);
    }
    await this.db.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(parse).run();
    await publishParse(this.db, parse);
    await identifyParse(
      this.db,
      {
        id: parse,
        artifact_id: artifact,
        source_id: "myjcb",
        producer_id: PRODUCER,
        fetch_run_id: run,
      },
      resolveIdentity,
    );
    return {
      run,
      artifact,
      parse,
      observations,
      replay: () => Promise.reject(new Error("a statement capture is not replayed here")),
    };
  }

  /** A pending parse run, its observations, `ok`, then publication and identity as asked. */
  private async parse(
    run: number,
    artifact: number,
    source: "vpass" | "myjcb",
    parser: Parser,
    bytes: Uint8Array,
    artifactMeta: ArtifactMeta,
    options: Omit<CaptureOptions, "fetchedAt" | "rows">,
    version = parser.version,
  ): Promise<Capture> {
    const parse = this.id();
    await this.db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'2026-09-01','pending','[]')",
      )
      .bind(parse, artifact, parser.name, version)
      .run();
    const observations: number[] = [];
    for (const parsed of parser.parse(bytes, artifactMeta).observations as Observation[]) {
      const row = options.rewrite ? options.rewrite(parsed) : parsed;
      if (row.kind !== "transaction") continue;
      const inserted = await this.db
        .prepare(
          `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        )
        .bind(
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
        )
        .first<{ id: number }>();
      observations.push(inserted!.id);
    }
    await this.db.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(parse).run();
    if (options.publish ?? true) await publishParse(this.db, parse);
    const resolver = options.identify === undefined ? resolveIdentity : options.identify;
    if (resolver)
      await identifyParse(
        this.db,
        {
          id: parse,
          artifact_id: artifact,
          source_id: source,
          producer_id: PRODUCER,
          fetch_run_id: run,
        },
        resolver,
      );
    let replays = 0;
    return {
      run,
      artifact,
      parse,
      observations,
      replay: (replay = {}) =>
        this.parse(
          run,
          artifact,
          source,
          parser,
          bytes,
          artifactMeta,
          { ...options, ...replay },
          `${version}-replay-${(replays += 1)}`,
        ),
    };
  }

  async publish(capture: Capture): Promise<void> {
    await publishParse(this.db, capture.parse);
  }

  async sweep(options: CardPurchaseSweepOptions = {}): Promise<CardPurchaseSweepResult> {
    return cardPurchaseSweep(this.db, { now: NOW, ...options });
  }

  async all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
    return (
      await this.db
        .prepare(sql)
        .bind(...binds)
        .all<T>()
    ).results;
  }

  async count(sql: string, ...binds: unknown[]): Promise<number> {
    return (await this.db
      .prepare(sql)
      .bind(...binds)
      .first<number>("n"))!;
  }

  /** Current card usage, every page. */
  async usage(): Promise<CurrentCardUsageRow[]> {
    const page = currentCardUsageSql({ afterId: 0, limit: 1000 });
    return this.all<CurrentCardUsageRow>(page.sql, ...page.args);
  }

  /** Every row of every table recognition writes, pointers included. */
  async snapshot(): Promise<Record<string, unknown>> {
    const tables = [
      "decision_revisions",
      "economic_event_revisions",
      "economic_legs",
      "card_purchase_recognitions",
      "card_purchase_recognition_keys",
      "allocations",
    ];
    return Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          await this.all(`SELECT * FROM ${table} ORDER BY 1,2,3`),
        ]),
      ),
    );
  }

  /** Live purchase/refund revisions read back into the domain shape. */
  async liveEvents(): Promise<EconomicEventRevision[]> {
    const events = await this.all<Record<string, any>>(
      "SELECT * FROM current_economic_events WHERE kind IN ('purchase','refund') ORDER BY event_id",
    );
    const legs = await this.all<Record<string, any>>(
      `SELECT l.* FROM economic_legs l JOIN current_economic_events e ON e.event_id=l.event_id AND e.revision=l.revision
       WHERE e.kind IN ('purchase','refund') ORDER BY l.event_id,l.leg_index`,
    );
    return events.map((event) => ({
      eventId: event["event_id"],
      revision: event["revision"],
      kind: event["kind"],
      state: event["state"],
      unknownReason: event["unknown_reason"],
      effectiveTime: JSON.parse(event["effective_time_json"]),
      basis: event["basis"],
      evidenceSupport: JSON.parse(event["evidence_support_json"]),
      decisionRevisionRef: event["decision_revision_id"],
      supersededBy: null,
      legs: legs
        .filter((leg) => leg["event_id"] === event["event_id"])
        .map((leg) => ({
          eventId: leg["event_id"],
          revision: leg["revision"],
          legIndex: leg["leg_index"],
          subjectRef: leg["subject_ref"],
          quantity: exactQuantity(
            leg["unit_ref"],
            normalizeDecimal(BigInt(leg["coefficient"]), leg["scale"]),
            "decimal-v1",
          ),
          role: leg["role"],
          basis: leg["basis"],
        })),
    }));
  }

  /** State-separated JPY totals of the live events, through the domain summary (never SQL sums). */
  async totals(): Promise<{
    captured: string;
    authorized: string;
    capturedRefunds: string;
    authorizedRefunds: string;
    unresolved: number;
  }> {
    const summary = cardPurchaseSummary(await this.liveEvents());
    if (!summary.ok) throw new Error("summary failed");
    const jpy = summary.summary.units.find((unit) => unit.unitRef === "JPY");
    const text = (name: "captured" | "authorized" | "capturedRefunds" | "authorizedRefunds") => {
      const value = jpy?.[name].value;
      return value?.status === "exact" ? value.value.coefficient : "0";
    };
    return {
      captured: text("captured"),
      authorized: text("authorized"),
      capturedRefunds: text("capturedRefunds"),
      authorizedRefunds: text("authorizedRefunds"),
      unresolved: summary.summary.unresolved,
    };
  }

  async cursor(): Promise<number> {
    return this.count(
      "SELECT last_observation_id AS n FROM card_purchase_scan_cursor WHERE singleton=1",
    );
  }
}

const open: Miniflare[] = [];
/** Dispose every world a test opened; each test file calls it from `afterEach`. */
export async function disposeWorlds(): Promise<void> {
  for (const mf of open.splice(0)) await mf.dispose();
}

export async function world(): Promise<World> {
  const { mf, env } = await startPipeline();
  open.push(mf);
  return new World(env);
}
