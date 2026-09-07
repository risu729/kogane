import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { sweep, parseJob } from "../src/worker.ts";
import { smbcDirectBalance } from "../../../poc/observation-pipeline/src/parsers/smbc-direct.ts";
import {
  providerTimestamp,
  wrapper,
} from "../../../poc/observation-pipeline/src/parsers/sbi-shinsei-common.ts";
import {
  sonyBankGrossBalance,
  sonyBankHistoryCsv,
  sonyBankWalletHistory,
} from "../../../poc/observation-pipeline/src/parsers/sony-bank.ts";

const migrationDir = new URL("../../raw-evidence/migrations/", import.meta.url);
const migration = readFileSync(new URL("0017_observation_pipeline.sql", migrationDir), "utf8");
let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/worker.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
  });
  if (!bundle.success) throw new Error("Worker test bundle failed");
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await bundle.outputs[0]!.text(),
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
      r2Buckets: ["EVIDENCE"],
    }),
  );
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("EVIDENCE");
  // Minimal Layer A fixtures; full production migrations are validated below.
  await db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY,provider TEXT);
CREATE TABLE fetch_runs(id INTEGER PRIMARY KEY,source_id TEXT,acquisition_session_id INTEGER,producer_id TEXT,first_recorded_at_ms INTEGER);
CREATE VIEW financial_fetch_runs AS SELECT * FROM fetch_runs WHERE source_id<>'kogane-synthetic';
CREATE TABLE acquisition_sessions(id INTEGER PRIMARY KEY,external_session_id TEXT);
CREATE TABLE fetch_run_seals(fetch_run_id INTEGER);
CREATE TABLE fetch_run_reports(fetch_run_id INTEGER,report_kind TEXT,normalized_outcome TEXT,started_at_ms INTEGER,completed_at_ms INTEGER);
CREATE TABLE fetch_units(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,unit_key TEXT);
CREATE TABLE fetch_unit_reports(fetch_unit_id INTEGER,report_kind TEXT,normalized_outcome TEXT,safe_failure_code TEXT);
CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,source_id TEXT,dataset TEXT,artifact_key TEXT,fetch_unit_id INTEGER,declared_media_type TEXT,fetched_at_ms INTEGER,recorded_at_ms INTEGER,sha256 TEXT,artifact_role TEXT);
CREATE TABLE raw_objects(sha256 TEXT PRIMARY KEY,byte_size INTEGER,blob_key TEXT);
CREATE TABLE fetch_run_ranges(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);
CREATE TABLE artifact_ranges(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);`);
  // D1 exec splits statements by line; use SQLite's parser to split migration
  // statements including triggers safely for individual D1 prepares.
  const statements = splitSql(migration);
  for (const sql of statements) await db.prepare(sql).run();
  // Miniflare and generated Workers types use distinct platform declarations;
  // validate the runtime proxy at this test boundary instead of double casts.
  const bindings: unknown = { DB: db, EVIDENCE: bucket };
  assertBindings(bindings);
  env = bindings;
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

test("audited provider date forms preserve timezone, validate calendar, and allow only explicit success wrapper", () => {
  expect(providerTimestamp("2026/09/07 12:34:56")).toBe("2026-09-07T12:34:56+09:00");
  expect(() => providerTimestamp("2026/02/30 12:34:56")).toThrow();
  expect(
    wrapper(
      { responseParam: {}, errorInfo: { statusID: "00000", statusMessage: "SUCCESS" } },
      "test",
    ),
  ).toEqual({});
  expect(() =>
    wrapper(
      { responseParam: {}, errorInfo: { statusID: "00001", statusMessage: "SUCCESS" } },
      "test",
    ),
  ).toThrow();
  expect(() =>
    wrapper(
      { responseParam: {}, errorInfo: { statusID: "00000", statusMessage: "failure" } },
      "test",
    ),
  ).toThrow();
  const gross = JSON.parse(
    readFileSync(
      new URL(
        "../../../poc/observation-pipeline/fixtures/sony-bank-parser-boundaries/gross-balance.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  gross.updateDttm = "2026-09-07T12:34:56.000+09:00";
  const meta = {
    id: 1,
    sourceId: "sony-bank",
    runStatus: "success" as const,
    runFailureCount: 0,
    dataset: "gross-balance",
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-07T00:00:00Z",
    sha256: "0".repeat(64),
  };
  expect(
    sonyBankGrossBalance.parse(new TextEncoder().encode(JSON.stringify(gross)), meta)
      .observations[0]?.asOf,
  ).toBe(gross.updateDttm);
  gross.updateDttm = "2026-02-30T12:34:56.000+09:00";
  expect(() =>
    sonyBankGrossBalance.parse(new TextEncoder().encode(JSON.stringify(gross)), meta),
  ).toThrow();
  const csv = readFileSync(
    new URL(
      "../../../poc/observation-pipeline/fixtures/sony-bank-parser-boundaries/yen-history.csv",
      import.meta.url,
    ),
    "utf8",
  )
    .replace(/2026\/09\/(\d{2})/g, (_, day) => `2026年9月${Number(day)}日`)
    .replace(/2026-09-(\d{2})/g, (_, day) => `2026年9月${Number(day)}日`);
  expect(
    sonyBankHistoryCsv.parse(new TextEncoder().encode(csv), {
      ...meta,
      dataset: "yen-history-csv",
      mime: "text/csv; charset=UTF-8",
      runWindow: { from: "2026-09-01", to: "2026-09-30" },
    }).observations.length,
  ).toBeGreaterThan(0);
  const wallet =
    '<select name="W131301.referenceDate"><option value="">Select</option><option value="20260901" selected>September</option></select><p>ご利用明細はありません。</p>';
  expect(
    sonyBankWalletHistory.parse(new TextEncoder().encode(wallet), {
      ...meta,
      dataset: "wallet-history-202609",
      mime: "text/html; charset=UTF-8",
    }).observations,
  ).toEqual([]);
  expect(() =>
    sonyBankWalletHistory.parse(
      new TextEncoder().encode(wallet.replace("ご利用明細はありません。", "")),
      { ...meta, dataset: "wallet-history-202609", mime: "text/html; charset=UTF-8" },
    ),
  ).toThrow();
  expect(() =>
    sonyBankWalletHistory.parse(
      new TextEncoder().encode(wallet.replace('value=""', 'value="" selected')),
      { ...meta, dataset: "wallet-history-202609", mime: "text/html; charset=UTF-8" },
    ),
  ).toThrow();
  const walletRows = readFileSync(
    new URL(
      "../../../poc/observation-pipeline/fixtures/sony-bank-parser-boundaries/wallet-history-2026-09.html",
      import.meta.url,
    ),
    "utf8",
  );
  const walletMeta = {
    ...meta,
    dataset: "wallet-history-202609",
    mime: "text/html; charset=UTF-8",
  };
  const blank = sonyBankWalletHistory.parse(
    new TextEncoder().encode(walletRows.replace("<tr><td>JPY 1200", "<tr><td>")),
    walletMeta,
  );
  expect(blank.observations).toHaveLength(1);
  expect(blank.observations[0]!.extra._kogane).toMatchObject({ usageAmount: null });
  const foreign = sonyBankWalletHistory.parse(
    new TextEncoder().encode(walletRows.replace("<tr><td>JPY 1200", "<tr><td>IDR 1200")),
    walletMeta,
  );
  expect(foreign.observations[0]!.extra._kogane).toMatchObject({
    usageAmount: { currency: "IDR", text: "1200", minor: null },
  });
  expect(() =>
    sonyBankWalletHistory.parse(
      new TextEncoder().encode(walletRows.replace("<tr><td>JPY 1200", "<tr><td>not-money")),
      walletMeta,
    ),
  ).toThrow();
  const bareFee = sonyBankWalletHistory.parse(
    new TextEncoder().encode(
      walletRows.replace("<td>-</td><td>2026/09/02", "<td>1.25</td><td>2026/09/02"),
    ),
    walletMeta,
  );
  expect(bareFee.observations[0]!.extra.primary).toMatchObject({ 海外取引経費: "1.25" });
  expect(() =>
    sonyBankWalletHistory.parse(
      new TextEncoder().encode(walletRows.replace("<td>JPY 1200</td>", "<td>IDR 1200</td>")),
      walletMeta,
    ),
  ).toThrow();
  expect(() =>
    sonyBankWalletHistory.parse(
      new TextEncoder().encode(walletRows.replace("<tr><td>JPY 1200", "<tr><td>IDR 1,2")),
      walletMeta,
    ),
  ).toThrow();
  expect(() =>
    sonyBankWalletHistory.parse(
      new TextEncoder().encode(
        walletRows.replace("<td>-</td><td>2026/09/02", "<td>1,2</td><td>2026/09/02"),
      ),
      walletMeta,
    ),
  ).toThrow();
  expect(
    sonyBankWalletHistory.parse(
      new TextEncoder().encode(walletRows.replace("<tr><td>JPY 1200", "<tr><td>IDR 1,200")),
      walletMeta,
    ).observations[0]!.extra._kogane,
  ).toMatchObject({ usageAmount: { currency: "IDR", text: "1200", minor: null } });
});

test("actual workerd bundle parses SBI fixtures and executes the entire D1/R2 path", async () => {
  for (const [id, dataset] of [
    [50, "domestic-cash-positions"],
    [51, "yen-detail-history"],
  ] as const) {
    let payload = JSON.parse(
      readFileSync(
        new URL(
          `../../../poc/observation-pipeline/fixtures/sbi-parser-boundaries/${dataset}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    if (dataset === "domestic-cash-positions") {
      const binary = Buffer.from(payload.payloadBase64, "base64");
      binary.copy(binary, 24, 27, 30);
      payload.payloadBase64 = binary.toString("base64");
    } else {
      payload = payload.pages[0];
      delete payload.exceededMaxCount;
    }
    await artifact(id, "sbi-securities", dataset, `${dataset}.json`, payload);
  }
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  const response = await mf.dispatchFetch("https://pipeline.internal/sweep", { method: "POST" });
  expect(response.status).toBe(200);
  const rows = await env.DB.prepare(
    "SELECT fetch_artifact_id,status,error FROM parse_runs WHERE fetch_artifact_id IN (50,51)",
  ).all();
  expect(rows.results).toEqual([
    { fetch_artifact_id: 50, status: "ok", error: null },
    { fetch_artifact_id: 51, status: "ok", error: null },
  ]);
}, 30000);

