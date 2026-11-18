import type { Database } from "bun:sqlite";
import { fullCoreDatabase } from "./sqlite.ts";
import { splitSqlStatements } from "../src/migrations.ts";

const SHA = "a".repeat(64);
const DESCRIPTOR = "b".repeat(64);

/** Full production schema and indexes, with only synthetic evidence and no ANALYZE. */
export type SeedStatement = { sql: string; values: (string | number | null)[] };
export function identitySweepFixture(
  size: number,
  seed: number,
  statements: SeedStatement[] = [],
): Database {
  const actual = fullCoreDatabase();
  const db = {
    exec(sql: string) {
      for (const statement of splitSqlStatements(sql))
        statements.push({ sql: statement, values: [] });
      actual.exec(sql);
    },
    run(sql: string, values: (string | number | null)[]) {
      statements.push({ sql, values });
      return actual.query(sql).run(...values);
    },
    transaction: actual.transaction.bind(actual),
  };
  let state = seed;
  const random = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  db.exec(`
    INSERT INTO sources(id,provider,display_name) VALUES('identity-fixture','Fixture','Fixture');
    INSERT INTO producers(id,kind,display_name) VALUES('identity-fixture','collector','Fixture');
    INSERT INTO ingest_clients(id,display_name) VALUES('identity-client','Fixture');
    INSERT INTO ingest_client_producers VALUES('identity-client','identity-fixture',1);
    INSERT INTO raw_objects VALUES('${SHA}',3,'objects/aa/${SHA}',1000);
  `);
  for (const source of [
    "identity-fixture",
    "mizuho-bank",
    "sbi-shinsei-bank",
    "vpass",
    "myjcb",
    "sbi-securities",
  ]) {
    db.run(
      "INSERT OR IGNORE INTO sources(id,provider,display_name) VALUES(?1,'Fixture','Fixture')",
      [source],
    );
    db.run("INSERT INTO producer_sources VALUES('identity-fixture',?1,1)", [source]);
    db.run("INSERT INTO ingest_client_routes VALUES('identity-client','identity-fixture',?1,1)", [
      source,
    ]);
  }
  /** One fetch run, its artifact and parse, and optionally a sealed identity run. */
  const run = (row: {
    id: number;
    source: string;
    dataset: string | null;
    outcome: "success" | "failed";
    sealed: boolean;
    excluded: boolean;
    status: "ok" | "error";
    /** The sealed identity run's version, or null for none. */
    identified: number | null;
    observed: boolean;
    published: boolean;
  }) => {
    const { id, source } = row;
    db.run(
      "INSERT INTO acquisition_sessions VALUES(?1,'identity-fixture','identity-client','synthetic',?2,1000)",
      [id, `session-${id}`],
    );
    db.run(
      "INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,first_recorded_at_ms) VALUES(?1,?1,'identity-fixture',?2,'identity-client',1000)",
      [id, source],
    );
    db.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,payload_fidelity,lineage_disposition,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms,dataset)
        VALUES(?1,?1,?2,'identity-fixture','identity-client','fixture.json','provider_response','exact','not_applicable','${SHA}',3,'v1','${DESCRIPTOR}',1000,?3)`,
      [id, source, row.dataset],
    );
    db.run(
      "INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,declared_artifact_count,artifact_count_scope,recorded_at_ms) VALUES(?1,'terminal','terminal','identity-client',?2,1,'all_catalogued',1000)",
      [id, row.outcome],
    );
    if (row.sealed) {
      db.run(
        `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id) VALUES(?1,?1,'${"c".repeat(64)}',1,'operator',1000,'identity-client')`,
        [id],
      );
      db.run(
        `INSERT INTO run_inventory_items VALUES(?1,?1,'fixture.json','${SHA}','${DESCRIPTOR}')`,
        [id],
      );
      db.run("INSERT INTO fetch_run_seals VALUES(?1,?1,1000,'identity-client')", [id]);
    }
    if (row.excluded)
      db.run(
        "INSERT INTO fetch_run_annotations VALUES(?1,'exclude_from_financial_views','synthetic-test',1000)",
        [id],
      );
    db.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?1,?1,'fixture','1.0.0','2026-01-01T00:00:00Z',?2,'[]')",
      [id, row.status],
    );
    if (row.identified !== null) {
      db.run(
        "INSERT INTO identity_runs(id,parse_run_id,policy_version,created_at) VALUES(?1,?2,?3,'2026-01-01T00:00:00Z')",
        [`identity-${id}`, id, row.identified],
      );
      db.run("INSERT INTO identity_run_seals VALUES(?1,0,'2026-01-01T00:00:00Z')", [
        `identity-${id}`,
      ]);
    }
    if (row.observed)
      db.run(
        "INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json) VALUES(?1,'synthetic','balance',1,'1',0,'JPY','2026-01-01','2026-01-01T00:00:00Z','$','{}')",
        [id],
      );
    if (row.published)
      db.run(
        "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?1,'fixture',?1,'1.0.0','2026-01-01T00:00:00Z','normal')",
        [id],
      );
  };
  db.transaction(() => {
    for (let id = 1; id <= size; id += 1) {
      const drawn = ["identity-fixture", "mizuho-bank", "vpass"][random(3)]!;
      // Half of the policy-2 source rows are SBI Shinsei (ADR 0076), chosen by
      // id so the random stream, and every other row, stays as it was.
      const source = drawn === "mizuho-bank" && id % 2 === 1 ? "sbi-shinsei-bank" : drawn;
      const outcome = random(9) === 0 ? "failed" : "success";
      const sealed = id % 17 !== 0;
      const excluded = id % 19 === 0;
      const status = random(7) === 0 ? "error" : "ok";
      const completed = id <= size - 30 && status === "ok" && sealed && !excluded;
      // Some Mizuho and SBI Shinsei rows retain policy 1 and must remain
      // eligible for policy 2.
      const version =
        (source === "mizuho-bank" || source === "sbi-shinsei-bank") && id % 23 !== 0 ? 2 : 1;
      run({
        id,
        source,
        dataset: null,
        outcome,
        sealed,
        excluded,
        status,
        identified: completed ? version : null,
        observed: !completed && status === "ok" && id % 3 === 0,
        published: status === "ok" && sealed && !excluded && id % 2 === 0,
      });
    }
    // A fixed grid after the random rows, for the sources whose required
    // version depends on the artifact's dataset and whose ceiling differs
    // from the build's highest version (ADR 0089, ADR 0113, ADR 0117): each
    // dataset with no identity run and with a sealed run at each version up
    // to 3, empty and not. A source without a module, and one with, sealed
    // above their ceiling complete the cases.
    const grid: [string, string][] = [
      ["sbi-securities", "foreign-trade-records"],
      ["sbi-securities", "foreign-cash-positions"],
      ["sbi-securities", "foreign-cash-balances"],
      ["sbi-securities", "foreign-cash-history"],
      ["sbi-securities", "domestic-cash-positions"],
      ["myjcb", "jpoint-balance"],
      ["myjcb", "card-statements"],
      ["identity-fixture", "synthetic"],
      ["mizuho-bank", "synthetic"],
    ];
    let id = size;
    for (const [source, dataset] of grid)
      for (const identified of [null, 1, 2, 3])
        for (const observed of [false, true]) {
          id += 1;
          run({
            id,
            source,
            dataset,
            outcome: "success",
            sealed: true,
            excluded: false,
            status: "ok",
            identified,
            observed,
            published: id % 2 === 0,
          });
        }
  })();
  return actual;
}
