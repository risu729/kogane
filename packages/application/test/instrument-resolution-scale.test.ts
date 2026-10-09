// The cost of the instrument candidate read (src/query/instrument-resolution.ts,
// ADR 0055 and its 2026-10-09 amendment) before a route serves it: the
// complete CORE schema, foreign keys on, never analyzed (D1 runs no
// `ANALYZE`, so its planner has no table statistics and neither has this
// store), identifiers written by the production identity writer
// (`identifyParse`) through the deployed SBI rules and the synthetic second
// broker's test policy. SBI Securities is captured daily: a domestic account
// holding `holdings` codes on XTKS and trading `trades` of them a day on a
// venue the SBI rule does not map, and a foreign account holding `foreign`
// codes with a RIC; broker B holds `broker` of the domestic codes daily.
// Every capture stays current (each is its own artifact), so the read walks
// every one of them.
//
// CI builds `CI_SCALE` and checks the plan and the answer; set
// KOGANE_INSTRUMENT_RESOLUTION_SCALE=full to build `FULL_SCALE` (a few
// minutes, or KOGANE_INSTRUMENT_RESOLUTION_DAYS days of captures) and print
// the timings the ADR 0055 amendment quotes. Every code,
// name and account is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { fullCoreSchema } from "../../read-model/test/card-usage-scale-fixture.ts";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import {
  IDENTITY_OBSERVATION_COUNT_SQL,
  INSTRUMENT_FACTS_SQL,
  LISTED_AS_SQL,
} from "../../read-model/src/instrument-resolution.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { identifyParse } from "../../storage-d1/src/core/identity-store.ts";
import { sqliteD1 } from "../../storage-d1/test/sqlite.ts";
import {
  reviewInstrumentCandidates,
  type InstrumentCandidatesRequest,
} from "../src/query/instrument-candidates-review.ts";
import { queryInstrumentResolution } from "../src/query/instrument-resolution.ts";
import { BROKER_B, resolver } from "./instrument-resolution-world.ts";

interface Scale {
  days: number;
  holdings: number;
  trades: number;
  foreign: number;
  broker: number;
}

const FULL = process.env["KOGANE_INSTRUMENT_RESOLUTION_SCALE"] === "full";
/** About one year of daily captures of a large retail portfolio, and a second broker. */
const FULL_SCALE: Scale = {
  days: Number(process.env["KOGANE_INSTRUMENT_RESOLUTION_DAYS"] ?? 365),
  holdings: 150,
  trades: 10,
  foreign: 30,
  broker: 100,
};
const CI_SCALE: Scale = { days: 12, holdings: 30, trades: 4, foreign: 6, broker: 20 };
const SCALE = FULL ? FULL_SCALE : CI_SCALE;
const TIMEOUT = FULL ? 1_800_000 : 120_000;
const PRODUCER = "collector-r2-importer";
const CLIENT = "scale-client";
const SHA = "a".repeat(64);
const DAY_MS = 86_400_000;

const hex = (value: number): string => value.toString(16).padStart(64, "0");
const code = (index: number): string => `SYN${String(1000 + index)}`;

class ScaleStore {
  readonly db: Database = fullCoreSchema();
  private id = 0;
  private readonly statements = new Map<string, ReturnType<Database["prepare"]>>();
  observations = 0;

  constructor() {
    this.run(
      "INSERT INTO sources(id,provider,display_name) VALUES(?,'synthetic','Synthetic broker B')",
      BROKER_B,
    );
    this.run("INSERT INTO producer_sources(producer_id,source_id) VALUES(?,?)", PRODUCER, BROKER_B);
    this.run(
      "INSERT INTO ingest_clients(id,display_name,active) VALUES(?,'Scale client',1)",
      CLIENT,
    );
    this.run(
      "INSERT INTO ingest_client_producers(ingest_client_id,producer_id) VALUES(?,?)",
      CLIENT,
      PRODUCER,
    );
    for (const source of ["sbi-securities", BROKER_B])
      this.run(
        "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES(?,?,?)",
        CLIENT,
        PRODUCER,
        source,
      );
    this.run(
      "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?,3,'objects/scale',0)",
      SHA,
    );
  }

  private run(sql: string, ...binds: (string | number | null)[]): number {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return Number(statement.run(...(binds as SQLQueryBindings[])).lastInsertRowid);
  }

  private next(): number {
    this.id += 1;
    return this.id;
  }