test("actual workerd hydrates verified WALLET MIME and preserves blank optional usage amount", async () => {
  const html = readFileSync(
    new URL(
      "../../../poc/observation-pipeline/fixtures/sony-bank-parser-boundaries/wallet-history-2026-09.html",
      import.meta.url,
    ),
    "utf8",
  ).replace("<tr><td>JPY 1200", "<tr><td>");
  const bytes = new TextEncoder().encode(html);
  const sha = await artifact(
    60,
    "sony-bank",
    "wallet-history-202609",
    "wallet-history-202609.html",
    bytes,
  );
  await env.DB.prepare(
    "UPDATE fetch_artifacts SET declared_media_type='text/html' WHERE id=60",
  ).run();
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      artifacts: [
        {
          dataset: "wallet-history-202609",
          sha256: sha,
          bytes: bytes.length,
          mediaType: "text/html; charset=UTF-8",
        },
      ],
    }),
  );
  const manifestSha = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", manifest)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await env.EVIDENCE.put(manifestSha, manifest);
  await env.DB.prepare("INSERT INTO raw_objects VALUES(?,?,?)")
    .bind(manifestSha, manifest.length, manifestSha)
    .run();
  await env.DB.prepare(
    "INSERT INTO fetch_artifacts VALUES(61,60,'sony-bank','collector-manifest','manifest.json',NULL,'application/json',0,0,?,'collector_manifest')",
  )
    .bind(manifestSha)
    .run();
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  expect(
    (await mf.dispatchFetch("https://pipeline.internal/sweep", { method: "POST" })).status,
  ).toBe(200);
  const row = await env.DB.prepare(
    "SELECT p.status,t.extra_json FROM parse_runs p JOIN transaction_observations t ON t.parse_run_id=p.id WHERE p.fetch_artifact_id=60 AND p.status='ok'",
  ).first<{ status: string; extra_json: string }>();
  expect(row?.status).toBe("ok");
  expect(JSON.parse(row!.extra_json)._kogane.usageAmount).toBeNull();
}, 30000);

