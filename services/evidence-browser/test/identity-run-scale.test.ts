// Synthetic full-schema cardinalities. No remote bindings or disabled guards.
import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import ingest from "../../raw-evidence/src/worker";
import { seedRegistry, seedRun } from "./fixtures";
import { identityQuery } from "../src/identity-api";
import { organizedFilterOptions } from "../src/organized-filter-options";
import {
  preferredInstrumentNames,
  PREFERRED_INSTRUMENT_NAMES_SQL,
} from "../src/preferred-instrument-names";

const credential = "synthetic-scale-credential-not-a-real-secret";
const token = (card: number) => `vpass-card-v1-${String(card + 1).repeat(64)}`;
const bytes = new TextEncoder().encode('{"synthetic":true}');
const keys = { "collector-r2-vpass": credential };
async function post(path: string, body: unknown) {
  const response = await ingest.fetch(
    new Request(`https://fixture.test${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer collector-r2-vpass.${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { ...env, INGEST_CLIENT_KEYS: JSON.stringify(keys) },
  );
  if (response.status !== 201)
    throw new Error(`synthetic scale ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<Record<string, any>>;
}
async function rawCard(index: number, binding: boolean, sha256: string) {
  const ordinal = `card-${String((index % 6) + 1).padStart(3, "0")}`;
  const { runId } = await post("/v1/runs", {
    producerId: "collector-r2-importer",
    sourceId: "vpass",
    externalIdNamespace: "vpass-worker-card-v1",
    externalSessionId: `scale-session-${Math.floor(index / 6)}`,
    sourceRunKey: ordinal + (binding ? "-vpass-card-binding-v1" : "-vpass-r2-v2"),
  });
  const { unitId } = await post(`/v1/runs/${runId}/units`, {
    unitKind: "card",
    unitKey: binding ? token(index % 6) : ordinal,
    terminalReportRequired: true,
  });
  const uploaded = await ingest.fetch(
    new Request(`https://fixture.test/v1/runs/${runId}/objects/${sha256}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer collector-r2-vpass.${credential}`,
        "content-length": String(bytes.length),
        "x-kogane-byte-size": String(bytes.length),
      },
      body: bytes,
    }),
    { ...env, INGEST_CLIENT_KEYS: JSON.stringify(keys) },
  );
  expect([200, 201]).toContain(uploaded.status);
  const artifactKey = binding ? "card-identity-binding.json" : "statement.json";
  const descriptor = await post(`/v1/runs/${runId}/artifacts`, {
    artifactKey,
    artifactRole: binding ? "collector_derived" : "collector_summary",
    payloadFidelity: binding ? "transformed" : "generated",
    containerKind: "single",
    lineageDisposition: binding ? "source_not_retained_for_security" : "not_applicable",
    fetchUnitId: unitId,
    sha256,
    byteSize: bytes.length,
    dataset: binding ? "card-identity-binding" : "statement-page",
    formatId: binding ? "vpass-card-identity-binding-json" : "synthetic",
    formatVersion: "1",
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    transformSteps: binding
      ? [
          {
            stepIndex: 0,
            stepKind: "extracted",
            transformerId: "synthetic",
            transformerVersion: "1",
          },
          {
            stepIndex: 1,
            stepKind: "redacted",
            transformerId: "synthetic",
            transformerVersion: "1",
          },
        ]
      : [],
  });
  await post(`/v1/units/${unitId}/reports`, {
    reportKey: "terminal",
    reportKind: "terminal",
    normalizedOutcome: "success",
    declaredArtifactCount: 1,
    artifactCountScope: "direct",
  });
  await post(`/v1/runs/${runId}/reports`, {
    reportKey: "terminal",
    reportKind: "terminal",
    normalizedOutcome: "success",
    declaredArtifactCount: 1,
    artifactCountScope: "all_catalogued",
  });
  await post(`/v1/runs/${runId}/seal`, {
    artifacts: [{ artifactKey, sha256, descriptorSha256: descriptor.descriptorSha256 }],
    declarationBasis: "operator",
    externalAttemptId: crypto.randomUUID(),
    startedAtMs: 0,
  });
  const artifact = await env.DB.prepare(
    "SELECT id FROM fetch_artifacts WHERE fetch_run_id=? AND artifact_key=?",
  )
    .bind(runId, artifactKey)
    .first<{ id: number }>();
  return {
    runId: Number(runId),
    unitId: Number(unitId),
    artifactId: artifact!.id,
  };
}

