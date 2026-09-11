import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { preferredInstrumentNames } from "../src/preferred-instrument-names";
import { publishParse, seedRegistry, seedRun, supersedeParse } from "./fixtures";
import { identifyParse } from "../../processor/src/identity-store";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { observationOrganizations, organizeRows } from "../src/observation-organization";

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test','sbi-securities')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test','sbi-securities')",
    ),
  ]);
});

async function seed(
  names: {
    code: string;
    label: string;
    market?: string;
    kind?: "position" | "transaction" | "valuation";
  }[],
  // A re-parse of an existing artifact: the same publication key, so one run
  // can supersede the other the way the pipeline writer does.
  reparse?: { artifactId: number; version: string },
) {
  const artifactId =
    reparse?.artifactId ?? (await seedRun({ count: 1, source: "sbi-securities" })).artifacts[0]!.id;
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'name-fixture',?,'2099-01-01','ok','[]') RETURNING id`)
    .bind(artifactId, reparse?.version ?? "1")
    .first<{ id: number }>();
  await publishParse(parse!.id);
  for (const name of names) {
    if (name.kind === "transaction") {
      await env.DB.prepare(`INSERT INTO transaction_observations
        (parse_run_id,source_account,currency,raw_locator,extra_json)
        VALUES (?,'sbi-securities:domestic','JPY','synthetic',?)`)
        .bind(
          parse!.id,
          JSON.stringify({
            issueCode: name.code,
            issueName: name.label,
            marketLabel: name.market ?? "TKY",
            accountLabel: "一般",
          }),
        )
        .run();
      continue;
    }
    if (name.kind === "valuation") {
      await env.DB.prepare(`INSERT INTO valuation_observations
        (parse_run_id,source_account,subject,metric,currency,raw_locator,extra_json)
        VALUES (?,'sbi-securities:domestic',?,'evaluation_amount','JPY','synthetic',?)`)
        .bind(
          parse!.id,
          name.code,
          JSON.stringify({ issueName: name.label, _kogane: { marketCode: name.market ?? "TKY" } }),
        )
        .run();
      continue;
    }
    await env.DB.prepare(`INSERT INTO position_observations
      (parse_run_id,source_account,security_code,security_name,market,currency,quantity_text,quantity_scale,raw_locator,extra_json)
      VALUES (?,'sbi-securities:domestic',?,?,?,'JPY','1',0,'synthetic','{}')`)
      .bind(parse!.id, name.code, name.label, name.market ?? "TKY")
      .run();
  }
  const verified =
    await env.DB.prepare(`SELECT p.id,a.id artifact_id,a.source_id,r.producer_id,a.fetch_run_id
    FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
    JOIN financial_fetch_runs r ON r.id=a.fetch_run_id WHERE p.id=?`)
      .bind(parse!.id)
      .first<{
        id: number;
        artifact_id: number;
        source_id: string;
        producer_id: string;
        fetch_run_id: number;
      }>();
  while (await identifyParse(env.DB, verified!, resolveIdentity)) {
    // Resume the production writer's bounded pages until the run is sealed.
  }
  const identifiers = await env.DB.prepare(`SELECT d.id,d.value,d.scope,m.label
    FROM instrument_identifiers d JOIN current_instrument_mappings m ON m.identifier_id=d.id
    WHERE d.namespace='mic-symbol'`).all<{
    id: string;
    value: string;
    scope: string;
    label: string;
  }>();
  return { parseId: parse!.id, artifactId, identifiers: identifiers.results };
}

it("prefers an observed Japanese name for the exact listing and keeps B and mappings unchanged", async () => {
  const data = await seed([
    { code: "NAME1", label: "Example Corp" },
    { code: "NAME1", label: "エグザンプル" },
    { code: "NAME2", label: "Different Corp" },
    { code: "NAME2", label: "日本企業", market: "NGY" },
  ]);
  const names = await preferredInstrumentNames(
    env.DB,
    data.identifiers.map((row) => row.id),
  );
  const first = data.identifiers.find((row) => row.value === "NAME1")!;
  expect(first.label).toBe("Example Corp");
  expect(names.get(first.id)).toMatchObject({
    label: "エグザンプル",
    reason: "observed-japanese-script",
    origin: { kind: "position" },
  });
  const other = data.identifiers.find((row) => row.value === "NAME2" && row.scope === "XTKS")!;
  expect(names.get(other.id)).toEqual({
    label: "Different Corp",
    reason: "provider-current",
    origin: null,
  });
  const han = data.identifiers.find((row) => row.value === "NAME2" && row.scope === "XNGO")!;
  expect(names.get(han.id)?.label).toBe("日本企業");
  expect(
    await env.DB.prepare(
      "SELECT security_name FROM position_observations WHERE parse_run_id=? ORDER BY id LIMIT 1",
    )
      .bind(data.parseId)
      .first("security_name"),
  ).toBe("Example Corp");
  expect(
    await env.DB.prepare("SELECT label FROM current_instrument_mappings WHERE identifier_id=?")
      .bind(first.id)
      .first("label"),
  ).toBe("Example Corp");
});

it("protects manual labels and ignores names from a superseded parse", async () => {
  const data = await seed([
    { code: "MANUAL", label: "Example" },
    { code: "MANUAL", label: "日本企業" },
  ]);
  const id = data.identifiers.find((row) => row.value === "MANUAL")!.id;
  await env.DB.prepare(`INSERT INTO instrument_mappings
    SELECT 'manual-name',identifier_id,revision+1,instrument_id,'manual','reviewed',policy_version,'2099','User chosen',status
    FROM current_instrument_mappings WHERE identifier_id=?`)
    .bind(id)
    .run();
  expect((await preferredInstrumentNames(env.DB, [id])).get(id)).toEqual({
    label: "User chosen",
    reason: "manual",
    origin: null,
  });
  // An older parse of the same artifact, published first and then replaced
  // by the data parse: its names are history, not the provider's current name.
  const stale = await seed(
    [
      { code: "STALE", label: "Example" },
      { code: "STALE", label: "日本企業" },
    ],
    { artifactId: data.artifactId, version: "0" },
  );
  const staleId = stale.identifiers.find((row) => row.value === "STALE")!.id;
  await supersedeParse(stale.parseId, data.parseId);
  expect((await preferredInstrumentNames(env.DB, [staleId])).get(staleId)).toEqual({
    label: "Example",
    reason: "provider-current",
    origin: null,
  });
});

it("deduplicates requested IDs and rejects an oversized lookup", async () => {
  expect((await preferredInstrumentNames(env.DB, [])).size).toBe(0);
  await expect(
    preferredInstrumentNames(
      env.DB,
      Array.from({ length: 501 }, (_, i) => String(i)),
    ),
  ).rejects.toThrow("preferred_instrument_name_budget_invalid");
});

it("uses transaction and valuation name evidence with stable selection across input order", async () => {
  const data = await seed([
    { code: "TXNAME", label: "Example Corp" },
    { code: "TXNAME", label: "名称企業", kind: "transaction" },
    { code: "VALNAME", label: "Example Corp" },
    { code: "VALNAME", label: "名称企業", kind: "valuation" },
    { code: "STABLE", label: "名称企業" },
    { code: "STABLE", label: "ベータ", kind: "transaction" },
    { code: "STABLE", label: "アルファ", kind: "valuation" },
  ]);
  const selected = await preferredInstrumentNames(
    env.DB,
    data.identifiers.map((row) => row.id).reverse(),
  );
  expect(selected.get(data.identifiers.find((row) => row.value === "TXNAME")!.id)).toMatchObject({
    label: "名称企業",
    origin: { kind: "transaction" },
  });
  expect(selected.get(data.identifiers.find((row) => row.value === "VALNAME")!.id)).toMatchObject({
    label: "名称企業",
    origin: { kind: "valuation" },
  });
  expect(selected.get(data.identifiers.find((row) => row.value === "STABLE")!.id)).toMatchObject({
    label: "アルファ",
    origin: { kind: "valuation" },
  });
});

it("observation organization shares preferred names and evidence while retaining source fields", async () => {
  const data = await seed([
    { code: "INTEGRATED", label: "Original English" },
    { code: "INTEGRATED", label: "日本企業", kind: "transaction" },
    { code: "INTEGRATED", label: "日本企業", kind: "valuation" },
  ]);
  const positions = await env.DB.prepare(
    "SELECT id,security_name,security_code FROM position_observations WHERE parse_run_id=?",
  )
    .bind(data.parseId)
    .all<{ id: number; security_name: string; security_code: string }>();
  const rows = await organizeRows(env.DB, "position", positions.results);
  expect(rows[0]).toMatchObject({
    security_name: "Original English",
    security_code: "INTEGRATED",
    organization: { state: "organized" },
  });
  expect(rows[0]!.organization.instruments.find((i) => i.role === "security")).toMatchObject({
    label: "日本企業",
    nameEvidence: {
      reason: "observed-japanese-script",
      origin: { kind: "transaction", id: expect.any(Number) },
    },
  });
  expect(positions.results[0]).not.toHaveProperty("organization");
  const reference = data.identifiers.find((row) => row.value === "INTEGRATED")!.id;
  await env.DB.prepare(`INSERT INTO instrument_mappings SELECT 'integration-manual',identifier_id,revision+1,
    instrument_id,'manual','chosen label',policy_version,'2100','Chosen name',status
    FROM current_instrument_mappings WHERE identifier_id=?`)
    .bind(reference)
    .run();
  const manual = await observationOrganizations(env.DB, [
    { kind: "position", id: positions.results[0]!.id },
  ]);
  expect(
    manual
      .get(`position:${positions.results[0]!.id}`)!
      .instruments.find((i) => i.role === "security"),
  ).toMatchObject({
    label: "Chosen name",
    method: "manual",
    nameEvidence: { reason: "manual", origin: null },
  });
});

it("organizes more than 500 distinct instruments without exceeding the name lookup budget", async () => {
  const data = await seed(
    Array.from({ length: 501 }, (_, i) => ({ code: `PAGE-${i}`, label: `企業${i}` })),
  );
  const positions = await env.DB.prepare(
    "SELECT id FROM position_observations WHERE parse_run_id=?",
  )
    .bind(data.parseId)
    .all<{ id: number }>();
  const result = await observationOrganizations(
    env.DB,
    positions.results.map(({ id }) => ({ kind: "position", id })),
  );
  expect(result.size).toBe(501);
  for (const organization of result.values()) {
    expect(
      organization.instruments.find((instrument) => instrument.role === "security")?.nameEvidence
        ?.reason,
    ).toBe("observed-japanese-script");
  }
}, 30_000);