function assertBindings(value: unknown): asserts value is Env {
  if (!value || typeof value !== "object" || !("DB" in value) || !("EVIDENCE" in value))
    throw new Error("bindings missing");
  for (const [binding, method] of [
    [value.DB, "prepare"],
    [value.EVIDENCE, "get"],
  ] as const) {
    if (!binding || typeof binding !== "object" || !(method in binding))
      throw new Error("invalid runtime binding");
  }
}

function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let pending = "";
  for (const line of sql.split("\n")) {
    if (line.trimStart().startsWith("--")) continue;
    pending += line + "\n";
    const trigger = /CREATE TRIGGER/i.test(pending);
    if ((!trigger && /;\s*$/.test(line)) || (trigger && /END;\s*$/.test(line))) {
      statements.push(pending);
      pending = "";
    }
  }
  return statements.filter((s) => s.trim());
}

test("all production migrations compile and Layer B observes sealed financial runs only", () => {
  const db = new Database(":memory:");
  for (const file of readdirSync(migrationDir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(file, migrationDir), "utf8"));
  expect(db.query("SELECT count(*) AS n FROM observation_fetch_artifacts").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM parse_runs").get()).toEqual({ n: 0 });
  db.close();
});

async function artifact(
  id: number,
  source: string,
  dataset: string,
  key: string,
  payload: unknown,
  seal = true,
) {
  const bytes =
    payload instanceof Uint8Array
      ? new Uint8Array(payload)
      : new TextEncoder().encode(JSON.stringify(payload));
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  await env.EVIDENCE.put(sha, bytes);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO sources VALUES(?,?)").bind(source, source),
    env.DB.prepare("INSERT INTO acquisition_sessions VALUES(?,?)").bind(id, `run-${id}`),
    env.DB.prepare("INSERT INTO fetch_runs VALUES(?,?,?, ?,?)").bind(
      id,
      source,
      id,
      "collector-r2-importer",
      Date.now(),
    ),
    env.DB.prepare("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',?,?)").bind(
      id,
      Date.now(),
      Date.now(),
    ),
    env.DB.prepare("INSERT OR IGNORE INTO raw_objects VALUES(?,?,?)").bind(sha, bytes.length, sha),
    env.DB.prepare(
      "INSERT INTO fetch_artifacts VALUES(?,?,?,?,?,NULL,'application/json',?,?,?,'collector_derived')",
    ).bind(id, id, source, dataset, key, Date.now(), Date.now(), sha),
  ]);
  if (seal) await env.DB.prepare("INSERT INTO fetch_run_seals VALUES(?)").bind(id).run();
  return sha;
}