  /** One sealed, successful run with one artifact, a published parse of `rows`, identified. */
  async capture(
    source: string,
    day: number,
    positions: {
      account: string;
      code: string;
      name: string;
      market: string | null;
      currency: string;
      extra: Record<string, unknown>;
    }[],
    trades: { account: string; currency: string; extra: Record<string, unknown> }[],
  ): Promise<void> {
    const at = day * DAY_MS;
    const session = this.next();
    this.run(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?,?,?,'scale',?,?)`,
      session,
      PRODUCER,
      CLIENT,
      `scale-session-${session}`,
      at,
    );
    const run = this.next();
    this.run(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?,?,?,?,?,'default',?)`,
      run,
      session,
      PRODUCER,
      source,
      CLIENT,
      at,
    );
    const artifact = this.next();
    this.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
        payload_fidelity,container_kind,lineage_disposition,dataset,declared_media_type,media_type_basis,
        fetched_at_ms,fetched_at_basis,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
       VALUES(?,?,?,?,?,'capture.json','provider_response','exact','single','not_applicable','synthetic','application/json',
        'response_header',?,'response',?,3,'v1',?,?)`,
      artifact,
      run,
      source,
      PRODUCER,
      CLIENT,
      at,
      SHA,
      hex(artifact),
      at,
    );
    const inventory = this.next();
    this.run(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
       VALUES(?,?,?,1,'operator',?,?)`,
      inventory,
      run,
      hex(inventory),
      at,
      CLIENT,
    );
    this.run(
      "INSERT INTO run_inventory_items(inventory_id,fetch_run_id,artifact_key,sha256,descriptor_sha256) VALUES(?,?,'capture.json',?,?)",
      inventory,
      run,
      SHA,
      hex(artifact),
    );
    this.run(
      `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,
        started_at_ms,started_at_basis,completed_at_ms,completed_at_basis,recorded_at_ms)
       VALUES(?,'terminal','terminal',?,'success',?,'manifest',?,'manifest',?)`,
      run,
      CLIENT,
      at,
      at,
      at,
    );
    this.run(
      "INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?,?,?,?)",
      inventory,
      run,
      at,
      CLIENT,
    );
    const parse = this.next();
    this.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'synthetic','1','2026-09-01','pending','[]')",
      parse,
      artifact,
    );
    for (const [index, position] of positions.entries())
      this.run(
        `INSERT INTO position_observations(parse_run_id,source_account,security_code,security_name,market,quantity_text,quantity_scale,currency,raw_locator,extra_json)
         VALUES(?,?,?,?,?,'1',0,?,?,?)`,
        parse,
        position.account,
        position.code,
        position.name,
        position.market,
        position.currency,
        `$.positions[${index}]`,
        JSON.stringify(position.extra),
      );
    for (const [index, trade] of trades.entries())
      this.run(
        `INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json)
         VALUES(?,?,?,?,?)`,
        parse,
        trade.account,
        trade.currency,
        `$.trades[${index}]`,
        JSON.stringify(trade.extra),
      );
    this.observations += positions.length + trades.length;
    this.run("UPDATE parse_runs SET status='ok' WHERE id=?", parse);
    this.run(
      "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,'synthetic',NULL,?,'normal','pipeline','parse_ok','2026-09-01')",
      artifact,
      parse,
    );
    this.run(
      "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,'synthetic',?,'1','2026-09-01','normal')",
      artifact,
      parse,
    );
    const meta = {
      id: parse,
      artifact_id: artifact,
      source_id: source,
      producer_id: PRODUCER,
      fetch_run_id: run,
    };
    while (await identifyParse(sqliteD1(this.db), meta, resolver)) {
      // Resume the writer's bounded pages until the run is sealed.
    }
  }
}

async function build(scale: Scale): Promise<ScaleStore> {
  const store = new ScaleStore();
  for (let day = 0; day < scale.days; day += 1) {
    await store.capture(
      "sbi-securities",
      day,
      [
        ...Array.from({ length: scale.holdings }, (_, index) => ({
          account: "sbi-securities:domestic",
          code: code(index),
          name: `Synthetic ${code(index)}`,
          market: "TKY",
          currency: "JPY",
          extra: {},
        })),
        ...Array.from({ length: scale.foreign }, (_, index) => ({
          account: "sbi-securities:foreign",
          code: `SYNF${String(index)}`,
          name: `Synthetic foreign ${String(index)}`,
          market: null,
          currency: "USD",
          extra: {
            specificAccountCode: "SYNTHETIC",
            securities: {
              securitiesCode: `SYNF${String(index)}`,
              ric: `SYNF${String(index)}.X`,
              countryCode: "US",
            },
          },
        })),
      ],
      Array.from({ length: scale.trades }, (_, index) => {
        const traded = code((day * scale.trades + index) % scale.holdings);
        return {
          account: "sbi-securities:domestic",
          currency: "JPY",
          extra: {
            issueCode: traded,
            issueName: `Synthetic ${traded}`,
            marketLabel: "SYNTHETIC-VENUE",
            accountLabel: "synthetic",
          },
        };
      }),
    );
    await store.capture(
      BROKER_B,
      day,
      Array.from({ length: scale.broker }, (_, index) => ({
        account: "synthetic-broker-b:custody",
        code: code(index),
        name: `SYNTHETIC ${code(index)}`,
        market: null,
        currency: "JPY",
        extra: { country: "JP" },
      })),
      [],
    );
  }
  return store;
}

