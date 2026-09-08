import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { seedRegistry, seedRun } from "./fixtures";
import { describeActivities } from "../src/activity-presentation";
import { validApiResponse } from "../../../poc/observation-pipeline/shared/api-validation";
import type { TransactionRow } from "../../../poc/observation-pipeline/shared/api-contract";
beforeAll(seedRegistry);
it("projects only bounded same-row facts and preserves the positive withdrawal amount", async () => {
  const run = await seedRun({ count: 1 });
  const parse = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'sbi-yen-detail-history','1','2099','ok','[]') RETURNING id",
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  const rows: TransactionRow[] = [];
  for (const direction of ["debit", "credit"]) {
    const raw = await env.DB.prepare(
      "INSERT INTO transaction_observations(parse_run_id,source_account,amount_minor,amount_text,currency,raw_locator,extra_json) VALUES (?,'synthetic',300,'300','JPY','json:$.synthetic',?) RETURNING id",
    )
      .bind(
        parse!.id,
        JSON.stringify({
          sensitive: "must-not-leak",
          _kogane: { direction, period: "x".repeat(257) },
        }),
      )
      .first<{ id: number }>();
    rows.push({
      id: raw!.id,
      source_id: "sbi-securities",
      source_account: "synthetic",
      parser: "sbi-yen-detail-history@1",
      amount_minor: "300",
      amount_text: "300",
      currency: "JPY",
      as_of: null,
      description: null,
      counterparty: null,
      external_id: null,
      status: "posted",
    });
  }
  const before = JSON.stringify(rows);
  const result = await describeActivities(env.DB, rows);
  expect(result.map((row) => row.interpretation?.direction)).toEqual(["debit", "credit"]);
  expect(result[0]!.amount_minor).toBe("300");
  expect(result[0]!.interpretation?.period).toBeNull();
  const myjcb = await describeActivities(
    env.DB,
    rows.map((row) => ({ ...row, source_id: "myjcb", parser: "myjcb-credit-ledger@1" })),
  );
  expect(myjcb.every((row) => row.interpretation?.period === null)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
  expect(JSON.stringify(rows)).toBe(before);
  expect(validApiResponse("/api/transactions", { transactions: result })).toBe(true);
  await expect(
    describeActivities(
      env.DB,
      Array.from({ length: 502 }, () => rows[0]!),
    ),
  ).rejects.toThrow("activity_presentation_budget");
});
