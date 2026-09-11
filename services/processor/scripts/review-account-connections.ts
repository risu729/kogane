import { getPlatformProxy } from "wrangler";
import { readConnectionDetail, verifyShinseiConnection } from "../src/account-connection-proof.ts";
const args = process.argv.slice(2);
if (
  args.length < 2 ||
  args[0] !== "--config" ||
  args.length > 3 ||
  (args[2] !== undefined && args[2] !== "--apply")
)
  throw new Error(
    "Usage: review-account-connections.ts --config <private diagnostic config> [--apply]",
  );
const apply = args[2] === "--apply";
const proxy = await getPlatformProxy<{ DB: D1Database; EVIDENCE: R2Bucket }>({
  configPath: args[1]!,
  persist: false,
  remoteBindings: true,
});
interface Artifact {
  id: number;
  source_id: string;
  dataset: string;
  fetch_run_id: number;
  fetch_unit_key: string;
  producer: string;
  sha256: string;
  byte_size: number;
  blob_key: string;
}
const projection = `SELECT a.id,a.source_id,a.dataset,a.fetch_run_id,a.fetch_unit_key,r.tool producer,a.sha256,o.byte_size,o.blob_key FROM observation_fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id JOIN fetch_artifacts fa ON fa.id=a.id JOIN raw_objects o ON o.sha256=fa.sha256 AND o.byte_size=fa.byte_size WHERE r.status='success' AND r.failure_count=0`;
async function read(artifact: Artifact): Promise<string> {
  const obj = await proxy.env.EVIDENCE.get(artifact.blob_key);
  if (!obj) throw new Error("connection_evidence_missing");
  if (
    !Number.isSafeInteger(artifact.byte_size) ||
    artifact.byte_size < 1 ||
    artifact.byte_size > 8 * 1024 * 1024 ||
    !Number.isSafeInteger(obj.size) ||
    obj.size !== artifact.byte_size ||
    obj.size > 8 * 1024 * 1024
  )
    throw new Error("connection_evidence_size");
  const bytes = await obj.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (bytes.byteLength !== artifact.byte_size || digest !== artifact.sha256)
    throw new Error("connection_evidence_integrity");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
try {
  const schemaReady = await proxy.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='account_connection_reviews'",
  ).first();
  if (apply && !schemaReady) throw new Error("connection_migration_required");
  // One latest complete MF run avoids combining different connection inventories.
  const latest = await proxy.env.DB.prepare(
    `${projection} AND a.source_id='moneyforward-me' AND a.dataset='accounts-index' ORDER BY a.id DESC LIMIT 1`,
  ).first<Artifact>();
  if (!latest) throw new Error("connection_inventory_missing");
  const details = (
    await proxy.env.DB.prepare(
      `${projection} AND a.source_id='moneyforward-me' AND a.dataset='account-detail' AND a.fetch_run_id=? ORDER BY a.id LIMIT 65`,
    )
      .bind(latest.fetch_run_id)
      .all<Artifact>()
  ).results;
  if (
    details.length < 1 ||
    details.length > 64 ||
    new Set(details.map((d) => d.fetch_unit_key)).size !== details.length ||
    details.some((d) => !/^moneyforward-account-v1-[0-9a-f]{64}$/u.test(d.fetch_unit_key))
  )
    throw new Error("connection_inventory_invalid");
  const direct = await proxy.env.DB.prepare(
    `${projection} AND a.source_id='sbi-shinsei-bank' AND a.dataset='top-accounts-balance-and-activity' ORDER BY a.id DESC LIMIT 1`,
  ).first<Artifact>();
  const branch = direct
    ? await proxy.env.DB.prepare(
        `${projection} AND a.source_id='sbi-shinsei-bank' AND a.dataset='balance-summary-and-stage' AND a.fetch_run_id=? ORDER BY a.id DESC LIMIT 1`,
      )
        .bind(direct.fetch_run_id)
        .first<Artifact>()
    : null;
  for (const artifact of details) {
    const detail = readConnectionDetail(await read(artifact));
    let status: "confirmed" | "unresolved" = "unresolved";
    let reason = detail.reason;
    let references: string[] = [];
    if (detail.relatedSource === "sbi-shinsei-bank" && direct && branch) {
      // A failed proof aborts; it never silently converts a conflict into a positive match.
      const proof = verifyShinseiConnection(
        detail,
        JSON.parse(await read(direct)),
        JSON.parse(await read(branch)),
      );
      const candidates = (
        await proxy.env.DB.prepare(
          "SELECT id FROM source_accounts WHERE source_id='sbi-shinsei-bank' AND producer_id=? AND json_extract(reference_json,'$[0]') IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 101",
        )
          .bind(direct.producer, JSON.stringify(proof.directSourceAccounts))
          .all<{ id: string }>()
      ).results;
      if (candidates.length > 100) throw new Error("connection_direct_reference_limit");
      references = candidates.map((c) => c.id).sort();
      if (!references.length) throw new Error("connection_direct_references_missing");
      status = "confirmed";
      reason =
        "保存原本の支店番号＋口座番号が直接取得の接続識別子と一致し、支店情報も一致しました。同じ接続先の確認であり、円普通預金・ハイパー預金・通貨別口座の個別対応は未確認です。";
    }
    const old = schemaReady
      ? await proxy.env.DB.prepare(
          "SELECT * FROM current_account_connection_reviews WHERE producer_id=? AND connection_key=?",
        )
          .bind(artifact.producer, artifact.fetch_unit_key)
          .first<Record<string, unknown> & { revision: number }>()
      : null;
    const directId = status === "confirmed" ? direct!.id : null;
    const branchId = status === "confirmed" ? branch!.id : null;
    const unchanged =
      old?.detail_artifact_id === artifact.id &&
      old.direct_artifact_id === directId &&
      old.branch_artifact_id === branchId &&
      old.label === detail.label &&
      old.status === status &&
      old.related_source_id === detail.relatedSource &&
      old.direct_producer_id === (status === "confirmed" ? direct!.producer : null) &&
      old.reason === reason &&
      old.verifier_version === "mf-connection-proof-v1" &&
      old.direct_reference_ids_json === JSON.stringify(references);
    if (apply && !unchanged)
      await proxy.env.DB.prepare(
        `INSERT INTO account_connection_reviews (producer_id,connection_key,revision,label,status,related_source_id,direct_producer_id,reason,verifier_version,detail_artifact_id,direct_artifact_id,branch_artifact_id,direct_reference_ids_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          artifact.producer,
          artifact.fetch_unit_key,
          (old?.revision ?? 0) + 1,
          detail.label,
          status,
          detail.relatedSource,
          status === "confirmed" ? direct!.producer : null,
          reason,
          "mf-connection-proof-v1",
          artifact.id,
          directId,
          branchId,
          JSON.stringify(references),
          new Date().toISOString(),
        )
        .run();
    console.log(
      JSON.stringify({
        label: detail.label,
        status,
        relation: status === "confirmed" ? "same-provider-connection" : "candidate",
        leafBinding: "unresolved",
        references: references.length,
        evidenceArtifactIds: [artifact.id, directId, branchId].filter((x) => x !== null),
        action: unchanged ? "unchanged" : apply ? "appended" : "dry-run",
      }),
    );
  }
} finally {
  await proxy.dispose();
}
