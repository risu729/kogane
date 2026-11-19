// The account list (`GET /api/identity/account-list`, `kogane.identity.read`
// with `collection: "account-list"`) and the entity label rule it shares with
// the organization of observation rows (ADR 0077 amendment 2026-11-19), over
// the real identity pipeline. Every institution label, key and account number
// here is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { observationOrganizations } from "../../../packages/application/src/query/observation-organization.ts";
import { readIdentityPage } from "../../../packages/application/src/query/identity-pages.ts";
import { organizedFilterOptions } from "../../../packages/application/src/query/organized-filter-options.ts";
import {
  ACCOUNT_LIST_BYTE_BUDGET,
  validIdentityResponse,
  type AccountListPage,
} from "../../../packages/observation-shared/src/identity-contract";
import { identifyParse } from "../../processor/src/identity-store";
import { identityApi } from "../src/identity-api";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const IMPORTER = "collector-r2-importer";
const COLLECTOR = "evidence-test";
const REVIEWED = `moneyforward-account-v2-${"a".repeat(64)}`;
const UNREVIEWED = `moneyforward-account-v2-${"b".repeat(64)}`;
const REVIEW_LABEL = "合成銀行（MoneyForward連携）";
const ENTITY_LABEL = `${REVIEW_LABEL}（個別口座未確定）`;

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO ingest_client_producers(ingest_client_id,producer_id) VALUES('evidence-test',?)",
    ).bind(IMPORTER),
    ...[
      [COLLECTOR, "moneyforward-me"],
      [IMPORTER, "moneyforward-me"],
      [COLLECTOR, "mizuho-bank"],
    ].flatMap(([producer, source]) => [
      env.DB.prepare(
        "INSERT OR IGNORE INTO producer_sources(producer_id,source_id) VALUES(?,?)",
      ).bind(producer, source),
      env.DB.prepare(
        "INSERT OR IGNORE INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test',?,?)",
      ).bind(producer, source),
    ]),
  ]);
  // A connection review recorded under the importer's producer only, as the
  // stored reviews are: the collector's reference of the same identity value
  // has none of its own.
  const detail = await seedRun({
    source: "moneyforward-me",
    producer: IMPORTER,
    count: 1,
    dataset: "account-detail",
    fetchUnitKey: REVIEWED,
  });
  await env.DB.prepare(`INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,
    related_source_id,reason,verifier_version,detail_artifact_id,direct_reference_ids_json,created_at)
    VALUES(?,?,1,?,'unresolved','smbc-bank','synthetic reason','fixture',?,'[]','2099')`)
    .bind(IMPORTER, REVIEWED, REVIEW_LABEL, detail.artifacts[0]!.id)
    .run();
  await observe("mizuho-bank", COLLECTOR, "mizuho-bank:ordinary:001:0000001");
  // A reference no identity rule recognizes stays unresolved.
  await observe("sony-bank", COLLECTOR, "sony-bank:synthetic-unrecognized");
  await observe("moneyforward-me", IMPORTER, `moneyforward-me:${REVIEWED}`);
  collectorObservation = await observe("moneyforward-me", COLLECTOR, `moneyforward-me:${REVIEWED}`);
  await observe("moneyforward-me", COLLECTOR, `moneyforward-me:${UNREVIEWED}`);
});
let collectorObservation: number;

/** One published balance observation of a reference, organized by the real rules. */
async function observe(source: string, producer: string, sourceAccount: string): Promise<number> {
  const run = await seedRun({ source, producer, count: 1 });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'fixture','1','2099','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  const observation = await env.DB.prepare(
    `INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json)
     VALUES(?,?,'synthetic_balance','JPY','row','{}') RETURNING id`,
  )
    .bind(parse!.id, sourceAccount)
    .first<{ id: number }>();
  await identifyParse(
    env.DB,
    {
      id: parse!.id,
      artifact_id: run.artifacts[0]!.id,
      source_id: source,
      producer_id: producer,
      fetch_run_id: run.id,
    },
    resolveIdentity,
  );
  return observation!.id;
}

async function list(query = ""): Promise<AccountListPage> {
  const request = new Request(`https://fixture.test/api/identity/account-list${query}`);
  const response = await identityApi(request, env, new URL(request.url));
  const body = await response!.json();
  expect(validIdentityResponse("/api/identity/account-list", body)).toBe(true);
  return body as AccountListPage;
}