test("sealed parsing is idempotent; missing blobs retry and unsealed artifacts do not publish", async () => {
  // Deliberately invalid bank JSON produces a safe failure.
  await artifact(1, "smbc-bank", "balance-normalized", "balance.normalized.json", {});
  await artifact(2, "smbc-bank", "balance-normalized", "balance.normalized.json", {}, false);
  const sha = await artifact(3, "smbc-bank", "balance-normalized", "balance.normalized.json", {
    a: 1,
  });
  await env.EVIDENCE.delete(sha);
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  const result = await sweep(env);
  expect(result.error).toBe(2);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id=2",
    ).first<number>("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT error FROM parse_runs WHERE fetch_artifact_id=3").first<string>(
      "error",
    ),
  ).toBe("raw_object_missing");
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id<=3",
    ).first<number>("n"),
  ).toBe(2);
  await sweep(env);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id<=3",
    ).first<number>("n"),
  ).toBe(2);
}, 30000);

test("successful concurrent sweeps publish once, preserve provenance, supersede old version and quarantine interrupted attempt", async () => {
  await artifact(10, "smbc-bank", "balance-normalized", "balance.normalized.json", {
    amount: 12345,
    currency: "JPY",
    observedAt: "2026-09-07T00:00:00.000Z",
  });
  await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(10,'smbc-direct-balance','0.9.0','2026-01-01T00:00:00.000Z','ok','[]')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(10,'smbc-direct-balance','1.0.0','2026-01-01T00:00:00.000Z','pending','[]')",
  ).run();
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await Promise.all([sweep(env), sweep(env)]);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id=10 AND status='ok' AND superseded_by_parse_run_id IS NULL",
    ).first<number>("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT error FROM parse_runs WHERE fetch_artifact_id=10 AND status='error'",
    ).first<string>("error"),
  ).toBe("parse_interrupted");
  const result = await env.DB.prepare(
    "SELECT b.amount_minor,b.extra_json,p.fetch_artifact_id FROM balance_observations b JOIN parse_runs p ON p.id=b.parse_run_id WHERE p.fetch_artifact_id=10",
  ).first<{ amount_minor: number; extra_json: string; fetch_artifact_id: number }>();
  expect(result?.amount_minor).toBe(12345);
  expect(JSON.parse(result!.extra_json).currency).toBe("JPY");
  expect(result?.fetch_artifact_id).toBe(10);
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await sweep(env);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM balance_observations").first<number>("n"),
  ).toBe(1);
}, 30000);

