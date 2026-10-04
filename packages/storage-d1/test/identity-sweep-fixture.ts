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
      return actual.run(sql, values);
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
  for (const source of ["identity-fixture", "mizuho-bank", "vpass"]) {
    db.run(
      "INSERT OR IGNORE INTO sources(id,provider,display_name) VALUES(?1,'Fixture','Fixture')",
      [source],
    );
    db.run("INSERT INTO producer_sources VALUES('identity-fixture',?1,1)", [source]);
    db.run("INSERT INTO ingest_client_routes VALUES('identity-client','identity-fixture',?1,1)", [
      source,
    ]);
  }
  db.transaction(() => {
    for (let id = 1; id <= size; id += 1) {
      const source = ["identity-fixture", "mizuho-bank", "vpass"][random(3)]!;
      const outcome = random(9) === 0 ? "failed" : "success";
      const sealed = id % 17 !== 0;
      const excluded = id % 19 === 0;
      const status = random(7) === 0 ? "error" : "ok";
      const completed = id <= size - 30 && status === "ok" && sealed && !excluded;
      db.run(
        "INSERT INTO acquisition_sessions VALUES(?1,'identity-fixture','identity-client','synthetic',?2,1000)",
        [id, `session-${id}`],
      );
      db.run(
        "INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,first_recorded_at_ms) VALUES(?1,?1,'identity-fixture',?2,'identity-client',1000)",
        [id, source],
      );
      db.run(
        `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,payload_fidelity,lineage_disposition,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
        VALUES(?1,?1,?2,'identity-fixture','identity-client','fixture.json','provider_response','exact','not_applicable','${SHA}',3,'v1','${DESCRIPTOR}',1000)`,
        [id, source],
      );
      db.run(
        "INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,declared_artifact_count,artifact_count_scope,recorded_at_ms) VALUES(?1,'terminal','terminal','identity-client',?2,1,'all_catalogued',1000)",
        [id, outcome],
      );
      if (sealed) {
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
      if (excluded)
        db.run(
          "INSERT INTO fetch_run_annotations VALUES(?1,'exclude_from_financial_views','synthetic-test',1000)",
          [id],
        );
      db.run(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?1,?1,'fixture','1.0.0','2026-01-01T00:00:00Z',?2,'[]')",
        [id, status],
      );
      if (completed) {
        // Some Mizuho rows retain policy 1 and must remain eligible for policy 2.
        const version = source === "mizuho-bank" && id % 23 !== 0 ? 2 : 1;
        db.run(
          "INSERT INTO identity_runs(id,parse_run_id,policy_version,created_at) VALUES(?1,?2,?3,'2026-01-01T00:00:00Z')",
          [`identity-${id}`, id, version],
        );
        db.run("INSERT INTO identity_run_seals VALUES(?1,0,'2026-01-01T00:00:00Z')", [
          `identity-${id}`,
        ]);
      } else if (status === "ok" && id % 3 === 0) {
        db.run(
          "INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,observed_at,raw_locator,extra_json) VALUES(?1,'synthetic','balance',1,'1',0,'JPY','2026-01-01','2026-01-01T00:00:00Z','$','{}')",
          [id],
        );
      }
      if (status === "ok" && sealed && !excluded && id % 2 === 0)
        db.run(
          "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?1,'fixture',?1,'1.0.0','2026-01-01T00:00:00Z','normal')",
          [id],
        );
    }
  })();
  return actual;
}
