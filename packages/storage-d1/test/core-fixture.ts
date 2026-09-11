// One synthetic CORE database for the Drizzle pilot's tests.
//
// Everything here is invented: a source called "pilot-source", two clients,
// one session, two runs, two artifacts of three and zero bytes, and amounts
// that exist to break naive mappers rather than to describe money anybody
// holds. No provider name, account, credential or real digest appears.
//
// The rows are chosen for the four ways a query can quietly stop meaning the
// same thing when it moves to an ORM:
//
// - **NULL**: the terminal report leaves eleven nullable columns empty, and
//   the second decimal row is `unparsed` with both value columns NULL.
// - **Ordering**: the two artifact keys differ only in case, so a BINARY
//   ordering ("B.json" before "a.json") and a case-insensitive one disagree.
// - **Paging / ties**: two verification events share a `checked_at_ms`, so
//   "most recent" is decided by the id tiebreaker and not by luck.
// - **Exactness**: the coefficient is larger than 2^53 and the date-only
//   bounds are calendar days, so any numeric or `Date` round trip loses.
import type { Database } from "bun:sqlite";
import { fullCoreDatabase } from "./sqlite.ts";

export const CLIENT = "pilot-client";
export const OTHER_CLIENT = "other-client";
export const REVOKED_CLIENT = "revoked-client";
export const SOURCE = "pilot-source";
export const PRODUCER = "pilot-producer";
export const RUN_ID = 1;
export const EMPTY_RUN_ID = 2;
/** Three bytes; the artifact keyed "B.json" carries them. */
export const OBJECT_SHA256 = "a".repeat(64);
/** Zero bytes; the artifact keyed "a.json" carries them. */
export const EMPTY_SHA256 = "b".repeat(64);
export const DESCRIPTOR_A = "c".repeat(64);
export const DESCRIPTOR_B = "d".repeat(64);
/** Larger than 2^53: a JS number cannot hold it without losing digits. */
export const BIG_COEFFICIENT = "123456789012345678901234567891";