test("empty transaction success is retained and failures/unit failures are excluded", async () => {
  await artifact(
    20,
    "smbc-bank",
    "transactions-normalized",
    "transactions/20260901-20260907.normalized.json",
    {
      range: { start: "2026-09-01", end: "2026-09-07" },
      transactions: [],
      depositsTotal: 0,
      withdrawalsTotal: 0,
    },
  );
  await artifact(21, "smbc-bank", "balance-normalized", "balance.normalized.json", {
    amount: 10,
    currency: "JPY",
    observedAt: "2026-09-07T00:00:00.000Z",
  });
  await artifact(22, "smbc-bank", "balance-normalized", "balance.normalized.json", {
    amount: 10,
    currency: "JPY",
    observedAt: "2026-09-07T00:00:00.000Z",
  });
  await env.DB.prepare(
    "UPDATE fetch_run_reports SET normalized_outcome='partial' WHERE fetch_run_id=21",
  ).run();
  await env.DB.prepare("INSERT INTO fetch_units VALUES(22,22,'account')").run();
  await env.DB.prepare(
    "INSERT INTO fetch_unit_reports VALUES(22,'terminal','failed','failed')",
  ).run();
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await sweep(env);
  expect(
    await env.DB.prepare("SELECT status FROM parse_runs WHERE fetch_artifact_id=20").first<string>(
      "status",
    ),
  ).toBe("ok");
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM transaction_observations o JOIN parse_runs p ON p.id=o.parse_run_id WHERE p.fetch_artifact_id=20",
    ).first<number>("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id IN (21,22)",
    ).first<number>("n"),
  ).toBe(0);
}, 30000);

test("checksum mismatch produces stable safe failure and delayed retry can recover", async () => {
  const sha = await artifact(30, "smbc-bank", "balance-normalized", "balance.normalized.json", {
    amount: 100,
    currency: "JPY",
    observedAt: "2026-09-07T00:00:00.000Z",
  });
  const original = await (await env.EVIDENCE.get(sha))!.arrayBuffer();
  await env.EVIDENCE.put(sha, new Uint8Array(original.byteLength));
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await sweep(env);
  expect(
    await env.DB.prepare("SELECT error FROM parse_runs WHERE fetch_artifact_id=30").first<string>(
      "error",
    ),
  ).toBe("raw_checksum_mismatch");
  await env.EVIDENCE.put(sha, original);
  await env.DB.prepare(
    "UPDATE observation_parse_jobs SET available_at_ms=0 WHERE fetch_artifact_id=30",
  ).run();
  await sweep(env);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id=30 AND status='ok'",
    ).first<number>("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id=30 AND status='error'",
    ).first<number>("n"),
  ).toBe(1);
}, 30000);

