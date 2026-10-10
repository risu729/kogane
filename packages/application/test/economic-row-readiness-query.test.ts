import type { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { queryEconomicRowReadiness } from "../src/query/economic-row-readiness.ts";
import {
  ECONOMIC_ROW_READINESS_SQL,
  loadEconomicRowReadiness,
} from "../../read-model/src/economic-row-readiness.ts";
import { accountOf, memberWrites, ROWS, seedOwnTransferStore } from "./own-transfer-fixture.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);
function world() {
  const db = migratedDatabase();
  seedOwnTransferStore(db);
  for (const id of [1, 2, 3]) {
    db.run(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
     VALUES(?,?,?,1,'operator',1000,'synthetic-client')`,
      [id, id, String(id).repeat(64)],
    );
    db.run(
      `INSERT INTO run_inventory_items(inventory_id,fetch_run_id,artifact_key,sha256,descriptor_sha256)
     VALUES(?,?,?,?,?)`,
      [id, id, `synthetic/details-${id}.json`, "a".repeat(64), String(id).repeat(64)],
    );
    db.run(
      `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,recorded_at_ms)
     VALUES(?,'terminal','terminal','synthetic-client','success',1000)`,
      [id],
    );
    db.run(
      `INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?,?,1000,'synthetic-client')`,
      [id, id],
    );
    db.run(
      `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
     SELECT fetch_artifact_id,parser_name,id,parser_version,'2030-01-01','normal' FROM parse_runs WHERE id=?`,
      [id],
    );
    db.run("INSERT INTO identity_runs VALUES(?,?,1,'2030-01-01')", [`ir-${id}`, id]);
    const entries = Object.entries(ROWS).filter(([, r]) => r[0] === id);
    const mapped = new Set<string>();
    for (const [oid, [, sourceAccount]] of entries) {
      const sa = `sa-${id}-${sourceAccount}`;
      if (!mapped.has(sa)) {
        db.run(
          `INSERT INTO source_accounts SELECT ?,a.source_id,a.producer_id,? FROM fetch_artifacts a WHERE a.id=?`,
          [sa, JSON.stringify([sourceAccount]), id],
        );
        db.run(
          `INSERT INTO account_mappings VALUES(?,?,1,?,'rule','synthetic',1,'2030-01-01','Synthetic','identified')`,
          [`map-${sa}`, sa, accountOf(sourceAccount)],
        );
        mapped.add(sa);
      }
      db.run(`INSERT INTO identity_observations VALUES(?,?,'transaction',?,?,?,'[]')`, [
        `io-${oid}`,
        `ir-${id}`,
        Number(oid),
        sa,
        `map-${sa}`,
      ]);
    }
    db.run("INSERT INTO identity_run_seals VALUES(?,?,'2030-01-01')", [`ir-${id}`, entries.length]);
  }
  return { db, store: sqliteCommandStore(db) };
}
const request = (ids = [101, 102]) => ({
  schema: "economic-row-readiness-v1",
  family: "bank-movement",
  knowledge: "current",
  rows: ids.map((observationId) => ({ observationId, parseRunId: ROWS[observationId]?.[0] ?? 1 })),
});
function snapshot(db: Database) {
  const names = db
    .query(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return names.map(({ name }) => [name, db.query(`SELECT * FROM "${name}" ORDER BY 1`).all()]);
}
test("coherent read, provider identity admission, unresolved principal, zero writes and no raw values", async () => {
  const { db, store } = world();
  const before = snapshot(db);
  let calls = 0;
  const result = await queryEconomicRowReadiness(
    {
      ...store,
      all: async <T>(s: string, a: readonly unknown[]) => {
        calls++;
        return store.all<T>(s, a);
      },
    },
    request(),
  );
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw Error(JSON.stringify(result));
  expect(calls).toBe(1);
  expect(result.manifest.rows[0]!.identity).toBe("admitted");
  expect(result.manifest.rows[0]!.reasons).toEqual(["ownership_unresolved"]);
  expect(result.writerEnabled).toBe(false);
  expect(result.proposalEnabled).toBe(false);
  expect(result.historyCoverage).toBe("unknown");
  expect(JSON.stringify(result)).not.toMatch(/meisai|synthetic-a|Producer|1000|ns-a/);
  expect(snapshot(db)).toEqual(before);
  db.close();
});
test("ordering is canonical; missing or mismatched rows are not dropped", async () => {
  const { db, store } = world();
  const a = await queryEconomicRowReadiness(store, request([102, 101]));
  expect(a).toEqual(await queryEconomicRowReadiness(store, request([101, 102])));
  const missing = await queryEconomicRowReadiness(store, request([999]));
  expect(missing.status).toBe("ok");
  if (missing.status === "ok")
    expect(missing.manifest.rows[0]!.reasons).toEqual(["observation_missing"]);
  const mismatch = await queryEconomicRowReadiness(store, {
    ...request([101]),
    rows: [{ observationId: 101, parseRunId: 2 }],
  });
  if (mismatch.status !== "ok") throw Error("unexpected");
  expect(mismatch.manifest.rows[0]!.reasons).toEqual(["observation_missing"]);
  db.close();
});
test.each(["no-reuse", "deleted", "key-destroyed"])(
  "current %s restriction is checked before identity content",
  async (restriction) => {
    for (const ref of [
      "transaction:101",
      "parse_run:1",
      "artifact:1",
      "fetch_run:1",
      `raw:${"a".repeat(64)}`,
    ]) {
      const { db, store } = world();
      const before = await queryEconomicRowReadiness(store, request([101]));
      db.run(
        "INSERT INTO evidence_use_restrictions(evidence_ref,restriction,since,affected_manifests_json,actor,reason) VALUES(?,?,'2099-01-01','[]','synthetic','synthetic')",
        [ref, restriction],
      );
      const result = await queryEconomicRowReadiness(store, request([101]));
      expect(result).not.toEqual(before);
      if (result.status !== "ok") throw Error("unexpected");
      expect(result.manifest.rows[0]!.reasons).toEqual(["evidence_restricted"]);
      const [raw] = await loadEconomicRowReadiness(store, request([101]).rows, "bank-movement");
      expect(raw!.source_account).toBeNull();
      expect(raw!.extra_json).toBeNull();
      expect(raw!.key_text).toBeNull();
      db.close();
    }
  },
);
test("invalid and oversized input refuses before reading, including overrides and old contexts", async () => {
  const { db, store } = world();
  const noRead = {
    ...store,
    all: async <T>(): Promise<T[]> => {
      throw Error("must not read");
    },
  };
  for (const input of [
    { ...request(), knowledge: { instant: "2030-01-01" } },
    { ...request(), accountId: "override" },
    { ...request(), contextId: "old" },
    request([]),
    request([101, 101]),
    request(Array.from({ length: 65 }, (_, i) => i + 1)),
  ])
    expect(await queryEconomicRowReadiness(noRead, input)).toEqual({
      status: "refused",
      reason: "invalid_request",
    });
  db.close();
});
test("republication, rollback and mapping revisions invalidate context", async () => {
  const { db, store } = world();
  const initial = await queryEconomicRowReadiness(store, request([101]));
  db.run(
    `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status) VALUES(9,1,'smbc-direct-transactions','2.0.0','2030-01-02','ok')`,
  );
  db.run(
    "UPDATE published_parse_runs SET parse_run_id=9,parser_version='2.0.0',published_at='2030-01-02' WHERE fetch_artifact_id=1",
  );
  const revised = await queryEconomicRowReadiness(store, request([101]));
  if (revised.status !== "ok") throw Error("unexpected");
  expect(revised.manifest.rows[0]!.reasons).toContain("evidence_not_current");
  db.run(
    "UPDATE published_parse_runs SET parse_run_id=1,parser_version='1.0.0',publication_kind='rollback' WHERE fetch_artifact_id=1",
  );
  const rollback = await queryEconomicRowReadiness(store, request([101]));
  expect(rollback).not.toEqual(initial);
  db.run(
    `INSERT INTO account_mappings SELECT id||'-r2',source_account_id,2,account_id,'manual','synthetic',1,'2030-01-02',label,'unresolved' FROM account_mappings WHERE source_account_id='sa-1-smbc-bank:synthetic-a'`,
  );
  const mapped = await queryEconomicRowReadiness(store, request([101]));
  if (mapped.status !== "ok") throw Error("unexpected");
  expect(mapped.manifest.rows[0]!.reasons).toContain("account_mapping_unresolved");
  expect(mapped).not.toEqual(rollback);
  db.close();
});
test("parse success is not publication; unfinished parses supply no readiness payload", async () => {
  const { db, store } = world();
  for (const [parseId, status] of [
    [10, "ok"],
    [11, "pending"],
  ] as const) {
    db.run(
      `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status)
      VALUES(?,1,'smbc-direct-transactions',?,'2030-01-02',?)`,
      [parseId, `synthetic-${parseId}`, status],
    );
    db.run(
      `INSERT INTO transaction_observations(id,parse_run_id,source_account,external_id,status,extra_json,raw_locator)
      SELECT ?,?,source_account,external_id,status,extra_json,raw_locator FROM transaction_observations WHERE id=101`,
      [1000 + parseId, parseId],
    );
    const rows = [{ observationId: 1000 + parseId, parseRunId: parseId }];
    const result = await queryEconomicRowReadiness(store, { ...request(), rows });
    if (result.status !== "ok") throw Error("unexpected");
    const [loaded] = await loadEconomicRowReadiness(store, rows, "bank-movement");
    expect(loaded!.current_parse).toBe(1);
    expect(result.manifest.rows[0]!.readiness).not.toBe("admitted");
    if (status === "ok") {
      expect(loaded!.visible).toBe(1);
      expect(result.manifest.rows[0]!.reasons).toContain("evidence_not_current");
    } else {
      expect(loaded!.visible).toBe(0);
      expect(loaded!.extra_json).toBeNull();
      expect(result.manifest.rows[0]!.reasons).toEqual(["evidence_unavailable"]);
    }
  }
  db.close();
});

test("same fact under another producer detects alias, own key detects holder; revision release changes context", async () => {
  const { db, store } = world();
  const before = await queryEconomicRowReadiness(store, request([101, 111]));
  await store.batch(
    memberWrites(db, [{ eventId: "synthetic-transfer", revision: 1, legs: [101, 102] }]),
  );
  const held = await queryEconomicRowReadiness(store, request([101, 111]));
  if (held.status !== "ok") throw Error("unexpected");
  expect(held.manifest.rows[0]!.reasons).toContain("economic_claim_held");
  expect(held.manifest.rows[1]!.reasons).toContain("alias_conflict");
  expect(held.manifest.rows[1]!.reasons).not.toContain("economic_claim_held");
  expect(held).not.toEqual(before);
  await store.batch(
    memberWrites(db, [{ eventId: "synthetic-transfer", revision: 2, legs: [] }], [101, 102]),
  );
  const released = await queryEconomicRowReadiness(store, request([101, 111]));
  if (released.status !== "ok") throw Error("unexpected");
  expect(released.manifest.rows[0]!.reasons).not.toContain("economic_claim_held");
  expect(released.manifest.rows[1]!.reasons).not.toContain("alias_conflict");
  expect(released).not.toEqual(held);
  db.close();
});
test("missing schema fails closed without exception detail", async () => {
  const { db, store } = world();
  db.run("DROP VIEW financial_fetch_runs");
  expect(await queryEconomicRowReadiness(store, request())).toEqual({
    status: "unavailable",
    reason: "readiness_store_unavailable",
  });
  db.close();
});
test("missing guard trigger is unavailable, not merely a free claim", async () => {
  const { db, store } = world();
  db.run("DROP TRIGGER economic_claims_guard");
  expect(await queryEconomicRowReadiness(store, request())).toEqual({
    status: "unavailable",
    reason: "readiness_store_unavailable",
  });
  db.close();
});
test("missing identity and changing accepted/rejected/conflicting ownership remain blocked", async () => {
  const { db, store } = world();
  const account = accountOf(ROWS[101]![1]);
  let previous = await queryEconomicRowReadiness(store, request([101]));
  for (const [id, to, status] of [
    ["rel-a", "party:synthetic-a", "accepted"],
    ["rel-b", "party:synthetic-b", "accepted"],
    ["rel-c", "party:synthetic-a", "rejected"],
  ]) {
    db.run(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,reason,evidence_refs_json,created_at)
     VALUES(?,'relation',?,1,?,'manual','synthetic','synthetic','[]','2030-01-01')`,
      [`dr-${id}`, id!, status === "accepted" ? "accept" : "reject"],
    );
    db.run(
      `INSERT INTO entity_relations(id,kind,from_ref,to_ref,status,decision_revision_id,evidence_refs_json,created_at)
     VALUES(?,'beneficial_owner',?,?,?,?,'[]','2030-01-01')`,
      [id!, account, to!, status!, `dr-${id}`],
    );
    const current = await queryEconomicRowReadiness(store, request([101]));
    if (current.status !== "ok") throw Error("unexpected");
    expect(current.manifest.rows[0]!.reasons).toContain("ownership_unresolved");
    expect(current).not.toEqual(previous);
    previous = current;
  }
  db.close();
});
test("published security fingerprint is refused end-to-end without a writer or cost policy", async () => {
  const { db, store } = world();
  db.run(
    "INSERT INTO producer_sources(producer_id,source_id) VALUES('producer-a','sbi-securities')",
  );
  db.run(
    "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('synthetic-client','producer-a','sbi-securities')",
  );
  db.run(`INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
    VALUES(4,'producer-a','synthetic-client','ns-security','synthetic-security',1000)`);
  db.run(`INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
    VALUES(4,4,'producer-a','sbi-securities','synthetic-client','synthetic-security',1000)`);
  db.run(
    `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,
    payload_fidelity,container_kind,lineage_disposition,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
    VALUES(4,4,'sbi-securities','producer-a','synthetic-client','synthetic-security','provider_response','exact','single','not_applicable',?,3,'v1',?,1000)`,
    ["a".repeat(64), "4".repeat(64)],
  );
  db.run(
    `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
    VALUES(4,4,?,1,'operator',1000,'synthetic-client')`,
    ["4".repeat(64)],
  );
  db.run(`INSERT INTO run_inventory_items VALUES(4,4,'synthetic-security',?,?)`, [
    "a".repeat(64),
    "4".repeat(64),
  ]);
  db.run(`INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,recorded_at_ms)
    VALUES(4,'terminal','terminal','synthetic-client','success',1000)`);
  db.run(
    `INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(4,4,1000,'synthetic-client')`,
  );
  db.run(`INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status)
    VALUES(4,4,'sbi-domestic-trade-records','1.0.0','2030-01-01','ok')`);
  db.run(`INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
    VALUES(4,'sbi-domestic-trade-records',4,'1.0.0','2030-01-01','normal')`);
  db.run(`INSERT INTO transaction_observations(id,parse_run_id,source_account,external_id,status,extra_json,raw_locator)
    VALUES(401,4,'synthetic-security-account','synthetic-fingerprint','posted','{"externalIdOrigin":"collector-fingerprint"}','json:$.synthetic')`);
  const result = await queryEconomicRowReadiness(store, {
    ...request(),
    family: "securities-execution",
    rows: [{ observationId: 401, parseRunId: 4 }],
  });
  if (result.status !== "ok") throw Error("unexpected");
  expect(result.manifest.rows[0]!.reasons).toContain("identity_fingerprint_only");
  expect(result.manifest.rows[0]!.reasons).not.toContain("family_mismatch");
  expect(result.generationGates).toEqual([
    "security_book_unsupported",
    "security_selector_unsupported",
    "security_event_vocabulary_missing",
    "security_class_unknown",
    "wrapper_unknown",
  ]);
  expect(result.writerEnabled).toBe(false);
  db.close();
});

test("keyed read plan on full schema without statistics never scans transaction or holder history", () => {
  const { db } = world();
  expect(
    db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
  ).toEqual({ n: 0 });
  const plan = db
    .query(`EXPLAIN QUERY PLAN ${ECONOMIC_ROW_READINESS_SQL}`)
    .all(JSON.stringify(request().rows), "cash-movement") as { detail: string }[];
  const scans = plan.map((r) => r.detail).filter((d) => /SCAN (?:t|c|v|d|pub)\b/u.test(d));
  expect(scans).toEqual([]);
  expect(plan.map((r) => r.detail).join("\n")).not.toContain("MATERIALIZE live_consumption_claims");
  db.close();
});