describe("account list", () => {
  it("lists one line per entity: a direct bank, reviewed and unreviewed aggregator accounts, an unresolved one", async () => {
    const page = await list();
    expect(page.coverage).toEqual({ limit: 50, total: 4, nextOffset: null, truncated: false });
    expect(page.rows.map(({ account: _account, lastObservedAt: _at, ...row }) => row)).toEqual([
      {
        label: "みずほ銀行 普通預金",
        kind: "deposit",
        sources: ["mizuho-bank"],
        mapping: "provider-local",
        connection: null,
      },
      // The importer's and the collector's reference of one identity value are
      // one entity, labelled by the review whichever reference a row uses.
      {
        label: "MoneyForward連携口座",
        kind: "aggregator-mirror",
        sources: ["moneyforward-me"],
        mapping: "provider-local",
        connection: "not-reviewed",
      },
      {
        label: ENTITY_LABEL,
        kind: "aggregator-mirror",
        sources: ["moneyforward-me"],
        mapping: "provider-local",
        connection: "unresolved",
      },
      {
        label: "ソニー銀行",
        kind: "source-account",
        sources: ["sony-bank"],
        mapping: "unresolved",
        connection: null,
      },
    ]);
    expect(page.rows.every((row) => /^account_[0-9a-f]{64}$/u.test(row.account))).toBe(true);
    expect(page.rows.every((row) => row.lastObservedAt !== null)).toBe(true);
    const mf = await env.DB.prepare(
      "SELECT count(*) AS n FROM source_accounts WHERE source_id='moneyforward-me'",
    ).first<number>("n");
    expect(mf).toBe(3);
  });

  it("filters by source and kind, and pages by offset", async () => {
    expect((await list("?source=mizuho-bank")).rows.map((row) => row.sources)).toEqual([
      ["mizuho-bank"],
    ]);
    const aggregators = await list("?kind=aggregator-mirror");
    expect(aggregators.coverage.total).toBe(2);
    expect(aggregators.rows.map((row) => row.connection)).toEqual(["not-reviewed", "unresolved"]);
    expect((await list("?source=absent")).rows).toEqual([]);
    const second = await list("?offset=3");
    expect(second.rows.map((row) => row.kind)).toEqual(["source-account"]);
    expect(second.coverage.nextOffset).toBeNull();
  });

  it("refuses what the other identity pages refuse, and identityRead", async () => {
    for (const query of [
      "?identityRead=latest",
      "?q=x",
      "?kind=",
      "?kind=a&kind=b",
      `?kind=${"x".repeat(129)}`,
    ])
      await expect(list(query), query).rejects.toThrow("invalid_query");
    await expect(list("?offset=-1")).rejects.toThrow("invalid_offset");
  });

  it("gives balance rows, the accounts page and the filter options the entity's label", async () => {
    const organization = (
      await observationOrganizations(d1Executor(env.DB), [
        { kind: "balance", id: collectorObservation },
      ])
    ).get(`balance:${collectorObservation}`)!;
    expect(organization.account).toMatchObject({
      label: ENTITY_LABEL,
      method: "rule",
      connection: { label: REVIEW_LABEL, status: "unresolved" },
    });
    const accounts = await readIdentityPage(d1Executor(env.DB), "accounts", {
      source: "moneyforward-me",
      offset: 0,
      mode: "latest",
    });
    const labels = (accounts.rows as { label: string; targetId: string }[]).map((row) => row.label);
    expect(labels.filter((label) => label === ENTITY_LABEL)).toHaveLength(2);
    expect(labels).toContain("MoneyForward連携口座");
    const options = await organizedFilterOptions(d1Executor(env.DB), "balances", {
      sources: ["moneyforward-me"],
      instruments: [],
      metrics: [],
      accounts: [{ source_id: "moneyforward-me", source_account: `moneyforward-me:${REVIEWED}` }],
    });
    // Two producers' references of one entity no longer disagree on the name.
    expect(options.accounts[0]).toMatchObject({
      display_name: ENTITY_LABEL,
      organization_ambiguous: false,
    });
  });

  it("keeps a manual label and the entity's other references apart", async () => {
    const reference = await env.DB.prepare(
      "SELECT id FROM source_accounts WHERE source_id='moneyforward-me' AND producer_id=? AND reference_json=?",
    )
      .bind(COLLECTOR, JSON.stringify([`moneyforward-me:${REVIEWED}`]))
      .first<string>("id");
    await env.DB.prepare(`INSERT INTO account_mappings SELECT 'manual-entity-label',source_account_id,revision+1,account_id,
      'manual','manual correction',policy_version,'2100','手動の合成名',status FROM current_account_mappings WHERE source_account_id=?`)
      .bind(reference)
      .run();
    const organization = (
      await observationOrganizations(d1Executor(env.DB), [
        { kind: "balance", id: collectorObservation },
      ])
    ).get(`balance:${collectorObservation}`)!;
    expect(organization.account).toMatchObject({ label: "手動の合成名", method: "manual" });
    // The entity's line follows the person's label; the importer's reference
    // still names the connection.
    const row = (await list("?kind=aggregator-mirror")).rows.find(
      (entry) => entry.connection === "unresolved",
    );
    expect(row).toMatchObject({ label: "手動の合成名", connection: "unresolved" });
  });

  it("stays within its byte budget", async () => {
    const page = await list();
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(
      ACCOUNT_LIST_BYTE_BUDGET,
    );
  });
});