test("MyJCB state and period come from sanitized central manifest", async () => {
  const payload = JSON.parse(
    readFileSync(
      new URL(
        "../../../poc/observation-pipeline/fixtures/myjcb/2026-09-07/run-synthetic/connection-a/credit-ledger-00.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await artifact(40, "myjcb", "credit-ledger", "connection-a/credit-ledger-00.json", payload);
  await env.DB.prepare("INSERT INTO fetch_units VALUES(40,40,'connection-a')").run();
  await env.DB.prepare("UPDATE fetch_artifacts SET fetch_unit_id=40 WHERE id=40").run();
  const manifest = {
    artifacts: [
      {
        connectionId: "connection-a",
        filename: "credit-ledger-00.json",
        dataset: "credit-ledger",
        statementState: payload.state,
        period: payload.period,
      },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  await env.EVIDENCE.put(sha, bytes);
  await env.DB.prepare("INSERT INTO raw_objects VALUES(?,?,?)").bind(sha, bytes.length, sha).run();
  await env.DB.prepare(
    "INSERT INTO fetch_artifacts VALUES(41,40,'myjcb',NULL,'manifest.json',NULL,'application/json',0,0,?,'collector_manifest')",
  )
    .bind(sha)
    .run();
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await sweep(env);
  expect(
    await env.DB.prepare("SELECT status FROM parse_runs WHERE fetch_artifact_id=40").first<string>(
      "status",
    ),
  ).toBe("ok");
  expect(
    await env.DB.prepare(
      "SELECT statement_state FROM observation_fetch_artifacts WHERE id=40",
    ).first<string>("statement_state"),
  ).toBe(payload.state);
  expect(
    await env.DB.prepare(
      "SELECT metadata_manifest_artifact_id FROM observation_artifact_metadata WHERE fetch_artifact_id=40",
    ).first<number>("metadata_manifest_artifact_id"),
  ).toBe(41);
}, 30000);

test("workerd decodes MoneyForward static descriptions from canonical text/html descriptors", async () => {
  const fixture = readFileSync(
    new URL(
      "../../../poc/observation-pipeline/fixtures/moneyforward/account-01-month-2099-02.html",
      import.meta.url,
    ),
  );
  const rawDescription = String.raw`' + 'ANONYMOUS\x20' + 'PURCHASE' + '' + '`;
  const bytes = new TextEncoder().encode(
    fixture.toString("utf8").replace("ANONYMOUS PURCHASE", rawDescription),
  );
  await artifact(
    90,
    "moneyforward-me",
    "monthly-transactions",
    "account-01-month-2099-02.html",
    bytes,
  );
  await env.DB.prepare("INSERT INTO fetch_units VALUES(90,90,?)")
    .bind(`moneyforward-account-v1-${"a".repeat(64)}`)
    .run();
  await env.DB.prepare(
    "UPDATE fetch_artifacts SET fetch_unit_id=90,declared_media_type='text/html' WHERE id=90",
  ).run();
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  const response = await mf.dispatchFetch("https://pipeline.internal/sweep?maxJobs=100", {
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT status FROM observation_parse_jobs WHERE fetch_artifact_id=90 AND parser_name='moneyforward-monthly-transactions' AND parser_version='2.0.2'",
    ).first<string>("status"),
  ).toBe("done");
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM transaction_observations o JOIN parse_runs p ON p.id=o.parse_run_id WHERE p.fetch_artifact_id=90 AND p.status='ok'",
    ).first<number>("n"),
  ).toBe(2);
  const row =
    await env.DB.prepare(`SELECT description, json_extract(extra_json,'$.cells[0]') AS raw_description
    FROM transaction_observations o JOIN parse_runs p ON p.id=o.parse_run_id
    WHERE p.fetch_artifact_id=90 AND o.amount_minor=-1234`).first<{
      description: string;
      raw_description: string;
    }>();
  expect(row).toEqual({ description: "ANONYMOUS PURCHASE", raw_description: rawDescription });
}, 30000);

test("late old parser publication cannot replace a numerically newer successful version", async () => {
  for (const [id, existingVersion, incomingVersion] of [
    [80, "1.10.0", "1.2.0"],
    [81, "1.2.0", "1.10.0"],
  ] as const) {
    await artifact(id, "smbc-bank", "balance-normalized", "balance.normalized.json", {
      amount: 1,
      currency: "JPY",
      observedAt: "2026-09-07T00:00:00.000Z",
    });
    const old = await env.DB.prepare(
      "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,'smbc-direct-balance',?,'2026-01-01T00:00:00.000Z','ok','[]') RETURNING id",
    )
      .bind(id, existingVersion)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,'smbc-direct-balance',?,'pending')",
    )
      .bind(id, incomingVersion)
      .run();
    expect(
      await parseJob(
        env,
        {
          fetch_artifact_id: id,
          parser_name: "smbc-direct-balance",
          parser_version: incomingVersion,
          attempts: 0,
        },
        { ...smbcDirectBalance, version: incomingVersion },
      ),
    ).toBe("parsed");
    const current = await env.DB.prepare(
      "SELECT id,parser_version FROM parse_runs WHERE fetch_artifact_id=? AND status='ok' AND superseded_by_parse_run_id IS NULL",
    )
      .bind(id)
      .all<{ id: number; parser_version: string }>();
    expect(current.results).toHaveLength(1);
    expect(current.results[0]?.parser_version).toBe("1.10.0");
    const superseded = await env.DB.prepare(
      "SELECT parser_version,superseded_by_parse_run_id FROM parse_runs WHERE fetch_artifact_id=? AND superseded_by_parse_run_id IS NOT NULL",
    )
      .bind(id)
      .first<{ parser_version: string; superseded_by_parse_run_id: number }>();
    expect(superseded?.parser_version).toBe("1.2.0");
    expect(superseded?.superseded_by_parse_run_id).toBe(current.results[0]!.id);
    if (id === 80) expect(current.results[0]!.id).toBe(old!.id);
  }
}, 30000);

test("workerd schedules deployed versions without retiring a future or unfinished replacement", async () => {
  await artifact(191, "smbc-bank", "balance-normalized", "balance.normalized.json", {
    amount: 1,
    currency: "JPY",
    observedAt: "2026-09-07T00:00:00.000Z",
  });
  for (const [version, available] of [
    ["0.0.0", -3000],
    ["99.0.0", -2000],
    [smbcDirectBalance.version, -1000],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,available_at_ms) VALUES(191,?,?, 'pending',?)",
    )
      .bind(smbcDirectBalance.name, version, available)
      .run();
  }
  const response = await mf.dispatchFetch("https://pipeline.internal/sweep?maxJobs=1", {
    method: "POST",
  });
  expect(response.status).toBe(200);
  const states = (
    await env.DB.prepare(
      "SELECT parser_version,status,last_error_code FROM observation_parse_jobs WHERE fetch_artifact_id=191 ORDER BY parser_version",
    ).all()
  ).results;
  expect(states).toContainEqual({
    parser_version: "0.0.0",
    status: "failed",
    last_error_code: "parser_version_retired",
  });
  expect(states).toContainEqual({
    parser_version: "99.0.0",
    status: "pending",
    last_error_code: null,
  });
  expect(states).toContainEqual({
    parser_version: smbcDirectBalance.version,
    status: "done",
    last_error_code: null,
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id=191",
    ).first<number>("n"),
  ).toBe(1);
}, 30000);