const FIXTURE = `
INSERT INTO sources(id,provider,display_name) VALUES('${SOURCE}','synthetic','Pilot source');
INSERT INTO producers(id,kind,display_name) VALUES('${PRODUCER}','collector','Pilot producer');
INSERT INTO producer_sources(producer_id,source_id) VALUES('${PRODUCER}','${SOURCE}');
INSERT INTO ingest_clients(id,display_name,active) VALUES
 ('${CLIENT}','Pilot client',1),('${OTHER_CLIENT}','Other client',1),('${REVOKED_CLIENT}','Revoked client',0);
INSERT INTO ingest_client_producers(ingest_client_id,producer_id) VALUES
 ('${CLIENT}','${PRODUCER}'),('${OTHER_CLIENT}','${PRODUCER}'),('${REVOKED_CLIENT}','${PRODUCER}');
INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES
 ('${CLIENT}','${PRODUCER}','${SOURCE}'),('${OTHER_CLIENT}','${PRODUCER}','${SOURCE}'),
 ('${REVOKED_CLIENT}','${PRODUCER}','${SOURCE}');
INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
 VALUES(1,'${PRODUCER}','${CLIENT}','test','pilot-session',1000);
INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
 VALUES(${RUN_ID},1,'${PRODUCER}','${SOURCE}','${CLIENT}','default',1000),
       (${EMPTY_RUN_ID},1,'${PRODUCER}','${SOURCE}','${CLIENT}','second',1000);
INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES
 ('${OBJECT_SHA256}',3,'objects/aa/${OBJECT_SHA256}',1000),
 ('${EMPTY_SHA256}',0,'objects/bb/${EMPTY_SHA256}',1000);
-- "B.json" sorts before "a.json" under BINARY and after it under NOCASE.
INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
 payload_fidelity,container_kind,lineage_disposition,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms) VALUES
 (1,${RUN_ID},'${SOURCE}','${PRODUCER}','${CLIENT}','B.json','provider_response','exact','single','not_applicable',
  '${OBJECT_SHA256}',3,'v1','${DESCRIPTOR_A}',1000),
 (2,${RUN_ID},'${SOURCE}','${PRODUCER}','${CLIENT}','a.json','provider_response','exact','single','not_applicable',
  '${EMPTY_SHA256}',0,'v1','${DESCRIPTOR_B}',1000);
-- The progress report fills every optional column; the terminal report is the
-- NULL-heavy row. Progress comes first because a run that already reported a
-- terminal outcome refuses later progress (trigger 'fetch_run_already_terminal').
INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,producer_version,producer_revision,
 manifest_schema_version,producer_status,normalized_outcome,started_at_ms,started_at_basis,declared_artifact_count,
 artifact_count_scope,recorded_at_ms)
 VALUES(${RUN_ID},'progress-1','progress','${CLIENT}','v1','rev1','manifest-v1','running','running',900,'manifest',2,
 'all_catalogued',1000);
INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,recorded_at_ms)
 VALUES(${RUN_ID},'terminal','terminal','${CLIENT}','success',1000);
-- Two events share 2000 ms: the id tiebreaker decides which is "most recent".
INSERT INTO raw_object_verification_events(sha256,checked_at_ms,result,observed_size,observed_sha256,detail_code,
 checked_by_client_id,recorded_at_ms) VALUES
 ('${OBJECT_SHA256}',1000,'missing',NULL,NULL,NULL,'${CLIENT}',1000),
 ('${OBJECT_SHA256}',2000,'ok',3,'${OBJECT_SHA256}',NULL,'${CLIENT}',2000),
 ('${OBJECT_SHA256}',2000,'read_error',NULL,NULL,'io','${CLIENT}',2000),
 ('${OBJECT_SHA256}',3000,'missing',NULL,NULL,NULL,'${OTHER_CLIENT}',3000);
INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,error,warnings_json,
 superseded_by_parse_run_id)
 VALUES(1,1,'pilot-parser','1.0.0','2026-09-07T00:00:00Z','ok',NULL,NULL,NULL);
INSERT INTO parser_releases(release_id,parser_name,semantic_version,code_digest,input_contract_version,
 output_contract_version,metadata_extractor_release,dependency_digests_json,registered_at)
 VALUES('pilot-parser@1.0.0','pilot-parser','1.0.0','${"e".repeat(64)}','in-v1','out-v1','meta-v1','{}',
 '2026-09-07T00:00:00Z');
INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind,release_id)
 VALUES(1,'pilot-parser',1,'1.0.0','2026-09-07T00:00:00Z','normal',NULL);
-- One exact amount too large for a JS number, one with nothing to report.
INSERT INTO observation_decimal_values(kind,observation_id,parse_run_id,policy_version,status,coefficient,scale,basis) VALUES
 ('balance',1,1,'decimal-v1','exact','${BIG_COEFFICIENT}',4,'decimal_text'),
 ('balance',2,1,'decimal-v1','unparsed',NULL,NULL,'none');
-- Date-only bounds, including the leap day, and a plan with no window at all.
INSERT INTO observation_replay_plans(id,created_at_ms,updated_at_ms,source_id,dataset,parser_name,parser_version,
 target_release,artifact_id_from,artifact_id_high_water,fetched_from,fetched_to,status,estimated_artifacts,
 already_parsed,jobs_created,creation_cursor,creation_complete,reason,operation_id) VALUES
 (1,1000,1000,'${SOURCE}',NULL,'pilot-parser','1.0.0',NULL,0,2,'2024-02-29','2024-03-01','planned',0,0,0,0,0,'pilot',NULL),
 (2,1000,1000,'${SOURCE}',NULL,'pilot-parser','1.0.0',NULL,0,2,NULL,NULL,'planned',0,0,0,0,1,'pilot',NULL);
`;

/**
 * The whole of CORE with the synthetic rows above.
 *
 * The statements run one at a time rather than through a single `exec`,
 * because a trigger that aborts inside a multi-statement `exec` does not
 * surface — a fixture row would then go missing without anybody noticing,
 * and a test asserting "no rows" would pass for the wrong reason.
 */
export function pilotDatabase(): Database {
  const db = fullCoreDatabase();
  for (const statement of FIXTURE.split(";\n")) {
    const sql = statement.trim();
    if (sql.length > 0) db.run(sql);
  }
  return db;
}
