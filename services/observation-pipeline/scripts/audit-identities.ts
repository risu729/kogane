// Read-only live audit. Raw references and payloads remain in memory; output is
// aggregate counts and fixed classifier reason codes, never financial values.
import { getPlatformProxy } from "wrangler";
import { otherIdentity } from "../../../poc/observation-pipeline/src/identity/other.ts";
import { sbiIdentity } from "../../../poc/observation-pipeline/src/identity/sbi.ts";
import type { IdentityInput } from "../../../poc/observation-pipeline/src/identity/types.ts";

const proxy = await getPlatformProxy<{ DB: D1Database; EVIDENCE: R2Bucket }>({
  configPath: new URL("../wrangler.diagnostic.jsonc", import.meta.url).pathname,
  persist: false,
  remoteBindings: true,
});
const kinds = ["transaction", "balance", "position", "valuation"] as const;
const columns = {
  transaction:
    "o.currency,NULL instrument,NULL security_code,NULL security_name,NULL market,NULL subject",
  balance:
    "NULL currency,o.instrument,NULL security_code,NULL security_name,NULL market,NULL subject",
  position: "o.currency,NULL instrument,o.security_code,o.security_name,o.market,NULL subject",
  valuation:
    "o.currency,NULL instrument,NULL security_code,NULL security_name,NULL market,o.subject",
};
type Counts = Record<string, number>;
interface Summary {
  observations: number;
  forms: Counts;
  accountStatus: Counts;
  accountRoles: Counts;
  issues: Counts;
  instrumentStatus: Counts;
  instrumentKinds: Counts;
  unknownUnitCodes: Counts;
  noInstrument: number;
  duplicateRoles: number;
  resolverErrors: number;
  sourceAccounts: Set<string>;
  canonicalKeys: Set<string>;
}
function increment(counts: Counts, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}
interface Row {
  id: number;
  parse_run_id: number;
  artifact_id: number;
  fetch_run_id: number;
  source_id: string;
  producer_id: string;
  dataset: string;
  source_account: string;
  currency: string | null;
  instrument: string | null;
  security_code: string | null;
  security_name: string | null;
  market: string | null;
  subject: string | null;
  extra_json: string;
}
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
      await proxy.env.DB.prepare(`SELECT o.extra_json,a.fetch_run_id FROM balance_observations o JOIN parse_runs p ON p.id=o.parse_run_id
      JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
      WHERE a.source_id='v-point' AND a.dataset='balance-info' AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL AND f.status='success' AND f.failure_count=0 LIMIT 1001`).all<{
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
    const maxParse = await proxy.env.DB.prepare(
      "SELECT coalesce(max(id),0) n FROM parse_runs",
    ).first<number>("n");
    const summaries = new Map<string, Summary>();
    const inventory = await proxy.env.DB.prepare(`SELECT a.source_id,count(*) successful_parses
    FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
    WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL AND f.status='success' AND f.failure_count=0 AND p.id<=?
    GROUP BY a.source_id`)
      .bind(maxParse)
      .all<{ source_id: string; successful_parses: number }>();
    for (const { source_id } of inventory.results)
      summaries.set(source_id, {
        observations: 0,
        forms: {},
        accountStatus: {},
        accountRoles: {},
        issues: {},
        instrumentStatus: {},
        instrumentKinds: {},
        unknownUnitCodes: {},
        noInstrument: 0,
        duplicateRoles: 0,
        resolverErrors: 0,
        sourceAccounts: new Set(),
        canonicalKeys: new Set(),
      });
    for (const kind of kinds) {
      let after = 0;
      for (let page = 0; page < 4000; page++) {
        const rows =
          await proxy.env.DB.prepare(`SELECT o.id,o.parse_run_id,a.id artifact_id,a.fetch_run_id,a.source_id,r.producer_id,a.dataset,o.source_account,${columns[kind]},o.extra_json
        FROM ${kind}_observations o JOIN parse_runs p ON p.id=o.parse_run_id
        JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
        JOIN observation_fetch_runs f ON f.id=a.fetch_run_id JOIN financial_fetch_runs r ON r.id=a.fetch_run_id
        WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL AND f.status='success' AND f.failure_count=0 AND p.id<=? AND o.id>?
        ORDER BY o.id LIMIT 250`)
            .bind(maxParse, after)
            .all<Row>();
        if (!rows.results.length) break;
        for (const row of rows.results) {
          after = row.id;
          const summary = summaries.get(row.source_id)!;
          summary.observations++;
          increment(summary.forms, `${kind}:${row.dataset}`);
          summary.sourceAccounts.add(JSON.stringify([row.producer_id, row.source_account]));
          try {
            const value: unknown = JSON.parse(row.extra_json);
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error("invalid-extra");
            const input: IdentityInput = {
              kind,
              observationId: row.id,
              parseRunId: row.parse_run_id,
              artifactId: row.artifact_id,
              fetchRunId: row.fetch_run_id,
              sourceId: row.source_id,
              producerId: row.producer_id,
              sourceAccount: row.source_account,
              currency: row.currency,
              instrument: row.instrument,
              securityCode: row.security_code,
              securityName: row.security_name,
              market: row.market,
              subject: row.subject,
              extra: value as Record<string, unknown>,
            };
            const plan =
              row.source_id === "sbi-securities" ? sbiIdentity(input) : otherIdentity(input);
            summary.canonicalKeys.add(JSON.stringify([row.producer_id, plan.account.key]));
            increment(summary.accountStatus, plan.account.status);
            increment(summary.accountRoles, plan.account.role);
            for (const issue of plan.issues) increment(summary.issues, issue);
            if (!plan.instruments.length) summary.noInstrument++;
            if (new Set(plan.instruments.map((i) => i.role)).size !== plan.instruments.length)
              summary.duplicateRoles++;
            for (const instrument of plan.instruments) {
              increment(summary.instrumentStatus, instrument.status);
              increment(summary.instrumentKinds, instrument.kind);
              if (instrument.status === "unresolved" && instrument.role !== "security")
                increment(
                  summary.unknownUnitCodes,
                  /^[A-Z_]{2,12}$/u.test(instrument.value)
                    ? instrument.value
                    : "unprintable-unit-code",
                );
            }
          } catch {
            summary.resolverErrors++;
          }
        }
        if (page === 3999) throw new Error("audit-page-bound-exceeded");
      }
      console.log(
        JSON.stringify({
          progress: kind,
          observations: Array.from(summaries.values()).reduce((n, s) => n + s.observations, 0),
        }),
      );
    }
    console.log(
      JSON.stringify({
        scope: "successful-nonsuperseded-parses-of-sealed-successful-financial-fetches",
        inventory: inventory.results,
      }),
    );
    for (const [source, summary] of summaries)
      console.log(
        JSON.stringify({
          source,
          ...summary,
          sourceAccounts: summary.sourceAccounts.size,
          canonicalKeys: summary.canonicalKeys.size,
        }),
      );
  }
} catch {
  console.error("identity-audit-failed-safe");
  process.exitCode = 1;
} finally {
  await proxy.dispose();
}
