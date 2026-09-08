import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  listAccountConnections,
  readAccountConnections,
  connectionReferenceSet,
} from "../../evidence-browser/src/account-connections";
test("reader rejects malformed, duplicate and oversized reference sets before lookup", () => {
  expect(
    connectionReferenceSet(JSON.stringify(Array.from({ length: 100 }, (_, i) => `ref-${i}`))).size,
  ).toBe(100);
  for (const value of [
    "null",
    "{}",
    '["duplicate","duplicate"]',
    JSON.stringify(Array.from({ length: 101 }, (_, i) => `ref-${i}`)),
    "[1]",
    '[""]',
    JSON.stringify(["x".repeat(257)]),
    " ".repeat(26002),
  ])
    expect(() => connectionReferenceSet(value)).toThrow();
});
test("D1 retains decisions, rejects untrusted lineage/replacements, and revokes effective proof after exclusion", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('test')}}",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
    }),
  );
  try {
    const db = (await mf.getD1Database("DB")) as unknown as D1Database;
    await db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY);
CREATE TABLE producers(id TEXT PRIMARY KEY);
CREATE TABLE source_accounts(id TEXT PRIMARY KEY,source_id TEXT,producer_id TEXT);
CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,source_id TEXT,dataset TEXT,fetch_run_id INTEGER,fetch_unit_key TEXT);
CREATE TABLE runs(id INTEGER PRIMARY KEY,tool TEXT,status TEXT,failure_count INTEGER,excluded INTEGER);
CREATE VIEW observation_fetch_runs AS SELECT * FROM runs WHERE excluded=0;
CREATE VIEW observation_fetch_artifacts AS SELECT a.* FROM fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id;
INSERT INTO sources VALUES('moneyforward-me'),('sbi-shinsei-bank'),('vpass');
INSERT INTO producers VALUES('mf-test'),('direct-test');
INSERT INTO source_accounts VALUES('direct-reference','sbi-shinsei-bank','direct-test'),('other-reference','vpass','direct-test');
INSERT INTO runs VALUES(1,'mf-test','success',0,0),(2,'direct-test','success',0,0),(3,'direct-test','success',0,0);
INSERT INTO fetch_artifacts VALUES(1,'moneyforward-me','account-detail',1,'connection-test'),(2,'sbi-shinsei-bank','top-accounts-balance-and-activity',2,'bank'),(3,'sbi-shinsei-bank','balance-summary-and-stage',2,'bank'),(4,'sbi-shinsei-bank','balance-summary-and-stage',3,'bank');`);
    let pending = "";
    const sql = readFileSync(
      new URL("../../raw-evidence/migrations/0023_account_connections.sql", import.meta.url),
      "utf8",
    );
    for (const line of sql.split("\n")) {
      if (line.trimStart().startsWith("--")) continue;
      pending += line + "\n";
      if (/CREATE TRIGGER/iu.test(pending) ? /END;\s*$/u.test(line) : /;\s*$/u.test(line)) {
        await db.prepare(pending).run();
        pending = "";
      }
    }
    const insert = (revision: number, branch = 3, refs = '["direct-reference"]') =>
      db
        .prepare(
          `INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,related_source_id,direct_producer_id,reason,verifier_version,detail_artifact_id,direct_artifact_id,branch_artifact_id,direct_reference_ids_json,created_at) VALUES('mf-test','connection-test',?,'SBI新生銀行（MoneyForward連携）','confirmed','sbi-shinsei-bank','direct-test','same connection; leaf unresolved','test-v1',1,2,?,?,'2099')`,
        )
        .bind(revision, branch, refs)
        .run();
    await expect(insert(1, 4)).rejects.toThrow("connection_evidence_invalid");
    await expect(insert(1, 3, '["other-reference"]')).rejects.toThrow(
      "connection_evidence_invalid",
    );
    await expect(insert(1, 3, '["direct-reference","direct-reference"]')).rejects.toThrow(
      "connection_evidence_invalid",
    );
    await expect(
      insert(1, 3, JSON.stringify(Array.from({ length: 101 }, () => "direct-reference"))),
    ).rejects.toThrow();
    await insert(1);
    expect(await listAccountConnections(db)).toMatchObject([
      {
        status: "confirmed",
        relation: "same-provider-connection",
        leafBinding: "unresolved",
        evidenceArtifactIds: [1, 2, 3],
      },
    ]);
    const refs = [
      {
        referenceId: "direct-reference",
        source: "sbi-shinsei-bank",
        producer: "direct-test",
        sourceAccount: "private-leaf",
      },
      {
        referenceId: "mf-reference",
        source: "moneyforward-me",
        producer: "mf-test",
        sourceAccount: "moneyforward-me:connection-test",
      },
    ];
    expect((await readAccountConnections(db, refs)).size).toBe(2);
    expect(
      (await readAccountConnections(db, [{ ...refs[0]!, producer: "wrong-producer" }])).size,
    ).toBe(0);
    expect(
      (
        await readAccountConnections(
          db,
          Array.from({ length: 5501 }, () => refs[0]!),
        )
      ).size,
    ).toBe(1);
    await expect(insert(3)).rejects.toThrow("connection_revision_conflict");
    await expect(
      db.prepare("UPDATE account_connection_reviews SET reason='change'").run(),
    ).rejects.toThrow("append-only");
    await expect(
      db
        .prepare(
          "INSERT OR REPLACE INTO account_connection_reviews SELECT * FROM account_connection_reviews",
        )
        .run(),
    ).rejects.toThrow();
    await db.prepare("UPDATE runs SET excluded=1 WHERE id=2").run();
    expect(await listAccountConnections(db)).toMatchObject([{ status: "evidence-ineligible" }]);
    expect((await readAccountConnections(db, refs)).get("direct-reference")?.status).toBe(
      "evidence-ineligible",
    );
    expect(
      await db.prepare("SELECT count(*) n FROM account_connection_reviews").first<{ n: number }>(),
    ).toEqual({ n: 1 });
    await expect(insert(2)).rejects.toThrow("connection_evidence_invalid");
    await db.prepare("UPDATE runs SET excluded=0 WHERE id=2").run();
    await insert(2);
    expect(await listAccountConnections(db)).toMatchObject([{ revision: 2, status: "confirmed" }]);
    await db.exec(
      "INSERT INTO fetch_artifacts VALUES(5,'moneyforward-me','account-detail',1,'connection-second');",
    );
    await db
      .prepare(
        "INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,related_source_id,direct_producer_id,reason,verifier_version,detail_artifact_id,direct_artifact_id,branch_artifact_id,direct_reference_ids_json,created_at) SELECT producer_id,'connection-second',1,label,status,related_source_id,direct_producer_id,reason,verifier_version,5,direct_artifact_id,branch_artifact_id,direct_reference_ids_json,created_at FROM account_connection_reviews WHERE revision=2",
      )
      .run();
    expect((await readAccountConnections(db, refs)).get("direct-reference")).toMatchObject({
      status: "unresolved",
      relation: "candidate",
      reason: "複数の連携が同じ取得元の参照に対応しています。個別口座の対応は確定していません。",
    });
  } finally {
    await mf.dispose();
  }
});
