// Read-only live audit. Raw references and payloads remain in memory; output is
// aggregate counts and fixed classifier reason codes, never financial values.
// The default mode classifies every published observation the way the identity
// projection does (src/identity-classifier-audit.ts); `--binding-evidence`
// counts the Vpass card-list and V Point bucket evidence instead.
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { auditIdentityClassification } from "../src/identity-classifier-audit.ts";

const proxy = await getPlatformProxy<{ DB: D1Database; EVIDENCE: R2Bucket }>({
  configPath: fileURLToPath(new URL("../wrangler.diagnostic.jsonc", import.meta.url)),
  persist: false,
  remoteBindings: true,
});
try {
  if (process.argv.includes("--binding-evidence")) {
    const cards =
      await proxy.env.DB.prepare(`SELECT a.id,o.blob_key,o.sha256,o.byte_size FROM observation_fetch_artifacts a
      JOIN observation_fetch_runs f ON f.id=a.fetch_run_id JOIN raw_objects o ON o.sha256=a.sha256
      WHERE a.source_id='vpass' AND a.dataset='card-list' AND f.status='success' AND f.failure_count=0 ORDER BY a.id LIMIT 1001`).all<{
        id: number;
        blob_key: string;
        sha256: string;
        byte_size: number;
      }>();
    if (cards.results.length > 1000) throw new Error("card-audit-bound-exceeded");
    let cardEntries = 0,
      redactedReferences = 0,
      ordinalNames = 0;
    for (const row of cards.results) {
      if (row.byte_size > 4 * 1024 * 1024) throw new Error("card-audit-object-bound");
      const object = await proxy.env.EVIDENCE.get(row.blob_key);
      if (!object) throw new Error("missing-card-object");
      const bytes = await object.arrayBuffer();
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (sha !== row.sha256 || bytes.byteLength !== row.byte_size)
        throw new Error("card-audit-integrity");
      const body = JSON.parse(new TextDecoder().decode(bytes));
      const list = body?.body?.content?.DropdownListInitDisplayServiceBean?.multiCardInfoList;
      if (!Array.isArray(list)) throw new Error("card-audit-shape");
      for (const entry of list) {
        cardEntries++;
        if (entry.value === "<redacted-card-reference>") redactedReferences++;
        if (/^card-\d{3}$/u.test(entry.name)) ordinalNames++;
      }
    }
    console.log(
      JSON.stringify({
        source: "vpass",
        cardListArtifacts: cards.results.length,
        cardEntries,
        redactedReferences,
        ordinalNames,
      }),
    );
    const points =
      await proxy.env.DB.prepare(`SELECT o.extra_json,a.fetch_run_id FROM balance_observations o JOIN published_parse_runs p ON p.parse_run_id=o.parse_run_id
      JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
      WHERE a.source_id='v-point' AND a.dataset='balance-info' AND f.status='success' AND f.failure_count=0 LIMIT 1001`).all<{
        extra_json: string;
        fetch_run_id: number;
      }>();
    if (points.results.length > 1000) throw new Error("point-audit-bound");
    const signatures = new Map<string, Set<number>>();
    let missing = 0;
    const perRun = new Set<string>();
    let duplicates = 0;
    for (const row of points.results) {
      const extra = JSON.parse(row.extra_json);
      const pointType = extra.point_type;
      if (!Number.isInteger(pointType) || typeof extra.expiration !== "string") {
        missing++;
        continue;
      }
      const signature = JSON.stringify(["common", pointType, extra.expiration]);
      const runs = signatures.get(signature) ?? new Set<number>();
      runs.add(row.fetch_run_id);
      signatures.set(signature, runs);
      const within = JSON.stringify([row.fetch_run_id, signature]);
      if (perRun.has(within)) duplicates++;
      perRun.add(within);
    }
    console.log(
      JSON.stringify({
        source: "v-point",
        bucketRows: points.results.length,
        explicitTypeExpiryMissing: missing,
        semanticTypeExpiryTuples: signatures.size,
        tuplesObservedAcrossRuns: Array.from(signatures.values()).filter((s) => s.size > 1).length,
        duplicateTupleWithinRun: duplicates,
      }),
    );
  } else {
    const audit = await auditIdentityClassification(proxy.env.DB, (kind, observations) =>
      console.log(JSON.stringify({ progress: kind, observations })),
    );
    console.log(
      JSON.stringify({ scope: audit.scope, policy: audit.policy, inventory: audit.inventory }),
    );
    for (const summary of audit.sources) console.log(JSON.stringify(summary));
  }
} catch {
  console.error("identity-audit-failed-safe");
  process.exitCode = 1;
} finally {
  await proxy.dispose();
}