export async function seedIdentityRunScale() {
  await seedRegistry();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  const cards: Array<{
    financial: number;
    unit: number;
    binding: number;
    token: string;
  }> = [];
  for (let i = 0; i < 96; i++) {
    const f = await rawCard(i, false, sha256),
      b = await rawCard(i, true, sha256);
    cards.push({
      financial: f.artifactId,
      unit: f.unitId,
      binding: b.artifactId,
      token: token(i % 6),
    });
  }
  const other: Array<{ source: string; artifact: number }> = [];
  for (let i = 0; i < 11; i++) {
    const source = `scale-other-${i}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sources(id,provider,display_name) VALUES (?,'Synthetic','Synthetic')",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO producer_sources(producer_id,source_id) VALUES ('evidence-test',?)",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
      ).bind(source),
    ]);
    const run = await seedRun({ source, count: 1 });
    other.push({ source, artifact: run.artifacts[0]!.id });
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO instruments VALUES ('scale-money','money','Synthetic','identified')",
    ),
    env.DB.prepare(
      "INSERT INTO instrument_identifiers VALUES ('scale-money','synthetic','fixture','SYN','{}')",
    ),
    env.DB.prepare(
      "INSERT INTO instrument_mappings VALUES ('scale-money','scale-money',1,'scale-money','rule','fixture',1,'2099','Synthetic','identified')",
    ),
  ]);
  for (const source of ["vpass", ...other.map((o) => o.source)])
    await env.DB.batch([
      env.DB.prepare("INSERT INTO source_accounts VALUES (?,?,?,?)").bind(
        source,
        source,
        source === "vpass" ? "collector-r2-importer" : "evidence-test",
        JSON.stringify([source]),
      ),
      env.DB.prepare("INSERT INTO accounts VALUES (?,'Synthetic','cash','provider-local')").bind(
        source,
      ),
      env.DB.prepare(
        "INSERT INTO account_mappings VALUES (?,?,1,?,'rule','fixture',1,'2099','Synthetic','provider-local')",
      ).bind(source, source, source),
    ]);
  // Bulk SQL keeps normal FK/provenance/append-only triggers enabled.
  await env.DB.prepare(
    "CREATE TABLE scale_parses(id INTEGER PRIMARY KEY,artifact INTEGER,source TEXT,unit INTEGER,binding INTEGER,token TEXT,n INTEGER)",
  ).run();
  for (let start = 0; start < 6000; start += 50) {
    const batch = [];
    for (let i = start; i < Math.min(start + 50, 6000); i++) {
      const vp = i < 2692,
        c = cards[i % 96]!,
        o = other[(i - 2692 + 3308) % 11]!;
      const n = vp ? (i < 845 ? 2 : 1) : i - 2692 < 1691 ? 10 : 9;
      batch.push(
        env.DB.prepare("INSERT INTO scale_parses VALUES (?,?,?,?,?,?,?)").bind(
          i + 1,
          vp ? c.financial : o.artifact,
          vp ? "vpass" : o.source,
          vp ? c.unit : null,
          vp ? c.binding : null,
          vp ? c.token : null,
          n,
        ),
      );
    }
    await env.DB.batch(batch);
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) SELECT id,artifact,'scale-'||id,'1','2099','ok','[]' FROM scale_parses",
    ),
    env.DB.prepare(
      "WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<10) INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json) SELECT p.id,p.source,'SYN','row-'||v,'{}' FROM scale_parses p JOIN n ON v<=p.n",
    ),
    env.DB.prepare("INSERT INTO identity_runs SELECT 'scale-1-'||id,id,1,'2099' FROM scale_parses"),
    env.DB.prepare(
      "INSERT INTO identity_runs SELECT 'scale-2-'||id,id,2,'2099' FROM scale_parses WHERE source='vpass'",
    ),
    env.DB.prepare(
      "INSERT INTO identity_vpass_bindings SELECT 'scale-2-'||id,unit,binding,token FROM scale_parses WHERE source='vpass'",
    ),
    env.DB.prepare(
      "INSERT INTO identity_observations SELECT 'scale-1-'||o.id,'scale-1-'||o.parse_run_id,'transaction',o.id,p.source,p.source,'[]' FROM transaction_observations o JOIN scale_parses p ON p.id=o.parse_run_id",
    ),
    env.DB.prepare(
      "INSERT INTO identity_observations SELECT 'scale-2-'||o.id,'scale-2-'||o.parse_run_id,'transaction',o.id,p.source,p.source,'[]' FROM transaction_observations o JOIN scale_parses p ON p.id=o.parse_run_id WHERE p.source='vpass'",
    ),
    env.DB.prepare(
      "INSERT INTO identity_instrument_uses SELECT id,'unit','scale-money','scale-money' FROM identity_observations",
    ),
    env.DB.prepare(
      "INSERT INTO identity_instrument_uses SELECT id,'trade-unit','scale-money','scale-money' FROM identity_observations",
    ),
    env.DB.prepare(
      "INSERT INTO identity_run_seals SELECT 'scale-1-'||id,n,'2099' FROM scale_parses",
    ),
    env.DB.prepare(
      "INSERT INTO identity_run_seals SELECT 'scale-2-'||id,n,'2099' FROM scale_parses WHERE source='vpass'",
    ),
    env.DB.prepare(
      "INSERT INTO identity_runs SELECT 'scale-3-'||id,id,3,'2099' FROM scale_parses WHERE id<=96",
    ),
  ]);
}

beforeAll(seedIdentityRunScale, 120_000);
it("representative parse/run/pin cardinalities preserve current identity eligibility", async () => {
  expect(await env.DB.prepare("SELECT count(*) n FROM parse_runs").first<number>("n")).toBe(6000);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM transaction_observations").first<number>("n"),
  ).toBe(35000);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM identity_vpass_bindings").first<number>("n"),
  ).toBe(2692);
  expect(
    await env.DB.prepare(
      "SELECT count(DISTINCT binding_artifact_id) n FROM identity_vpass_bindings",
    ).first<number>("n"),
  ).toBe(96);
  expect(
    await env.DB.prepare(
      "SELECT count(DISTINCT card_token) n FROM identity_vpass_bindings",
    ).first<number>("n"),
  ).toBe(6);
  let started = performance.now();
  expect(
    await env.DB.prepare("SELECT count(*) n FROM current_identity_observations").first<number>("n"),
  ).toBe(35000);
  const timings: Record<string, number> = {
    core: Math.round(performance.now() - started),
  };
  for (const endpoint of ["accounts", "instruments", "coverage"] as const) {
    started = performance.now();
    const rows = await env.DB.prepare(identityQuery(endpoint, false))
      .bind(0)
      .all<{ observedCount: number; eligible: number; organized: number }>();
    timings[endpoint] = Math.round(performance.now() - started);
    expect(rows.results).toHaveLength(12);
    expect(
      rows.results.reduce(
        (n, r) => n + (endpoint === "coverage" ? r.organized : r.observedCount),
        0,
      ),
    ).toBe(35000);
    if (endpoint === "coverage")
      expect(rows.results.reduce((n, r) => n + r.eligible, 0)).toBe(35000);
  }
  console.log(
    JSON.stringify({
      parseRuns: 6000,
      observations: 35000,
      pins: 2692,
      sidecars: 96,
      cards: 6,
      milliseconds: timings,
    }),
  );
  const references = await env.DB.prepare("SELECT id FROM instrument_identifiers LIMIT 500").all<{
    id: string;
  }>();
  started = performance.now();
  const names = await preferredInstrumentNames(
    env.DB,
    references.results.map((row) => row.id),
  );
  expect(names.size).toBe(references.results.length);
  expect(performance.now() - started).toBeLessThan(5000);
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN " + PREFERRED_INSTRUMENT_NAMES_SQL)
    .bind(JSON.stringify(references.results.map((row) => row.id)))
    .all<{ detail: string }>();
  expect(plan.results.filter((row) => row.detail === "MATERIALIZE eligible")).toHaveLength(1);
  const filterAccounts = await env.DB.prepare(`SELECT DISTINCT s.source_id,b.source_account
    FROM current_identity_observations o JOIN source_accounts s ON s.id=o.source_account_id
    JOIN transaction_observations b ON b.id=o.observation_id WHERE o.kind='transaction'`).all<{
    source_id: string;
    source_account: string;
  }>();
  started = performance.now();
  const filters = await organizedFilterOptions(env.DB, "transactions", {
    sources: [],
    instruments: [],
    metrics: [],
    accounts: filterAccounts.results,
  });
  const filterTime = Math.round(performance.now() - started);
  expect(filters.accounts.length).toBe(filterAccounts.results.length);
  expect(
    filters.accounts.every((row) => row.display_name !== null && !row.organization_ambiguous),
  ).toBe(true);
  expect(filterTime).toBeLessThan(5000);
  console.log(
    JSON.stringify({ organizedFilterMs: filterTime, parseRuns: 6000, observations: 35000 }),
  );
  // A newer unsealed policy never replaces the sealed policy-2 evidence.
  expect(
    await env.DB.prepare(
      "SELECT max(policy_version) FROM current_identity_observations WHERE parse_run_id=1",
    ).first<number>("max(policy_version)"),
  ).toBe(2);
  // Removing a sidecar's eligibility invalidates its pinned higher policy,
  // while the original sealed ordinal policy remains usable.
  await env.DB.prepare(
    "INSERT INTO fetch_run_annotations SELECT a.fetch_run_id,'exclude_from_financial_views','synthetic-fixture',0 FROM fetch_artifacts a JOIN scale_parses p ON p.binding=a.id WHERE p.id=1",
  ).run();
  expect(
    await env.DB.prepare(
      "SELECT max(policy_version) FROM current_identity_observations WHERE parse_run_id=1",
    ).first<number>("max(policy_version)"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM current_identity_observations").first<number>("n"),
  ).toBe(35000);
  // Supersession is append-once metadata, not an identity rewrite.
  await env.DB.prepare("UPDATE parse_runs SET superseded_by_parse_run_id=101 WHERE id=100").run();
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM current_identity_observations WHERE parse_run_id=100",
    ).first<number>("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT count(*) n FROM current_identity_observations").first<number>("n"),
  ).toBe(34998);
  const excluded = await env.DB.prepare(
    "SELECT sum(n) n FROM scale_parses WHERE artifact=(SELECT artifact FROM scale_parses WHERE id=1)",
  ).first<number>("n");
  await env.DB.prepare(
    "INSERT INTO fetch_run_annotations SELECT a.fetch_run_id,'exclude_from_financial_views','synthetic-fixture',0 FROM fetch_artifacts a JOIN scale_parses p ON p.artifact=a.id WHERE p.id=1",
  ).run();
  expect(
    await env.DB.prepare("SELECT count(*) n FROM current_identity_observations").first<number>("n"),
  ).toBe(34998 - excluded!);
  const coverage = await env.DB.prepare(identityQuery("coverage", false))
    .bind(0)
    .all<{ eligible: number; organized: number }>();
  expect(coverage.results.reduce((n, r) => n + r.eligible, 0)).toBe(34998 - excluded!);
  expect(coverage.results.reduce((n, r) => n + r.organized, 0)).toBe(34998 - excluded!);
}, 120_000);
