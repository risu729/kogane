import { queryDatedState } from "../../../packages/application/src/query/dated-state.ts";
import type { SqlExecutor } from "../../../packages/read-model/src/reader.ts";
import { identitySweep } from "../src/identity-store.ts";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
} from "../../../packages/storage-d1/src/migrations.ts";
import { applyTestReadMigrations, applyTestSql } from "./migration-setup.ts";
import { alarmCollection } from "../../collector-vpass/src/worker.ts";
import * as mobileAuth from "../../collector-vpass/src/mobile-auth.ts";
import { authori, envelope, revo } from "../../../packages/parsers/test/fixtures/vpass-credit.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { sweep } from "../src/worker.ts";
import { DATED_BALANCES_SQL } from "../../../packages/read-model/src/dated-state.ts";
import { resolveMetric } from "../../../packages/domain/src/metrics.ts";
import { reportedStateCutoff } from "../../../packages/domain/src/reported-state.ts";
let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB", "READ"],
      r2Buckets: ["EVIDENCE"],
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    await applyTestSql(db, migrationSql(CORE_MIGRATIONS_URL, file));
  await applyTestSql(
    db,
    readFileSync(new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url), "utf8"),
  );
  const read = await mf.getD1Database("READ");
  await applyTestReadMigrations(read);
  env = {
    DB: db,
    READ: read,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

async function collect(day: number) {
  let selected = 0;
  const auth = [
    spyOn(mobileAuth, "assertPublicKeyHash").mockImplementation(() => {}),
    spyOn(mobileAuth, "buildConfigAuth").mockReturnValue("synthetic-config"),
    spyOn(mobileAuth, "buildFirstLoginAuth").mockReturnValue("synthetic-auth"),
  ];
  const logs = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
  const reads: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/Config"))
          return Response.json(
            { status: 200 },
            {
              headers: { "x-vappsessiontime": "synthetic", "set-cookie": "sid=synthetic; Path=/" },
            },
          );
        if (path.endsWith("/Fauth"))
          return Response.json({ status: 200, data: { login_token: "synthetic" } });
        reads.push(path);
        const body = JSON.parse(String(init?.body)) as {
          body: { content: Record<string, unknown> };
        };
        const content = body.body.content;
        if (path.includes("dropdownlist_init"))
          return Response.json(
            envelope({
              DropdownListInitDisplayServiceBean: {
                multiCardInfoList: [1, 2].map((card) => ({
                  name: `Synthetic card ${card}`,
                  value: `synthetic-${card}`,
                })),
              },
            }),
          );
        if (path.includes("operation_card_update")) {
          selected = content["cardIdentifyKey"] === "synthetic-1" ? 1 : 2;
          return Response.json(envelope({}, selected));
        }
        expect(content).toEqual({});
        if (path.includes("web_meisai_top"))
          return Response.json(
            envelope({ WebMeisaiTopDisplayServiceBean: { seikyuYMList: [] } }, selected),
          );
        if (path.includes("authori_shokai_cvv2_input") || path.includes("xt_authori_shokai"))
          return Response.json(envelope({}, selected));
        if (path.includes("/authori/authori_shokai/"))
          return Response.json({
            ...authori(String(100 + selected + day)),
            header: envelope({}, selected).header,
          });
        if (path.includes("/revo/xt_revo_shokai/"))
          return Response.json({
            ...revo(`+${100000 + selected + day}`),
            header: envelope({}, selected).header,
          });
        throw new Error("unexpected_synthetic_route");
      },
      { preconnect: () => {} },
    ),
  );
  try {
    const result = await alarmCollection(
      {
        DATA: env.EVIDENCE,
        VPASS_AUTH_PUBLIC_KEY_B64: "c3ludGhldGlj",
        VPASS_CONFIG_PUBLIC_KEY_B64: "c3ludGhldGlj",
        VPASS_DEVICE_ID: "00000000-0000-4000-8000-000000000000",
        VPASS_ID: "synthetic",
        VPASS_PASSWORD: "synthetic",
      } as unknown as Parameters<typeof alarmCollection>[0],
      "",
      Date.parse(`2026-09-0${day}T00:00:00Z`),
    );
    // Statements fail independently (no months); daily snapshots persist for both cards.
    expect(result.status).toBe("failed");
    expect(result.runIds).toHaveLength(4);
    expect(reads.filter((path) => path.includes("/authori/authori_shokai/"))).toHaveLength(2);
    return result.runIds;
  } finally {
    fetcher.mockRestore();
    for (const spy of [...auth, ...logs]) spy.mockRestore();
  }
}
test("daily collector → R2 → registration → publication → real reader selects one snapshot per card across two runs", async () => {
  for (const day of [1, 2]) {
    for (const runId of await collect(day))
      expect(await registerCollectionRun(env, { source: "vpass", runId })).toMatchObject(
        runId.includes("-credit-")
          ? { outcome: "registered" }
          : { outcome: "blocked", code: "provider_run_failed" },
      );
    expect(await sweep(env)).toMatchObject({ parsed: 4, error: 0 });
    await identitySweep(env.DB, resolveIdentity, 40);
  }
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM published_parse_runs pub JOIN parse_runs p ON p.id=pub.parse_run_id WHERE p.parser_name='vpass-credit-snapshot'",
      ).first<{ n: number }>()
    )?.n,
  ).toBe(8);
  const { results } = await env.DB.prepare(DATED_BALANCES_SQL)
    .bind(reportedStateCutoff("2026-11-11"))
    .all<{
      source_account: string;
      metric: string;
      coefficient: string;
      source_id: string;
      parser_name: string;
      account_id: string | null;
      identity_recorded: number;
    }>();
  const credit = results.filter((row) => row.parser_name === "vpass-credit-snapshot");
  expect(credit.every((row) => row.identity_recorded === 1 && row.account_id !== null)).toBe(true);
  expect(new Set(credit.map((row) => row.account_id)).size).toBe(2);
  expect(credit).toHaveLength(28); // 14 reported metrics × 2 cards, not 56 from both runs.
  expect(credit.filter((row) => row.source_account === "vpass:card-001")).toHaveLength(14);
  expect(credit.filter((row) => row.source_account === "vpass:card-002")).toHaveLength(14);
  expect(
    credit.find(
      (row) =>
        row.source_account === "vpass:card-001" &&
        row.metric === "reported_card_outstanding_thousand_yen",
    )?.coefficient,
  ).toBe("103000");
  expect(
    credit.find(
      (row) =>
        row.source_account === "vpass:card-002" &&
        row.metric === "reported_revolving_outstanding_yen",
    )?.coefficient,
  ).toBe("100004");
  for (const row of credit)
    expect(
      resolveMetric({
        family: "balance",
        sourceId: row.source_id,
        parserName: row.parser_name,
        metric: row.metric,
        sourceAccount: row.source_account,
        amountBasis: null,
      }),
    ).toMatchObject({
      aggregationRule: "non-additive",
      netAssetEligible: false,
      overlapGroup: "vpass:shared-card-credit",
    });
  const sql: SqlExecutor = {
    async all<T>(query: string, args: readonly unknown[]): Promise<T[]> {
      return (
        await env.DB.prepare(query)
          .bind(...args)
          .all<T>()
      ).results;
    },
    async first<T>(query: string, args: readonly unknown[]): Promise<T | null> {
      return env.DB.prepare(query)
        .bind(...args)
        .first<T>();
    },
  };
  const reported = await queryDatedState(sql, { date: "2026-11-11", source: "vpass" });
  expect(reported.accounts).toHaveLength(2);
  expect(reported.accounts.flatMap((account) => account.balances)).toHaveLength(28);
  expect(
    reported.accounts
      .flatMap((account) => account.balances)
      .every(
        (balance) =>
          balance.metric.aggregationRule === "non-additive" &&
          balance.metric.overlapGroup === "vpass:shared-card-credit",
      ),
  ).toBe(true);
  expect(reported).not.toHaveProperty("total");
  // The existing stable identity binding sees each snapshot artifact; no new card identity derivation.
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(DISTINCT card_token) AS n FROM trusted_vpass_card_bindings b JOIN fetch_artifacts fa ON fa.id=b.financial_artifact_id WHERE fa.dataset='credit-snapshot'",
      ).first<{ n: number }>()
    )?.n,
  ).toBe(2);
}, 60000);