let store: ScaleStore;
let sql: SqlExecutor;

beforeAll(async () => {
  store = await build(SCALE);
  const db = store.db;
  sql = {
    all: async <T>(text: string, args: readonly unknown[]) =>
      db.query(text).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(text: string, args: readonly unknown[]) =>
      (db.query(text).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}, TIMEOUT);

/** Median wall time of `runs` executions, in milliseconds. */
async function timed(run: () => unknown, runs = 5): Promise<number> {
  const times: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  return Math.round(times.sort((left, right) => left - right)[Math.floor(runs / 2)]! * 10) / 10;
}

const OPEN: InstrumentCandidatesRequest = { view: "open", offset: 0, identifierId: null };
const READER = {
  principal: "scale-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
} as const;

describe("the candidate read on a scaled store without table statistics", () => {
  test("the store has no statistics and holds every capture as current", () => {
    expect(
      store.db
        .query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")
        .get(),
    ).toEqual({ n: 0 });
    const current = store.db
      .query("SELECT count(*) AS n FROM current_identity_observations")
      .get() as { n: number };
    expect(current.n).toBe(store.observations);
    expect(store.db.query(IDENTITY_OBSERVATION_COUNT_SQL).get()).toEqual({ n: store.observations });
  });

  test("the facts read reaches uses, units and mappings by key and scans no observation table", () => {
    const steps = explain(store.db, INSTRUMENT_FACTS_SQL, []).map((step) => step.detail);
    const text = steps.join("\n");
    for (const table of [
      "transaction_observations",
      "balance_observations",
      "position_observations",
      "valuation_observations",
    ])
      expect(text).not.toContain(table);
    // Uses are reached from each current identity observation by primary key,
    // never by scanning the use, identifier or mapping tables whole.
    expect(text).not.toMatch(/SCAN (u|t|n|td|c|d)\b/u);
    expect(text).toContain("SEARCH u USING INDEX sqlite_autoindex_identity_instrument_uses_1");
    for (const alias of ["t", "n"])
      expect(text).toContain(
        `SEARCH ${alias} USING INDEX sqlite_autoindex_identity_instrument_uses_1 (identity_observation_id=? AND role=?) LEFT-JOIN`,
      );
    // The walk itself: every published parse, through the view's covering index.
    expect(text).toContain("SCAN pub USING COVERING INDEX published_parse_runs_run");
    const listed = explain(store.db, LISTED_AS_SQL, [])
      .map((step) => step.detail)
      .join("\n");
    expect(listed).not.toMatch(/SCAN r\b/u);
    expect(listed).toContain("SEARCH r USING INDEX entity_relations_from");
    // The bound's count reads identity runs and their seals, never an observation.
    const count = explain(store.db, IDENTITY_OBSERVATION_COUNT_SQL, [])
      .map((step) => step.detail)
      .join("\n");
    expect(count).not.toContain("identity_observations");
    expect(count).not.toContain("identity_instrument_uses");
    expect(count).toContain("SEARCH s USING INDEX sqlite_autoindex_identity_run_seals_1");
  });

  test("the answer on the scaled store: one proposal per code held at both brokers", async () => {
    const resolution = await queryInstrumentResolution(sql);
    // Each broker B code pairs with its XTKS listing; each traded venue code
    // pairs with its listing and with broker B's code where it holds one.
    const listings = resolution.identifiers.filter((row) => row.namespace === "mic-symbol");
    expect(listings).toHaveLength(SCALE.holdings);
    expect(
      resolution.candidates.filter((candidate) => candidate.crossSource).length,
    ).toBeGreaterThanOrEqual(SCALE.broker);
    expect(resolution.summary.adopted).toBe(0);
    const outcome = await reviewInstrumentCandidates({ grant: READER, sql, request: OPEN });
    expect(outcome.ok).toBe(true);
  });

  test.if(FULL)(
    "timings (printed for the ADR 0055 amendment)",
    async () => {
      const facts = await timed(() => sql.all(INSTRUMENT_FACTS_SQL, []));
      const listed = await timed(() => sql.all(LISTED_AS_SQL, []));
      const count = await timed(() => sql.first(IDENTITY_OBSERVATION_COUNT_SQL, []));
      const resolution = await timed(() => queryInstrumentResolution(sql));
      const page = await timed(() =>
        reviewInstrumentCandidates({ grant: READER, sql, request: OPEN }),
      );
      const counted = await queryInstrumentResolution(sql);
      const factRows = (await sql.all(INSTRUMENT_FACTS_SQL, [])).length;
      console.log(
        JSON.stringify({
          scale: SCALE,
          identityObservations: store.observations,
          identifiers: counted.summary.identifiers,
          factRows,
          candidates: counted.candidates.length,
          separated: counted.summary.separated,
          hints: counted.summary.hints,
          medianMs: { facts, listed, count, resolution, page },
        }),
      );
    },
    TIMEOUT,
  );
});
