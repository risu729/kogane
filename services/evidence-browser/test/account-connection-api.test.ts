import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { seedRegistry, seedRun } from "./fixtures";
import { identityApi } from "../src/identity-api";
import { observationOrganizations } from "../src/observation-organization";
import { identifyParse } from "../../observation-pipeline/src/identity-store";
import { resolveIdentity } from "../../../poc/observation-pipeline/src/identity";
import { validIdentityResponse } from "../../../poc/observation-pipeline/shared/identity-contract";
import { validAccountConnection } from "../../../poc/observation-pipeline/shared/account-connection-contract";

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources(producer_id,source_id) VALUES('evidence-test','moneyforward-me')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test','evidence-test','moneyforward-me')",
    ),
  ]);
});
async function call(path: string, method = "GET") {
  const request = new Request(`https://fixture.test${path}`, { method });
  return identityApi(request, env, new URL(request.url));
}
async function review(key: string) {
  const evidence = await seedRun({
    source: "moneyforward-me",
    count: 1,
    dataset: "account-detail",
    fetchUnitKey: key,
  });
  await env.DB.prepare(`INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,
    related_source_id,reason,verifier_version,detail_artifact_id,direct_reference_ids_json,created_at)
    VALUES('evidence-test',?,1,'三井住友銀行（MoneyForward連携）','unresolved','smbc-bank',
    '個別口座の根拠不足','fixture',?,'[]','2099')`)
    .bind(key, evidence.artifacts[0]!.id)
    .run();
  return evidence;
}
it("lists reviewed connections even with no parsed observations and validates route boundaries", async () => {
  await review("no-observations");
  const response = await call("/api/identity/connections");
  const body = await response!.json();
  expect(validIdentityResponse("/api/identity/connections", body)).toBe(true);
  expect(body).toMatchObject({
    connections: [
      {
        label: "三井住友銀行（MoneyForward連携）",
        status: "unresolved",
        leafBinding: "unresolved",
      },
    ],
  });
  await expect(call("/api/identity/connections?source=moneyforward-me")).rejects.toThrow(
    "invalid_query",
  );
  await expect(call("/api/identity/connections", "POST")).rejects.toThrow("method_not_allowed");
  expect(
    validAccountConnection({ ...(body as any).connections[0], leafBinding: "confirmed" }),
  ).toBe(false);
  for (const invalid of [
    { status: ["confirmed"] },
    { relation: ["candidate"] },
    { evidenceArtifactIds: [] },
  ]) {
    expect(validAccountConnection({ ...(body as any).connections[0], ...invalid })).toBe(false);
  }
});
it("applies only eligible automatic MF connection names without altering originals or instrument metadata", async () => {
  const evidence = await review("observed-connection");
  const financial = await seedRun({ source: "moneyforward-me", count: 1 });
  const parse =
    await env.DB.prepare(`INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES(?,'fixture','1','2099','ok','[]') RETURNING id`)
      .bind(financial.artifacts[0]!.id)
      .first<{ id: number }>();
  const observation =
    await env.DB.prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json)
    VALUES(?,'moneyforward-me:observed-connection','JPY','row','{}') RETURNING id`)
      .bind(parse!.id)
      .first<{ id: number }>();
  await identifyParse(
    env.DB,
    {
      id: parse!.id,
      artifact_id: financial.artifacts[0]!.id,
      source_id: "moneyforward-me",
      producer_id: "evidence-test",
      fetch_run_id: financial.id,
    },
    resolveIdentity,
  );
  const ref = { kind: "transaction" as const, id: observation!.id };
  const get = async () =>
    (await observationOrganizations(env.DB, [ref])).get(`transaction:${ref.id}`)!;
  const initial = await get();
  expect(initial.account).toMatchObject({
    label: "三井住友銀行（MoneyForward連携）（個別口座未確定）",
    connection: { status: "unresolved" },
  });
  expect(initial.instruments.every((instrument) => !("connection" in instrument))).toBe(true);
  const raw = await env.DB.prepare("SELECT source_account FROM transaction_observations WHERE id=?")
    .bind(ref.id)
    .first("source_account");
  expect(raw).toBe("moneyforward-me:observed-connection");
  const response = await call("/api/identity/accounts?source=moneyforward-me");
  const body = await response!.json();
  expect(validIdentityResponse("/api/identity/accounts", body)).toBe(true);
  expect(body).toMatchObject({
    rows: [{ label: initial.account!.label, connection: { status: "unresolved" } }],
  });
  expect(JSON.stringify(body)).not.toContain('"producer"');
  await env.DB.prepare(
    "INSERT INTO fetch_run_annotations VALUES(?,'exclude_from_financial_views','fixture',0)",
  )
    .bind(evidence.id)
    .run();
  const ineligible = await get();
  expect(ineligible.account!.connection!.status).toBe("evidence-ineligible");
  expect(ineligible.account!.label).not.toBe(initial.account!.label);
  await env.DB.prepare(`INSERT INTO account_mappings SELECT 'manual-connection-label',source_account_id,revision+1,account_id,
    'manual','manual correction',policy_version,'2100','手動で選んだ口座',status FROM current_account_mappings WHERE source_account_id=?`)
    .bind(initial.account!.referenceId)
    .run();
  expect((await get()).account).toMatchObject({ label: "手動で選んだ口座", method: "manual" });
});
